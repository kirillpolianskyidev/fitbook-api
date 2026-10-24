import {describe, expect, it} from 'vitest';

import {BookingModel} from '../src/models/booking.js';
import {ClientPackageModel} from '../src/models/package.js';
import {chicagoAt, groupSession, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
type Coach = Awaited<ReturnType<typeof publishedCoach>>;
const HOUR = 3600_000;

let day = 0;
/** A paid individual booking moved so that it started `hoursAgo` hours ago (completed if it has ended). */
async function pastBooking(
  coach: Coach,
  client: Awaited<ReturnType<typeof registerUser>>,
  hoursAgo: number,
  body: Record<string, unknown> = {},
) {
  const res = await api()
    .post(`${v1}/bookings`)
    .set(client.auth)
    .send({
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(3 + (day++ % 20), '10:00'),
      ...body,
    });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  if (res.body.status === 'pending_payment') {
    await api().post(`${v1}/bookings/${res.body.id}/pay`).set(client.auth);
  }
  const startAt = new Date(Date.now() - hoursAgo * HOUR);
  const endAt = new Date(startAt.getTime() + HOUR);
  await BookingModel.updateOne(
    {_id: res.body.id},
    {startAt, endAt, status: endAt <= new Date() ? 'completed' : 'confirmed'},
  );
  return res.body.id as string;
}
const mark = (auth: Auth, id: string, refund: boolean) =>
  api().post(`${v1}/coach/bookings/${id}/no-show`).set(auth).send({refund});
const undo = (auth: Auth, id: string) =>
  api().delete(`${v1}/coach/bookings/${id}/no-show`).set(auth);

describe('no-show', () => {
  it('window: before the start and after 48h -> NO_SHOW_WINDOW_PASSED; at 47h -> ok', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const future = await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({sessionTypeId: coach.individualTypeId, startAt: chicagoAt(5, '10:00'), isTrial: true});
    const early = await mark(coach.auth, future.body.id, false);
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({
      code: 'NO_SHOW_WINDOW_PASSED',
      message: 'A no-show can be marked from the start of the training until 48 hours later.',
    });
    expect(future.body).toMatchObject({noShow: null, noShowMarkable: false, noShowUndoable: false});

    const late = await pastBooking(coach, client, 49);
    expect((await mark(coach.auth, late, false)).body.error.code).toBe('NO_SHOW_WINDOW_PASSED');

    const ok = await pastBooking(coach, client, 47);
    const coachView = await api().get(`${v1}/bookings/${ok}`).set(coach.auth);
    expect(coachView.body).toMatchObject({
      noShowMarkable: true,
      noShowUndoable: false,
      noShow: null,
    });
    expect(Date.parse(coachView.body.noShowDeadline)).toBe(
      Date.parse(coachView.body.startAt) + 48 * HOUR,
    );
    const res = await mark(coach.auth, ok, false);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'no_show',
      noShow: {refunded: false},
      noShowMarkable: false,
      noShowUndoable: true,
      payment: {status: 'paid', refundedAt: null},
    });
    // The client sees it in past bookings, without coach actions.
    const past = await api().get(`${v1}/bookings?scope=past`).set(client.auth);
    expect(past.body.items.find((b: {id: string}) => b.id === ok)).toMatchObject({
      status: 'no_show',
      noShowMarkable: false,
      noShowUndoable: false,
    });
    const filtered = await api().get(`${v1}/bookings?scope=past&status=no_show`).set(client.auth);
    expect(filtered.body.items.map((b: {id: string}) => b.id)).toEqual([ok]);
  });

  it('refund: true returns the payment; undo is then NO_SHOW_REFUNDED', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const id = await pastBooking(coach, client, 3);
    const res = await mark(coach.auth, id, true);
    expect(res.body).toMatchObject({
      status: 'no_show',
      noShow: {refunded: true},
      noShowUndoable: false,
      payment: {status: 'refunded'},
    });
    expect(res.body.payment.refundedAt).toEqual(expect.any(String));
    const again = await undo(coach.auth, id);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'NO_SHOW_REFUNDED',
      message: 'The payment was already returned, so the no-show cannot be removed.',
    });
  });

  it('credit bookings: refund returns the credit, no refund keeps it used', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const pkg = await api()
      .post(`${v1}/coach/packages`)
      .set(coach.auth)
      .send({title: '5', credits: 5, price: {amountCents: 30000, currency: 'USD'}});
    const bought = await api().post(`${v1}/packages/${pkg.body.id}/purchase`).set(client.auth);
    const a = await pastBooking(coach, client, 5, {useCredits: true});
    const b = await pastBooking(coach, client, 6, {useCredits: true});
    const left = async () => (await ClientPackageModel.findById(bought.body.id))!.creditsLeft;
    expect(await left()).toBe(3);
    await mark(coach.auth, a, false);
    expect(await left()).toBe(3);
    expect((await mark(coach.auth, b, true)).body.payment).toMatchObject({
      method: 'credits',
      status: 'refunded',
    });
    expect(await left()).toBe(4);
  });

  it('undo returns completed (after the end) or confirmed (still running); refund ignored for trials', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const ended = await pastBooking(coach, client, 3);
    await mark(coach.auth, ended, false);
    const undone = await undo(coach.auth, ended);
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({status: 'completed', noShow: null, noShowMarkable: true});

    const running = await pastBooking(coach, client, 0.5); // started 30 minutes ago, still running
    await mark(coach.auth, running, false);
    expect((await undo(coach.auth, running)).body.status).toBe('confirmed');
    expect((await undo(coach.auth, running)).body.error.code).toBe('NO_SHOW_NOT_ALLOWED');

    const trial = await pastBooking(coach, client, 2, {isTrial: true});
    const res = await mark(coach.auth, trial, true);
    expect(res.body).toMatchObject({
      noShow: {refunded: false},
      payment: {status: 'not_required'},
      noShowUndoable: true,
    });
  });

  it('only for confirmed / completed bookings of the coach', async () => {
    const coach = await publishedCoach();
    const other = await publishedCoach();
    const client = await registerUser('client');
    const id = await pastBooking(coach, client, 2);
    expect((await mark(client.auth, id, false)).status).toBe(403);
    const foreign = await mark(other.auth, id, false);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('FORBIDDEN');
    expect((await mark(coach.auth, '0123456789abcdef01234567', false)).status).toBe(404);
    expect(
      (await api().post(`${v1}/coach/bookings/${id}/no-show`).set(coach.auth).send({})).status,
    ).toBe(400);

    await BookingModel.updateOne({_id: id}, {status: 'cancelled'});
    const cancelled = await mark(coach.auth, id, false);
    expect(cancelled.body.error).toMatchObject({
      code: 'NO_SHOW_NOT_ALLOWED',
      message: 'This booking cannot be marked as a no-show.',
    });
    await BookingModel.updateOne({_id: id}, {status: 'pending_payment'});
    expect((await mark(coach.auth, id, false)).body.error.code).toBe('NO_SHOW_NOT_ALLOWED');
  });

  it('group sessions: per participant; schedule participants carry the fields', async () => {
    const coach = await publishedCoach({groupCapacity: 3});
    const sessionId = await groupSession(coach, chicagoAt(4, '18:00'));
    const a = await registerUser('client');
    const b = await registerUser('client');
    const ba = await api().post(`${v1}/bookings`).set(a.auth).send({sessionId});
    const bb = await api().post(`${v1}/bookings`).set(b.auth).send({sessionId});
    await api().post(`${v1}/bookings/${ba.body.id}/pay`).set(a.auth);
    await api().post(`${v1}/bookings/${bb.body.id}/pay`).set(b.auth);
    const startAt = new Date(Date.now() - 2 * HOUR);
    const endAt = new Date(startAt.getTime() + HOUR);
    await BookingModel.updateMany({sessionId}, {startAt, endAt, status: 'completed'});
    const {TrainingSessionModel} = await import('../src/models/trainingSession.js');
    await TrainingSessionModel.updateOne({_id: sessionId}, {startAt, endAt, status: 'completed'});

    await mark(coach.auth, ba.body.id, false);
    const details = await api().get(`${v1}/coach/sessions/${sessionId}`).set(coach.auth);
    const byId = Object.fromEntries(
      details.body.participants.map((p: {bookingId: string}) => [p.bookingId, p]),
    );
    expect(byId[ba.body.id]).toMatchObject({
      status: 'no_show',
      noShow: {refunded: false},
      noShowUndoable: true,
    });
    expect(byId[bb.body.id]).toMatchObject({
      status: 'completed',
      noShow: null,
      noShowMarkable: true,
    });
  });

  it('no-shows count neither in progress, nor for reviews, nor in the coach client list', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const id = await pastBooking(coach, client, 3);
    await mark(coach.auth, id, false);
    const progress = await api().get(`${v1}/me/progress`).set(client.auth);
    expect(progress.body.totals.completed).toBe(0);
    expect(
      progress.body.weekly.reduce((n: number, w: {completed: number}) => n + w.completed, 0),
    ).toBe(0);
    expect(progress.body.thisWeek.completed).toBe(0);
    const review = await api()
      .put(`${v1}/coaches/${coach.user.id}/my-review`)
      .set(client.auth)
      .send({rating: 5});
    expect(review.body.error.code).toBe('REVIEW_NOT_ALLOWED');
    const clients = await api().get(`${v1}/coach/clients`).set(coach.auth);
    expect(clients.body.items[0].totalBookings).toBe(0);
  });
});
