import {DateTime} from 'luxon';
import {Types} from 'mongoose';
import {describe, expect, it} from 'vitest';

import {BookingModel} from '../src/models/booking.js';
import {chicagoAt, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
const ZONE = 'America/Chicago';
type Auth = Record<string, string>;
const thisMonday = () => DateTime.now().setZone(ZONE).startOf('week');

/** Inserts a booking directly (progress only reads status, coach and start time). */
async function training(
  clientId: string,
  coachId: string,
  startAt: DateTime,
  status: 'completed' | 'confirmed' = 'completed',
) {
  const start = startAt.toJSDate();
  await BookingModel.create({
    sessionId: new Types.ObjectId(),
    coachId,
    clientId,
    status,
    price: {amountCents: 5000, currency: 'USD'},
    payment: {status: 'paid', method: 'mock', paidAt: start},
    startAt: start,
    endAt: new Date(start.getTime() + 3600_000),
  });
}
const progress = async (auth: Auth, weeks?: number) =>
  (
    await api()
      .get(`${v1}/me/progress${weeks ? `?weeks=${weeks}` : ''}`)
      .set(auth)
  ).body;
const setGoal = (auth: Auth, trainingsPerWeek: number | null) =>
  api().put(`${v1}/me/goal`).set(auth).send({trainingsPerWeek});

describe('progress', () => {
  it('buckets weeks (Monday start) in the client time zone: late Sunday counts for that Sunday', async () => {
    const client = await registerUser('client');
    const coach = await publishedCoach();
    // Sunday 23:30 in Chicago = Monday morning UTC.
    await training(client.user.id, coach.user.id, thisMonday().minus({minutes: 30}));
    const body = await progress(client.auth);
    expect(body.weekly).toHaveLength(12);
    expect(body.weekly.at(-1)).toEqual({weekStart: thisMonday().toISODate(), completed: 0});
    expect(body.weekly.at(-2)).toEqual({
      weekStart: thisMonday().minus({weeks: 1}).toISODate(),
      completed: 1,
    });
    expect(body.weekly[0].weekStart).toBe(thisMonday().minus({weeks: 11}).toISODate());
    expect(body.thisWeek).toMatchObject({weekStart: thisMonday().toISODate(), completed: 0});
    expect((await progress(client.auth, 4)).weekly).toHaveLength(4);
    expect((await api().get(`${v1}/me/progress?weeks=3`).set(client.auth)).status).toBe(400);
    expect((await api().get(`${v1}/me/progress?weeks=53`).set(client.auth)).status).toBe(400);
  });

  it('totals, planned and the streak with and without a goal', async () => {
    const client = await registerUser('client');
    const [c1, c2] = [await publishedCoach(), await publishedCoach()];
    const monday = thisMonday();
    const at = (weeksAgo: number, day = 0) =>
      monday.minus({weeks: weeksAgo}).plus({days: day, hours: 9});
    // Weeks ago: 1 -> 2 trainings, 2 -> 2, 3 -> 1, 4 -> 0, 5 -> 1.
    for (const [weeksAgo, day] of [
      [1, 0],
      [1, 2],
      [2, 1],
      [2, 3],
      [3, 4],
      [5, 2],
    ] as const) {
      await training(client.user.id, weeksAgo === 2 ? c2.user.id : c1.user.id, at(weeksAgo, day));
    }
    let body = await progress(client.auth);
    expect(body.goal).toEqual({trainingsPerWeek: null});
    expect(body.totals).toMatchObject({completed: 6, coaches: 2});
    expect(body.streakWeeks).toBe(3); // weeks 1..3 have >= 1 training, week 4 none

    expect((await setGoal(client.auth, 2)).body).toEqual({trainingsPerWeek: 2});
    body = await progress(client.auth);
    expect(body.goal).toEqual({trainingsPerWeek: 2});
    expect(body.streakWeeks).toBe(2); // weeks 1 and 2 meet 2/week; the current week does not yet

    // The current week counts once its goal is met.
    const now = DateTime.now().setZone(ZONE);
    await training(client.user.id, c1.user.id, now.minus({minutes: 10}));
    await training(client.user.id, c1.user.id, now.minus({minutes: 20}));
    body = await progress(client.auth);
    expect(body.thisWeek.completed).toBe(2);
    expect(body.streakWeeks).toBe(3);
    expect(body.totals.thisMonth).toBe(
      [
        now.minus({minutes: 10}),
        now.minus({minutes: 20}),
        ...[
          [1, 0],
          [1, 2],
          [2, 1],
          [2, 3],
          [3, 4],
          [5, 2],
        ].map(([w, d]) => at(w!, d)),
      ].filter(d => d >= now.startOf('month')).length,
    );

    // Planned: confirmed bookings later this week.
    const later = now.plus({minutes: 30});
    if (later < monday.plus({weeks: 1})) {
      await training(client.user.id, c1.user.id, later, 'confirmed');
      expect((await progress(client.auth)).thisWeek.planned).toBe(1);
    }

    // Remove the goal.
    expect((await setGoal(client.auth, null)).body).toEqual({trainingsPerWeek: null});
    expect((await progress(client.auth)).goal.trainingsPerWeek).toBeNull();
    for (const value of [0, 15, 2.5, '3']) {
      expect((await setGoal(client.auth, value as number)).status).toBe(400);
    }
  });
});

describe('measurements', () => {
  const post = (auth: Auth, body: Record<string, unknown>) =>
    api().post(`${v1}/me/measurements`).set(auth).send(body);

  it('validates type, range, decimals, date and note', async () => {
    const client = await registerUser('client');
    const bad = [
      {type: 'height', value: 70},
      {type: 'weight', value: 49.9},
      {type: 'weight', value: 700.1},
      {type: 'body_fat', value: 1.9},
      {type: 'body_fat', value: 70.5},
      {type: 'waist', value: 14},
      {type: 'waist', value: 80.5},
      {type: 'weight', value: 182.45},
      {type: 'weight', value: 182, measuredAt: '2026-13-01'},
      {
        type: 'weight',
        value: 182,
        measuredAt: DateTime.now().setZone(ZONE).plus({days: 2}).toISODate(),
      },
      {type: 'weight', value: 182, note: 'x'.repeat(201)},
    ];
    for (const body of bad) {
      const res = await post(client.auth, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const body of [
      {type: 'weight', value: 50},
      {type: 'body_fat', value: 18.5},
      {type: 'waist', value: 80},
    ]) {
      expect((await post(client.auth, body)).status).toBe(201);
    }
  });

  it('one value per type per day (replace -> 200), list newest first, filter, delete', async () => {
    const client = await registerUser('client');
    const today = DateTime.now().setZone(ZONE).toISODate();
    const first = await post(client.auth, {type: 'weight', value: 182.4, note: 'morning'});
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      type: 'weight',
      value: 182.4,
      unit: 'lb',
      measuredAt: today,
      note: 'morning',
    });
    const again = await post(client.auth, {type: 'weight', value: 181.9});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({id: first.body.id, value: 181.9, note: null});

    await post(client.auth, {
      type: 'weight',
      value: 184,
      measuredAt: DateTime.fromISO(today!).minus({days: 7}).toISODate(),
    });
    await post(client.auth, {type: 'waist', value: 34.5});
    await post(client.auth, {type: 'body_fat', value: 22});

    const all = await api().get(`${v1}/me/measurements`).set(client.auth);
    expect(all.body.items).toHaveLength(4);
    expect(all.body.items.at(-1)).toMatchObject({type: 'weight', value: 184});
    expect(all.body.items.find((m: {type: string}) => m.type === 'waist').unit).toBe('in');
    expect(all.body.items.find((m: {type: string}) => m.type === 'body_fat').unit).toBe('%');
    const weights = await api().get(`${v1}/me/measurements?type=weight&limit=1`).set(client.auth);
    expect(weights.body.items).toEqual([expect.objectContaining({id: first.body.id})]);
    expect((await api().get(`${v1}/me/measurements?limit=201`).set(client.auth)).status).toBe(400);

    expect(
      (await api().delete(`${v1}/me/measurements/${first.body.id}`).set(client.auth)).status,
    ).toBe(204);
    expect(
      (await api().delete(`${v1}/me/measurements/${first.body.id}`).set(client.auth)).status,
    ).toBe(404);
    const other = await registerUser('client');
    const theirs = await post(other.auth, {type: 'weight', value: 150});
    expect(
      (await api().delete(`${v1}/me/measurements/${theirs.body.id}`).set(client.auth)).status,
    ).toBe(404);
  });
});

describe('coach view', () => {
  it('a coach sees progress (own trainings) and measurements only of their clients', async () => {
    const coach = await publishedCoach();
    const otherCoach = await publishedCoach();
    const client = await registerUser('client');
    await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({sessionTypeId: coach.individualTypeId, startAt: chicagoAt(5, '10:00')});
    await training(client.user.id, coach.user.id, thisMonday().minus({weeks: 1}).plus({hours: 10}));
    await training(
      client.user.id,
      otherCoach.user.id,
      thisMonday().minus({weeks: 1}).plus({days: 1, hours: 10}),
    );
    await api().post(`${v1}/me/measurements`).set(client.auth).send({type: 'weight', value: 180});

    const res = await api()
      .get(`${v1}/coach/clients/${client.user.id}/progress?weeks=4`)
      .set(coach.auth);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({completed: 1, coaches: 1});
    expect(res.body.weekly.at(-2).completed).toBe(1);
    expect(res.body.measurements.latest).toMatchObject({
      weight: {type: 'weight', value: 180},
      body_fat: null,
      waist: null,
    });
    const list = await api()
      .get(`${v1}/coach/clients/${client.user.id}/measurements`)
      .set(coach.auth);
    expect(list.body.items).toHaveLength(1);

    // Not my client / unknown / role checks.
    const third = await publishedCoach();
    expect(
      (await api().get(`${v1}/coach/clients/${client.user.id}/progress`).set(third.auth)).status,
    ).toBe(404);
    expect(
      (await api().get(`${v1}/coach/clients/${client.user.id}/measurements`).set(third.auth))
        .status,
    ).toBe(404);
    expect(
      (await api().get(`${v1}/coach/clients/0123456789abcdef01234567/progress`).set(coach.auth))
        .status,
    ).toBe(404);
    expect(
      (await api().get(`${v1}/coach/clients/${client.user.id}/progress`).set(client.auth)).status,
    ).toBe(403);
    expect((await api().get(`${v1}/me/progress`).set(coach.auth)).status).toBe(403);
    expect(
      (await api().put(`${v1}/me/goal`).set(coach.auth).send({trainingsPerWeek: 3})).status,
    ).toBe(403);
  });
});
