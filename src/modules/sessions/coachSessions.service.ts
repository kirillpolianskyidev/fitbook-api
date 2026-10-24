import {DateTime} from 'luxon';
import type {Types} from 'mongoose';

import {AppError} from '../../lib/errors.js';
import {addMinutes, isOnSlotGrid} from '../../lib/time.js';
import {BookingModel} from '../../models/booking.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {NoteModel} from '../../models/note.js';
import {SeatLockModel} from '../../models/seatLock.js';
import {SessionTypeModel} from '../../models/sessionType.js';
import {TrainingSessionModel, type TrainingSessionDoc} from '../../models/trainingSession.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {cancelBookingInternal} from '../bookings/bookings.service.js';
import {toUserSummary} from '../users/users.service.js';
import {noShowFields} from '../bookings/noShow.js';
import {expireWaitlist} from '../waitlist/waitlist.service.js';
import {createLockedSession, toSessionDto, unlockSession} from './sessions.service.js';

type Repeat = {weekdays: number[]; weeks: number};

export async function createGroupSessions(
  coach: UserDoc,
  input: {sessionTypeId: string; startAt: string; repeat?: Repeat},
) {
  const type = await SessionTypeModel.findOne({_id: input.sessionTypeId, coachId: coach._id});
  if (!type) throw new AppError('NOT_FOUND', 'Training type not found.');
  if (!type.isActive) throw new AppError('SESSION_TYPE_INACTIVE');
  if (type.kind !== 'group') {
    throw new AppError('VALIDATION_ERROR', 'Choose a group training type.', {
      fields: {sessionTypeId: 'Must be a group training type'},
    });
  }
  const first = new Date(input.startAt);
  if (!isOnSlotGrid(first) || first <= new Date()) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Start must be in the future on a :00 or :30 boundary.',
      {
        fields: {startAt: 'Invalid start time'},
      },
    );
  }

  // Occurrences keep the same local time in the coach's time zone (DST-safe).
  const zone = coach.homeArea!.timezone;
  const firstLocal = DateTime.fromJSDate(first, {zone});
  const starts: Date[] = [first];
  if (input.repeat) {
    const end = firstLocal.startOf('day').plus({weeks: input.repeat.weeks});
    for (
      let day = firstLocal.startOf('day').plus({days: 1});
      day < end;
      day = day.plus({days: 1})
    ) {
      if (input.repeat.weekdays.includes(day.weekday % 7)) {
        starts.push(day.set({hour: firstLocal.hour, minute: firstLocal.minute}).toUTC().toJSDate());
      }
    }
  }

  const profile = await CoachProfileModel.findOne({userId: coach._id}).lean();
  const created: TrainingSessionDoc[] = [];
  const skipped: {startAt: string; reason: 'SLOT_UNAVAILABLE'}[] = [];
  for (const startAt of starts) {
    try {
      created.push(
        await createLockedSession({
          coachId: coach._id,
          sessionTypeId: type._id,
          kind: 'group',
          title: type.title,
          startAt,
          endAt: addMinutes(startAt, type.durationMin),
          capacity: type.capacity,
          participantsCount: 0,
          price: type.price,
          location: type.location ?? profile?.defaultLocation ?? null,
        }),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'SLOT_UNAVAILABLE') {
        skipped.push({startAt: startAt.toISOString(), reason: 'SLOT_UNAVAILABLE'});
        continue;
      }
      throw error;
    }
  }
  return {created: created.map(toSessionDto), skipped};
}

export async function cancelGroupSession(coach: UserDoc, sessionId: string, reason: string) {
  const session = await TrainingSessionModel.findOne({
    _id: sessionId,
    coachId: coach._id,
    kind: 'group',
  });
  if (!session) throw new AppError('NOT_FOUND', 'Group session not found.');
  if (session.status !== 'scheduled' || session.startAt <= new Date()) {
    throw new AppError('CANCELLATION_WINDOW_PASSED', 'Only upcoming sessions can be cancelled.');
  }
  // Cancelled first, so freed places are not offered to the waitlist while the bookings are cancelled.
  session.status = 'cancelled';
  session.cancelReason = reason;
  await session.save();
  const bookings = await BookingModel.find({
    sessionId: session._id,
    status: {$in: ['pending_payment', 'confirmed']},
  });
  for (const booking of bookings) {
    await cancelBookingInternal(booking, 'coach', reason);
  }
  await expireWaitlist(session._id);
  session.participantsCount = 0;
  session.heldCount = 0;
  await session.save();
  await unlockSession(session._id);
  await SeatLockModel.deleteMany({sessionId: session._id});
  return toSessionDto(session);
}

async function scheduleItems(sessions: TrainingSessionDoc[], coachId: Types.ObjectId) {
  const ids = sessions.map(s => s._id);
  const bookings = await BookingModel.find({sessionId: {$in: ids}}).sort({createdAt: 1});
  const clients = await UserModel.find({
    _id: {$in: [...new Set(bookings.map(b => b.clientId.toString()))]},
  })
    .select('firstName lastName avatarUrl')
    .lean();
  const notes = await NoteModel.aggregate<{_id: Types.ObjectId; n: number}>([
    {$match: {bookingId: {$in: bookings.map(b => b._id)}}},
    {$group: {_id: '$bookingId', n: {$sum: 1}}},
  ]);
  const clientById = new Map(clients.map(c => [c._id.toString(), c]));
  const notesById = new Map(notes.map(n => [n._id.toString(), n.n]));
  return sessions.map(session => ({
    session: toSessionDto(session),
    participants: bookings
      .filter(b => b.sessionId.equals(session._id))
      .map(b => {
        const client = clientById.get(b.clientId.toString());
        return {
          bookingId: b.id as string,
          status: b.status as
            'pending_payment' | 'confirmed' | 'cancelled' | 'completed' | 'no_show',
          isTrial: b.isTrial,
          ...noShowFields(b, coachId),
          client: client
            ? toUserSummary(client)
            : {id: b.clientId.toString(), firstName: '', lastName: '', avatarUrl: null},
          notesCount: notesById.get(b.id as string) ?? 0,
        };
      }),
  }));
}

/** Work calendar: every session in the range with its participants. */
export async function coachSchedule(
  coach: UserDoc,
  from: Date,
  to: Date,
  includeCancelled: boolean,
) {
  const sessions = await TrainingSessionModel.find({
    coachId: coach._id,
    startAt: {$gte: from, $lt: to},
    ...(includeCancelled ? {} : {status: {$ne: 'cancelled'}}),
  }).sort({startAt: 1});
  // Individual sessions without any booking left (e.g. expired) are not shown.
  const items = await scheduleItems(sessions, coach._id);
  return {
    items: items.filter(item => item.session.kind === 'group' || item.participants.length > 0),
  };
}

export async function coachSessionDetails(coach: UserDoc, sessionId: string) {
  const session = await TrainingSessionModel.findOne({_id: sessionId, coachId: coach._id});
  if (!session) throw new AppError('NOT_FOUND', 'Session not found.');
  const [item] = await scheduleItems([session], coach._id);
  return item!;
}

export async function coachClients(coach: UserDoc, search?: string) {
  const bookings = await BookingModel.find({coachId: coach._id, status: {$ne: 'cancelled'}})
    .select('clientId startAt status')
    .lean();
  const stats = new Map<string, {total: number; last: Date}>();
  for (const b of bookings) {
    const key = b.clientId.toString();
    const current = stats.get(key);
    stats.set(key, {
      // A no-show is not a training: the client stays in the list but it is not counted.
      total: (current?.total ?? 0) + (b.status === 'no_show' ? 0 : 1),
      last: current && current.last > b.startAt ? current.last : b.startAt,
    });
  }
  const users = await UserModel.find({_id: {$in: [...stats.keys()]}})
    .select('firstName lastName avatarUrl')
    .lean();
  const pattern = search?.toLowerCase();
  return {
    items: users
      .filter(u => !pattern || `${u.firstName} ${u.lastName ?? ''}`.toLowerCase().includes(pattern))
      .map(u => ({
        ...toUserSummary(u),
        totalBookings: stats.get(u._id.toString())?.total ?? 0,
        lastBookingAt: stats.get(u._id.toString())?.last.toISOString() ?? null,
      }))
      .sort((a, b) => (b.lastBookingAt ?? '').localeCompare(a.lastBookingAt ?? '')),
  };
}
