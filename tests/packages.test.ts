import {describe, expect, it} from 'vitest';

import {ClientPackageModel} from '../src/models/package.js';
import {chicagoAt, groupSession, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
type Coach = Awaited<ReturnType<typeof publishedCoach>>;

const usd = (amountCents: number) => ({amountCents, currency: 'USD'});
async function createPackage(coach: Coach, body: Record<string, unknown> = {}) {
  const res = await api()
    .post(`${v1}/coach/packages`)
    .set(coach.auth)
    .send({title: '10 sessions', credits: 10, price: usd(70000), ...body});
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as {id: string};
}
const purchase = (auth: Auth, id: string) => api().post(`${v1}/packages/${id}/purchase`).set(auth);
const book = (auth: Auth, body: Record<string, unknown>) =>
  api().post(`${v1}/bookings`).set(auth).send(body);
const myPackages = async (auth: Auth, coachId?: string) =>
  (
    await api()
      .get(`${v1}/me/packages${coachId ? `?coachId=${coachId}` : ''}`)
      .set(auth)
  ).body;

describe('coach packages', () => {
  it('creates, lists, updates and deletes (deactivates if bought) packages', async () => {
    const coach = await publishedCoach();
    const created = await api()
      .post(`${v1}/coach/packages`)
      .set(coach.auth)
      .send({title: ' 10 sessions ', credits: 10, price: usd(70000)});
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      title: '10 sessions',
      credits: 10,
      price: usd(70000),
      validityDays: 90,
      isActive: true,
      pricePerCredit: usd(7000),
    });
    const small = await createPackage(coach, {title: '3 sessions', credits: 3, price: usd(20000)});

    for (const body of [
      {title: '', credits: 5, price: usd(100)},
      {title: 'x', credits: 0, price: usd(100)},
      {title: 'x', credits: 101, price: usd(100)},
      {title: 'x', credits: 5, price: usd(0)},
      {title: 'x', credits: 5, price: usd(100), validityDays: 6},
      {title: 'x'.repeat(61), credits: 5, price: usd(100)},
    ]) {
      const res = await api().post(`${v1}/coach/packages`).set(coach.auth).send(body);
      expect(res.status).toBe(400);
    }

    const patched = await api()
      .patch(`${v1}/coach/packages/${small.id}`)
      .set(coach.auth)
      .send({price: usd(21000), isActive: false});
    expect(patched.body).toMatchObject({
      price: usd(21000),
      isActive: false,
      pricePerCredit: usd(7000),
    });
    const list = await api().get(`${v1}/coach/packages`).set(coach.auth);
    expect(list.body.items.map((p: {title: string}) => p.title)).toEqual([
      '10 sessions',
      '3 sessions',
    ]);

    // Only active packages are shown in the coach profile.
    const client = await registerUser('client');
    const profile = await api().get(`${v1}/coaches/${coach.user.id}`).set(client.auth);
    expect(profile.body.packages.map((p: {id: string}) => p.id)).toEqual([created.body.id]);

    // Bought -> deactivated; never bought -> deleted.
    await purchase(client.auth, created.body.id);
    expect(
      (await api().delete(`${v1}/coach/packages/${created.body.id}`).set(coach.auth)).status,
    ).toBe(204);
    expect((await api().delete(`${v1}/coach/packages/${small.id}`).set(coach.auth)).status).toBe(
      204,
    );
    const after = await api().get(`${v1}/coach/packages`).set(coach.auth);
    expect(after.body.items).toEqual([
      expect.objectContaining({id: created.body.id, isActive: false}),
    ]);

    const other = await publishedCoach();
    expect(
      (
        await api()
          .patch(`${v1}/coach/packages/${created.body.id}`)
          .set(other.auth)
          .send({title: 'x'})
      ).status,
    ).toBe(404);
  });
});

describe('buying and using credits', () => {
  it('buys a package; PATCH later does not change the purchase', async () => {
    const coach = await publishedCoach();
    const pkg = await createPackage(coach, {validityDays: 30});
    const client = await registerUser('client');
    const res = await purchase(client.auth, pkg.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      packageId: pkg.id,
      title: '10 sessions',
      coach: {id: coach.user.id},
      creditsTotal: 10,
      creditsLeft: 10,
      price: usd(70000),
      expired: false,
    });
    expect(Date.parse(res.body.expiresAt) - Date.parse(res.body.purchasedAt)).toBe(30 * 86_400_000);
    await api()
      .patch(`${v1}/coach/packages/${pkg.id}`)
      .set(coach.auth)
      .send({credits: 5, title: 'New'});
    expect((await myPackages(client.auth)).items[0]).toMatchObject({
      title: '10 sessions',
      creditsLeft: 10,
    });

    await api().patch(`${v1}/coach/packages/${pkg.id}`).set(coach.auth).send({isActive: false});
    const inactive = await purchase(client.auth, pkg.id);
    expect(inactive.status).toBe(409);
    expect(inactive.body.error).toMatchObject({
      code: 'PACKAGE_INACTIVE',
      message: 'This package is no longer available.',
    });
    expect((await purchase(client.auth, '0123456789abcdef01234567')).status).toBe(404);
  });

  it('individual and group bookings with a credit are confirmed and take 1 credit', async () => {
    const coach = await publishedCoach();
    const pkg = await createPackage(coach);
    const client = await registerUser('client');
    const bought = await purchase(client.auth, pkg.id);

    const individual = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '10:00'),
      useCredits: true,
    });
    expect(individual.status).toBe(201);
    expect(individual.body).toMatchObject({
      status: 'confirmed',
      expiresAt: null,
      price: usd(6500),
      payment: {
        status: 'paid',
        method: 'credits',
        refundedAt: null,
        clientPackageId: bought.body.id,
      },
    });
    expect(individual.body.payment.paidAt).toEqual(expect.any(String));

    const sessionId = await groupSession(coach, chicagoAt(4, '18:00'));
    const group = await book(client.auth, {sessionId, useCredits: true});
    expect(group.body).toMatchObject({
      status: 'confirmed',
      price: usd(2000),
      payment: {method: 'credits', clientPackageId: bought.body.id},
    });
    expect(await myPackages(client.auth, coach.user.id)).toMatchObject({
      creditsAvailable: 8,
      items: [{creditsLeft: 8}],
    });

    // A normal booking has method mock and no clientPackageId.
    const normal = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '10:00'),
    });
    expect(normal.body.payment).toMatchObject({method: 'mock', clientPackageId: null});
  });

  it('no credits -> NO_CREDITS (and nothing is booked); useCredits + isTrial -> VALIDATION_ERROR', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const startAt = chicagoAt(5, '10:00');
    const res = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt,
      useCredits: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'NO_CREDITS',
      message: 'You have no credits left with this coach.',
    });
    // The slot was not taken.
    expect((await book(client.auth, {sessionTypeId: coach.individualTypeId, startAt})).status).toBe(
      201,
    );

    // Credits of another coach do not count.
    const other = await publishedCoach();
    await purchase(client.auth, (await createPackage(other)).id);
    const sessionId = await groupSession(coach, chicagoAt(4, '18:00'));
    expect((await book(client.auth, {sessionId, useCredits: true})).body.error.code).toBe(
      'NO_CREDITS',
    );
    const group = await api()
      .get(`${v1}/coaches/${coach.user.id}/group-sessions`)
      .query({
        from: new Date().toISOString(),
        to: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      })
      .set(client.auth);
    expect(group.body.items[0].participantsCount).toBe(0);

    const both = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(7, '10:00'),
      isTrial: true,
      useCredits: true,
    });
    expect(both.status).toBe(400);
    expect(both.body.error.details.fields.useCredits).toBeDefined();
  });

  it('uses the purchase that expires first and never an expired one', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const long = await purchase(client.auth, (await createPackage(coach, {validityDays: 365})).id);
    const short = await purchase(client.auth, (await createPackage(coach, {validityDays: 30})).id);
    const expired = await purchase(client.auth, (await createPackage(coach, {validityDays: 7})).id);
    await ClientPackageModel.updateOne(
      {_id: expired.body.id},
      {expiresAt: new Date(Date.now() - 1000)},
    );

    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '10:00'),
      useCredits: true,
    });
    expect(booking.body.payment.clientPackageId).toBe(short.body.id);

    const mine = await myPackages(client.auth);
    expect(mine.creditsAvailable).toBe(19);
    expect(mine.items.map((p: {id: string; expired: boolean}) => [p.id, p.expired])).toEqual([
      [short.body.id, false],
      [long.body.id, false],
      [expired.body.id, true],
    ]);

    // Only expired credits left -> NO_CREDITS.
    await ClientPackageModel.updateMany({_id: {$ne: expired.body.id}}, {creditsLeft: 0});
    const none = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '10:00'),
      useCredits: true,
    });
    expect(none.body.error.code).toBe('NO_CREDITS');
    expect((await myPackages(client.auth)).creditsAvailable).toBe(0);
  });

  it('cancelling (client before the deadline, coach) gives the credit back; expired purchase loses it', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const bought = await purchase(
      client.auth,
      (await createPackage(coach, {credits: 3, price: usd(18000)})).id,
    );
    const credits = async () => (await myPackages(client.auth)).creditsAvailable;

    const a = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '10:00'),
      useCredits: true,
    });
    const b = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(1, '21:00'), // inside the 24h-ish deadline window soon
      useCredits: true,
    });
    expect(await credits()).toBe(1);

    const byClient = await api()
      .post(`${v1}/bookings/${a.body.id}/cancel`)
      .set(client.auth)
      .send({});
    expect(byClient.body.payment).toMatchObject({status: 'refunded', method: 'credits'});
    expect(byClient.body.payment.refundedAt).toEqual(expect.any(String));
    expect(await credits()).toBe(2);

    const byCoach = await api()
      .post(`${v1}/coach/bookings/${b.body.id}/cancel`)
      .set(coach.auth)
      .send({reason: 'Sick'});
    expect(byCoach.body.payment.status).toBe('refunded');
    expect(await credits()).toBe(3);

    // Purchase expired before the cancellation: the credit is lost.
    const c = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(6, '10:00'),
      useCredits: true,
    });
    await ClientPackageModel.updateOne(
      {_id: bought.body.id},
      {expiresAt: new Date(Date.now() - 1000)},
    );
    await api()
      .post(`${v1}/coach/bookings/${c.body.id}/cancel`)
      .set(coach.auth)
      .send({reason: 'x'});
    expect((await ClientPackageModel.findById(bought.body.id))!.creditsLeft).toBe(2);
  });

  it('rescheduling keeps the credit', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    await purchase(client.auth, (await createPackage(coach)).id);
    const booking = await book(client.auth, {
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(5, '10:00'),
      useCredits: true,
    });
    const moved = await api()
      .post(`${v1}/bookings/${booking.body.id}/reschedule`)
      .set(client.auth)
      .send({startAt: chicagoAt(6, '12:00')});
    expect(moved.body.payment).toEqual(booking.body.payment);
    expect((await myPackages(client.auth)).creditsAvailable).toBe(9);
  });

  it('series with credits: 1 credit per date; too few credits -> INSUFFICIENT_CREDITS, nothing booked', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    await purchase(client.auth, (await createPackage(coach, {credits: 2, price: usd(13000)})).id);
    const startDate = chicagoAt(3, '00:00').slice(0, 10);
    const series = (dates: string[]) =>
      api()
        .post(`${v1}/bookings/series`)
        .set(client.auth)
        .send({
          sessionTypeId: coach.individualTypeId,
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          time: '08:00',
          weeks: 1,
          startDate,
          dates,
          useCredits: true,
        });
    const preview = await api()
      .post(`${v1}/bookings/series/preview`)
      .set(client.auth)
      .send({
        sessionTypeId: coach.individualTypeId,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        time: '08:00',
        weeks: 1,
        startDate,
      });
    const dates = preview.body.items.map((i: {date: string}) => i.date) as string[];

    const tooMany = await series(dates.slice(0, 3));
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      message: 'Not enough credits for all dates.',
      details: {creditsAvailable: 2},
    });
    const upcoming = await api().get(`${v1}/bookings`).set(client.auth);
    expect(upcoming.body.total).toBe(0);

    const ok = await series(dates.slice(0, 2));
    expect(ok.status).toBe(201);
    expect(ok.body.bookings).toHaveLength(2);
    for (const b of ok.body.bookings) {
      expect(b).toMatchObject({status: 'confirmed', payment: {method: 'credits', status: 'paid'}});
    }
    expect((await myPackages(client.auth)).creditsAvailable).toBe(0);
  });
});
