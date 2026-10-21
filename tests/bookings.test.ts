import {describe, expect, it} from 'vitest';

import {
  cancelBookingInternal,
  completePastSessions,
  releaseExpiredPendingBookings,
} from '../src/modules/bookings/bookings.service.js';
import {runMigrations} from '../src/db/migrations.js';
import {BookingModel} from '../src/models/booking.js';
import {TrainingSessionModel} from '../src/models/trainingSession.js';
import {
  chicagoAt,
  chicagoDate,
  groupSession,
  LAKEFRONT,
  publishedCoach,
  weekdayOf,
} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const book = (auth: Record<string, string>, body: Record<string, unknown>) =>
  api().post('/api/v1/bookings').set(auth).send(body);

describe('individual bookings', () => {
  it('books a free slot as pending payment, pays it, and shows it in the calendar', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const startAt = chicagoAt(5, '10:00');
    const res = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt,
      location: {...LAKEFRONT, comment: 'Lifeguard tower 4'},
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'pending_payment',
      isTrial: false,
      price: {amountCents: 6500, currency: 'USD'},
      payment: {status: 'unpaid', method: 'mock', paidAt: null, refundedAt: null},
      cancellable: true,
      session: {
        kind: 'individual',
        title: '1:1 Strength',
        location: {comment: 'Lifeguard tower 4'},
      },
      coach: {id: coach.user.id},
    });
    expect(res.body.expiresAt).not.toBeNull();

    const paid = await api().post(`/api/v1/bookings/${res.body.id}/pay`).set(client.auth);
    expect(paid.body).toMatchObject({
      status: 'confirmed',
      payment: {status: 'paid'},
      expiresAt: null,
    });
    expect(
      (await api().post(`/api/v1/bookings/${res.body.id}/pay`).set(client.auth)).body.error.code,
    ).toBe('BOOKING_NOT_PAYABLE');

    const upcoming = await api().get('/api/v1/bookings?scope=upcoming').set(client.auth);
    expect(upcoming.body.items.map((b: {id: string}) => b.id)).toEqual([res.body.id]);
    expect((await api().get('/api/v1/bookings?scope=past').set(client.auth)).body.total).toBe(0);

    const event = await api()
      .get(`/api/v1/bookings/${res.body.id}/calendar-event`)
      .set(client.auth);
    expect(event.body).toMatchObject({
      title: `1:1 Strength with Coach ${coach.user.email ? '' : ''}`.trim().length
        ? expect.stringContaining('1:1 Strength with Coach')
        : '',
      startAt: new Date(startAt).toISOString(),
      timezone: 'America/Chicago',
      location: {name: 'North Avenue Beach'},
    });
    expect(event.body.notes).toContain('Free cancellation up to 24h');
  });

  it('rejects times outside availability, off-grid or too soon', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    for (const startAt of [
      chicagoAt(5, '23:00'),
      chicagoAt(5, '10:15'),
      new Date(Date.now() + 30 * 60_000).toISOString(),
    ]) {
      const res = await book(client.auth, {sessionTypeId: coach.individualTypeId, startAt});
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    }
  });

  it('never double-books the same time, even with parallel requests', async () => {
    const coach = await publishedCoach();
    const clients = await Promise.all([
      registerUser('client'),
      registerUser('client'),
      registerUser('client'),
    ]);
    const startAt = chicagoAt(6, '08:00');
    const results = await Promise.all(
      clients.map(c => book(c.auth, {sessionTypeId: coach.individualTypeId, startAt})),
    );
    expect(results.map(r => r.status).sort()).toEqual([201, 409, 409]);
    expect(
      results.filter(r => r.status === 409).every(r => r.body.error.code === 'SLOT_UNAVAILABLE'),
    ).toBe(true);
    // An overlapping start (07:30-08:30) is also taken.
    const overlap = await book(clients[0]!.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '07:30'),
    });
    expect(overlap.body.error.code).toBe('SLOT_UNAVAILABLE');
  });
});

describe('free trial', () => {
  it('gives one free confirmed trial per account', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    expect((await api().get('/api/v1/me/trial').set(client.auth)).body).toEqual({eligible: true});
    const trial = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '09:00'),
      isTrial: true,
    });
    expect(trial.body).toMatchObject({
      status: 'confirmed',
      isTrial: true,
      price: {amountCents: 0},
      payment: {status: 'not_required'},
    });
    expect((await api().get('/api/v1/me/trial').set(client.auth)).body).toEqual({
      eligible: false,
      reason: 'TRIAL_ALREADY_USED',
    });

    const other = await publishedCoach();
    const second = await book(client.auth, {
      sessionTypeId: other.individualTypeId,
      startAt: chicagoAt(5, '09:00'),
      isTrial: true,
    });
    expect(second.body.error.code).toBe('TRIAL_ALREADY_USED');
  });

  it('blocks a second trial with a Gmail alias of the same address', async () => {
    const coach = await publishedCoach();
    const first = await registerUser('client', {email: 'john.doe@gmail.com'});
    await book(first.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '09:00'),
      isTrial: true,
    });
    const alias = await registerUser('client', {email: 'J.o.h.n.Doe+fit@googlemail.com'});
    const res = await book(alias.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '11:00'),
      isTrial: true,
    });
    expect(res.body.error.code).toBe('TRIAL_ALREADY_USED');
  });

  it('is not available for group sessions and is kept after cancelling', async () => {
    const coach = await publishedCoach({freeCancelHours: 1});
    const client = await registerUser('client');
    const sessionId = await groupSession(coach, chicagoAt(5, '18:00'));
    expect((await book(client.auth, {sessionId, isTrial: true})).body.error.code).toBe(
      'TRIAL_NOT_ALLOWED',
    );

    const trial = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '09:00'),
      isTrial: true,
    });
    await api().post(`/api/v1/bookings/${trial.body.id}/cancel`).set(client.auth).send({});
    const again = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '11:00'),
      isTrial: true,
    });
    expect(again.body.error.code).toBe('TRIAL_ALREADY_USED');
  });

  it('releases the trial claim when the slot was taken', async () => {
    const coach = await publishedCoach();
    const [a, b] = await Promise.all([registerUser('client'), registerUser('client')]);
    const startAt = chicagoAt(5, '09:00');
    await book(a.auth, {sessionTypeId: coach.individualTypeId, startAt});
    const failed = await book(b.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt,
      isTrial: true,
    });
    expect(failed.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect((await api().get('/api/v1/me/trial').set(b.auth)).body.eligible).toBe(true);
  });
});

describe('group sessions', () => {
  it('fills up to capacity and rejects duplicates and overflow', async () => {
    const coach = await publishedCoach({groupCapacity: 2});
    const [a, b, c] = await Promise.all([
      registerUser('client'),
      registerUser('client'),
      registerUser('client'),
    ]);
    const sessionId = await groupSession(coach, chicagoAt(4, '18:00'));

    const listed = await api()
      .get(
        `/api/v1/coaches/${coach.user.id}/group-sessions?from=${encodeURIComponent(chicagoAt(0, '00:00'))}&to=${encodeURIComponent(chicagoAt(10, '00:00'))}`,
      )
      .set(a.auth);
    expect(listed.body.items[0]).toMatchObject({id: sessionId, spotsLeft: 2, capacity: 2});

    expect((await book(a.auth, {sessionId})).status).toBe(201);
    expect((await book(a.auth, {sessionId})).body.error.code).toBe('ALREADY_BOOKED');
    const parallel = await Promise.all([book(b.auth, {sessionId}), book(c.auth, {sessionId})]);
    expect(parallel.map(r => r.status).sort()).toEqual([201, 409]);
    expect(parallel.find(r => r.status === 409)!.body.error.code).toBe('SESSION_FULL');
    expect((await TrainingSessionModel.findById(sessionId))!.participantsCount).toBe(2);
  });

  it('frees a spot when a participant cancels, and the coach can cancel the whole session', async () => {
    const coach = await publishedCoach({groupCapacity: 2});
    const [a, b] = await Promise.all([registerUser('client'), registerUser('client')]);
    const sessionId = await groupSession(coach, chicagoAt(4, '18:00'));
    const booking = await book(a.auth, {sessionId});
    await api().post(`/api/v1/bookings/${booking.body.id}/cancel`).set(a.auth).send({});
    expect((await TrainingSessionModel.findById(sessionId))!.participantsCount).toBe(0);
    expect((await book(a.auth, {sessionId})).status).toBe(201); // can re-join after cancelling
    await book(b.auth, {sessionId});

    const cancelled = await api()
      .post(`/api/v1/coach/group-sessions/${sessionId}/cancel`)
      .set(coach.auth)
      .send({reason: 'Storm warning'});
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Storm warning',
      participantsCount: 0,
    });
    const bookings = await BookingModel.find({sessionId});
    expect(bookings.every(x => x.status === 'cancelled')).toBe(true);
    // The time is free again for an individual booking.
    const individual = await book(a.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(4, '18:00'),
    });
    expect(individual.status).toBe(201);
  });

  it('coach cannot schedule overlapping sessions; repeats skip taken dates', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(7 + 7, '18:00'),
    });
    const res = await api()
      .post('/api/v1/coach/group-sessions')
      .set(coach.auth)
      .send({
        sessionTypeId: coach.groupTypeId,
        startAt: chicagoAt(7, '18:00'),
        repeat: {weekdays: [weekdayOf(7)], weeks: 3},
      });
    expect(res.body.created).toHaveLength(2);
    expect(res.body.skipped).toEqual([
      {startAt: new Date(chicagoAt(14, '18:00')).toISOString(), reason: 'SLOT_UNAVAILABLE'},
    ]);
  });
});

describe('recurring series', () => {
  it('previews availability, books only free dates and pays the series at once', async () => {
    const coach = await publishedCoach();
    const other = await registerUser('client');
    const client = await registerUser('client');
    const weekday = weekdayOf(3);
    await book(other.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(10, '07:00'),
    });
    await api()
      .post('/api/v1/coach/availability/exceptions')
      .set(coach.auth)
      .send({date: chicagoDate(17), reason: 'Conference'});

    const body = {
      sessionTypeId: coach.individualTypeId,
      weekdays: [weekday],
      time: '07:00',
      weeks: 4,
      startDate: chicagoDate(3),
    };
    const preview = await api().post('/api/v1/bookings/series/preview').set(client.auth).send(body);
    expect(preview.status).toBe(200);
    expect(
      preview.body.items.map((i: {available: boolean; reason?: string}) => i.reason ?? 'ok'),
    ).toEqual(['ok', 'UNAVAILABLE', 'EXCEPTION', 'ok']);

    const series = await api()
      .post('/api/v1/bookings/series')
      .set(client.auth)
      .send({...body, dates: preview.body.items.map((i: {date: string}) => i.date)});
    expect(series.status).toBe(201);
    expect(series.body.bookings).toHaveLength(2);
    expect(series.body.skipped.map((s: {reason: string}) => s.reason)).toEqual([
      'UNAVAILABLE',
      'EXCEPTION',
    ]);
    expect(
      series.body.bookings.every(
        (b: {status: string; seriesId: string}) =>
          b.status === 'pending_payment' && b.seriesId === series.body.seriesId,
      ),
    ).toBe(true);

    const paid = await api()
      .post(`/api/v1/bookings/series/${series.body.seriesId}/pay`)
      .set(client.auth);
    expect(paid.body.paidCount).toBe(2);
    expect(paid.body.bookings.every((b: {status: string}) => b.status === 'confirmed')).toBe(true);
  });

  it('rejects dates that are not part of the series', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const res = await api()
      .post('/api/v1/bookings/series')
      .set(client.auth)
      .send({
        sessionTypeId: coach.individualTypeId,
        weekdays: [weekdayOf(3)],
        time: '07:00',
        weeks: 1,
        startDate: chicagoDate(3),
        dates: [chicagoDate(4)],
      });
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('cancellation policy', () => {
  it("enforces the coach's free-cancellation window for confirmed bookings", async () => {
    const coach = await publishedCoach({freeCancelHours: 48});
    const client = await registerUser('client');
    const soon = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(1, '21:00'),
    });
    await api().post(`/api/v1/bookings/${soon.body.id}/pay`).set(client.auth);
    const late = await api()
      .post(`/api/v1/bookings/${soon.body.id}/cancel`)
      .set(client.auth)
      .send({});
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({
      code: 'CANCELLATION_WINDOW_PASSED',
      details: {freeCancelHours: 48},
    });

    const later = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '10:00'),
    });
    await api().post(`/api/v1/bookings/${later.body.id}/pay`).set(client.auth);
    const ok = await api()
      .post(`/api/v1/bookings/${later.body.id}/cancel`)
      .set(client.auth)
      .send({reason: 'Travel'});
    expect(ok.body).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'client',
      cancelReason: 'Travel',
      cancellable: false,
    });
    // The time is bookable again.
    expect(
      (
        await book(client.auth, {
          sessionTypeId: coach.individualTypeId,
          startAt: chicagoAt(6, '10:00'),
        })
      ).status,
    ).toBe(201);
  });

  it('lets the coach cancel any upcoming booking with a reason', async () => {
    const coach = await publishedCoach({freeCancelHours: 72});
    const client = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(1, '21:00'),
    });
    const res = await api()
      .post(`/api/v1/coach/bookings/${booking.body.id}/cancel`)
      .set(coach.auth)
      .send({reason: 'Sick'});
    expect(res.body).toMatchObject({status: 'cancelled', cancelledBy: 'coach'});
    const outsider = await publishedCoach();
    expect(
      (
        await api()
          .post(`/api/v1/coach/bookings/${booking.body.id}/cancel`)
          .set(outsider.auth)
          .send({reason: 'x'})
      ).status,
    ).toBe(404);
  });
});

describe('jobs', () => {
  it('releases unpaid bookings after the payment window and frees the time', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const startAt = chicagoAt(5, '12:00');
    const booking = await book(client.auth, {sessionTypeId: coach.individualTypeId, startAt});
    await BookingModel.updateOne({_id: booking.body.id}, {expiresAt: new Date(Date.now() - 1000)});
    expect(
      (await api().post(`/api/v1/bookings/${booking.body.id}/pay`).set(client.auth)).body.error
        .code,
    ).toBe('BOOKING_NOT_PAYABLE');
    expect(await releaseExpiredPendingBookings()).toBe(1);
    const released = await api().get(`/api/v1/bookings/${booking.body.id}`).set(client.auth);
    expect(released.body).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'system',
      cancelReason: 'PAYMENT_EXPIRED',
    });
    expect((await book(client.auth, {sessionTypeId: coach.individualTypeId, startAt})).status).toBe(
      201,
    );
  });

  it('completes past sessions and their confirmed bookings', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '12:00'),
    });
    await api().post(`/api/v1/bookings/${booking.body.id}/pay`).set(client.auth);
    const result = await completePastSessions(new Date(Date.now() + 30 * 86_400_000));
    expect(result).toEqual({sessions: 1, bookings: 1});
    expect((await BookingModel.findById(booking.body.id))!.status).toBe('completed');
  });
});

describe('access', () => {
  it('only participants can see a booking', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const stranger = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '12:00'),
    });
    expect((await api().get(`/api/v1/bookings/${booking.body.id}`).set(coach.auth)).status).toBe(
      200,
    );
    expect(
      (await api().get(`/api/v1/bookings/${booking.body.id}`).set(stranger.auth)).body.error.code,
    ).toBe('FORBIDDEN');
    expect((await api().get('/api/v1/bookings/not-an-id').set(client.auth)).body.error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('shows the coach schedule with participants', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const sessionId = await groupSession(coach, chicagoAt(3, '18:00'));
    await book(client.auth, {sessionId});
    await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(3, '09:00'),
      isTrial: true,
    });
    const schedule = await api()
      .get(
        `/api/v1/coach/schedule?from=${encodeURIComponent(chicagoAt(0, '00:00'))}&to=${encodeURIComponent(chicagoAt(7, '00:00'))}`,
      )
      .set(coach.auth);
    expect(schedule.body.items).toHaveLength(2);
    expect(schedule.body.items[0].participants[0]).toMatchObject({
      isTrial: true,
      status: 'confirmed',
      client: {id: client.user.id},
    });
    const details = await api().get(`/api/v1/coach/sessions/${sessionId}`).set(coach.auth);
    expect(details.body.participants).toHaveLength(1);
    const clients = await api().get('/api/v1/coach/clients').set(coach.auth);
    expect(clients.body.items[0]).toMatchObject({id: client.user.id, totalBookings: 2});
  });
});

describe('refunds', () => {
  const pay = (auth: Record<string, string>, id: string) =>
    api().post(`/api/v1/bookings/${id}/pay`).set(auth);
  const cancelAsClient = (auth: Record<string, string>, id: string) =>
    api().post(`/api/v1/bookings/${id}/cancel`).set(auth).send({});
  const cancelAsCoach = (auth: Record<string, string>, id: string) =>
    api().post(`/api/v1/coach/bookings/${id}/cancel`).set(auth).send({reason: 'Sick'});
  const expectRefunded = (payment: {status: string; refundedAt: string | null}) => {
    expect(payment.status).toBe('refunded');
    expect(Date.now() - Date.parse(payment.refundedAt!)).toBeLessThan(60_000);
  };

  it('client cancels a paid booking before the deadline -> 100% refund', async () => {
    const coach = await publishedCoach({freeCancelHours: 24});
    const client = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '10:00'),
    });
    const paid = await pay(client.auth, booking.body.id);
    expect(paid.body.payment).toMatchObject({status: 'paid', refundedAt: null});

    const res = await cancelAsClient(client.auth, booking.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({status: 'cancelled', cancelledBy: 'client'});
    expect(res.body.price).toEqual(paid.body.price);
    expect(res.body.payment.paidAt).toBe(paid.body.payment.paidAt);
    expectRefunded(res.body.payment);

    // The refund is visible in the booking details and in the past / upcoming lists.
    const details = await api().get(`/api/v1/bookings/${booking.body.id}`).set(client.auth);
    expectRefunded(details.body.payment);
  });

  it('client cannot cancel a paid booking after the deadline (no refund)', async () => {
    const coach = await publishedCoach({freeCancelHours: 48});
    const client = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(1, '21:00'),
    });
    await pay(client.auth, booking.body.id);
    const res = await cancelAsClient(client.auth, booking.body.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCELLATION_WINDOW_PASSED');
    const details = await api().get(`/api/v1/bookings/${booking.body.id}`).set(client.auth);
    expect(details.body).toMatchObject({
      status: 'confirmed',
      payment: {status: 'paid', refundedAt: null},
    });
  });

  it('coach cancels a paid booking -> 100% refund, even inside the client deadline', async () => {
    const coach = await publishedCoach({freeCancelHours: 72});
    const client = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(1, '21:00'),
    });
    await pay(client.auth, booking.body.id);
    const res = await cancelAsCoach(coach.auth, booking.body.id);
    expect(res.body).toMatchObject({status: 'cancelled', cancelledBy: 'coach'});
    expectRefunded(res.body.payment);
  });

  it('coach cancels a group session -> every paid participant is refunded, unpaid stay unpaid', async () => {
    const coach = await publishedCoach({groupCapacity: 3});
    const sessionId = await groupSession(coach, chicagoAt(4, '18:00'));
    const a = await registerUser('client');
    const b = await registerUser('client');
    const paidBooking = await book(a.auth, {sessionId});
    await pay(a.auth, paidBooking.body.id);
    const unpaidBooking = await book(b.auth, {sessionId});

    await api()
      .post(`/api/v1/coach/group-sessions/${sessionId}/cancel`)
      .set(coach.auth)
      .send({reason: 'Storm warning'});
    const paidAfter = await api().get(`/api/v1/bookings/${paidBooking.body.id}`).set(a.auth);
    expect(paidAfter.body.status).toBe('cancelled');
    expectRefunded(paidAfter.body.payment);
    const unpaidAfter = await api().get(`/api/v1/bookings/${unpaidBooking.body.id}`).set(b.auth);
    expect(unpaidAfter.body.payment).toMatchObject({status: 'unpaid', refundedAt: null});
  });

  it('system cancellation of a paid booking -> 100% refund', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '12:00'),
    });
    await pay(client.auth, booking.body.id);
    const doc = await BookingModel.findById(booking.body.id);
    const cancelled = await cancelBookingInternal(doc!, 'system', 'COACH_ACCOUNT_CLOSED');
    expect(cancelled!.payment.status).toBe('refunded');
    expect(cancelled!.payment.refundedAt).toBeInstanceOf(Date);
  });

  it('unpaid and free bookings have nothing to refund', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const unpaid = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '09:00'),
    });
    expect((await cancelAsClient(client.auth, unpaid.body.id)).body.payment).toMatchObject({
      status: 'unpaid',
      refundedAt: null,
    });
    // Expired unpaid booking released by the system.
    const expiring = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '11:00'),
    });
    await BookingModel.updateOne({_id: expiring.body.id}, {expiresAt: new Date(Date.now() - 1000)});
    await releaseExpiredPendingBookings();
    const released = await api().get(`/api/v1/bookings/${expiring.body.id}`).set(client.auth);
    expect(released.body).toMatchObject({
      cancelledBy: 'system',
      payment: {status: 'unpaid', refundedAt: null},
    });
    // Free trial.
    const trial = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(7, '10:00'),
      isTrial: true,
    });
    expect((await cancelAsClient(client.auth, trial.body.id)).body.payment).toMatchObject({
      status: 'not_required',
      refundedAt: null,
    });
  });

  it('a refunded booking cannot be paid or refunded twice', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '15:00'),
    });
    await pay(client.auth, booking.body.id);
    const first = await cancelAsClient(client.auth, booking.body.id);
    expect((await pay(client.auth, booking.body.id)).body.error.code).toBe('BOOKING_NOT_PAYABLE');
    expect((await cancelAsClient(client.auth, booking.body.id)).status).toBe(409);
    const details = await api().get(`/api/v1/bookings/${booking.body.id}`).set(client.auth);
    expect(details.body.payment.refundedAt).toBe(first.body.payment.refundedAt);
  });

  it('migration marks paid bookings cancelled before refunds existed as refunded', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '17:00'),
    });
    const cancelledAt = new Date('2026-10-01T10:00:00.000Z');
    await BookingModel.updateOne(
      {_id: booking.body.id},
      {
        $set: {
          status: 'cancelled',
          cancelledAt,
          cancelledBy: 'client',
          payment: {status: 'paid', method: 'mock', paidAt: new Date('2026-09-30T10:00:00.000Z')},
        },
        $unset: {activeKey: 1},
      },
    );
    await runMigrations();
    await runMigrations(); // idempotent
    const doc = await BookingModel.findById(booking.body.id).lean();
    expect(doc!.payment).toMatchObject({status: 'refunded', refundedAt: cancelledAt});
  });
});
