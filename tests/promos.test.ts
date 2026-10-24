import {DateTime} from 'luxon';
import {describe, expect, it} from 'vitest';

import {chicagoAt, chicagoDate, groupSession, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
type Coach = Awaited<ReturnType<typeof publishedCoach>>;

async function createPromo(coach: Coach, body: Record<string, unknown>) {
  const res = await api().post(`${v1}/coach/promo-codes`).set(coach.auth).send(body);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as {id: string; code: string; usesCount: number};
}
const book = (auth: Auth, body: Record<string, unknown>) =>
  api().post(`${v1}/bookings`).set(auth).send(body);
const bookAt = (auth: Auth, coach: Coach, day: number, promoCode?: string, extra = {}) =>
  book(auth, {
    sessionTypeId: coach.individualTypeId,
    startAt: chicagoAt(day, '09:00'),
    ...(promoCode && {promoCode}),
    ...extra,
  });

describe('promo codes: coach CRUD', () => {
  it('creates (uppercase), lists newest first, updates, deletes / deactivates; code unique per coach', async () => {
    const coach = await publishedCoach();
    const a = await createPromo(coach, {code: 'spring20', discount: {type: 'percent', value: 20}});
    expect(a).toMatchObject({
      code: 'SPRING20',
      discount: {type: 'percent', value: 20},
      validFrom: null,
      validUntil: null,
      maxUses: null,
      usesCount: 0,
      newClientsOnly: false,
      appliesTo: ['bookings', 'packages'],
      isActive: true,
    });
    const b = await createPromo(coach, {code: 'SAVE10', discount: {type: 'amount', value: 1000}});
    const taken = await api()
      .post(`${v1}/coach/promo-codes`)
      .set(coach.auth)
      .send({code: 'Spring20', discount: {type: 'percent', value: 5}});
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('PROMO_CODE_TAKEN');
    // Another coach may use the same code.
    const other = await publishedCoach();
    await createPromo(other, {code: 'SPRING20', discount: {type: 'percent', value: 5}});

    const bad = await api()
      .post(`${v1}/coach/promo-codes`)
      .set(coach.auth)
      .send({code: 'AB', discount: {type: 'percent', value: 120}, appliesTo: []});
    expect(bad.status).toBe(400);

    const list = await api().get(`${v1}/coach/promo-codes`).set(coach.auth);
    expect(list.body.items.map((p: {id: string}) => p.id)).toEqual([b.id, a.id]);

    const patched = await api()
      .patch(`${v1}/coach/promo-codes/${a.id}`)
      .set(coach.auth)
      .send({maxUses: 5, appliesTo: ['packages'], validUntil: '2099-12-31'});
    expect(patched.body).toMatchObject({maxUses: 5, appliesTo: ['packages'], code: 'SPRING20'});

    // Unused -> deleted; used -> deactivated.
    expect((await api().delete(`${v1}/coach/promo-codes/${a.id}`).set(coach.auth)).status).toBe(
      204,
    );
    const client = await registerUser('client');
    expect((await bookAt(client.auth, coach, 2, 'save10')).status).toBe(201);
    expect((await api().delete(`${v1}/coach/promo-codes/${b.id}`).set(coach.auth)).status).toBe(
      204,
    );
    const after = await api().get(`${v1}/coach/promo-codes`).set(coach.auth);
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0]).toMatchObject({code: 'SAVE10', isActive: false, usesCount: 1});
    expect(
      (await bookAt((await registerUser('client')).auth, coach, 3, 'SAVE10')).body.error.code,
    ).toBe('PROMO_INVALID');
  });
});

describe('promo codes: check', () => {
  it('quotes percent and amount discounts; count multiplies; amount never below 0', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    await createPromo(coach, {code: 'WELCOME20', discount: {type: 'percent', value: 20}});
    await createPromo(coach, {code: 'BIGONE', discount: {type: 'amount', value: 100000}});
    const check = (code: string, target: Record<string, unknown>) =>
      api()
        .post(`${v1}/promo-codes/check`)
        .set(client.auth)
        .send({coachId: coach.user.id, code, target});

    const pct = await check('welcome20', {
      type: 'booking',
      sessionTypeId: coach.individualTypeId,
      count: 4,
    });
    expect(pct.status).toBe(200);
    expect(pct.body).toEqual({
      code: 'WELCOME20',
      label: '−20%',
      unitPrice: {amountCents: 6500, currency: 'USD'},
      unitDiscount: {amountCents: 1300, currency: 'USD'},
      total: {amountCents: 20800, currency: 'USD'},
      totalDiscount: {amountCents: 5200, currency: 'USD'},
    });
    const big = await check('BIGONE', {type: 'booking', sessionTypeId: coach.individualTypeId});
    expect(big.body).toMatchObject({
      label: '−$1000',
      unitDiscount: {amountCents: 6500},
      total: {amountCents: 0},
    });
    const pkg = await api()
      .post(`${v1}/coach/packages`)
      .set(coach.auth)
      .send({title: '5', credits: 5, price: {amountCents: 30000, currency: 'USD'}});
    const forPkg = await check('WELCOME20', {type: 'package', packageId: pkg.body.id});
    expect(forPkg.body).toMatchObject({total: {amountCents: 24000}});
    const unknown = await check('NOPE', {type: 'package', packageId: pkg.body.id});
    expect(unknown.status).toBe(409);
    expect(unknown.body.error).toEqual({
      code: 'PROMO_INVALID',
      message: 'This promo code is not valid.',
    });
    // Check does not use the code.
    const list = await api().get(`${v1}/coach/promo-codes`).set(coach.auth);
    expect(list.body.items.every((p: {usesCount: number}) => p.usesCount === 0)).toBe(true);
  });
});

describe('promo codes: applying', () => {
  it('percent on an individual booking: discounted price, listPrice, promo; refund is the paid amount', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    await createPromo(coach, {code: 'WELCOME20', discount: {type: 'percent', value: 20}});
    const res = await bookAt(client.auth, coach, 2, 'Welcome20');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'pending_payment',
      price: {amountCents: 5200, currency: 'USD'},
      listPrice: {amountCents: 6500, currency: 'USD'},
      promo: {code: 'WELCOME20', discount: {amountCents: 1300, currency: 'USD'}},
    });
    await api().post(`${v1}/bookings/${res.body.id}/pay`).set(client.auth);
    const cancelled = await api()
      .post(`${v1}/bookings/${res.body.id}/cancel`)
      .set(client.auth)
      .send({});
    expect(cancelled.body).toMatchObject({
      payment: {status: 'refunded'},
      price: {amountCents: 5200},
    });
    // Coach earnings show refunds of the actual amount.
    const earnings = await api().get(`${v1}/coach/earnings?period=month`).set(coach.auth);
    expect(earnings.body.breakdown.refunds).toEqual({amountCents: 5200, currency: 'USD'});

    // Reuse by the same client -> PROMO_ALREADY_USED (a cancelled booking still counts as used).
    const again = await bookAt(client.auth, coach, 3, 'WELCOME20');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PROMO_ALREADY_USED');
    // Without a promo: listPrice = price, promo null.
    const plain = await bookAt(client.auth, coach, 4);
    expect(plain.body).toMatchObject({
      price: {amountCents: 6500},
      listPrice: {amountCents: 6500},
      promo: null,
    });
  });

  it('amount discount on a group session; bigger than the price -> 0, confirmed, no payment', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    await createPromo(coach, {code: 'SAVE10', discount: {type: 'amount', value: 1000}});
    await createPromo(coach, {code: 'FREE50', discount: {type: 'amount', value: 5000}});
    const s1 = await groupSession(coach, chicagoAt(2, '18:00'));
    const s2 = await groupSession(coach, chicagoAt(3, '18:00'));
    const g1 = await book(client.auth, {sessionId: s1, promoCode: 'SAVE10'});
    expect(g1.body).toMatchObject({
      status: 'pending_payment',
      price: {amountCents: 1000},
      listPrice: {amountCents: 2000},
      promo: {code: 'SAVE10', discount: {amountCents: 1000}},
    });
    const g2 = await book(client.auth, {sessionId: s2, promoCode: 'FREE50'});
    expect(g2.body).toMatchObject({
      status: 'confirmed',
      price: {amountCents: 0},
      payment: {status: 'not_required'},
      promo: {discount: {amountCents: 2000}},
    });
  });

  it('series: discount on every booked date, one use; extend can use another code', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    await createPromo(coach, {code: 'SAVE10', discount: {type: 'amount', value: 1000}});
    await createPromo(coach, {code: 'MORE20', discount: {type: 'percent', value: 20}});
    const startDate = chicagoDate(3);
    const dates = [0, 1, 2].map(i => DateTime.fromISO(startDate).plus({days: i}).toISODate()!);
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
        promoCode: 'save10',
      });
    expect(res.status).toBe(201);
    expect(res.body.bookings).toHaveLength(3);
    for (const b of res.body.bookings) {
      expect(b).toMatchObject({
        price: {amountCents: 5500},
        listPrice: {amountCents: 6500},
        promo: {code: 'SAVE10', discount: {amountCents: 1000}},
      });
    }
    const list = await api().get(`${v1}/coach/promo-codes`).set(coach.auth);
    expect(list.body.items.find((p: {code: string}) => p.code === 'SAVE10').usesCount).toBe(1);

    const seriesId = res.body.seriesId as string;
    const preview = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend/preview`)
      .set(client.auth)
      .send({weeks: 1});
    const extendDates = preview.body.items.slice(0, 2).map((i: {date: string}) => i.date);
    const reused = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend`)
      .set(client.auth)
      .send({weeks: 1, dates: extendDates, promoCode: 'SAVE10'});
    expect(reused.body.error.code).toBe('PROMO_ALREADY_USED');
    const extended = await api()
      .post(`${v1}/bookings/series/${seriesId}/extend`)
      .set(client.auth)
      .send({weeks: 1, dates: extendDates, promoCode: 'MORE20'});
    expect(extended.status).toBe(201);
    for (const b of extended.body.bookings) {
      expect(b).toMatchObject({price: {amountCents: 5200}, promo: {code: 'MORE20'}});
    }
  });

  it('package purchase with a promo; appliesTo packages only cannot be used for bookings', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    await createPromo(coach, {
      code: 'PACK15',
      discount: {type: 'percent', value: 15},
      appliesTo: ['packages'],
    });
    const notForBookings = await bookAt(client.auth, coach, 2, 'PACK15');
    expect(notForBookings.status).toBe(409);
    expect(notForBookings.body.error.code).toBe('PROMO_NOT_APPLICABLE');
    const pkg = await api()
      .post(`${v1}/coach/packages`)
      .set(coach.auth)
      .send({title: '5', credits: 5, price: {amountCents: 30000, currency: 'USD'}});
    const bought = await api()
      .post(`${v1}/packages/${pkg.body.id}/purchase`)
      .set(client.auth)
      .send({promoCode: 'pack15'});
    expect(bought.status).toBe(201);
    expect(bought.body).toMatchObject({
      price: {amountCents: 25500},
      listPrice: {amountCents: 30000},
      promo: {code: 'PACK15', discount: {amountCents: 4500}},
    });
    // Purchase without a body still works.
    const plain = await api().post(`${v1}/packages/${pkg.body.id}/purchase`).set(client.auth);
    expect(plain.body).toMatchObject({price: {amountCents: 30000}, promo: null});
  });
});

describe('promo codes: rules', () => {
  it('maxUses, validity dates, new clients only, not with trial / credits', async () => {
    const coach = await publishedCoach();
    await createPromo(coach, {code: 'ONCE', discount: {type: 'percent', value: 10}, maxUses: 1});
    const today = chicagoDate(0);
    await createPromo(coach, {
      code: 'LATER',
      discount: {type: 'percent', value: 10},
      validFrom: chicagoDate(2),
    });
    await createPromo(coach, {
      code: 'OLDONE',
      discount: {type: 'percent', value: 10},
      validUntil: chicagoDate(-1),
    });
    await createPromo(coach, {
      code: 'TODAY',
      discount: {type: 'percent', value: 10},
      validFrom: today,
      validUntil: today,
    });
    await createPromo(coach, {
      code: 'NEWBIE',
      discount: {type: 'percent', value: 10},
      newClientsOnly: true,
    });

    const a = await registerUser('client');
    const b = await registerUser('client');
    expect((await bookAt(a.auth, coach, 2, 'ONCE')).status).toBe(201);
    expect((await bookAt(b.auth, coach, 3, 'ONCE')).body.error.code).toBe('PROMO_USED_UP');
    expect((await bookAt(b.auth, coach, 3, 'LATER')).body.error.code).toBe('PROMO_EXPIRED');
    expect((await bookAt(b.auth, coach, 3, 'OLDONE')).body.error.code).toBe('PROMO_EXPIRED');
    expect((await bookAt(b.auth, coach, 3, 'TODAY')).status).toBe(201); // inclusive
    // a and b now have bookings with the coach.
    const newbie = await bookAt(a.auth, coach, 4, 'NEWBIE');
    expect(newbie.status).toBe(409);
    expect(newbie.body.error).toEqual({
      code: 'PROMO_NEW_CLIENTS_ONLY',
      message: 'This promo code is for new clients only.',
    });
    const fresh = await registerUser('client');
    const trial = await bookAt(fresh.auth, coach, 4, 'NEWBIE', {isTrial: true});
    expect(trial.body.error.code).toBe('PROMO_NOT_APPLICABLE');
    const credits = await bookAt(fresh.auth, coach, 4, 'NEWBIE', {useCredits: true});
    expect(credits.body.error.code).toBe('PROMO_NOT_APPLICABLE');
    // Failed attempts do not use the code.
    expect((await bookAt(fresh.auth, coach, 4, 'NEWBIE')).status).toBe(201);
    const list = await api().get(`${v1}/coach/promo-codes`).set(coach.auth);
    expect(list.body.items.find((p: {code: string}) => p.code === 'NEWBIE').usesCount).toBe(1);
  });
});
