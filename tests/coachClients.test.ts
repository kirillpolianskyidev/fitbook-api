import {describe, expect, it} from 'vitest';

import {BookingModel} from '../src/models/booking.js';
import {chicagoAt, groupSession, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
type Coach = Awaited<ReturnType<typeof publishedCoach>>;

async function bookAt(auth: Auth, coach: Coach, day: number, time = '09:00') {
  const res = await api()
    .post(`${v1}/bookings`)
    .set(auth)
    .send({sessionTypeId: coach.individualTypeId, startAt: chicagoAt(day, time)});
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as {id: string; startAt: string};
}
/** Moves a booking into the past with the given status. */
async function past(id: string, daysAgo: number, status: string) {
  const startAt = new Date(Date.now() - daysAgo * 86_400_000);
  await BookingModel.updateOne(
    {_id: id},
    {startAt, endAt: new Date(startAt.getTime() + 3600_000), status},
  );
  return startAt.toISOString();
}
const clients = (coach: Coach, query = '') =>
  api().get(`${v1}/coach/clients${query}`).set(coach.auth);

describe('coach clients: next / last training', () => {
  it('nextBookingAt is the nearest upcoming booking; lastTrainedAt the latest trained one', async () => {
    const coach = await publishedCoach();
    const jamie = await registerUser('client', {firstName: 'Jamie'});
    const soon = await bookAt(jamie.auth, coach, 1);
    const later = await bookAt(jamie.auth, coach, 3);
    const farthest = await bookAt(jamie.auth, coach, 10);
    const trained = await past((await bookAt(jamie.auth, coach, 4)).id, 2, 'completed');
    await past((await bookAt(jamie.auth, coach, 5)).id, 6, 'confirmed');
    // Not trainings: a newer no-show and an unpaid booking that did not happen.
    await past((await bookAt(jamie.auth, coach, 6)).id, 1, 'no_show');
    await past((await bookAt(jamie.auth, coach, 7)).id, 1.5, 'pending_payment');

    const res = await clients(coach);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      id: jamie.user.id,
      totalBookings: 6,
      lastBookingAt: farthest.startAt,
      nextBookingAt: soon.startAt,
      lastTrainedAt: trained,
    });

    // Cancelling the nearest booking moves nextBookingAt to the next one.
    await api().post(`${v1}/bookings/${soon.id}/cancel`).set(jamie.auth).send({});
    expect((await clients(coach)).body.items[0].nextBookingAt).toBe(later.startAt);
  });

  it('group sessions count with the session time', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const sessionId = await groupSession(coach, chicagoAt(2, '18:00'));
    await api().post(`${v1}/bookings`).set(client.auth).send({sessionId});
    expect((await clients(coach)).body.items[0]).toMatchObject({
      nextBookingAt: chicagoAt(2, '18:00'),
      lastTrainedAt: null,
    });
  });

  it('sorting: upcoming (soonest first), then last trained (latest first), then by name; search', async () => {
    const coach = await publishedCoach();
    const make = (firstName: string, lastName: string) =>
      registerUser('client', {firstName, lastName});
    const upcomingLater = await make('Uma', 'Later');
    const upcomingSoon = await make('Zed', 'Soon');
    const trainedOld = await make('Olga', 'Old');
    const trainedRecent = await make('Rita', 'Recent');
    const noneB = await make('Bob', 'Zane');
    const noneA = await make('Bob', 'Adams');
    const cancelledOnly = await make('Carl', 'Cancelled');

    await bookAt(upcomingLater.auth, coach, 5);
    await bookAt(upcomingSoon.auth, coach, 2);
    await past((await bookAt(trainedOld.auth, coach, 3)).id, 20, 'completed');
    await past((await bookAt(trainedRecent.auth, coach, 4)).id, 3, 'completed');
    await past((await bookAt(noneB.auth, coach, 6)).id, 2, 'no_show');
    await past((await bookAt(noneA.auth, coach, 7)).id, 2, 'pending_payment');
    const cancelled = await bookAt(cancelledOnly.auth, coach, 8);
    await api().post(`${v1}/bookings/${cancelled.id}/cancel`).set(cancelledOnly.auth).send({});

    const res = await clients(coach);
    expect(res.body.items.map((c: {id: string}) => c.id)).toEqual([
      upcomingSoon.user.id,
      upcomingLater.user.id,
      trainedRecent.user.id,
      trainedOld.user.id,
      noneA.user.id,
      noneB.user.id,
    ]);
    expect(res.body.items.at(-1)).toMatchObject({nextBookingAt: null, lastTrainedAt: null});

    const found = await clients(coach, '?search=bob');
    expect(found.body.items.map((c: {id: string}) => c.id)).toEqual([noneA.user.id, noneB.user.id]);
  });
});
