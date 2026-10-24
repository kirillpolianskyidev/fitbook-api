import {DateTime} from 'luxon';
import type {Types} from 'mongoose';
import type {z} from 'zod';

import {env} from '../../config/env.js';
import {toLocationDto, toMoneyDto} from '../../lib/dto.js';
import {AppError, isDuplicateKeyError} from '../../lib/errors.js';
import type {Location} from '../../lib/schemas.js';
import {BOOKING_LEAD_MINUTES, isWholeDayOff} from '../../lib/slots.js';
import {addMinutes, isOnSlotGrid, zonedDateTime} from '../../lib/time.js';
import {AvailabilityModel} from '../../models/availability.js';
import {BookingModel, type BookingDoc} from '../../models/booking.js';
import {BookingSeriesModel, type BookingSeriesDoc} from '../../models/bookingSeries.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {NoteModel} from '../../models/note.js';
import {SeatLockModel} from '../../models/seatLock.js';
import {SessionTypeModel} from '../../models/sessionType.js';
import {TrainingSessionModel, type TrainingSessionDoc} from '../../models/trainingSession.js';
import {TrialClaimModel} from '../../models/trialClaim.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {
  coachTimezone,
  createLockedSession,
  findSlots,
  isFreeSlot,
  moveLockedSession,
  syncSeatCounts,
  unlockSession,
} from '../sessions/sessions.service.js';
import {
  claimOfferedSeat,
  markBooked,
  processWaitlist,
  restoreOfferedSeat,
} from '../waitlist/waitlist.service.js';
import {creditsAvailable, returnCredit, takeCredit} from '../packages/packages.service.js';
import {noShowFields} from './noShow.js';
import {toUserSummary} from '../users/users.service.js';
import type {
  BookingDto,
  BookingListQuery,
  SeriesBody,
  SeriesPreviewBody,
} from './bookings.schemas.js';

const ACTIVE = ['pending_payment', 'confirmed'] as const;
type Status = 'pending_payment' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
type CancelledBy = 'coach' | 'client' | 'system';

const activeKey = (sessionId: Types.ObjectId, clientId: Types.ObjectId) =>
  `${sessionId}:${clientId}`;

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

/** Builds booking DTOs for a list, loading related sessions, users, policies and note counts in batches. */
export async function toBookingDtos(
  bookings: BookingDoc[],
  viewerId?: Types.ObjectId,
): Promise<BookingDto[]> {
  if (bookings.length === 0) return [];
  const sessionIds = [...new Set(bookings.map(b => b.sessionId.toString()))];
  const userIds = [
    ...new Set(bookings.flatMap(b => [b.coachId.toString(), b.clientId.toString()])),
  ];
  const coachIds = [...new Set(bookings.map(b => b.coachId.toString()))];
  const [sessions, users, profiles, noteCounts] = await Promise.all([
    TrainingSessionModel.find({_id: {$in: sessionIds}}),
    UserModel.find({_id: {$in: userIds}})
      .select('firstName lastName avatarUrl')
      .lean(),
    CoachProfileModel.find({userId: {$in: coachIds}})
      .select('userId cancellationPolicy online')
      .lean(),
    NoteModel.aggregate<{_id: Types.ObjectId; n: number}>([
      {$match: {bookingId: {$in: bookings.map(b => b._id)}}},
      {$group: {_id: '$bookingId', n: {$sum: 1}}},
    ]),
  ]);
  const sessionById = new Map(sessions.map(s => [s.id as string, s]));
  const userById = new Map(users.map(u => [u._id.toString(), u]));
  const hoursByCoach = new Map(
    profiles.map(p => [p.userId.toString(), p.cancellationPolicy?.freeCancelHours ?? 24]),
  );
  const meetingUrlByCoach = new Map(
    profiles.map(p => [p.userId.toString(), p.online?.meetingUrl ?? null]),
  );
  const notesById = new Map(noteCounts.map(n => [n._id.toString(), n.n]));
  const now = Date.now();

  return bookings.map(booking => {
    const session = sessionById.get(booking.sessionId.toString());
    const coach = userById.get(booking.coachId.toString());
    const client = userById.get(booking.clientId.toString());
    const freeCancelHours = hoursByCoach.get(booking.coachId.toString()) ?? 24;
    const deadline = addMinutes(booking.startAt, -freeCancelHours * 60);
    const status = booking.status as Status;
    const format = (session?.format ?? 'in_person') as 'in_person' | 'online';
    const isActive = status === 'pending_payment' || status === 'confirmed';
    const cancellable =
      isActive &&
      booking.startAt.getTime() > now &&
      (status === 'pending_payment' || now <= deadline.getTime());
    // Same window as cancelling, and only for the client of the booking.
    const reschedulable = cancellable && (!viewerId || booking.clientId.equals(viewerId));
    return {
      id: booking.id as string,
      status,
      isTrial: booking.isTrial,
      price: toMoneyDto(booking.price),
      payment: {
        status: booking.payment.status as 'unpaid' | 'paid' | 'refunded' | 'not_required',
        method: (booking.payment.method ?? 'mock') as 'mock' | 'credits',
        paidAt: booking.payment.paidAt?.toISOString() ?? null,
        clientPackageId: booking.payment.clientPackageId?.toString() ?? null,
        refundedAt: booking.payment.refundedAt?.toISOString() ?? null,
      },
      expiresAt: status === 'pending_payment' ? (booking.expiresAt?.toISOString() ?? null) : null,
      startAt: booking.startAt.toISOString(),
      endAt: booking.endAt.toISOString(),
      seriesId: booking.seriesId?.toString() ?? null,
      format,
      // Only participants receive Booking objects; the link is read from the coach profile at request time.
      meetingUrl:
        format === 'online' ? (meetingUrlByCoach.get(booking.coachId.toString()) ?? null) : null,
      cancellable,
      reschedulable,
      rescheduledAt: booking.rescheduledAt?.toISOString() ?? null,
      ...noShowFields(booking, viewerId),
      cancelDeadline: isActive ? deadline.toISOString() : null,
      cancelledAt: booking.cancelledAt?.toISOString() ?? null,
      cancelledBy: (booking.cancelledBy as CancelledBy | undefined) ?? null,
      cancelReason: booking.cancelReason ?? null,
      session: {
        id: booking.sessionId.toString(),
        sessionTypeId: session?.sessionTypeId.toString() ?? '',
        title: session?.title ?? '',
        kind: (session?.kind as 'individual' | 'group') ?? 'individual',
        format,
        location: toLocationDto(session?.location),
        capacity: session?.capacity ?? 1,
        participantsCount: session?.participantsCount ?? 0,
      },
      coach: coach
        ? toUserSummary(coach)
        : {id: booking.coachId.toString(), firstName: '', lastName: '', avatarUrl: null},
      client: client
        ? toUserSummary(client)
        : {id: booking.clientId.toString(), firstName: '', lastName: '', avatarUrl: null},
      notesCount: notesById.get(booking.id as string) ?? 0,
      createdAt: (booking.get('createdAt') as Date).toISOString(),
    };
  });
}

export async function toBookingDto(booking: BookingDoc, viewerId?: Types.ObjectId) {
  const [dto] = await toBookingDtos([booking], viewerId);
  return dto!;
}

// ---------------------------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------------------------

export async function getBookingForParticipant(user: UserDoc, bookingId: string) {
  const booking = await BookingModel.findById(bookingId);
  if (!booking) {
    throw new AppError('NOT_FOUND', 'Booking not found.');
  }
  if (!booking.clientId.equals(user._id) && !booking.coachId.equals(user._id)) {
    throw new AppError('FORBIDDEN');
  }
  return booking;
}

async function assertPublishedCoach(coachId: Types.ObjectId) {
  if (!(await CoachProfileModel.exists({userId: coachId, isPublished: true}))) {
    throw new AppError('NOT_FOUND', 'Coach not found.');
  }
}

/** A booking paid with a credit: confirmed immediately. */
function creditPayment(clientPackageId: Types.ObjectId) {
  return {
    status: 'confirmed' as const,
    payment: {
      status: 'paid' as const,
      method: 'credits' as const,
      paidAt: new Date(),
      clientPackageId,
    },
    expiresAt: null,
  };
}

function initialPayment(priceCents: number, isTrial: boolean) {
  if (isTrial || priceCents === 0) {
    return {
      status: 'confirmed' as const,
      payment: {status: 'not_required' as const, method: 'mock' as const},
      expiresAt: null,
    };
  }
  return {
    status: 'pending_payment' as const,
    payment: {status: 'unpaid' as const, method: 'mock' as const},
    expiresAt: addMinutes(new Date(), env.PENDING_PAYMENT_TTL_MIN),
  };
}

// ---------------------------------------------------------------------------------------------
// Individual bookings (incl. free trial)
// ---------------------------------------------------------------------------------------------

type IndividualInput = {
  sessionTypeId: string;
  startAt: string;
  isTrial: boolean;
  useCredits?: boolean;
  format?: 'in_person' | 'online';
  location?: Location;
};

/** The format of a new individual booking: required for "both" types, must match the others. */
export function bookingFormat(
  typeFormat: string | null | undefined,
  requested?: 'in_person' | 'online',
): 'in_person' | 'online' {
  const format = (typeFormat ?? 'in_person') as 'in_person' | 'online' | 'both';
  if (format === 'both') {
    if (!requested) {
      throw new AppError('VALIDATION_ERROR', undefined, {
        fields: {format: 'Choose in_person or online for this training type'},
      });
    }
    return requested;
  }
  if (requested && requested !== format) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {format: `This training type is ${format} only`},
    });
  }
  return format;
}

export async function createIndividualBooking(
  client: UserDoc,
  input: IndividualInput,
  options: {seriesId?: Types.ObjectId} = {},
) {
  const type = await SessionTypeModel.findById(input.sessionTypeId);
  if (!type) {
    throw new AppError('NOT_FOUND', 'Training type not found.');
  }
  if (!type.isActive) {
    throw new AppError('SESSION_TYPE_INACTIVE');
  }
  if (type.kind !== 'individual') {
    throw new AppError(input.isTrial ? 'TRIAL_NOT_ALLOWED' : 'VALIDATION_ERROR', undefined, {
      fields: {sessionTypeId: 'Group trainings are joined with sessionId'},
    });
  }
  await assertPublishedCoach(type.coachId);
  const format = bookingFormat(type.format, input.format);

  const startAt = new Date(input.startAt);
  if (!isOnSlotGrid(startAt) || !(await isFreeSlot(type.coachId, type.durationMin, startAt))) {
    throw new AppError('SLOT_UNAVAILABLE');
  }

  // A credit is taken before the time is locked and given back if anything below fails.
  const credit = input.useCredits ? await takeCredit(client._id, type.coachId) : null;

  // Claim the trial first: the unique index on emailKey makes it race-safe across accounts.
  if (input.isTrial) {
    if (client.trialUsed) {
      throw new AppError('TRIAL_ALREADY_USED');
    }
    try {
      await TrialClaimModel.create({emailKey: client.emailKey, userId: client._id});
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AppError('TRIAL_ALREADY_USED');
      throw error;
    }
  }

  const profile = await CoachProfileModel.findOne({userId: type.coachId}).lean();
  const price = input.isTrial
    ? {amountCents: 0, currency: 'USD' as const}
    : {amountCents: type.price.amountCents, currency: 'USD' as const};
  let session: TrainingSessionDoc;
  try {
    session = await createLockedSession({
      coachId: type.coachId,
      sessionTypeId: type._id,
      kind: 'individual',
      format,
      title: type.title,
      startAt,
      endAt: addMinutes(startAt, type.durationMin),
      capacity: 1,
      participantsCount: 1,
      price,
      // Online bookings have no place (a location in the request is ignored).
      location:
        format === 'online'
          ? null
          : (input.location ?? type.location ?? profile?.defaultLocation ?? null),
    });
  } catch (error) {
    if (input.isTrial)
      await TrialClaimModel.deleteOne({emailKey: client.emailKey, bookingId: null});
    if (credit) await returnCredit(credit._id);
    throw error;
  }

  const booking = await BookingModel.create({
    sessionId: session._id,
    coachId: type.coachId,
    clientId: client._id,
    seriesId: options.seriesId ?? null,
    isTrial: input.isTrial,
    price,
    startAt: session.startAt,
    endAt: session.endAt,
    activeKey: activeKey(session._id, client._id),
    ...(credit ? creditPayment(credit._id) : initialPayment(price.amountCents, input.isTrial)),
  });

  if (input.isTrial) {
    await TrialClaimModel.updateOne({emailKey: client.emailKey}, {bookingId: booking._id});
    client.trialUsed = true;
    await client.save();
  }
  return booking;
}

// ---------------------------------------------------------------------------------------------
// Group sessions
// ---------------------------------------------------------------------------------------------

export async function joinGroupSession(
  client: UserDoc,
  sessionId: string,
  isTrial?: boolean,
  useCredits = false,
) {
  if (isTrial) {
    throw new AppError('TRIAL_NOT_ALLOWED');
  }
  const session = await TrainingSessionModel.findOne({
    _id: sessionId,
    kind: 'group',
    status: 'scheduled',
    startAt: {$gt: new Date()},
  });
  if (!session) {
    throw new AppError('NOT_FOUND', 'Group session not found.');
  }
  await assertPublishedCoach(session.coachId);
  if (await BookingModel.exists({activeKey: activeKey(session._id, client._id)})) {
    throw new AppError('ALREADY_BOOKED');
  }
  // Expired offers pass on first; a client with a waitlist offer books the place held for them.
  await processWaitlist(session._id);
  const claimed = await claimOfferedSeat(session._id, client._id);
  const seat = claimed ?? (await takeSeat(session._id, client._id, session.capacity));
  let credit: Awaited<ReturnType<typeof takeCredit>> | null = null;
  try {
    credit = useCredits ? await takeCredit(client._id, session.coachId) : null;
    const booking = await BookingModel.create({
      sessionId: session._id,
      coachId: session.coachId,
      clientId: client._id,
      isTrial: false,
      price: session.price,
      startAt: session.startAt,
      endAt: session.endAt,
      activeKey: activeKey(session._id, client._id),
      ...(credit ? creditPayment(credit._id) : initialPayment(session.price.amountCents, false)),
    });
    await markBooked(session._id, client._id);
    await syncParticipants(session._id);
    return booking;
  } catch (error) {
    if (claimed) await restoreOfferedSeat(session._id, client._id);
    else await SeatLockModel.deleteOne({_id: seat._id});
    if (credit) await returnCredit(credit._id);
    if (isDuplicateKeyError(error)) throw new AppError('ALREADY_BOOKED');
    throw error;
  }
}

/** Takes the first free seat; unique indexes make this race-safe. */
async function takeSeat(sessionId: Types.ObjectId, clientId: Types.ObjectId, capacity: number) {
  for (let seat = 1; seat <= capacity; seat += 1) {
    try {
      return await SeatLockModel.create({sessionId, seat, clientId});
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      if (await SeatLockModel.exists({sessionId, clientId})) throw new AppError('ALREADY_BOOKED');
    }
  }
  throw new AppError('SESSION_FULL');
}

/** participantsCount / heldCount mirror the taken seats (for display). */
export const syncParticipants = (sessionId: Types.ObjectId) => syncSeatCounts(sessionId);

// ---------------------------------------------------------------------------------------------
// Recurring series (individual)
// ---------------------------------------------------------------------------------------------

export type PreviewItem = {
  date: string;
  startAt: string;
  endAt: string;
  available: boolean;
  reason?: 'UNAVAILABLE' | 'PAST' | 'EXCEPTION';
};

export async function seriesType(sessionTypeId: string) {
  const type = await SessionTypeModel.findById(sessionTypeId);
  if (!type) throw new AppError('NOT_FOUND', 'Training type not found.');
  if (!type.isActive) throw new AppError('SESSION_TYPE_INACTIVE');
  if (type.kind !== 'individual') {
    throw new AppError('VALIDATION_ERROR', 'Series are available for individual trainings.', {
      fields: {sessionTypeId: 'Must be an individual training type'},
    });
  }
  await assertPublishedCoach(type.coachId);
  return type;
}

export async function previewSeries(
  input: z.infer<typeof SeriesPreviewBody>,
): Promise<PreviewItem[]> {
  const type = await seriesType(input.sessionTypeId);
  bookingFormat(type.format, input.format);
  const timezone = await coachTimezone(type.coachId);
  const first = DateTime.fromISO(input.startDate, {zone: timezone}).startOf('day');
  const end = first.plus({weeks: input.weeks});
  const [slots, availability] = await Promise.all([
    findSlots(type.coachId, type.durationMin, first.toJSDate(), end.toJSDate()),
    AvailabilityModel.findOne({coachId: type.coachId}).lean(),
  ]);
  const free = new Set(slots.map(s => s.startAt.getTime()));
  const exceptions = availability?.exceptions ?? [];
  const notBefore = addMinutes(new Date(), BOOKING_LEAD_MINUTES);

  const items: PreviewItem[] = [];
  for (let day = first; day < end; day = day.plus({days: 1})) {
    if (!input.weekdays.includes(day.weekday % 7)) continue;
    const date = day.toISODate()!;
    const startAt = zonedDateTime(date, input.time, timezone);
    const endAt = addMinutes(startAt, type.durationMin);
    let reason: PreviewItem['reason'];
    if (startAt < notBefore) reason = 'PAST';
    else if (!free.has(startAt.getTime())) {
      reason =
        isWholeDayOff(date, exceptions) || exceptions.some(e => e.date === date)
          ? 'EXCEPTION'
          : 'UNAVAILABLE';
    }
    items.push({
      date,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      available: !reason,
      ...(reason && {reason}),
    });
  }
  return items;
}

export async function createSeries(client: UserDoc, input: z.infer<typeof SeriesBody>) {
  const type = await seriesType(input.sessionTypeId);
  const format = bookingFormat(type.format, input.format);
  const preview = await previewSeries(input);
  assertDatesInPreview(input.dates, preview);
  const series = await BookingSeriesModel.create({
    clientId: client._id,
    coachId: type.coachId,
    sessionTypeId: type._id,
    weekdays: input.weekdays,
    time: input.time,
    weeks: input.weeks,
    startDate: input.startDate,
    format,
  });
  try {
    const result = await bookSeriesDates(client, series, preview, {...input, format});
    return {seriesId: series.id as string, ...result};
  } catch (error) {
    await series.deleteOne();
    throw error;
  }
}

export function assertDatesInPreview(dates: string[], preview: PreviewItem[]) {
  const known = new Set(preview.map(item => item.date));
  const unknown = dates.filter(date => !known.has(date));
  if (unknown.length) {
    throw new AppError('VALIDATION_ERROR', 'Some dates are not part of this series.', {
      fields: {dates: `Not in the series: ${unknown.join(', ')}`},
    });
  }
}

/**
 * Books the chosen dates of a preview into a series (new or extended). Taken dates are skipped. With credits,
 * all dates are paid with credits or nothing is booked (INSUFFICIENT_CREDITS).
 */
export async function bookSeriesDates(
  client: UserDoc,
  series: BookingSeriesDoc,
  preview: PreviewItem[],
  input: {
    sessionTypeId: string;
    dates: string[];
    useCredits?: boolean;
    format?: 'in_person' | 'online';
  },
) {
  const byDate = new Map(preview.map(item => [item.date, item]));
  if (input.useCredits) {
    const needed = [...new Set(input.dates)].filter(date => byDate.get(date)!.available).length;
    const available = await creditsAvailable(client._id, series.coachId);
    if (available < needed) {
      throw new AppError('INSUFFICIENT_CREDITS', undefined, {
        creditsAvailable: available,
        creditsNeeded: needed,
      });
    }
  }

  const bookings: BookingDoc[] = [];
  const skipped: {date: string; reason: 'UNAVAILABLE' | 'PAST' | 'EXCEPTION'}[] = [];
  for (const date of [...new Set(input.dates)].sort()) {
    const item = byDate.get(date)!;
    if (!item.available) {
      skipped.push({date, reason: item.reason ?? 'UNAVAILABLE'});
      continue;
    }
    try {
      bookings.push(
        await createIndividualBooking(
          client,
          {
            sessionTypeId: input.sessionTypeId,
            startAt: item.startAt,
            isTrial: false,
            useCredits: input.useCredits,
            format: input.format,
          },
          {seriesId: series._id},
        ),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'SLOT_UNAVAILABLE') {
        skipped.push({date, reason: 'UNAVAILABLE'});
        continue;
      }
      if (error instanceof AppError && error.code === 'NO_CREDITS') {
        // Credits were used up in parallel: nothing is booked (credits go back).
        for (const booking of bookings) await cancelBookingInternal(booking, 'system');
        await BookingModel.deleteMany({_id: {$in: bookings.map(b => b._id)}});
        throw new AppError('INSUFFICIENT_CREDITS', undefined, {
          creditsAvailable: await creditsAvailable(client._id, series.coachId),
        });
      }
      throw error;
    }
  }
  series.bookingIds = [...series.bookingIds, ...bookings.map(b => b._id)];
  series.skippedDates = [...series.skippedDates, ...skipped.map(s => s.date)];
  await series.save();
  return {bookings: await toBookingDtos(bookings), skipped};
}

// ---------------------------------------------------------------------------------------------
// Mock payment
// ---------------------------------------------------------------------------------------------

async function markPaid(booking: BookingDoc) {
  const paid = await BookingModel.findOneAndUpdate(
    {_id: booking._id, status: 'pending_payment', expiresAt: {$gt: new Date()}},
    {
      $set: {
        status: 'confirmed',
        payment: {status: 'paid', method: 'mock', paidAt: new Date()},
        expiresAt: null,
      },
    },
    {returnDocument: 'after'},
  );
  if (!paid) {
    throw new AppError('BOOKING_NOT_PAYABLE');
  }
  return paid;
}

export async function payBooking(client: UserDoc, bookingId: string) {
  const booking = await getBookingForParticipant(client, bookingId);
  if (!booking.clientId.equals(client._id)) {
    throw new AppError('FORBIDDEN');
  }
  return markPaid(booking);
}

export async function paySeries(client: UserDoc, seriesId: string) {
  const series = await BookingSeriesModel.findOne({_id: seriesId, clientId: client._id});
  if (!series) {
    throw new AppError('NOT_FOUND', 'Series not found.');
  }
  const pending = await BookingModel.find({
    seriesId: series._id,
    status: 'pending_payment',
    expiresAt: {$gt: new Date()},
  });
  if (pending.length === 0) {
    throw new AppError('BOOKING_NOT_PAYABLE', 'Nothing to pay in this series.');
  }
  const paid = [];
  for (const booking of pending) paid.push(await markPaid(booking));
  const all = await BookingModel.find({seriesId: series._id}).sort({startAt: 1});
  return {bookings: await toBookingDtos(all), paidCount: paid.length};
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

export async function listClientBookings(client: UserDoc, query: z.infer<typeof BookingListQuery>) {
  const now = new Date();
  const filter: Record<string, unknown> = {clientId: client._id};
  filter.endAt = query.scope === 'upcoming' ? {$gte: now} : {$lt: now};
  if (query.status) filter.status = query.status;
  if (query.from || query.to) {
    filter.startAt = {
      ...(query.from && {$gte: new Date(query.from)}),
      ...(query.to && {$lt: new Date(query.to)}),
    };
  }
  const [total, bookings] = await Promise.all([
    BookingModel.countDocuments(filter),
    BookingModel.find(filter)
      .sort({startAt: query.scope === 'upcoming' ? 1 : -1})
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize),
  ]);
  return {items: await toBookingDtos(bookings), page: query.page, pageSize: query.pageSize, total};
}

// ---------------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------------

/**
 * Cancels an active booking and releases its place. Returns null if it was not active anymore.
 *
 * Refund rule: a paid booking is always refunded in full. Clients can cancel a paid (confirmed) booking only
 * before the coach's free-cancellation deadline (checked in cancelByClient), so their cancellations are 100%;
 * cancellations by the coach or the system are 100% at any time. Unpaid and free bookings have nothing to refund.
 * One atomic update, so a payment arriving at the same moment cannot slip through without a refund.
 */
export async function cancelBookingInternal(booking: BookingDoc, by: CancelledBy, reason?: string) {
  const now = new Date();
  const wasPaid = {$eq: ['$payment.status', 'paid']};
  const cancelled = await BookingModel.findOneAndUpdate(
    {_id: booking._id, status: {$in: ACTIVE}},
    [
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: {$literal: by},
          ...(reason && {cancelReason: {$literal: reason}}),
          'payment.status': {$cond: [wasPaid, 'refunded', '$payment.status']},
          'payment.refundedAt': {$cond: [wasPaid, now, '$payment.refundedAt']},
        },
      },
      {$unset: 'activeKey'},
    ],
    {returnDocument: 'after', updatePipeline: true},
  );
  if (!cancelled) {
    return null;
  }
  // Paid with a credit: the refund is the credit, back into the same purchase (lost if it expired).
  if (
    cancelled.payment.method === 'credits' &&
    cancelled.payment.status === 'refunded' &&
    cancelled.payment.clientPackageId
  ) {
    await returnCredit(cancelled.payment.clientPackageId);
  }
  const session = await TrainingSessionModel.findById(cancelled.sessionId);
  if (session?.kind === 'individual') {
    session.status = 'cancelled';
    session.cancelReason = reason;
    await session.save();
    await unlockSession(session._id);
  } else if (session) {
    await SeatLockModel.deleteOne({sessionId: session._id, clientId: cancelled.clientId});
    await syncParticipants(session._id);
    // A place was freed: the first client on the waitlist gets an offer.
    await processWaitlist(session._id);
  }
  return cancelled;
}

export async function cancelByClient(client: UserDoc, bookingId: string, reason?: string) {
  const booking = await getBookingForParticipant(client, bookingId);
  if (!booking.clientId.equals(client._id)) {
    throw new AppError('FORBIDDEN');
  }
  if (
    !ACTIVE.includes(booking.status as (typeof ACTIVE)[number]) ||
    booking.startAt <= new Date()
  ) {
    throw new AppError('CANCELLATION_WINDOW_PASSED', 'This training can no longer be cancelled.');
  }
  if (booking.status === 'confirmed') {
    const profile = await CoachProfileModel.findOne({userId: booking.coachId}).lean();
    const freeCancelHours = profile?.cancellationPolicy?.freeCancelHours ?? 24;
    const deadline = addMinutes(booking.startAt, -freeCancelHours * 60);
    if (new Date() > deadline) {
      throw new AppError('CANCELLATION_WINDOW_PASSED', undefined, {
        freeCancelHours,
        deadline: deadline.toISOString(),
      });
    }
  }
  const cancelled = await cancelBookingInternal(booking, 'client', reason);
  if (!cancelled) {
    throw new AppError('CANCELLATION_WINDOW_PASSED', 'This training can no longer be cancelled.');
  }
  return cancelled;
}

export async function cancelByCoach(coach: UserDoc, bookingId: string, reason: string) {
  const booking = await BookingModel.findOne({_id: bookingId, coachId: coach._id});
  if (!booking) {
    throw new AppError('NOT_FOUND', 'Booking not found.');
  }
  if (booking.startAt <= new Date()) {
    throw new AppError('CANCELLATION_WINDOW_PASSED', 'Past trainings cannot be cancelled.');
  }
  const cancelled = await cancelBookingInternal(booking, 'coach', reason);
  if (!cancelled) {
    throw new AppError('CANCELLATION_WINDOW_PASSED', 'This booking is not active.');
  }
  return cancelled;
}

// ---------------------------------------------------------------------------------------------
// Reschedule (client)
// ---------------------------------------------------------------------------------------------

/**
 * Moves a booking to another time (individual) or another group session of the same type (group), before the
 * free-cancellation deadline. Payment, trial flag, price, notes, location and series stay as they are.
 */
export async function rescheduleBooking(
  client: UserDoc,
  bookingId: string,
  input: {startAt?: string; sessionId?: string},
) {
  const booking = await BookingModel.findById(bookingId);
  if (!booking) {
    throw new AppError('NOT_FOUND', 'Booking not found.');
  }
  if (!booking.clientId.equals(client._id)) {
    throw new AppError('FORBIDDEN');
  }
  const now = new Date();
  if (!ACTIVE.includes(booking.status as (typeof ACTIVE)[number]) || booking.startAt <= now) {
    throw new AppError('RESCHEDULE_WINDOW_PASSED');
  }
  if (booking.status === 'confirmed') {
    const profile = await CoachProfileModel.findOne({userId: booking.coachId}).lean();
    const freeCancelHours = profile?.cancellationPolicy?.freeCancelHours ?? 24;
    const deadline = addMinutes(booking.startAt, -freeCancelHours * 60);
    if (now > deadline) {
      throw new AppError('RESCHEDULE_WINDOW_PASSED', undefined, {
        freeCancelHours,
        deadline: deadline.toISOString(),
      });
    }
  }
  const session = await TrainingSessionModel.findById(booking.sessionId);
  if (!session) {
    throw new AppError('NOT_FOUND', 'Session not found.');
  }
  const moved =
    session.kind === 'individual'
      ? await rescheduleIndividual(booking, session, input)
      : await rescheduleGroup(client, booking, session, input);
  return moved;
}

async function rescheduleIndividual(
  booking: BookingDoc,
  session: TrainingSessionDoc,
  input: {startAt?: string; sessionId?: string},
) {
  if (!input.startAt) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {startAt: 'Individual bookings are moved with startAt'},
    });
  }
  const startAt = new Date(input.startAt);
  if (startAt.getTime() === session.startAt.getTime()) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {startAt: 'Choose a different time'},
    });
  }
  const durationMin = Math.round((session.endAt.getTime() - session.startAt.getTime()) / 60_000);
  // The booking's own slot does not block the new time.
  if (
    !isOnSlotGrid(startAt) ||
    !(await isFreeSlot(session.coachId, durationMin, startAt, session._id))
  ) {
    throw new AppError('SLOT_UNAVAILABLE');
  }
  const oldStart = booking.startAt;
  const endAt = addMinutes(startAt, durationMin);
  await moveLockedSession(session, startAt, endAt);
  const updated = await BookingModel.findOneAndUpdate(
    {_id: booking._id, startAt: oldStart, status: {$in: ACTIVE}},
    {$set: {startAt, endAt, rescheduledAt: new Date()}},
    {returnDocument: 'after'},
  );
  if (!updated) {
    // Cancelled or moved in parallel: put the session back.
    await moveLockedSession(session, oldStart, addMinutes(oldStart, durationMin));
    throw new AppError('RESCHEDULE_WINDOW_PASSED');
  }
  return updated;
}

async function rescheduleGroup(
  client: UserDoc,
  booking: BookingDoc,
  session: TrainingSessionDoc,
  input: {startAt?: string; sessionId?: string},
) {
  if (!input.sessionId) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {sessionId: 'Group bookings are moved with sessionId'},
    });
  }
  if (input.sessionId === session.id) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {sessionId: 'Choose a different session'},
    });
  }
  const target = await TrainingSessionModel.findOne({
    _id: input.sessionId,
    kind: 'group',
    status: 'scheduled',
    startAt: {$gt: new Date()},
    coachId: session.coachId,
    sessionTypeId: session.sessionTypeId,
  });
  if (!target) {
    throw new AppError('NOT_FOUND', 'Group session not found.');
  }
  if (await BookingModel.exists({activeKey: activeKey(target._id, client._id)})) {
    throw new AppError('ALREADY_BOOKED');
  }
  await processWaitlist(target._id);
  const claimed = await claimOfferedSeat(target._id, client._id);
  const seat = claimed ?? (await takeSeat(target._id, client._id, target.capacity));
  const updated = await BookingModel.findOneAndUpdate(
    {_id: booking._id, sessionId: session._id, status: {$in: ACTIVE}},
    {
      $set: {
        sessionId: target._id,
        startAt: target.startAt,
        endAt: target.endAt,
        activeKey: activeKey(target._id, client._id),
        rescheduledAt: new Date(),
      },
    },
    {returnDocument: 'after'},
  );
  if (!updated) {
    if (claimed) await restoreOfferedSeat(target._id, client._id);
    else await SeatLockModel.deleteOne({_id: seat._id});
    throw new AppError('RESCHEDULE_WINDOW_PASSED');
  }
  await markBooked(target._id, client._id);
  await SeatLockModel.deleteOne({sessionId: session._id, clientId: client._id});
  await Promise.all([syncParticipants(session._id), syncParticipants(target._id)]);
  // The old place goes to the waitlist of the old session.
  await processWaitlist(session._id);
  return updated;
}

// ---------------------------------------------------------------------------------------------
// Calendar export
// ---------------------------------------------------------------------------------------------

export async function calendarEvent(user: UserDoc, bookingId: string) {
  const booking = await getBookingForParticipant(user, bookingId);
  const [session, coach, client, profile] = await Promise.all([
    TrainingSessionModel.findById(booking.sessionId),
    UserModel.findById(booking.coachId).lean(),
    UserModel.findById(booking.clientId).lean(),
    CoachProfileModel.findOne({userId: booking.coachId}).lean(),
  ]);
  const isCoach = booking.coachId.equals(user._id);
  const other = isCoach ? client : coach;
  const otherName = [other?.firstName, other?.lastName].filter(Boolean).join(' ');
  const location = session?.location;
  const meetingUrl =
    session?.format === 'online'
      ? ((profile?.online?.meetingUrl as string | undefined) ?? null)
      : null;
  const freeCancelHours = profile?.cancellationPolicy?.freeCancelHours ?? 24;
  const notes = [
    `FitBook ${session?.kind === 'group' ? 'group training' : 'training'}${otherName ? ` with ${otherName}` : ''}.`,
    location?.comment ? `Meeting point: ${location.comment}.` : null,
    meetingUrl ? `Join online: ${meetingUrl}` : null,
    isCoach ? null : `Free cancellation up to ${freeCancelHours}h before the start.`,
    `Booking: ${booking.id}`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    title: `${session?.title ?? 'Training'}${otherName ? ` with ${otherName}` : ''}`,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    timezone: (isCoach ? user.homeArea?.timezone : coach?.homeArea?.timezone) ?? 'America/Chicago',
    location: location
      ? {name: location.name, address: location.address, lat: location.lat, lng: location.lng}
      : null,
    meetingUrl,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

export async function releaseExpiredPendingBookings(now = new Date()) {
  const expired = await BookingModel.find({status: 'pending_payment', expiresAt: {$lte: now}});
  let released = 0;
  for (const booking of expired) {
    if (await cancelBookingInternal(booking, 'system', 'PAYMENT_EXPIRED')) released += 1;
  }
  return released;
}

export async function completePastSessions(now = new Date()) {
  const sessions = await TrainingSessionModel.updateMany(
    {status: 'scheduled', endAt: {$lte: now}},
    {$set: {status: 'completed'}},
  );
  const bookings = await BookingModel.updateMany(
    {status: 'confirmed', endAt: {$lte: now}},
    {$set: {status: 'completed'}},
  );
  return {sessions: sessions.modifiedCount, bookings: bookings.modifiedCount};
}
