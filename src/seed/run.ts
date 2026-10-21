import {DateTime} from 'luxon';
import mongoose, {type Types} from 'mongoose';

import {mongoUri} from '../config/env.js';
import {connectDb, disconnectDb} from '../db/connect.js';
import {emailKey} from '../lib/emailKey.js';
import {isDuplicateKeyError} from '../lib/errors.js';
import {hashPassword} from '../lib/password.js';
import {addMinutes} from '../lib/time.js';
import * as models from '../models/index.js';
import {
  AvailabilityModel,
  BookingModel,
  BookingSeriesModel,
  CoachProfileModel,
  ConversationModel,
  MessageModel,
  NoteModel,
  SeatLockModel,
  SessionTypeModel,
  TrialClaimModel,
  UserModel,
  type SessionTypeDoc,
  type TrainingSessionDoc,
  type UserDoc,
} from '../models/index.js';
import {createLockedSession} from '../modules/sessions/sessions.service.js';
import {refreshCoachCatalogFields} from '../modules/sessionTypes/sessionTypes.service.js';
import {ensureCoachSetup} from '../modules/users/users.service.js';
import {
  CHAT_SCRIPTS,
  CLIENTS,
  COACHES,
  DEMO_CLIENT,
  DEMO_PASSWORD,
  INCOMPLETE_COACH,
  NEW_CLIENT,
  NOTE_TEXTS,
  type SeedClient,
  type SeedCoach,
} from './data.js';

// ------------------------------------------------------------------------------------------------
// Deterministic randomness so every reset produces the same shape of data.
// ------------------------------------------------------------------------------------------------
let rngState = 20261020;
function random() {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p: number) => random() < p;
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
const shuffle = <T>(items: T[]) => [...items].sort(() => random() - 0.5);

const avatarUrl = (n: number) => `https://i.pravatar.cc/300?img=${n}`;
const now = new Date();

/** Local date (offset in days from today) + local time in a zone -> UTC Date. */
function at(zone: string, dayOffset: number, time: string) {
  const [hour, minute] = time.split(':').map(Number);
  return DateTime.now()
    .setZone(zone)
    .startOf('day')
    .plus({days: dayOffset})
    .set({hour, minute})
    .toUTC()
    .toJSDate();
}
const localWeekday = (zone: string, dayOffset: number) =>
  DateTime.now().setZone(zone).startOf('day').plus({days: dayOffset}).weekday % 7;
const localDate = (zone: string, dayOffset: number) =>
  DateTime.now().setZone(zone).startOf('day').plus({days: dayOffset}).toISODate()!;

// ------------------------------------------------------------------------------------------------
// Builders
// ------------------------------------------------------------------------------------------------

type Coach = {user: UserDoc; seed: SeedCoach; types: Map<string, SessionTypeDoc>};

async function createUser(
  data: {
    email: string;
    firstName: string;
    lastName: string;
    avatar: number;
    homeArea: SeedClient['homeArea'];
  },
  role: 'coach' | 'client',
  passwordHash: string,
) {
  return UserModel.create({
    email: data.email,
    emailKey: emailKey(data.email),
    passwordHash,
    role,
    firstName: data.firstName,
    lastName: data.lastName,
    avatarUrl: avatarUrl(data.avatar),
    homeArea: data.homeArea,
    authProviders: [{provider: 'password'}],
    emailVerifiedAt: now,
    onboardingCompleted: true,
    settings: {theme: 'system'},
  });
}

async function createCoach(seed: SeedCoach, passwordHash: string): Promise<Coach> {
  const user = await createUser(seed, 'coach', passwordHash);
  await CoachProfileModel.create({
    userId: user._id,
    headline: seed.headline,
    bio: seed.bio,
    specializations: seed.specializations,
    experienceYears: seed.experienceYears,
    certifications: seed.certifications,
    highlights: seed.highlights,
    languages: seed.languages,
    defaultLocation: seed.defaultLocation,
    cancellationPolicy: {freeCancelHours: seed.freeCancelHours},
    rating: seed.rating,
    isPublished: true,
    city: seed.homeArea.city,
    state: seed.homeArea.state,
  });
  const zone = seed.homeArea.timezone;
  // One whole day off and one shortened day in the coming weeks (not for the demo coach's busy days).
  const exceptions =
    seed.email === 'coach@fitbook.dev'
      ? [{date: localDate(zone, 8), start: '16:00', end: '20:00', reason: 'Physio appointment'}]
      : [
          {date: localDate(zone, 9 + Math.floor(random() * 5)), reason: 'Vacation'},
          {
            date: localDate(zone, 3 + Math.floor(random() * 3)),
            start: '07:00',
            end: '09:00',
            reason: 'Workshop',
          },
        ];
  await AvailabilityModel.create({coachId: user._id, weekly: seed.weekly, exceptions});
  const types = new Map<string, SessionTypeDoc>();
  for (const t of seed.types) {
    types.set(
      t.key,
      await SessionTypeModel.create({
        coachId: user._id,
        title: t.title,
        kind: t.kind,
        durationMin: t.durationMin,
        price: {amountCents: t.priceCents, currency: 'USD'},
        capacity: t.kind === 'individual' ? 1 : t.capacity,
        location: t.location ?? null,
        description: t.description,
        isActive: true,
      }),
    );
  }
  await refreshCoachCatalogFields(user._id);
  return {user, seed, types};
}

async function createSession(
  coach: Coach,
  type: SessionTypeDoc,
  startAt: Date,
): Promise<TrainingSessionDoc | null> {
  const endAt = addMinutes(startAt, type.durationMin);
  try {
    return await createLockedSession({
      coachId: coach.user._id,
      sessionTypeId: type._id,
      kind: type.kind,
      title: type.title,
      startAt,
      endAt,
      capacity: type.capacity,
      participantsCount: 0,
      price: type.price,
      location: type.location ?? coach.seed.defaultLocation,
      status: endAt <= now ? 'completed' : 'scheduled',
    });
  } catch {
    return null; // Time already taken: skip.
  }
}

type BookingStatus = 'pending_payment' | 'confirmed' | 'cancelled' | 'completed';

async function addBooking(
  session: TrainingSessionDoc,
  client: UserDoc,
  options: {
    status?: BookingStatus;
    isTrial?: boolean;
    seriesId?: Types.ObjectId;
    cancelledBy?: 'client' | 'coach';
    cancelReason?: string;
    expiresAt?: Date;
  } = {},
) {
  const status: BookingStatus =
    options.status ?? (session.endAt <= now ? 'completed' : 'confirmed');
  const active = status !== 'cancelled';
  if (session.kind === 'group' && active) {
    const taken = await SeatLockModel.countDocuments({sessionId: session._id});
    if (taken >= session.capacity) return null;
    try {
      await SeatLockModel.create({sessionId: session._id, seat: taken + 1, clientId: client._id});
    } catch (error) {
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
  }
  const price = options.isTrial ? {amountCents: 0, currency: 'USD' as const} : session.price;
  type Payment = {status: 'unpaid' | 'paid' | 'not_required'; method: 'mock'; paidAt?: Date};
  const payment: Payment =
    options.isTrial || price.amountCents === 0
      ? {status: 'not_required', method: 'mock'}
      : status === 'pending_payment'
        ? {status: 'unpaid', method: 'mock'}
        : {
            status: 'paid',
            method: 'mock',
            paidAt: addMinutes(session.startAt, -60 * 24 * (2 + Math.floor(random() * 10))),
          };
  const booking = await BookingModel.create({
    sessionId: session._id,
    coachId: session.coachId,
    clientId: client._id,
    seriesId: options.seriesId ?? null,
    status,
    isTrial: options.isTrial ?? false,
    price,
    payment,
    expiresAt: status === 'pending_payment' ? options.expiresAt : null,
    startAt: session.startAt,
    endAt: session.endAt,
    ...(active && {activeKey: `${session._id}:${client._id}`}),
    ...(status === 'cancelled' && {
      cancelledAt: addMinutes(session.startAt, -60 * 30),
      cancelledBy: options.cancelledBy ?? 'client',
      cancelReason: options.cancelReason,
    }),
  });
  if (session.kind === 'group') {
    session.participantsCount = await SeatLockModel.countDocuments({sessionId: session._id});
    await session.save();
  } else if (!active) {
    session.status = 'cancelled';
    await session.save();
    await mongoose.model('SlotLock').deleteMany({sessionId: session._id});
  }
  return booking;
}

async function addNote(
  booking: {_id: Types.ObjectId; coachId: Types.ObjectId; clientId: Types.ObjectId; startAt: Date},
  phase: 'before' | 'after',
  role: 'coach' | 'client',
  text: string,
) {
  const authorId = role === 'coach' ? booking.coachId : booking.clientId;
  const createdAt =
    phase === 'before' ? addMinutes(booking.startAt, -60 * 20) : addMinutes(booking.startAt, 120);
  await NoteModel.create({
    bookingId: booking._id,
    coachId: booking.coachId,
    clientId: booking.clientId,
    phase,
    text,
    authorId,
    authorRole: role,
    lastEditedById: authorId,
    lastEditedByRole: role,
    createdAt: createdAt < now ? createdAt : now,
    updatedAt: createdAt < now ? createdAt : now,
  });
}

async function claimTrial(client: UserDoc, bookingId: Types.ObjectId) {
  await TrialClaimModel.create({emailKey: client.emailKey, userId: client._id, bookingId});
  client.trialUsed = true;
  await client.save();
}

async function conversation(
  coach: UserDoc,
  client: UserDoc,
  script: string[],
  daysAgo: number,
  unreadFor?: 'coach' | 'client',
) {
  const convo = await ConversationModel.create({coachId: coach._id, clientId: client._id});
  let time = addMinutes(now, -daysAgo * 1440);
  let last: {text: string; senderId: Types.ObjectId; createdAt: Date} | null = null;
  const lastIndex = script.length - 1;
  for (const [index, line] of script.entries()) {
    const fromCoach = line.startsWith('k:');
    const text = line.slice(2);
    time = addMinutes(time, 7 + Math.floor(random() * 90));
    const isUnread = unreadFor && index === lastIndex && (unreadFor === 'client') === fromCoach;
    await MessageModel.create({
      conversationId: convo._id,
      senderId: fromCoach ? coach._id : client._id,
      senderRole: fromCoach ? 'coach' : 'client',
      text,
      createdAt: time,
      readAt: isUnread ? null : addMinutes(time, 5),
    });
    last = {text, senderId: fromCoach ? coach._id : client._id, createdAt: time};
  }
  convo.lastMessage = last;
  convo.lastActivityAt = last!.createdAt;
  convo.unread = {coach: unreadFor === 'coach' ? 1 : 0, client: unreadFor === 'client' ? 1 : 0};
  await convo.save();
}

// ------------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------------

async function main() {
  const reset = process.argv.includes('--reset');
  await connectDb(mongoUri);
  const db = mongoose.connection.db!;

  if (reset) {
    await db.dropDatabase();
  } else if ((await UserModel.estimatedDocumentCount()) > 0) {
    console.log('The database already has data. Run `npm run seed:reset` to drop and recreate it.');
    await disconnectDb();
    return;
  }
  await Promise.all(
    Object.values(models)
      .filter(m => typeof m === 'function' && 'syncIndexes' in m)
      .map(m => (m as unknown as {syncIndexes: () => Promise<unknown>}).syncIndexes()),
  );

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // Users
  const coaches: Coach[] = [];
  for (const seed of COACHES) coaches.push(await createCoach(seed, passwordHash));
  const byEmail = new Map(coaches.map(c => [c.seed.email, c]));
  const alex = byEmail.get('coach@fitbook.dev')!;
  const maya = byEmail.get('maya.patel@fitbook.dev')!;
  const marcus = byEmail.get('marcus.reed@fitbook.dev')!;
  const sofia = byEmail.get('sofia.alvarez@fitbook.dev')!;

  const newCoach = await createUser(INCOMPLETE_COACH, 'coach', passwordHash);
  await ensureCoachSetup(newCoach);
  await CoachProfileModel.updateOne(
    {userId: newCoach._id},
    {headline: 'Personal trainer (profile in progress)'},
  );

  const jamie = await createUser(DEMO_CLIENT, 'client', passwordHash);
  jamie.settings = {theme: 'dark'};
  await jamie.save();
  await createUser(NEW_CLIENT, 'client', passwordHash);
  const clients: UserDoc[] = [];
  for (const seed of CLIENTS) clients.push(await createUser(seed, 'client', passwordHash));
  const clientsIn = (state: string) => clients.filter(c => c.homeArea?.state === state);

  // --- Demo client Jamie: trial, series, pending, cancelled, group classes -----------------------
  const chicago = 'America/Chicago';
  const trialDay = -35 + ((1 - localWeekday(chicago, -35) + 7) % 7); // a Monday ~5 weeks ago
  const trialSession = await createSession(
    maya,
    maya.types.get('maya-private')!,
    at(chicago, trialDay, '08:00'),
  );
  const trialBooking = await addBooking(trialSession!, jamie, {isTrial: true});
  await claimTrial(jamie, trialBooking!._id);
  await addNote(
    trialBooking!,
    'before',
    'client',
    'First time doing yoga in years - my hamstrings are very tight.',
  );
  await addNote(
    trialBooking!,
    'after',
    'coach',
    'Lovely first class, Jamie! Practice the hamstring flow from today 3x a week.',
  );

  const seriesStart = -14 + ((2 - localWeekday(chicago, -14) + 7) % 7); // Tuesday two weeks ago
  const series = await BookingSeriesModel.create({
    clientId: jamie._id,
    coachId: alex.user._id,
    sessionTypeId: alex.types.get('alex-1on1')!._id,
    weekdays: [2, 4],
    time: '07:00',
    weeks: 6,
    startDate: localDate(chicago, seriesStart),
  });
  const seriesBookings: NonNullable<Awaited<ReturnType<typeof addBooking>>>[] = [];
  for (let d = seriesStart; d < seriesStart + 42; d += 1) {
    if (![2, 4].includes(localWeekday(chicago, d))) continue;
    const session = await createSession(
      alex,
      alex.types.get('alex-1on1')!,
      at(chicago, d, '07:00'),
    );
    if (!session) {
      series.skippedDates.push(localDate(chicago, d));
      continue;
    }
    const booking = await addBooking(session, jamie, {seriesId: series._id});
    if (booking) seriesBookings.push(booking);
  }
  series.bookingIds = seriesBookings.map(b => b._id);
  await series.save();
  const pastSeries = seriesBookings.filter(b => b.endAt <= now);
  for (const [i, booking] of pastSeries.entries()) {
    await addNote(
      booking,
      'before',
      'client',
      NOTE_TEXTS.clientBefore[i % NOTE_TEXTS.clientBefore.length]!,
    );
    await addNote(
      booking,
      'after',
      'coach',
      NOTE_TEXTS.coachAfter[i % NOTE_TEXTS.coachAfter.length]!,
    );
  }
  const nextSeries = seriesBookings.find(b => b.startAt > now);
  if (nextSeries)
    await addNote(nextSeries, 'before', 'client', 'Can we focus on deadlift technique this time?');

  const pendingSession = await createSession(
    marcus,
    marcus.types.get('marcus-1on1')!,
    at(chicago, 4, '16:00'),
  );
  if (pendingSession) {
    await addBooking(pendingSession, jamie, {
      status: 'pending_payment',
      expiresAt: addMinutes(now, 120),
    });
  }
  const cancelledSession = await createSession(
    sofia,
    sofia.types.get('sofia-1on1')!,
    at(chicago, 6, '06:00'),
  );
  if (cancelledSession) {
    await addBooking(cancelledSession, jamie, {
      status: 'cancelled',
      cancelledBy: 'client',
      cancelReason: 'Out of town',
    });
  }

  // --- Group sessions for every coach: last 4 weeks and next 2 weeks ------------------------------
  const groupSessions: TrainingSessionDoc[] = [];
  for (const coach of coaches) {
    const zone = coach.seed.homeArea.timezone;
    for (const t of coach.seed.types.filter(x => x.kind === 'group')) {
      const type = coach.types.get(t.key)!;
      for (let d = -28; d <= 14; d += 1) {
        for (const slot of (t.schedule ?? []).filter(s => s.weekday === localWeekday(zone, d))) {
          const session = await createSession(coach, type, at(zone, d, slot.time));
          if (session) groupSessions.push(session);
        }
      }
    }
  }
  // Jamie joins two upcoming classes; Maya's next beach yoga is fully booked.
  const upcomingGroups = groupSessions
    .filter(s => s.startAt > now)
    .sort((a, b) => +a.startAt - +b.startAt);
  const nextCircuit = upcomingGroups.find(s => s.coachId.equals(alex.user._id));
  const nextBeach = upcomingGroups.find(
    s => s.coachId.equals(maya.user._id) && s.title === 'Sunrise Beach Yoga',
  );
  if (nextCircuit) await addBooking(nextCircuit, jamie);
  if (nextBeach) await addBooking(nextBeach, jamie);

  for (const session of groupSessions) {
    const coach = coaches.find(c => c.user._id.equals(session.coachId))!;
    const pool = shuffle(clientsIn(coach.seed.homeArea.state));
    const isFull = nextBeach && session._id.equals(nextBeach._id);
    const fill = isFull ? 1 : session.endAt <= now ? 0.45 + random() * 0.5 : 0.2 + random() * 0.55;
    const target = Math.min(pool.length, Math.round(session.capacity * fill));
    for (const client of pool.slice(0, isFull ? pool.length : target)) {
      if (session.participantsCount >= session.capacity) break;
      await addBooking(session, client);
    }
  }

  // --- Individual bookings: last 6 weeks and next 3 weeks -----------------------------------------
  const individualBookings: NonNullable<Awaited<ReturnType<typeof addBooking>>>[] = [];
  for (const coach of coaches) {
    const zone = coach.seed.homeArea.timezone;
    const pool = clientsIn(coach.seed.homeArea.state);
    if (!pool.length) continue;
    const types = coach.seed.types
      .filter(t => t.kind === 'individual')
      .map(t => coach.types.get(t.key)!);
    for (let d = -42; d <= 21; d += 1) {
      const windows = coach.seed.weekly.filter(w => w.weekday === localWeekday(zone, d));
      if (!windows.length) continue;
      const bookingsToday = chance(d < 0 ? 0.55 : 0.4) ? 1 + (chance(0.35) ? 1 : 0) : 0;
      for (let i = 0; i < bookingsToday; i += 1) {
        const window = pick(windows);
        const type = pick(types);
        const [sh = 0] = window.start.split(':').map(Number);
        const [eh = 0] = window.end.split(':').map(Number);
        const lastStart = eh - Math.ceil(type.durationMin / 60);
        if (lastStart < sh) continue;
        const hour = sh + Math.floor(random() * (lastStart - sh + 1));
        const startAt = at(zone, d, `${String(hour).padStart(2, '0')}:00`);
        if (startAt > now && startAt < addMinutes(now, 180)) continue;
        const session = await createSession(coach, type, startAt);
        if (!session) continue;
        const cancelled = startAt > now && chance(0.06);
        const booking = await addBooking(
          session,
          pick(pool),
          cancelled ? {status: 'cancelled'} : {},
        );
        if (booking) individualBookings.push(booking);
      }
    }
  }

  // Free trials for some clients: their first past individual booking becomes the trial.
  for (const client of clients) {
    const first = individualBookings
      .filter(b => b.clientId.equals(client._id) && b.endAt <= now && b.status === 'completed')
      .sort((a, b) => +a.startAt - +b.startAt)[0];
    if (first && chance(0.65)) {
      first.isTrial = true;
      first.price = {amountCents: 0, currency: 'USD'};
      first.payment = {status: 'not_required', method: 'mock'};
      await first.save();
      await claimTrial(client, first._id);
    }
  }

  // Notes on past individual trainings.
  for (const booking of individualBookings.filter(b => b.status === 'completed')) {
    if (chance(0.35)) await addNote(booking, 'before', 'client', pick(NOTE_TEXTS.clientBefore));
    if (chance(0.15)) await addNote(booking, 'before', 'coach', pick(NOTE_TEXTS.coachBefore));
    if (chance(0.55)) await addNote(booking, 'after', 'coach', pick(NOTE_TEXTS.coachAfter));
    if (chance(0.25)) await addNote(booking, 'after', 'client', pick(NOTE_TEXTS.clientAfter));
  }

  // --- Chats --------------------------------------------------------------------------------------
  await conversation(
    alex.user,
    jamie,
    [...CHAT_SCRIPTS[0]!, ...CHAT_SCRIPTS[1]!, ...CHAT_SCRIPTS[2]!],
    13,
    'client',
  );
  await conversation(maya.user, jamie, CHAT_SCRIPTS[1]!, 30);
  await conversation(sofia.user, jamie, CHAT_SCRIPTS[3]!, 4, 'client');
  const chicagoClients = clientsIn('IL');
  await conversation(alex.user, chicagoClients[0]!, CHAT_SCRIPTS[3]!, 2, 'coach');
  await conversation(alex.user, chicagoClients[1]!, CHAT_SCRIPTS[2]!, 6);
  await conversation(alex.user, chicagoClients[2]!, CHAT_SCRIPTS[0]!, 9, 'coach');
  await conversation(marcus.user, chicagoClients[3]!, CHAT_SCRIPTS[0]!, 3);
  await conversation(maya.user, chicagoClients[4]!, CHAT_SCRIPTS[2]!, 1, 'coach');

  // --- Summary ------------------------------------------------------------------------------------
  const counts: Record<string, number> = {};
  for (const name of [
    'users',
    'coachprofiles',
    'sessiontypes',
    'availabilities',
    'trainingsessions',
    'bookings',
    'bookingseries',
    'notes',
    'conversations',
    'messages',
    'slotlocks',
    'seatlocks',
    'trialclaims',
  ]) {
    counts[name] = await db.collection(name).countDocuments();
  }
  const byStatus = await BookingModel.aggregate<{_id: string; n: number}>([
    {$group: {_id: '$status', n: {$sum: 1}}},
  ]);
  console.log(`\nSeeded ${mongoUri}`);
  console.table(counts);
  console.log('Bookings by status:', Object.fromEntries(byStatus.map(s => [s._id, s.n])));
  console.log(`
Demo accounts (password: ${DEMO_PASSWORD})
  coach@fitbook.dev      Alex Carter - coach, Chicago, full schedule and clients
  client@fitbook.dev     Jamie Lee - client, Chicago, trial used, series, notes, chats
  newclient@fitbook.dev  Riley Chen - client, Chicago, free trial still available
  newcoach@fitbook.dev   Taylor Morgan - coach with an incomplete, unpublished profile
`);
  await disconnectDb();
}

main().catch(async error => {
  console.error(error);
  await disconnectDb();
  process.exit(1);
});
