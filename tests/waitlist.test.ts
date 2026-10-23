import {afterEach, describe, expect, it, vi} from 'vitest';

import {TrainingSessionModel} from '../src/models/trainingSession.js';
import {WaitlistEntryModel} from '../src/models/waitlistEntry.js';
import {sweepWaitlists, waitlistEvents} from '../src/modules/waitlist/waitlist.service.js';
import {chicagoAt, groupSession, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();
afterEach(() => {
  vi.restoreAllMocks();
});

const v1 = '/api/v1';
type Auth = Record<string, string>;
type Client = Awaited<ReturnType<typeof registerUser>>;

const join = (auth: Auth, sessionId: string) =>
  api().post(`${v1}/group-sessions/${sessionId}/waitlist`).set(auth);
const leave = (auth: Auth, sessionId: string) =>
  api().delete(`${v1}/group-sessions/${sessionId}/waitlist`).set(auth);
const book = (auth: Auth, body: Record<string, unknown>) =>
  api().post(`${v1}/bookings`).set(auth).send(body);
const myWaitlist = async (auth: Auth) => (await api().get(`${v1}/me/waitlist`).set(auth)).body;

/** A full 2-place group session (a, b booked) and three clients on its waitlist (w1, w2, w3). */
async function fullSession(options: {waiting?: number; start?: string} = {}) {
  const coach = await publishedCoach({groupCapacity: 2});
  const sessionId = await groupSession(coach, options.start ?? chicagoAt(4, '18:00'));
  const a = await registerUser('client');
  const b = await registerUser('client');
  const bookingA = await book(a.auth, {sessionId});
  const bookingB = await book(b.auth, {sessionId});
  const waiting: Client[] = [];
  for (let i = 0; i < (options.waiting ?? 3); i += 1) {
    const client = await registerUser('client');
    const res = await join(client.auth, sessionId);
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    waiting.push(client);
  }
  return {
    coach,
    sessionId,
    a,
    b,
    bookingA: bookingA.body.id as string,
    bookingB: bookingB.body.id as string,
    waiting,
  };
}
const groupView = async (coachId: string, auth: Auth, sessionId: string) => {
  const res = await api()
    .get(`${v1}/coaches/${coachId}/group-sessions`)
    .query({
      from: new Date().toISOString(),
      to: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    })
    .set(auth);
  return res.body.items.find((s: {id: string}) => s.id === sessionId);
};
const cancelByCoach = (coachAuth: Auth, bookingId: string) =>
  api()
    .post(`${v1}/coach/bookings/${bookingId}/cancel`)
    .set(coachAuth)
    .send({reason: 'Changed plans'});

describe('waitlist: joining', () => {
  it('joins a full session with queue positions; waitlist field on group sessions', async () => {
    const {coach, sessionId, waiting} = await fullSession();
    const [w1, w2] = waiting;
    const mine = await myWaitlist(w2!.auth);
    expect(mine.items).toEqual([
      expect.objectContaining({
        status: 'waiting',
        position: 2,
        offerExpiresAt: null,
        session: expect.objectContaining({
          id: sessionId,
          coach: expect.objectContaining({id: coach.user.id}),
        }),
      }),
    ]);
    expect(await groupView(coach.user.id, w1!.auth, sessionId)).toMatchObject({
      spotsLeft: 0,
      waitlist: {count: 3, myStatus: 'waiting', myPosition: 1, offerExpiresAt: null},
    });
    const outsider = await registerUser('client');
    expect((await groupView(coach.user.id, outsider.auth, sessionId)).waitlist).toEqual({
      count: 3,
      myStatus: null,
      myPosition: null,
      offerExpiresAt: null,
    });
  });

  it('rejects: not full, already booked, already on the waitlist, unknown / individual, coach', async () => {
    const coach = await publishedCoach({groupCapacity: 2});
    const sessionId = await groupSession(coach, chicagoAt(4, '18:00'));
    const a = await registerUser('client');
    const notFull = await join(a.auth, sessionId);
    expect(notFull.status).toBe(409);
    expect(notFull.body.error).toMatchObject({
      code: 'SESSION_NOT_FULL',
      message: 'This session still has places — book it now.',
    });
    await book(a.auth, {sessionId});
    await book((await registerUser('client')).auth, {sessionId});
    expect((await join(a.auth, sessionId)).body.error.code).toBe('ALREADY_BOOKED');
    const w = await registerUser('client');
    expect((await join(w.auth, sessionId)).status).toBe(201);
    const twice = await join(w.auth, sessionId);
    expect(twice.body.error).toMatchObject({
      code: 'ALREADY_ON_WAITLIST',
      message: 'You are already on the waitlist.',
    });
    expect((await join(w.auth, '0123456789abcdef01234567')).status).toBe(404);
    const individual = await book(w.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '10:00'),
    });
    expect((await join(w.auth, individual.body.session.id)).status).toBe(404);
    expect((await join(coach.auth, sessionId)).status).toBe(403);
  });
});

describe('waitlist: offers', () => {
  it('a cancellation offers the place to the first in line and holds it; others get SESSION_FULL', async () => {
    const offered = vi.spyOn(waitlistEvents, 'offered');
    const {coach, sessionId, a, bookingA, waiting} = await fullSession();
    const [w1, w2] = waiting;
    const before = Date.now();
    await api().post(`${v1}/bookings/${bookingA}/cancel`).set(a.auth).send({});

    const mine = (await myWaitlist(w1!.auth)).items[0];
    expect(mine).toMatchObject({status: 'offered', position: null});
    const expiresIn = Date.parse(mine.offerExpiresAt) - before;
    expect(expiresIn).toBeGreaterThan(2 * 3600_000 - 60_000);
    expect(expiresIn).toBeLessThanOrEqual(2 * 3600_000 + 5_000);
    expect(offered).toHaveBeenCalledTimes(1);
    expect(offered.mock.calls[0]![0]).toBe(w1!.user.id);
    expect(offered.mock.calls[0]![1]).toMatchObject({
      entry: {status: 'offered', session: {id: sessionId}},
    });

    // Everyone else still sees a full session.
    expect(await groupView(coach.user.id, w2!.auth, sessionId)).toMatchObject({
      spotsLeft: 0,
      participantsCount: 1,
      waitlist: {count: 2, myStatus: 'waiting', myPosition: 1},
    });
    expect(await groupView(coach.user.id, w1!.auth, sessionId)).toMatchObject({
      waitlist: {myStatus: 'offered', myPosition: null, offerExpiresAt: mine.offerExpiresAt},
    });
    expect((await book(w2!.auth, {sessionId})).body.error.code).toBe('SESSION_FULL');
    const stranger = await registerUser('client');
    expect((await book(stranger.auth, {sessionId})).body.error.code).toBe('SESSION_FULL');
    expect((await myWaitlist(w2!.auth)).items[0].position).toBe(1);
  });

  it('the offered client books the held place (also with credits) and the entry becomes booked', async () => {
    const {coach, sessionId, bookingA, waiting} = await fullSession();
    const [w1] = waiting;
    await cancelByCoach(coach.auth, bookingA);
    const booked = await book(w1!.auth, {sessionId});
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({status: 'pending_payment', session: {id: sessionId}});
    expect((await myWaitlist(w1!.auth)).items).toEqual([]);
    expect((await WaitlistEntryModel.findOne({clientId: w1!.user.id}))!.status).toBe('booked');
    expect(await groupView(coach.user.id, w1!.auth, sessionId)).toMatchObject({
      spotsLeft: 0,
      participantsCount: 2,
      waitlist: {count: 2, myStatus: null},
    });
  });

  it('an expired offer passes to the next client (on read and by the job)', async () => {
    const {coach, sessionId, bookingA, waiting} = await fullSession();
    const [w1, w2, w3] = waiting;
    await cancelByCoach(coach.auth, bookingA);
    await WaitlistEntryModel.updateOne(
      {clientId: w1!.user.id},
      {offerExpiresAt: new Date(Date.now() - 1000)},
    );
    // Lazy: any read brings the state up to date.
    expect((await myWaitlist(w2!.auth)).items[0]).toMatchObject({status: 'offered'});
    expect((await WaitlistEntryModel.findOne({clientId: w1!.user.id}))!.status).toBe('expired');
    expect((await myWaitlist(w1!.auth)).items).toEqual([]);
    expect((await book(w1!.auth, {sessionId})).body.error.code).toBe('SESSION_FULL');

    // Job: the next expiry hands it to w3.
    await WaitlistEntryModel.updateOne(
      {clientId: w2!.user.id},
      {offerExpiresAt: new Date(Date.now() - 1000)},
    );
    expect(await sweepWaitlists()).toBe(1);
    expect((await WaitlistEntryModel.findOne({clientId: w3!.user.id}))!.status).toBe('offered');
  });

  it('leaving with an offer passes it on; positions update when someone leaves', async () => {
    const {coach, sessionId, bookingA, waiting} = await fullSession({waiting: 3});
    const [w1, w2, w3] = waiting;
    expect((await leave(w2!.auth, sessionId)).status).toBe(204);
    expect((await myWaitlist(w3!.auth)).items[0].position).toBe(2);
    expect((await leave(w2!.auth, sessionId)).status).toBe(404);

    await cancelByCoach(coach.auth, bookingA);
    expect((await myWaitlist(w1!.auth)).items[0].status).toBe('offered');
    await leave(w1!.auth, sessionId);
    expect((await WaitlistEntryModel.findOne({clientId: w1!.user.id}))!.status).toBe('left');
    expect((await myWaitlist(w3!.auth)).items[0]).toMatchObject({status: 'offered'});
  });

  it('two freed places -> two offers', async () => {
    const {coach, bookingA, bookingB, waiting} = await fullSession();
    await cancelByCoach(coach.auth, bookingA);
    await cancelByCoach(coach.auth, bookingB);
    const statuses = await Promise.all(
      waiting.map(async w => (await myWaitlist(w.auth)).items[0].status),
    );
    expect(statuses).toEqual(['offered', 'offered', 'waiting']);
  });

  it('the offer window ends 15 minutes before the start; closer than that the place is free for all', async () => {
    const {coach, sessionId, bookingA, bookingB, waiting} = await fullSession();
    const startAt = new Date(Date.now() + 60 * 60_000);
    await TrainingSessionModel.updateOne(
      {_id: sessionId},
      {startAt, endAt: new Date(startAt.getTime() + 3600_000)},
    );
    await cancelByCoach(coach.auth, bookingA);
    const offer = (await myWaitlist(waiting[0]!.auth)).items[0];
    expect(Date.parse(offer.offerExpiresAt)).toBe(startAt.getTime() - 15 * 60_000);

    const soon = new Date(Date.now() + 10 * 60_000);
    await TrainingSessionModel.updateOne(
      {_id: sessionId},
      {startAt: soon, endAt: new Date(soon.getTime() + 3600_000)},
    );
    await cancelByCoach(coach.auth, bookingB);
    expect((await myWaitlist(waiting[1]!.auth)).items[0].status).toBe('waiting');
    const stranger = await registerUser('client');
    expect((await book(stranger.auth, {sessionId})).status).toBe(201);
  });

  it('a reschedule out of the session frees the place for the waitlist; cancelled session expires entries', async () => {
    const {coach, sessionId, a, bookingA, waiting} = await fullSession({waiting: 2});
    const other = await groupSession(coach, chicagoAt(5, '18:00'));
    const moved = await api()
      .post(`${v1}/bookings/${bookingA}/reschedule`)
      .set(a.auth)
      .send({sessionId: other});
    expect(moved.status).toBe(200);
    expect((await myWaitlist(waiting[0]!.auth)).items[0].status).toBe('offered');

    await api()
      .post(`${v1}/coach/group-sessions/${sessionId}/cancel`)
      .set(coach.auth)
      .send({reason: 'Storm'});
    expect((await myWaitlist(waiting[0]!.auth)).items).toEqual([]);
    expect((await myWaitlist(waiting[1]!.auth)).items).toEqual([]);
    expect(await WaitlistEntryModel.countDocuments({status: 'expired'})).toBe(2);
  });

  it('entries expire when the session starts', async () => {
    const {sessionId, waiting} = await fullSession({waiting: 1});
    await TrainingSessionModel.updateOne(
      {_id: sessionId},
      {startAt: new Date(Date.now() - 60_000)},
    );
    expect(await sweepWaitlists()).toBe(1);
    expect((await myWaitlist(waiting[0]!.auth)).items).toEqual([]);
  });
});
