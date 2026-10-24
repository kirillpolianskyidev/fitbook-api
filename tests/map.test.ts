import {describe, expect, it} from 'vitest';

import {publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Coach = Awaited<ReturnType<typeof publishedCoach>>;
const ids = (items: {id: string}[]) => items.map(i => i.id);
const place = (coach: Coach, name: string, lat: number, lng: number) =>
  api()
    .put(`${v1}/coach/profile`)
    .set(coach.auth)
    .send({
      defaultLocation: {
        name,
        address: `${name}, Chicago, IL`,
        city: 'Chicago',
        state: 'IL',
        lat,
        lng,
        comment: 'Ring the bell',
      },
    });
// Downtown Chicago.
const LOOP = '-87.70,41.85,-87.60,41.92';

describe('map search (bbox)', () => {
  it('returns coaches inside the box with a public location; outside and online-only coaches are excluded', async () => {
    const inside = await publishedCoach();
    await place(inside, 'Iron Loop Gym', 41.8925, -87.6347);
    const outside = await publishedCoach();
    await place(outside, 'Evanston Studio', 42.0451, -87.6877);
    const online = await publishedCoach();
    await api()
      .put(`${v1}/coach/profile`)
      .set(online.auth)
      .send({online: {enabled: true, meetingUrl: 'https://zoom.us/j/1'}, defaultLocation: null});
    const client = await registerUser('client');

    const res = await api().get(`${v1}/coaches?bbox=${LOOP}`).set(client.auth);
    expect(res.status).toBe(200);
    expect(ids(res.body.items)).toEqual([inside.user.id]);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].location).toEqual({
      lat: 41.8925,
      lng: -87.6347,
      name: 'Iron Loop Gym',
      city: 'Chicago',
      state: 'IL',
    });
    expect(JSON.stringify(res.body)).not.toContain('Ring the bell');

    const all = await api().get(`${v1}/coaches`).set(client.auth);
    const byId = Object.fromEntries(
      all.body.items.map((c: {id: string; location: unknown}) => [c.id, c.location]),
    );
    expect(byId[online.user.id]).toBeNull();
    expect(byId[outside.user.id]).toMatchObject({name: 'Evanston Studio'});
    const big = await api()
      .get(`${v1}/coaches?bbox=-88.5,41.5,-87.0,42.5&sort=price_asc`)
      .set(client.auth);
    expect(big.body.total).toBe(2);
  });

  it('combines with filters; pageSize up to 100 only with bbox', async () => {
    const yoga = await publishedCoach();
    await place(yoga, 'Yoga Loft', 41.89, -87.63);
    await api()
      .put(`${v1}/coach/profile`)
      .set(yoga.auth)
      .send({specializations: ['yoga']});
    const strength = await publishedCoach();
    await place(strength, 'Strength Lab', 41.88, -87.64);
    const client = await registerUser('client');
    const res = await api()
      .get(`${v1}/coaches?bbox=${LOOP}&specialization=yoga&pageSize=100`)
      .set(client.auth);
    expect(ids(res.body.items)).toEqual([yoga.user.id]);
    expect(res.body.pageSize).toBe(100);
    expect((await api().get(`${v1}/coaches?pageSize=100`).set(client.auth)).status).toBe(400);
  });

  it('rejects an invalid bbox', async () => {
    const client = await registerUser('client');
    for (const bbox of [
      '1,2,3',
      '1,2,3,4,5',
      'a,b,c,d',
      '-87.6,41.9,-87.7,41.85',
      '-87.7,41.9,-87.6,41.85',
      '-200,0,0,10',
      '0,-95,10,0',
      '0,0,10,95',
      ',,,',
    ]) {
      const res = await api()
        .get(`${v1}/coaches?bbox=${encodeURIComponent(bbox)}`)
        .set(client.auth);
      expect(res.status, bbox).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
