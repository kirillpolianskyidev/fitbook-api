import type {Types} from 'mongoose';

import {toLocationDto, toMoneyDto} from '../../lib/dto.js';
import {AppError, isDuplicateKeyError} from '../../lib/errors.js';
import {BOOKING_LEAD_MINUTES, computeSlots} from '../../lib/slots.js';
import {addMinutes, slotBlocks} from '../../lib/time.js';
import {AvailabilityModel} from '../../models/availability.js';
import {SlotLockModel} from '../../models/slotLock.js';
import type {TrainingSessionDoc} from '../../models/trainingSession.js';
import {TrainingSessionModel} from '../../models/trainingSession.js';
import {UserModel} from '../../models/user.js';
import type {TrainingSessionDto} from './sessions.schemas.js';

export function toSessionDto(session: TrainingSessionDoc): TrainingSessionDto {
  return {
    id: session.id,
    coachId: session.coachId.toString(),
    sessionTypeId: session.sessionTypeId.toString(),
    kind: session.kind as 'individual' | 'group',
    title: session.title,
    startAt: session.startAt.toISOString(),
    endAt: session.endAt.toISOString(),
    durationMin: Math.round((session.endAt.getTime() - session.startAt.getTime()) / 60_000),
    capacity: session.capacity,
    participantsCount: session.participantsCount,
    spotsLeft: Math.max(0, session.capacity - session.participantsCount),
    price: toMoneyDto(session.price),
    location: toLocationDto(session.location),
    status: session.status as 'scheduled' | 'cancelled' | 'completed',
    cancelReason: session.cancelReason ?? null,
  };
}

/** Epoch ms of every locked block of a coach inside a time range (optionally ignoring one session's locks). */
export async function lockedBlocks(
  coachId: Types.ObjectId | string,
  from: Date,
  to: Date,
  ignoreSessionId?: Types.ObjectId,
) {
  const locks = await SlotLockModel.find({
    coachId,
    slotStart: {$gte: addMinutes(from, -180), $lt: addMinutes(to, 180)},
    ...(ignoreSessionId && {sessionId: {$ne: ignoreSessionId}}),
  })
    .select('slotStart')
    .lean();
  return new Set(locks.map(lock => lock.slotStart.getTime()));
}

export async function coachTimezone(coachId: Types.ObjectId | string) {
  const coach = await UserModel.findById(coachId).select('homeArea role').lean();
  if (!coach || coach.role !== 'coach' || !coach.homeArea) {
    throw new AppError('NOT_FOUND', 'Coach not found.');
  }
  return coach.homeArea.timezone;
}

/** Free individual slots of a coach for a duration. */
export async function findSlots(
  coachId: Types.ObjectId | string,
  durationMin: number,
  from: Date,
  to: Date,
  ignoreSessionId?: Types.ObjectId,
) {
  const [timezone, availability, locked] = await Promise.all([
    coachTimezone(coachId),
    AvailabilityModel.findOne({coachId}).lean(),
    lockedBlocks(coachId, from, to, ignoreSessionId),
  ]);
  return computeSlots({
    timezone,
    weekly: availability?.weekly ?? [],
    exceptions: availability?.exceptions ?? [],
    durationMin,
    from,
    to,
    locked,
    notBefore: addMinutes(new Date(), BOOKING_LEAD_MINUTES),
  });
}

export async function isFreeSlot(
  coachId: Types.ObjectId | string,
  durationMin: number,
  startAt: Date,
  ignoreSessionId?: Types.ObjectId,
) {
  const slots = await findSlots(
    coachId,
    durationMin,
    startAt,
    addMinutes(startAt, 1),
    ignoreSessionId,
  );
  return slots.some(slot => slot.startAt.getTime() === startAt.getTime());
}

/**
 * Inserts one lock per 30-minute block of the session. Throws SLOT_UNAVAILABLE if any block is taken
 * (unique index), after removing the locks this call managed to insert.
 */
export async function lockSession(session: TrainingSessionDoc) {
  const docs = slotBlocks(session.startAt, session.endAt).map(slotStart => ({
    coachId: session.coachId,
    slotStart,
    sessionId: session._id,
  }));
  try {
    await SlotLockModel.insertMany(docs, {ordered: true});
  } catch (error) {
    await SlotLockModel.deleteMany({sessionId: session._id});
    if (isDuplicateKeyError(error) || (error as {writeErrors?: unknown}).writeErrors) {
      throw new AppError('SLOT_UNAVAILABLE');
    }
    throw error;
  }
}

export const unlockSession = (sessionId: Types.ObjectId) => SlotLockModel.deleteMany({sessionId});

/**
 * Moves an individual session to a new time. Blocks the session already holds are kept, new ones are inserted
 * (unique index -> SLOT_UNAVAILABLE, rolled back), and blocks it no longer needs are released.
 */
export async function moveLockedSession(session: TrainingSessionDoc, startAt: Date, endAt: Date) {
  const held = new Set(slotBlocks(session.startAt, session.endAt).map(d => d.getTime()));
  const wanted = slotBlocks(startAt, endAt);
  const added = wanted.filter(d => !held.has(d.getTime()));
  const inserted: Date[] = [];
  try {
    for (const slotStart of added) {
      await SlotLockModel.create({coachId: session.coachId, slotStart, sessionId: session._id});
      inserted.push(slotStart);
    }
  } catch (error) {
    if (inserted.length) {
      await SlotLockModel.deleteMany({sessionId: session._id, slotStart: {$in: inserted}});
    }
    if (isDuplicateKeyError(error)) throw new AppError('SLOT_UNAVAILABLE');
    throw error;
  }
  const keep = new Set(wanted.map(d => d.getTime()));
  const released = [...held].filter(ms => !keep.has(ms)).map(ms => new Date(ms));
  if (released.length) {
    await SlotLockModel.deleteMany({sessionId: session._id, slotStart: {$in: released}});
  }
  session.startAt = startAt;
  session.endAt = endAt;
  await session.save();
}

/** Creates a session and reserves its time; the session is removed again if the time is taken. */
export async function createLockedSession(input: Record<string, unknown>) {
  const session = await TrainingSessionModel.create(input);
  try {
    await lockSession(session);
  } catch (error) {
    await session.deleteOne();
    throw error;
  }
  return session;
}
