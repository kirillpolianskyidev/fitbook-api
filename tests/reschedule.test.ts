import {describe, expect, it} from 'vitest';

import {BookingModel} from '../src/models/booking.js';
import {chicagoAt, groupSession, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
const book = (auth: Auth, body: Record<string, unknown>) =>
  api().post(`${v1}/bookings`).set(auth).send(body);
const reschedule = (auth: Auth, id: string, body: Record<string, unknown>) =>
  api().post(`${v1}/bookings/${id}/reschedule`).set(auth).send(body);
const pay = (auth: Auth, id: string) => api().post(`${v1}/bookings/${id}/pay`).set(auth);

describe('reschedule: individual', () => {
  it('moves a paid booking with notes; payment, price and id stay; old slot is free again', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const oldStart = chicagoAt(5, '10:00');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: oldStart,
    });
    expect(booking.body).toMatchObject({
      reschedulable: true,
      rescheduledAt: null,
      session: {sessionTypeId: coach.individualTypeId},
    });
    const paid = await pay(client.auth, booking.body.id);
    await api()
      .post(`${v1}/bookings/${booking.body.id}/notes`)
      .set(client.auth)
      .send({phase: 'before', text: 'Knee is a bit sore'});

    const newStart = chicagoAt(6, '15:00');
    const res = await reschedule(client.auth, booking.body.id, {startAt: newStart});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: booking.body.id,
      status: 'confirmed',
      startAt: newStart,
      price: paid.body.price,
      payment: {status: 'paid', paidAt: paid.body.payment.paidAt, refundedAt: null},
      notesCount: 1,
      reschedulable: true,
      cancellable: true,
      session: {sessionTypeId: coach.individualTypeId},
    });
    expect(Date.parse(res.body.endAt) - Date.parse(newStart)).toBe(60 * 60_000);
    expect(Date.parse(res.body.cancelDeadline)).toBe(Date.parse(newStart) - 24 * 3600_000);
    expect(Date.now() - Date.parse(res.body.rescheduledAt)).toBeLessThan(60_000);

    // The coach schedule shows the new time.
    const schedule = await api()
      .get(
        `${v1}/coach/schedule?from=${encodeURIComponent(chicagoAt(0, '00:00'))}&to=${encodeURIComponent(chicagoAt(8, '00:00'))}`,
      )
      .set(coach.auth);
    expect(
      schedule.body.items.map((item: {session: {startAt: string}}) => item.session.startAt),
    ).toEqual([newStart]);

    // The old slot can be booked again by someone else.
    const other = await registerUser('client');
    expect(
      (await book(other.auth, {sessionTypeId: coach.individualTypeId, startAt: oldStart})).status,
    ).toBe(201);
  });

  it('can move by 30 minutes into its own slot; pending payment keeps expiresAt; trial stays trial', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const pending = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '10:00'),
    });
    const moved = await reschedule(client.auth, pending.body.id, {
      startAt: chicagoAt(5, '10:30'),
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      status: 'pending_payment',
      expiresAt: pending.body.expiresAt,
      payment: {status: 'unpaid'},
    });

    const trial = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '10:00'),
      isTrial: true,
    });
    const trialMoved = await reschedule(client.auth, trial.body.id, {
      startAt: chicagoAt(6, '12:00'),
    });
    expect(trialMoved.body).toMatchObject({
      isTrial: true,
      price: {amountCents: 0},
      payment: {status: 'not_required'},
    });
  });

  it('a taken slot -> SLOT_UNAVAILABLE; same time and bad bodies -> VALIDATION_ERROR', async () => {
    const coach = await publishedCoach();
    const a = await registerUser('client');
    const b = await registerUser('client');
    const mine = await book(a.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '10:00'),
    });
    await book(b.auth, {sessionTypeId: coach.individualTypeId, startAt: chicagoAt(5, '14:00')});

    const taken = await reschedule(a.auth, mine.body.id, {startAt: chicagoAt(5, '14:00')});
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('SLOT_UNAVAILABLE');
    const overlapping = await reschedule(a.auth, mine.body.id, {startAt: chicagoAt(5, '13:30')});
    expect(overlapping.body.error.code).toBe('SLOT_UNAVAILABLE');
    const offGrid = await reschedule(a.auth, mine.body.id, {startAt: chicagoAt(5, '11:10')});
    expect(offGrid.body.error.code).toBe('SLOT_UNAVAILABLE');

    const same = await reschedule(a.auth, mine.body.id, {startAt: chicagoAt(5, '10:00')});
    expect(same.status).toBe(400);
    expect(same.body.error.details.fields.startAt).toBeDefined();
    for (const body of [{}, {startAt: chicagoAt(6, '10:00'), sessionId: mine.body.session.id}]) {
      const res = await reschedule(a.auth, mine.body.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const wrongKind = await reschedule(a.auth, mine.body.id, {sessionId: mine.body.session.id});
    expect(wrongKind.body.error.details.fields.startAt).toBeDefined();
    const badDate = await reschedule(a.auth, mine.body.id, {startAt: 'tomorrow'});
    expect(badDate.body.error.code).toBe('VALIDATION_ERROR');

    // Nothing changed after the failed attempts.
    const after = await api().get(`${v1}/bookings/${mine.body.id}`).set(a.auth);
    expect(after.body).toMatchObject({startAt: chicagoAt(5, '10:00'), rescheduledAt: null});
  });

  it('after the deadline or when cancelled -> RESCHEDULE_WINDOW_PASSED', async () => {
    const coach = await publishedCoach({freeCancelHours: 48});
    const client = await registerUser('client');
    const soon = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(1, '21:00'),
    });
    await pay(client.auth, soon.body.id);
    const details = await api().get(`${v1}/bookings/${soon.body.id}`).set(client.auth);
    expect(details.body.reschedulable).toBe(false);
    const late = await reschedule(client.auth, soon.body.id, {startAt: chicagoAt(6, '10:00')});
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({
      code: 'RESCHEDULE_WINDOW_PASSED',
      message: 'It is too late to reschedule this training.',
    });

    const later = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '10:00'),
    });
    await api().post(`${v1}/bookings/${later.body.id}/cancel`).set(client.auth).send({});
    const cancelled = await reschedule(client.auth, later.body.id, {
      startAt: chicagoAt(6, '12:00'),
    });
    expect(cancelled.body.error.code).toBe('RESCHEDULE_WINDOW_PASSED');
  });

  it('only the client of the booking can reschedule', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const stranger = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '10:00'),
    });
    const res = await reschedule(stranger.auth, booking.body.id, {startAt: chicagoAt(5, '12:00')});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(
      (await reschedule(coach.auth, booking.body.id, {startAt: chicagoAt(5, '12:00')})).status,
    ).toBe(403);
    const coachView = await api().get(`${v1}/bookings/${booking.body.id}`).set(coach.auth);
    expect(coachView.body.reschedulable).toBe(false);
    expect(
      (await reschedule(client.auth, '0123456789abcdef01234567', {startAt: chicagoAt(5, '12:00')}))
        .status,
    ).toBe(404);
  });

  it('a booking from a series can be moved and stays in the series', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const startDate = chicagoAt(3, '00:00').slice(0, 10);
    const series = await api()
      .post(`${v1}/bookings/series`)
      .set(client.auth)
      .send({
        sessionTypeId: coach.individualTypeId,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        time: '08:00',
        weeks: 1,
        startDate,
        dates: [startDate],
      });
    const first = series.body.bookings[0];
    const moved = await reschedule(client.auth, first.id, {
      startAt: new Date(Date.parse(first.startAt) + 3 * 3600_000).toISOString(),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.seriesId).toBe(series.body.seriesId);
  });
});

describe('reschedule: group', () => {
  it('moves to another session of the same type and frees the old place', async () => {
    const coach = await publishedCoach({groupCapacity: 2});
    const s1 = await groupSession(coach, chicagoAt(4, '18:00'));
    const s2 = await groupSession(coach, chicagoAt(5, '18:00'));
    const client = await registerUser('client');
    const booking = await book(client.auth, {sessionId: s1});
    await pay(client.auth, booking.body.id);
    await book((await registerUser('client')).auth, {sessionId: s1}); // s1 is full now

    const res = await reschedule(client.auth, booking.body.id, {sessionId: s2});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: booking.body.id,
      startAt: chicagoAt(5, '18:00'),
      session: {id: s2, participantsCount: 1, sessionTypeId: coach.groupTypeId},
      payment: {status: 'paid'},
    });
    // The old place is free for others; the client can even re-join the old session.
    const other = await registerUser('client');
    expect((await book(other.auth, {sessionId: s1})).status).toBe(201);
    const doc = await BookingModel.findById(booking.body.id).lean();
    expect(doc!.activeKey).toBe(`${s2}:${doc!.clientId}`);
  });

  it('a full target -> SESSION_FULL; unknown or other-type session -> NOT_FOUND', async () => {
    const coach = await publishedCoach({groupCapacity: 2});
    const s1 = await groupSession(coach, chicagoAt(4, '18:00'));
    const full = await groupSession(coach, chicagoAt(5, '18:00'));
    const a = await registerUser('client');
    const mine = await book(a.auth, {sessionId: s1});
    await book((await registerUser('client')).auth, {sessionId: full});
    await book((await registerUser('client')).auth, {sessionId: full});
    const res = await reschedule(a.auth, mine.body.id, {sessionId: full});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_FULL');

    expect(
      (await reschedule(a.auth, mine.body.id, {sessionId: '0123456789abcdef01234567'})).status,
    ).toBe(404);
    const otherCoach = await publishedCoach();
    const foreign = await groupSession(otherCoach, chicagoAt(5, '19:00'));
    expect((await reschedule(a.auth, mine.body.id, {sessionId: foreign})).status).toBe(404);
    const viaTime = await reschedule(a.auth, mine.body.id, {startAt: chicagoAt(5, '18:00')});
    expect(viaTime.body.error.details.fields.sessionId).toBeDefined();
    const same = await reschedule(a.auth, mine.body.id, {sessionId: s1});
    expect(same.body.error.details.fields.sessionId).toBeDefined();
  });
});
