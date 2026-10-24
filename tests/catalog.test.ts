import {describe, expect, it} from 'vitest';

import {AvailabilityModel} from '../src/models/availability.js';
import {publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
type Coach = Awaited<ReturnType<typeof publishedCoach>>;
const ids = (items: {id: string}[]) => items.map(i => i.id);
const catalog = async (auth: Auth, query = '') =>
  (await api().get(`${v1}/coaches?pageSize=50${query}`).set(auth)).body;
const setHours = (coach: Coach, start: string, end: string) =>
  api()
    .put(`${v1}/coach/availability`)
    .set(coach.auth)
    .send({weekly: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({weekday, start, end}))});
const setPrice = (coach: Coach, typeId: string, amountCents: number) =>
  api()
    .patch(`${v1}/coach/session-types/${typeId}`)
    .set(coach.auth)
    .send({price: {amountCents, currency: 'USD'}});

describe('catalog filters', () => {
  it('price range: a coach with $25 and $120 types matches priceMin=10000', async () => {
    const pricey = await publishedCoach();
    await setPrice(pricey, pricey.individualTypeId, 12000);
    await setPrice(pricey, pricey.groupTypeId, 2500);
    const cheap = await publishedCoach(); // $65 and $20
    const client = await registerUser('client');
    const res = await catalog(client.auth, '&priceMin=10000');
    expect(ids(res.items)).toEqual([pricey.user.id]);
    expect(res.total).toBe(1);
    expect(ids((await catalog(client.auth, '&priceMax=2200')).items)).toEqual([cheap.user.id]);
    expect((await catalog(client.auth, '&priceMin=2400&priceMax=2600')).total).toBe(1);
    expect((await catalog(client.auth, '&priceMin=3000&priceMax=6000')).total).toBe(0);
  });

  it("time of day in the viewer's time zone", async () => {
    const morning = await publishedCoach();
    await setHours(morning, '07:00', '09:00');
    const evening = await publishedCoach();
    await setHours(evening, '18:00', '20:00');
    // Group sessions of the fixtures would add other times: none are scheduled here.
    const chicago = await registerUser('client');
    expect(ids((await catalog(chicago.auth, '&timeOfDay=morning')).items)).toEqual([
      morning.user.id,
    ]);
    expect(ids((await catalog(chicago.auth, '&timeOfDay=evening')).items)).toEqual([
      evening.user.id,
    ]);
    expect((await catalog(chicago.auth, '&timeOfDay=morning,evening')).total).toBe(2);
    expect((await catalog(chicago.auth, '&timeOfDay=afternoon')).total).toBe(0);
    // Los Angeles: 07:00 in Chicago is 05:00 (morning), 18:00-19:00 in Chicago is 16:00-17:00 (afternoon).
    const la = await registerUser('client', {
      homeArea: {city: 'Los Angeles', state: 'CA', country: 'US', timezone: 'America/Los_Angeles'},
    });
    expect(ids((await catalog(la.auth, '&timeOfDay=afternoon')).items)).toEqual([evening.user.id]);
    expect(ids((await catalog(la.auth, '&timeOfDay=morning')).items)).toEqual([morning.user.id]);
    expect((await api().get(`${v1}/coaches?timeOfDay=night`).set(chicago.auth)).status).toBe(400);
  });

  it('trial=true drops group-only coaches; language is case-insensitive', async () => {
    const groupOnly = await publishedCoach();
    await api()
      .patch(`${v1}/coach/session-types/${groupOnly.individualTypeId}`)
      .set(groupOnly.auth)
      .send({isActive: false});
    const both = await publishedCoach();
    await api()
      .put(`${v1}/coach/profile`)
      .set(both.auth)
      .send({languages: ['English', 'Spanish']});
    const client = await registerUser('client');
    expect(ids((await catalog(client.auth, '&trial=true')).items)).toEqual([both.user.id]);
    expect(ids((await catalog(client.auth, '&language=spanish')).items)).toEqual([both.user.id]);
    expect((await catalog(client.auth, '&language=span')).total).toBe(0);
    const card = (await catalog(client.auth)).items.find(
      (c: {id: string}) => c.id === both.user.id,
    );
    expect(card.languages).toEqual(['English', 'Spanish']);
  });
});

describe('next available', () => {
  it('sort=next_available puts coaches without free time last; nextAvailableAt moves after booking', async () => {
    const busy = await publishedCoach();
    // No working hours any more (before any catalog read, so nothing is cached).
    await AvailabilityModel.updateOne({coachId: busy.user.id}, {weekly: []});
    const late = await publishedCoach();
    await setHours(late, '20:00', '22:00');
    const early = await publishedCoach();
    await setHours(early, '06:00', '22:00');
    const client = await registerUser('client');

    const sorted = await catalog(client.auth, '&sort=next_available');
    expect(sorted.items.at(-1).id).toBe(busy.user.id);
    expect(sorted.items.at(-1).nextAvailableAt).toBeNull();
    const times = sorted.items
      .slice(0, 2)
      .map((c: {nextAvailableAt: string}) => Date.parse(c.nextAvailableAt));
    expect(times[0]).toBeLessThanOrEqual(times[1]);

    const before = (await api().get(`${v1}/coaches/${early.user.id}`).set(client.auth)).body
      .nextAvailableAt;
    expect(before).toEqual(expect.any(String));
    const booked = await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({sessionTypeId: early.individualTypeId, startAt: before});
    expect(booked.status).toBe(201);
    const after = (await api().get(`${v1}/coaches/${early.user.id}`).set(client.auth)).body
      .nextAvailableAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));

    // Paging works with sorting.
    const p1 = await api()
      .get(`${v1}/coaches?sort=next_available&pageSize=2&page=1`)
      .set(client.auth);
    const p2 = await api()
      .get(`${v1}/coaches?sort=next_available&pageSize=2&page=2`)
      .set(client.auth);
    expect(p1.body.total).toBe(3);
    expect([...ids(p1.body.items), ...ids(p2.body.items)]).toEqual(ids(sorted.items));
  });

  it('price and rating sorting, and the filters endpoint', async () => {
    const a = await publishedCoach(); // from $20
    const b = await publishedCoach();
    await setPrice(b, b.groupTypeId, 1500); // from $15
    const c = await publishedCoach();
    await setPrice(c, c.groupTypeId, 9000);
    await setPrice(c, c.individualTypeId, 15000); // from $90
    await api()
      .put(`${v1}/coach/profile`)
      .set(c.auth)
      .send({languages: ['Polish', 'English']});
    const client = await registerUser('client');
    expect(ids((await catalog(client.auth, '&sort=price_asc')).items)).toEqual([
      b.user.id,
      a.user.id,
      c.user.id,
    ]);
    expect(ids((await catalog(client.auth, '&sort=price_desc')).items)).toEqual([
      c.user.id,
      a.user.id,
      b.user.id,
    ]);
    const page2 = await api()
      .get(`${v1}/coaches?sort=price_asc&pageSize=1&page=2`)
      .set(client.auth);
    expect(ids(page2.body.items)).toEqual([a.user.id]);
    expect((await catalog(client.auth, '&sort=rating')).total).toBe(3);

    const filters = await api().get(`${v1}/coaches/filters`).set(client.auth);
    expect(filters.status).toBe(200);
    expect(filters.body).toEqual({
      languages: ['English', 'Polish'],
      price: {
        min: {amountCents: 1500, currency: 'USD'},
        max: {amountCents: 15000, currency: 'USD'},
      },
    });
    expect((await api().get(`${v1}/coaches/filters`).set(a.auth)).status).toBe(200);
  });
});
