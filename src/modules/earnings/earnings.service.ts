import {DateTime} from 'luxon';
import type {Types} from 'mongoose';

import {AppError} from '../../lib/errors.js';
import {BookingModel} from '../../models/booking.js';
import {ClientPackageModel} from '../../models/package.js';
import {TrainingSessionModel} from '../../models/trainingSession.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {toUserSummary} from '../users/users.service.js';

type Period = 'week' | 'month' | 'year';
const usd = (amountCents: number) => ({amountCents, currency: 'USD' as const});

function periodRange(period: Period, day: DateTime) {
  const unit = period === 'week' ? 'week' : period === 'month' ? 'month' : 'year';
  const start = day.startOf(unit);
  return {start, end: start.plus({[`${unit}s`]: 1})};
}

/**
 * Money of one period: card-paid trainings (mock payments; credit bookings are counted as package sales) by start
 * time, package purchases by purchase time, refunds by refund time.
 */
async function periodMoney(coachId: Types.ObjectId, start: DateTime, end: DateTime) {
  const from = start.toJSDate();
  const to = end.toJSDate();
  const now = new Date();
  const [bookings, packages, refunded] = await Promise.all([
    BookingModel.find({
      coachId,
      status: {$in: ['confirmed', 'completed', 'no_show']},
      'payment.status': 'paid',
      'payment.method': 'mock',
      startAt: {$gte: from, $lt: to},
    })
      .select('clientId sessionId startAt price')
      .lean(),
    ClientPackageModel.find({coachId, purchasedAt: {$gte: from, $lt: to}})
      .select('clientId price purchasedAt')
      .lean(),
    BookingModel.find({
      coachId,
      'payment.status': 'refunded',
      'payment.method': 'mock',
      'payment.refundedAt': {$gte: from, $lt: to},
    })
      .select('price')
      .lean(),
  ]);
  const earned = bookings.filter(b => b.startAt <= now);
  const upcoming = bookings.filter(b => b.startAt > now);
  return {earned, upcoming, packages, refunded};
}

const sum = (items: {price: {amountCents: number}}[]) =>
  items.reduce((total, item) => total + item.price.amountCents, 0);

export async function coachEarnings(coach: UserDoc, period: Period, date?: string) {
  const zone = coach.homeArea?.timezone ?? 'America/Chicago';
  const day = date ? DateTime.fromISO(date, {zone}) : DateTime.now().setZone(zone);
  if (!day.isValid) {
    throw new AppError('VALIDATION_ERROR', undefined, {fields: {date: 'Invalid date'}});
  }
  const {start, end} = periodRange(period, day);
  const previous = periodRange(period, start.minus({days: 1}));
  const [current, before] = await Promise.all([
    periodMoney(coach._id, start, end),
    periodMoney(coach._id, previous.start, previous.end),
  ]);

  const total = sum(current.earned) + sum(current.packages);
  const previousTotal = sum(before.earned) + sum(before.packages);

  // Individual / group split of the earned trainings.
  const sessions = await TrainingSessionModel.find({
    _id: {$in: current.earned.map(b => b.sessionId)},
  })
    .select('kind')
    .lean();
  const kindById = new Map(sessions.map(s => [s._id.toString(), s.kind]));
  const group = current.earned.filter(b => kindById.get(b.sessionId.toString()) === 'group');
  const individual = current.earned.filter(b => kindById.get(b.sessionId.toString()) !== 'group');

  // Chart buckets: days (week / month) or months (year).
  const bucketUnit = period === 'year' ? 'month' : 'day';
  const chart: {start: string; amount: ReturnType<typeof usd>}[] = [];
  const bucketIndex = new Map<string, number>();
  for (let cursor = start; cursor < end; cursor = cursor.plus({[`${bucketUnit}s`]: 1})) {
    bucketIndex.set(cursor.toISODate()!, chart.length);
    chart.push({start: cursor.toISODate()!, amount: usd(0)});
  }
  const add = (at: Date, cents: number) => {
    const key = DateTime.fromJSDate(at, {zone}).startOf(bucketUnit).toISODate()!;
    const index = bucketIndex.get(key);
    if (index !== undefined) chart[index]!.amount.amountCents += cents;
  };
  for (const b of current.earned) add(b.startAt, b.price.amountCents);
  for (const p of current.packages) add(p.purchasedAt, p.price.amountCents);

  // Top clients: trainings + packages.
  const byClient = new Map<string, {amount: number; trainings: number}>();
  const bump = (clientId: Types.ObjectId, cents: number, training: boolean) => {
    const key = clientId.toString();
    const entry = byClient.get(key) ?? {amount: 0, trainings: 0};
    entry.amount += cents;
    if (training) entry.trainings += 1;
    byClient.set(key, entry);
  };
  for (const b of current.earned) bump(b.clientId, b.price.amountCents, true);
  for (const p of current.packages) bump(p.clientId, p.price.amountCents, false);
  const top = [...byClient.entries()]
    .sort((a, b) => b[1].amount - a[1].amount || b[1].trainings - a[1].trainings)
    .slice(0, 5);
  const users = await UserModel.find({_id: {$in: top.map(([id]) => id)}})
    .select('firstName lastName avatarUrl')
    .lean();
  const userById = new Map(users.map(u => [u._id.toString(), u]));

  return {
    period,
    from: start.toISODate()!,
    to: end.minus({days: 1}).toISODate()!,
    total: usd(total),
    upcoming: usd(sum(current.upcoming)),
    previousTotal: usd(previousTotal),
    changePercent:
      previousTotal === 0 ? null : Math.round(((total - previousTotal) / previousTotal) * 100),
    breakdown: {
      individual: usd(sum(individual)),
      group: usd(sum(group)),
      packages: usd(sum(current.packages)),
      refunds: usd(sum(current.refunded)),
    },
    counts: {
      trainings: current.earned.length,
      packagesSold: current.packages.length,
      clients: byClient.size,
    },
    chart,
    topClients: top.map(([id, entry]) => {
      const user = userById.get(id);
      return {
        client: user ? toUserSummary(user) : {id, firstName: '', lastName: '', avatarUrl: null},
        amount: usd(entry.amount),
        trainings: entry.trainings,
      };
    }),
  };
}
