import {DateTime} from 'luxon';
import {describe, expect, it} from 'vitest';

import {BookingModel} from '../src/models/booking.js';
import {chicagoAt, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
const ZONE = 'America/Chicago';

/** A paid series: every day at 08:00 for 4 days starting in 3 days. */
async function paidSeries(options: {pay?: boolean} = {}) {
  const coach = await publishedCoach();
  const client = await registerUser('client');
  const startDate = chicagoAt(3, '00:00').slice(0, 10);
  const dates = [0, 1, 2, 3].map(i => DateTime.fromISO(startDate).plus({days: i}).toISODate()!);
  const res = await api()
    .post(`${v1}/bookings/series`)
    .set(client.auth)
    .send({
      sessionTypeId: coach.individualTypeId,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      time: '08:00',
      weeks: 1,
      startDate,
      dates,
    });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const seriesId = res.body.seriesId as string;
  if (options.pay !== false)
    await api().post(`${v1}/bookings/series/${seriesId}/pay`).set(client.auth);
  return {
    coach,
    client,
    seriesId,
    dates,
    bookings: res.body.bookings as {id: string; startAt: string}[],
  };
}
const get = (auth: Auth, id: string) => api().get(`${v1}/bookings/series/${id}`).set(auth);

describe('series: details', () => {
  it('returns the pattern, bookings and extend info; coach can read; others are forbidden', async () => {
    const {coach, client, seriesId, dates} = await paidSeries();
    const res = await get(client.auth, seriesId);
    expect(res.status).toBe(200);
    const last = DateTime.fromISO(dates.at(-1)!, {zone: ZONE});
    expect(res.body).toMatchObject({
      id: seriesId,
      sessionType: {
        id: coach.individualTypeId,
        title: '1:1 Strength',
        durationMin: 60,
        isActive: true,
      },
      coach: {id: coach.user.id},
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      time: '08:00',
      timezone: ZONE,
      format: 'in_person',
      upcomingCount: 4,
      canExtend: true,
      extendFrom: last.startOf('week').plus({weeks: 1}).toISODate(),
    });
    expect(res.body.bookings).toHaveLength(4);
    expect(res.body.nextAt).toBe(res.body.bookings[0].startAt);
    expect(res.body.lastAt).toBe(res.body.bookings[3].startAt);
    expect((await get(coach.auth, seriesId)).status).toBe(200);
    const stranger = await registerUser('client');
    expect((await get(stranger.auth, seriesId)).status).toBe(403);
    expect((await get(client.auth, '0123456789abcdef01234567')).status).toBe(404);
  });
});

describe('series: cancel all upcoming', () => {
  it('cancels and refunds; bookings past their deadline are kept; nothing left -> 409', async () => {
    const {client, seriesId, bookings} = await paidSeries();
    // The first booking is now within the 24h deadline.
    const soon = new Date(Date.now() + 5 * 3600_000);
    await BookingModel.updateOne(
      {_id: bookings[0]!.id},
      {startAt: soon, endAt: new Date(soon.getTime() + 3600_000)},
    );
    const stranger = await registerUser('client');
    expect(
      (await api().post(`${v1}/bookings/series/${seriesId}/cancel`).set(stranger.auth).send({}))
        .status,
    ).toBe(403);

    const res = await api()
      .post(`${v1}/bookings/series/${seriesId}/cancel`)
      .set(client.auth)
      .send({reason: 'Moving away'});
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toHaveLength(3);
    for (const b of res.body.cancelled) {
      expect(b).toMatchObject({
        status: 'cancelled',
        cancelReason: 'Moving away',
        payment: {status: 'refunded'},
      });
    }
    expect(res.body.kept).toEqual([
      {
        bookingId: bookings[0]!.id,
        startAt: soon.toISOString(),
        reason: 'CANCELLATION_WINDOW_PASSED',
      },
    ]);
    const again = await api()
      .post(`${v1}/bookings/series/${seriesId}/cancel`)
      .set(client.auth)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CANCELLATION_WINDOW_PASSED');
  });
});

describe('series: reschedule all upcoming', () => {
  it('pairs bookings in order with the new dates, keeps taken ones, updates the pattern, keeps payment', async () => {
    const {coach, client, seriesId, bookings, dates} = await paidSeries();
    // New pattern: 18:00 on the same days. Someone else takes 18:00 on the 2nd date.
    const other = await registerUser('client');
    const taken = DateTime.fromISO(`${dates[1]}T18:00`, {zone: ZONE}).toUTC().toISO()!;
    expect(
      (
        await api()
          .post(`${v1}/bookings`)
          .set(other.auth)
          .send({sessionTypeId: coach.individualTypeId, startAt: taken})
      ).status,
    ).toBe(201);
    const body = {weekdays: [0, 1, 2, 3, 4, 5, 6], time: '18:00', startDate: dates[0]};

    const preview = await api()
      .post(`${v1}/bookings/series/${seriesId}/reschedule/preview`)
      .set(client.auth)
      .send(body);
    expect(preview.status).toBe(200);
    expect(preview.body.items.map((i: {bookingId: string}) => i.bookingId)).toEqual(
      bookings.map(b => b.id),
    );
    expect(preview.body.items[0]).toMatchObject({
      fromStartAt: bookings[0]!.startAt,
      date: dates[0],
      startAt: DateTime.fromISO(`${dates[0]}T18:00`, {zone: ZONE}).toUTC().toISO(),
      available: true,
      reason: null,
    });
    expect(preview.body.items[1]).toMatchObject({
      date: dates[1],
      available: false,
      reason: 'UNAVAILABLE',
    });

    const res = await api()
      .post(`${v1}/bookings/series/${seriesId}/reschedule`)
      .set(client.auth)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.moved.map((b: {id: string}) => b.id)).toEqual([
      bookings[0]!.id,
      bookings[2]!.id,
      bookings[3]!.id,
    ]);
    expect(res.body.moved[0]).toMatchObject({
      status: 'confirmed',
      payment: {status: 'paid'},
      seriesId,
    });
    expect(res.body.moved[0].rescheduledAt).toEqual(expect.any(String));
    expect(res.body.kept).toEqual([{bookingId: bookings[1]!.id, reason: 'UNAVAILABLE'}]);
    const series = await get(client.auth, seriesId);
    expect(series.body).toMatchObject({time: '18:00'});
    expect(series.body.bookings.find((b: {id: string}) => b.id === bookings[1]!.id).startAt).toBe(
      bookings[1]!.startAt,
    );

    const yesterday = DateTime.now().setZone(ZONE).minus({days: 1}).toISODate();
    const past = await api()
      .post(`${v1}/bookings/series/${seriesId}/reschedule/preview`)
      .set(client.auth)
      .send({...body, startDate: yesterday});
    expect(past.status).toBe(400);
  });

  it('no movable booking -> RESCHEDULE_WINDOW_PASSED', async () => {
    const {client, seriesId} = await paidSeries();
    await BookingModel.updateMany({seriesId}, {status: 'cancelled'});
    const res = await api()
      .post(`${v1}/bookings/series/${seriesId}/reschedule/preview`)
      .set(client.auth)
      .send({weekdays: [1], time: '09:00', startDate: chicagoAt(3, '00:00').slice(0, 10)});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESCHEDULE_WINDOW_PASSED');
  });
});

describe('series: extend', () => {
  it('extends into the same series: pending payment, paid with /pay; with credits confirmed', async () => {
    const {coach, client, seriesId} = await paidSeries();
    const preview = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend/preview`)
      .set(client.auth)
      .send({weeks: 1});
    expect(preview.status).toBe(200);
    expect(preview.body.items).toHaveLength(7);
    const series = await get(client.auth, seriesId);
    expect(preview.body.items[0].date).toBe(series.body.extendFrom);
    const dates = preview.body.items.slice(0, 2).map((i: {date: string}) => i.date);

    const extended = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend`)
      .set(client.auth)
      .send({weeks: 1, dates});
    expect(extended.status).toBe(201);
    expect(extended.body.seriesId).toBe(seriesId);
    expect(extended.body.bookings).toHaveLength(2);
    for (const b of extended.body.bookings)
      expect(b).toMatchObject({status: 'pending_payment', seriesId});
    const paid = await api().post(`${v1}/bookings/series/${seriesId}/pay`).set(client.auth);
    expect(paid.body.paidCount).toBe(2);
    expect((await get(client.auth, seriesId)).body.upcomingCount).toBe(6);

    // With credits.
    const pkg = await api()
      .post(`${v1}/coach/packages`)
      .set(coach.auth)
      .send({title: '5', credits: 5, price: {amountCents: 30000, currency: 'USD'}});
    await api().post(`${v1}/packages/${pkg.body.id}/purchase`).set(client.auth);
    // extendFrom moved after the first extension: preview again.
    const next = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend/preview`)
      .set(client.auth)
      .send({weeks: 1});
    expect(next.body.items[0].date > preview.body.items.at(-1).date).toBe(true);
    const more = next.body.items.slice(0, 2).map((i: {date: string}) => i.date);
    const withCredits = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend`)
      .set(client.auth)
      .send({weeks: 1, dates: more, useCredits: true});
    expect(withCredits.status).toBe(201);
    for (const b of withCredits.body.bookings) {
      expect(b).toMatchObject({status: 'confirmed', payment: {method: 'credits'}, seriesId});
    }
  });

  it('not extendable: inactive type or the last training ended more than 14 days ago', async () => {
    const {coach, client, seriesId} = await paidSeries();
    await api()
      .patch(`${v1}/coach/session-types/${coach.individualTypeId}`)
      .set(coach.auth)
      .send({isActive: false});
    expect((await get(client.auth, seriesId)).body.canExtend).toBe(false);
    const preview = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend/preview`)
      .set(client.auth)
      .send({weeks: 2});
    expect(preview.status).toBe(409);
    expect(preview.body.error).toMatchObject({
      code: 'SERIES_NOT_EXTENDABLE',
      message: 'This series can no longer be extended.',
    });
    const extend = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend`)
      .set(client.auth)
      .send({weeks: 1, dates: ['2030-01-01']});
    expect(extend.body.error.code).toBe('SESSION_TYPE_INACTIVE');

    await api()
      .patch(`${v1}/coach/session-types/${coach.individualTypeId}`)
      .set(coach.auth)
      .send({isActive: true});
    const old = new Date(Date.now() - 20 * 86_400_000);
    await BookingModel.updateMany(
      {seriesId},
      {startAt: old, endAt: new Date(old.getTime() + 3600_000), status: 'completed'},
    );
    expect((await get(client.auth, seriesId)).body.canExtend).toBe(false);
    const stranger = await registerUser('client');
    expect(
      (
        await api()
          .post(`${v1}/bookings/series/${seriesId}/extend/preview`)
          .set(stranger.auth)
          .send({weeks: 1})
      ).status,
    ).toBe(403);
  });
});
