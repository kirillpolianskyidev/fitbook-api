import {DateTime} from 'luxon';
import {Types} from 'mongoose';
import {describe, expect, it} from 'vitest';

import {BookingModel} from '../src/models/booking.js';
import {ClientPackageModel} from '../src/models/package.js';
import {TrainingSessionModel} from '../src/models/trainingSession.js';
import {publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
const ZONE = 'America/Chicago';
type Auth = Record<string, string>;
const usd = (amountCents: number) => ({amountCents, currency: 'USD' as const});

type Opts = {
  status?: string;
  method?: 'mock' | 'credits';
  paymentStatus?: 'paid' | 'refunded' | 'not_required';
  refundedAt?: Date;
  kind?: 'individual' | 'group';
};
/** Inserts a booking (and its session) of the coach directly. */
async function booking(
  coachId: string,
  clientId: string,
  startAt: DateTime,
  cents: number,
  o: Opts = {},
) {
  const start = startAt.toJSDate();
  const end = new Date(start.getTime() + 3600_000);
  const session = await TrainingSessionModel.create({
    coachId,
    sessionTypeId: new Types.ObjectId(),
    kind: o.kind ?? 'individual',
    title: 'T',
    startAt: start,
    endAt: end,
    capacity: o.kind === 'group' ? 5 : 1,
    price: usd(cents),
  });
  await BookingModel.create({
    sessionId: session._id,
    coachId,
    clientId,
    status: (o.status ?? (end <= new Date() ? 'completed' : 'confirmed')) as 'completed',
    price: usd(cents),
    payment: {
      status: o.paymentStatus ?? 'paid',
      method: o.method ?? 'mock',
      paidAt: start,
      refundedAt: o.refundedAt,
    },
    startAt: start,
    endAt: end,
  });
}
const earnings = async (auth: Auth, query: string) =>
  (await api().get(`${v1}/coach/earnings?${query}`).set(auth)).body;

describe('coach earnings', () => {
  it('earned vs upcoming, credits not counted, packages by purchase date, refunds and no-shows', async () => {
    const coach = await publishedCoach();
    const a = await registerUser('client');
    const b = await registerUser('client');
    const now = DateTime.now().setZone(ZONE);
    const c = coach.user.id;
    await booking(c, a.user.id, now.minus({hours: 2}), 8500); // earned
    await booking(c, b.user.id, now.minus({hours: 3}), 2500, {kind: 'group'}); // earned (group)
    await booking(c, a.user.id, now.plus({hours: 1}), 8500); // upcoming
    await booking(c, a.user.id, now.minus({hours: 4}), 8500, {method: 'credits'}); // not income
    await booking(c, b.user.id, now.minus({hours: 5}), 6000, {
      status: 'cancelled',
      paymentStatus: 'refunded',
      refundedAt: now.minus({hours: 1}).toJSDate(),
    }); // refund
    await booking(c, b.user.id, now.minus({hours: 6}), 4000, {status: 'no_show'}); // no-show kept -> income
    await booking(c, b.user.id, now.minus({hours: 7}), 3000, {
      status: 'no_show',
      paymentStatus: 'refunded',
      refundedAt: now.minus({hours: 1}).toJSDate(),
    }); // no-show refunded -> not income
    await booking(c, a.user.id, now.minus({hours: 8}), 0, {paymentStatus: 'not_required'}); // trial
    await ClientPackageModel.create({
      clientId: a.user.id,
      coachId: c,
      packageId: new Types.ObjectId(),
      title: '10',
      creditsTotal: 10,
      creditsLeft: 9,
      price: usd(70000),
      purchasedAt: now.minus({hours: 1}).toJSDate(),
      expiresAt: now.plus({days: 90}).toJSDate(),
    });

    const res = await earnings(coach.auth, 'period=month');
    expect(res.period).toBe('month');
    expect(res.from).toBe(now.startOf('month').toISODate());
    expect(res.to).toBe(now.endOf('month').toISODate());
    expect(res.breakdown).toEqual({
      individual: usd(8500 + 4000),
      group: usd(2500),
      packages: usd(70000),
      refunds: usd(6000 + 3000),
    });
    expect(res.total).toEqual(usd(8500 + 2500 + 4000 + 70000));
    expect(res.upcoming).toEqual(usd(8500));
    expect(res.counts).toEqual({trainings: 3, packagesSold: 1, clients: 2});
    expect(res.chart).toHaveLength(now.daysInMonth!);
    const today = res.chart.find((p: {start: string}) => p.start === now.toISODate());
    expect(today.amount.amountCents).toBeGreaterThan(0);
    expect(
      res.chart.reduce(
        (n: number, p: {amount: {amountCents: number}}) => n + p.amount.amountCents,
        0,
      ),
    ).toBe(res.total.amountCents);
    expect(res.topClients[0]).toMatchObject({
      client: {id: a.user.id},
      amount: usd(78500),
      trainings: 1,
    });
    expect(res.topClients[1]).toMatchObject({
      client: {id: b.user.id},
      amount: usd(6500),
      trainings: 2,
    });
  });

  it("week and month boundaries in the coach's time zone; changePercent; year chart", async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const c = coach.user.id;
    // A week 5 weeks ago: Sunday 23:30 (inside), next Monday 00:30 (next week).
    const monday = DateTime.now().setZone(ZONE).startOf('week').minus({weeks: 5});
    const sunday = monday.plus({days: 6}).set({hour: 23, minute: 30});
    await booking(c, client.user.id, sunday, 10000);
    await booking(c, client.user.id, monday.plus({weeks: 1, minutes: 30}), 15000);
    const week = await earnings(
      coach.auth,
      `period=week&date=${monday.plus({days: 2}).toISODate()}`,
    );
    expect(week).toMatchObject({
      from: monday.toISODate(),
      to: sunday.toISODate(),
      total: usd(10000),
    });
    expect(week.chart).toHaveLength(7);
    expect(week.chart[6]).toEqual({start: sunday.toISODate(), amount: usd(10000)});
    const next = await earnings(
      coach.auth,
      `period=week&date=${monday.plus({weeks: 1}).toISODate()}`,
    );
    expect(next).toMatchObject({total: usd(15000), previousTotal: usd(10000), changePercent: 50});

    // Month: Oct 31 23:30 belongs to October, Nov 1 00:10 to November (last year, all earned).
    const year = DateTime.now().setZone(ZONE).year - 1;
    const oct31 = DateTime.fromObject(
      {year, month: 10, day: 31, hour: 23, minute: 30},
      {zone: ZONE},
    );
    await booking(c, client.user.id, oct31, 5000);
    await booking(c, client.user.id, oct31.plus({minutes: 40}), 7000);
    const october = await earnings(coach.auth, `period=month&date=${year}-10-15`);
    expect(october).toMatchObject({
      from: `${year}-10-01`,
      to: `${year}-10-31`,
      total: usd(5000),
      changePercent: null,
    });
    expect((await earnings(coach.auth, `period=month&date=${year}-11-02`)).total).toEqual(
      usd(7000),
    );
    const wholeYear = await earnings(coach.auth, `period=year&date=${year}-06-01`);
    expect(wholeYear.chart).toHaveLength(12);
    expect(wholeYear.chart[9]).toEqual({start: `${year}-10-01`, amount: usd(5000)});
    expect(wholeYear.chart[10]).toEqual({start: `${year}-11-01`, amount: usd(7000)});
  });

  it('empty period, validation and role', async () => {
    const coach = await publishedCoach();
    const empty = await earnings(coach.auth, 'period=year');
    expect(empty).toMatchObject({
      total: usd(0),
      upcoming: usd(0),
      changePercent: null,
      topClients: [],
      counts: {trainings: 0},
    });
    expect((await api().get(`${v1}/coach/earnings?period=day`).set(coach.auth)).status).toBe(400);
    expect(
      (await api().get(`${v1}/coach/earnings?period=week&date=2026-02-30`).set(coach.auth)).status,
    ).toBe(400);
    const client = await registerUser('client');
    expect((await api().get(`${v1}/coach/earnings`).set(client.auth)).status).toBe(403);
  });
});
