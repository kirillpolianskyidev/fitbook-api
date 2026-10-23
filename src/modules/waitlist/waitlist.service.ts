import type {Types} from 'mongoose';

import {toMoneyDto} from '../../lib/dto.js';
import {AppError, isDuplicateKeyError} from '../../lib/errors.js';
import {logger} from '../../lib/logger.js';
import {addMinutes} from '../../lib/time.js';
import {BookingModel} from '../../models/booking.js';
import {SeatLockModel} from '../../models/seatLock.js';
import {TrainingSessionModel, type TrainingSessionDoc} from '../../models/trainingSession.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {WaitlistEntryModel, type WaitlistEntryDoc} from '../../models/waitlistEntry.js';
import {emitToUsers} from '../../realtime/socket.js';
import {syncSeatCounts} from '../sessions/sessions.service.js';
import {toUserSummary} from '../users/users.service.js';

/** An offer holds the place for 2 hours, but never later than 15 minutes before the start. */
export const OFFER_HOLD_MINUTES = 120;
export const OFFER_CUTOFF_MINUTES = 15;

const ACTIVE = ['waiting', 'offered'] as const;
const activeKey = (sessionId: Types.ObjectId, clientId: Types.ObjectId) =>
  `${sessionId}:${clientId}`;

/** Indirection so tests can observe realtime events without a socket server. */
export const waitlistEvents = {
  offered: (clientId: string, payload: unknown) =>
    emitToUsers([clientId], 'waitlist:offered', payload),
};

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

async function positionOf(entry: WaitlistEntryDoc) {
  if (entry.status !== 'waiting') return null;
  const ahead = await WaitlistEntryModel.countDocuments({
    sessionId: entry.sessionId,
    status: 'waiting',
    $or: [{joinedAt: {$lt: entry.joinedAt}}, {joinedAt: entry.joinedAt, _id: {$lt: entry._id}}],
  });
  return ahead + 1;
}

export async function toEntryDtos(entries: WaitlistEntryDoc[]) {
  const sessions = await TrainingSessionModel.find({_id: {$in: entries.map(e => e.sessionId)}});
  const sessionById = new Map(sessions.map(s => [s.id as string, s]));
  const coaches = await UserModel.find({_id: {$in: sessions.map(s => s.coachId)}})
    .select('firstName lastName avatarUrl')
    .lean();
  const coachById = new Map(coaches.map(c => [c._id.toString(), c]));
  return Promise.all(
    entries.map(async entry => {
      const session = sessionById.get(entry.sessionId.toString());
      const coach = session ? coachById.get(session.coachId.toString()) : undefined;
      return {
        id: entry.id as string,
        status: entry.status as 'waiting' | 'offered' | 'booked' | 'expired' | 'left',
        position: await positionOf(entry),
        offerExpiresAt:
          entry.status === 'offered' ? (entry.offerExpiresAt?.toISOString() ?? null) : null,
        joinedAt: entry.joinedAt.toISOString(),
        session: {
          id: entry.sessionId.toString(),
          title: session?.title ?? '',
          startAt: session?.startAt.toISOString() ?? '',
          endAt: session?.endAt.toISOString() ?? '',
          price: toMoneyDto(session?.price ?? {amountCents: 0, currency: 'USD'}),
          coach: coach
            ? toUserSummary(coach)
            : {id: session?.coachId.toString() ?? '', firstName: '', lastName: '', avatarUrl: null},
        },
      };
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------------------------

async function finishEntry(entryId: Types.ObjectId, status: 'expired' | 'left' | 'booked') {
  return WaitlistEntryModel.findOneAndUpdate(
    {_id: entryId, status: {$in: ACTIVE}},
    {$set: {status}, $unset: {activeKey: 1}},
    {returnDocument: 'after'},
  );
}

/** Releases the place held for an offer (if it is still a hold). */
async function releaseHold(sessionId: Types.ObjectId, clientId: Types.ObjectId) {
  await SeatLockModel.deleteOne({sessionId, clientId, hold: true});
}

/** The session started or was cancelled: every active entry expires, holds are released. */
export async function expireWaitlist(sessionId: Types.ObjectId) {
  const entries = await WaitlistEntryModel.find({sessionId, status: {$in: ACTIVE}});
  for (const entry of entries) {
    if (await finishEntry(entry._id, 'expired')) await releaseHold(sessionId, entry.clientId);
  }
  await SeatLockModel.deleteMany({sessionId, hold: true});
  await syncSeatCounts(sessionId);
}

/** Takes the first free seat number as a hold for the client. Null if the session is full. */
async function holdSeat(session: TrainingSessionDoc, clientId: Types.ObjectId) {
  for (let seat = 1; seat <= session.capacity; seat += 1) {
    try {
      return await SeatLockModel.create({sessionId: session._id, seat, clientId, hold: true});
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      if (await SeatLockModel.exists({sessionId: session._id, clientId})) return null;
    }
  }
  return null;
}

/**
 * Brings the waitlist of a session up to date. Called after a place is freed, on reads and by a job:
 * expired offers pass to the next waiting client, free places are offered in queue order and held for
 * min(now + 2h, start - 15 min). If that moment has passed, the place stays free for everybody.
 */
export async function processWaitlist(sessionId: Types.ObjectId) {
  const session = await TrainingSessionModel.findById(sessionId);
  if (!session || session.kind !== 'group') return;
  const now = new Date();
  if (!(await WaitlistEntryModel.exists({sessionId, status: {$in: ACTIVE}}))) return;
  if (session.status !== 'scheduled' || session.startAt <= now) {
    await expireWaitlist(sessionId);
    return;
  }

  // 1. Offers that ran out.
  const stale = await WaitlistEntryModel.find({
    sessionId,
    status: 'offered',
    offerExpiresAt: {$lte: now},
  });
  for (const entry of stale) {
    if (await finishEntry(entry._id, 'expired')) await releaseHold(sessionId, entry.clientId);
  }

  // 2. Offer free places to the queue.
  const offerExpiresAt = new Date(
    Math.min(
      addMinutes(now, OFFER_HOLD_MINUTES).getTime(),
      addMinutes(session.startAt, -OFFER_CUTOFF_MINUTES).getTime(),
    ),
  );
  if (offerExpiresAt > now) {
    for (;;) {
      const taken = await SeatLockModel.countDocuments({sessionId});
      if (taken >= session.capacity) break;
      const next = await WaitlistEntryModel.findOneAndUpdate(
        {sessionId, status: 'waiting'},
        {$set: {status: 'offered', offeredAt: now, offerExpiresAt}},
        {sort: {joinedAt: 1, _id: 1}, returnDocument: 'after'},
      );
      if (!next) break;
      const hold = await holdSeat(session, next.clientId);
      if (!hold) {
        // Booked by someone else in the meantime: back to the queue, same position.
        await WaitlistEntryModel.updateOne(
          {_id: next._id, status: 'offered'},
          {$set: {status: 'waiting', offeredAt: null, offerExpiresAt: null}},
        );
        break;
      }
      const [dto] = await toEntryDtos([next]);
      waitlistEvents.offered(next.clientId.toString(), {entry: dto});
    }
  }
  await syncSeatCounts(sessionId);
}

/** Brings the waitlists of these sessions up to date (only sessions that have active entries). */
export async function refreshWaitlists(sessionIds: Types.ObjectId[]) {
  if (!sessionIds.length) return;
  const ids = await WaitlistEntryModel.distinct('sessionId', {
    sessionId: {$in: sessionIds},
    status: {$in: ACTIVE},
  });
  for (const id of ids) await processWaitlist(id as Types.ObjectId);
}

/** Job: expired offers and started sessions. */
export async function sweepWaitlists() {
  const now = new Date();
  const staleOffers = await WaitlistEntryModel.distinct('sessionId', {
    status: 'offered',
    offerExpiresAt: {$lte: now},
  });
  const active = await WaitlistEntryModel.distinct('sessionId', {status: {$in: ACTIVE}});
  const started = await TrainingSessionModel.find({
    _id: {$in: active},
    $or: [{startAt: {$lte: now}}, {status: {$ne: 'scheduled'}}],
  }).distinct('_id');
  const ids = new Map([...staleOffers, ...started].map(id => [String(id), id as Types.ObjectId]));
  for (const id of ids.values()) {
    try {
      await processWaitlist(id);
    } catch (error) {
      logger.error({err: error, sessionId: String(id)}, 'Waitlist processing failed');
    }
  }
  return ids.size;
}

// ---------------------------------------------------------------------------------------------
// Booking integration
// ---------------------------------------------------------------------------------------------

/**
 * If the client holds an offered place in the session, turns the hold into a normal seat and returns it.
 * Returns null otherwise (book a free seat as usual).
 */
export async function claimOfferedSeat(sessionId: Types.ObjectId, clientId: Types.ObjectId) {
  const offer = await WaitlistEntryModel.findOne({
    sessionId,
    clientId,
    status: 'offered',
    offerExpiresAt: {$gt: new Date()},
  });
  if (!offer) return null;
  return SeatLockModel.findOneAndUpdate(
    {sessionId, clientId, hold: true},
    {$set: {hold: false}},
    {returnDocument: 'after'},
  );
}

/** Booking with a claimed seat failed: the seat goes back to being a hold for the offer. */
export async function restoreOfferedSeat(sessionId: Types.ObjectId, clientId: Types.ObjectId) {
  await SeatLockModel.updateOne({sessionId, clientId, hold: false}, {$set: {hold: true}});
}

/** The client booked the session: their waiting / offered entry is done. */
export async function markBooked(sessionId: Types.ObjectId, clientId: Types.ObjectId) {
  await WaitlistEntryModel.updateOne(
    {sessionId, clientId, status: {$in: ACTIVE}},
    {$set: {status: 'booked'}, $unset: {activeKey: 1}},
  );
}

// ---------------------------------------------------------------------------------------------
// Client endpoints
// ---------------------------------------------------------------------------------------------

async function upcomingGroupSession(sessionId: string) {
  const session = await TrainingSessionModel.findOne({_id: sessionId, kind: 'group'});
  if (!session) throw new AppError('NOT_FOUND', 'Group session not found.');
  return session;
}

export async function joinWaitlist(client: UserDoc, sessionId: string) {
  let session = await upcomingGroupSession(sessionId);
  if (session.status !== 'scheduled' || session.startAt <= new Date()) {
    throw new AppError('NOT_FOUND', 'Group session not found.');
  }
  await processWaitlist(session._id);
  session = (await TrainingSessionModel.findById(session._id))!;
  if (await BookingModel.exists({activeKey: `${session._id}:${client._id}`})) {
    throw new AppError('ALREADY_BOOKED');
  }
  if (await WaitlistEntryModel.exists({activeKey: activeKey(session._id, client._id)})) {
    throw new AppError('ALREADY_ON_WAITLIST');
  }
  const taken = await SeatLockModel.countDocuments({sessionId: session._id});
  if (taken < session.capacity) {
    throw new AppError('SESSION_NOT_FULL');
  }
  try {
    const entry = await WaitlistEntryModel.create({
      sessionId: session._id,
      clientId: client._id,
      status: 'waiting',
      joinedAt: new Date(),
      activeKey: activeKey(session._id, client._id),
    });
    const [dto] = await toEntryDtos([entry]);
    return dto!;
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError('ALREADY_ON_WAITLIST');
    throw error;
  }
}

export async function leaveWaitlist(client: UserDoc, sessionId: string) {
  const session = await upcomingGroupSession(sessionId);
  const entry = await WaitlistEntryModel.findOne({
    activeKey: activeKey(session._id, client._id),
  });
  if (!entry) throw new AppError('NOT_FOUND', 'You are not on the waitlist.');
  const left = await finishEntry(entry._id, 'left');
  if (left && entry.status === 'offered') {
    await releaseHold(session._id, client._id);
  }
  // The offer (if any) passes to the next client in the queue.
  await processWaitlist(session._id);
}

export async function myWaitlist(client: UserDoc) {
  const sessionIds = await WaitlistEntryModel.distinct('sessionId', {
    clientId: client._id,
    status: {$in: ACTIVE},
  });
  await refreshWaitlists(sessionIds as Types.ObjectId[]);
  const entries = await WaitlistEntryModel.find({clientId: client._id, status: {$in: ACTIVE}});
  const dtos = await toEntryDtos(entries);
  dtos.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'offered' ? -1 : 1;
    return a.session.startAt.localeCompare(b.session.startAt);
  });
  return {items: dtos};
}

/** `waitlist` field of group sessions for the viewer. */
export async function waitlistInfo(sessionIds: Types.ObjectId[], viewerId: Types.ObjectId) {
  const [counts, mine] = await Promise.all([
    WaitlistEntryModel.aggregate<{_id: Types.ObjectId; n: number}>([
      {$match: {sessionId: {$in: sessionIds}, status: 'waiting'}},
      {$group: {_id: '$sessionId', n: {$sum: 1}}},
    ]),
    WaitlistEntryModel.find({
      sessionId: {$in: sessionIds},
      clientId: viewerId,
      status: {$in: ACTIVE},
    }),
  ]);
  const countBy = new Map(counts.map(c => [c._id.toString(), c.n]));
  const mineBy = new Map(mine.map(e => [e.sessionId.toString(), e]));
  const result = new Map<
    string,
    {
      count: number;
      myStatus: 'waiting' | 'offered' | null;
      myPosition: number | null;
      offerExpiresAt: string | null;
    }
  >();
  for (const id of sessionIds) {
    const entry = mineBy.get(id.toString());
    result.set(id.toString(), {
      count: countBy.get(id.toString()) ?? 0,
      myStatus: (entry?.status as 'waiting' | 'offered' | undefined) ?? null,
      myPosition: entry ? await positionOf(entry) : null,
      offerExpiresAt:
        entry?.status === 'offered' ? (entry.offerExpiresAt?.toISOString() ?? null) : null,
    });
  }
  return result;
}
