import {DateTime} from 'luxon';
import {Types} from 'mongoose';
import type {z} from 'zod';

import {AppError} from '../../lib/errors.js';
import {BookingModel} from '../../models/booking.js';
import {MeasurementModel, type MeasurementDoc} from '../../models/measurement.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {MEASUREMENT_TYPES, type MeasurementBody, type MeasurementType} from './progress.schemas.js';

const zoneOf = (user: {homeArea?: {timezone?: string | null} | null}) =>
  user.homeArea?.timezone || 'America/Chicago';

/** Monday (YYYY-MM-DD) of the week containing the moment, in the zone. */
export const weekStartOf = (date: Date, zone: string) =>
  DateTime.fromJSDate(date, {zone}).startOf('week').toISODate()!;

const todayIn = (zone: string) => DateTime.now().setZone(zone).toISODate()!;

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

/**
 * Progress of a client. With coachId, `totals` and `weekly` count only trainings with that coach
 * (`thisWeek` and the streak stay the client's own, across all coaches).
 */
export async function progressOf(
  client: {
    _id: Types.ObjectId;
    homeArea?: {timezone?: string | null} | null;
    weeklyGoal?: number | null;
  },
  weeks: number,
  coachId?: Types.ObjectId,
) {
  const zone = zoneOf(client);
  const now = DateTime.now().setZone(zone);
  const currentWeek = now.startOf('week');
  const goal = client.weeklyGoal ?? null;

  const [completed, planned] = await Promise.all([
    BookingModel.find({clientId: client._id, status: 'completed'}).select('coachId startAt').lean(),
    BookingModel.countDocuments({
      clientId: client._id,
      status: 'confirmed',
      startAt: {$gte: now.toJSDate(), $lt: currentWeek.plus({weeks: 1}).toJSDate()},
    }),
  ]);
  const scoped = coachId ? completed.filter(b => b.coachId.equals(coachId)) : completed;

  const countByWeek = (list: typeof completed) => {
    const map = new Map<string, number>();
    for (const b of list) {
      const key = weekStartOf(b.startAt, zone);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  };
  const allWeeks = countByWeek(completed);
  const scopedWeeks = countByWeek(scoped);

  const weekly = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const weekStart = currentWeek.minus({weeks: i}).toISODate()!;
    weekly.push({weekStart, completed: scopedWeeks.get(weekStart) ?? 0});
  }

  // Streak: consecutive weeks meeting the goal (or >= 1 training without a goal).
  const target = goal ?? 1;
  const met = (week: DateTime) => (allWeeks.get(week.toISODate()!) ?? 0) >= target;
  let streakWeeks = 0;
  let week = met(currentWeek) ? currentWeek : currentWeek.minus({weeks: 1});
  while (met(week)) {
    streakWeeks += 1;
    week = week.minus({weeks: 1});
  }

  const monthStart = now.startOf('month').toJSDate();
  return {
    totals: {
      completed: scoped.length,
      thisMonth: scoped.filter(b => b.startAt >= monthStart).length,
      coaches: new Set(scoped.map(b => b.coachId.toString())).size,
    },
    goal: {trainingsPerWeek: goal},
    thisWeek: {
      weekStart: currentWeek.toISODate()!,
      completed: allWeeks.get(currentWeek.toISODate()!) ?? 0,
      planned,
    },
    streakWeeks,
    weekly,
  };
}

export async function setGoal(client: UserDoc, trainingsPerWeek: number | null) {
  client.weeklyGoal = trainingsPerWeek;
  await client.save();
  return {trainingsPerWeek};
}

// ---------------------------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------------------------

export function toMeasurementDto(m: MeasurementDoc) {
  const type = m.type as MeasurementType;
  return {
    id: m.id as string,
    type,
    value: m.value,
    unit: MEASUREMENT_TYPES[type].unit,
    measuredAt: m.measuredAt,
    note: m.note ?? null,
    createdAt: (m.get('createdAt') as Date).toISOString(),
  };
}

export async function listMeasurements(
  clientId: Types.ObjectId,
  query: {type?: MeasurementType; limit: number},
) {
  const items = await MeasurementModel.find({clientId, ...(query.type && {type: query.type})})
    .sort({measuredAt: -1, type: 1, _id: -1})
    .limit(query.limit);
  return {items: items.map(toMeasurementDto)};
}

/** Saves a measurement; the same type on the same day replaces the value (created: false). */
export async function saveMeasurement(client: UserDoc, input: z.output<typeof MeasurementBody>) {
  const zone = zoneOf(client);
  const today = todayIn(zone);
  const measuredAt = input.measuredAt ?? today;
  if (measuredAt > today) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {measuredAt: 'Cannot be in the future'},
    });
  }
  const note = input.note ? input.note : null;
  const existing = await MeasurementModel.findOne({
    clientId: client._id,
    type: input.type,
    measuredAt,
  });
  if (existing) {
    existing.value = input.value;
    existing.note = note;
    await existing.save();
    return {created: false, measurement: toMeasurementDto(existing)};
  }
  try {
    const created = await MeasurementModel.create({
      clientId: client._id,
      type: input.type,
      value: input.value,
      measuredAt,
      note,
    });
    return {created: true, measurement: toMeasurementDto(created)};
  } catch (error) {
    if ((error as {code?: number}).code !== 11000) throw error;
    // Saved by a parallel request for the same day: replace it.
    const same = await MeasurementModel.findOneAndUpdate(
      {clientId: client._id, type: input.type, measuredAt},
      {$set: {value: input.value, note}},
      {returnDocument: 'after'},
    );
    return {created: false, measurement: toMeasurementDto(same!)};
  }
}

export async function deleteMeasurement(client: UserDoc, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new AppError('NOT_FOUND', 'Measurement not found.');
  const deleted = await MeasurementModel.deleteOne({_id: id, clientId: client._id});
  if (deleted.deletedCount === 0) throw new AppError('NOT_FOUND', 'Measurement not found.');
}

export async function latestMeasurements(clientId: Types.ObjectId) {
  const latest = async (type: MeasurementType) => {
    const m = await MeasurementModel.findOne({clientId, type}).sort({measuredAt: -1});
    return m ? toMeasurementDto(m) : null;
  };
  return {
    weight: await latest('weight'),
    body_fat: await latest('body_fat'),
    waist: await latest('waist'),
  };
}

// ---------------------------------------------------------------------------------------------
// Coach access
// ---------------------------------------------------------------------------------------------

/** A client the coach has (or had) a booking with; otherwise NOT_FOUND. */
export async function coachClient(coach: UserDoc, clientId: string) {
  if (!Types.ObjectId.isValid(clientId)) throw new AppError('NOT_FOUND', 'Client not found.');
  const [client, booked] = await Promise.all([
    UserModel.findOne({_id: clientId, role: 'client'}),
    BookingModel.exists({coachId: coach._id, clientId}),
  ]);
  if (!client || !booked) throw new AppError('NOT_FOUND', 'Client not found.');
  return client;
}

export async function coachClientProgress(coach: UserDoc, clientId: string, weeks: number) {
  const client = await coachClient(coach, clientId);
  return {
    ...(await progressOf(client, weeks, coach._id)),
    measurements: {latest: await latestMeasurements(client._id)},
  };
}
