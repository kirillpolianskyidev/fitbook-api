import {describe, expect, it} from 'vitest';

import {computeSlots} from '../src/lib/slots.js';
import {chicagoAt, chicagoDate, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

describe('coach profile', () => {
  it('reports missing fields and refuses to publish an incomplete profile', async () => {
    const coach = await registerUser('coach');
    const profile = await api().get('/api/v1/coach/profile').set(coach.auth);
    expect(profile.body.completeness.missing).toEqual([
      'headline',
      'bio',
      'specializations',
      'sessionTypes',
      'availability',
    ]);
    const publish = await api()
      .post('/api/v1/coach/profile/publish')
      .set(coach.auth)
      .send({isPublished: true});
    expect(publish.status).toBe(422);
    expect(publish.body.error).toMatchObject({code: 'PROFILE_INCOMPLETE'});
  });

  it('publishes a complete profile and shows it in the catalog with price from', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const list = await api().get('/api/v1/coaches').set(client.auth);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      id: coach.user.id,
      priceFrom: {amountCents: 2000, currency: 'USD'},
      kinds: ['group', 'individual'],
    });
    const details = await api().get(`/api/v1/coaches/${coach.user.id}`).set(client.auth);
    expect(details.body.sessionTypes).toHaveLength(2);
    expect(details.body.cancellationPolicy).toEqual({freeCancelHours: 24});
  });

  it('lists coaches of the client state first and filters by city/state/specialization', async () => {
    const ny = await publishedCoach({
      homeArea: {city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York'},
    });
    const chi = await publishedCoach();
    const client = await registerUser('client');
    const all = await api().get('/api/v1/coaches').set(client.auth);
    expect(all.body.items.map((c: {id: string}) => c.id)).toEqual([chi.user.id, ny.user.id]);
    const byState = await api().get('/api/v1/coaches?state=ny').set(client.auth);
    expect(byState.body.items.map((c: {id: string}) => c.id)).toEqual([ny.user.id]);
    const byCity = await api()
      .get('/api/v1/coaches?city=chicago&specialization=strength')
      .set(client.auth);
    expect(byCity.body.items).toHaveLength(1);
    const none = await api().get('/api/v1/coaches?specialization=yoga').set(client.auth);
    expect(none.body.total).toBe(0);
    const search = await api()
      .get('/api/v1/coaches?search=conditioning&pageSize=1&page=2')
      .set(client.auth);
    expect(search.body).toMatchObject({total: 2, page: 2, pageSize: 1});
    expect(search.body.items).toHaveLength(1);
  });

  it('price changes keep the catalog price up to date', async () => {
    const coach = await publishedCoach();
    await api()
      .patch(`/api/v1/coach/session-types/${coach.groupTypeId}`)
      .set(coach.auth)
      .send({price: {amountCents: 1500, currency: 'USD'}});
    const client = await registerUser('client');
    const list = await api().get('/api/v1/coaches').set(client.auth);
    expect(list.body.items[0].priceFrom.amountCents).toBe(1500);
  });

  it('clients cannot call coach endpoints and vice versa', async () => {
    const client = await registerUser('client');
    const coach = await registerUser('coach');
    expect((await api().get('/api/v1/coach/profile').set(client.auth)).body.error.code).toBe(
      'FORBIDDEN',
    );
    expect((await api().get('/api/v1/bookings').set(coach.auth)).body.error.code).toBe('FORBIDDEN');
  });
});

describe('slots', () => {
  it('returns slots inside working hours, honoring exceptions and existing bookings', async () => {
    const coach = await publishedCoach();
    await api()
      .put('/api/v1/coach/availability')
      .set(coach.auth)
      .send({
        weekly: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({weekday, start: '09:00', end: '12:00'})),
      });
    const client = await registerUser('client');
    const query = (day: number) =>
      `/api/v1/coaches/${coach.user.id}/slots?sessionTypeId=${coach.individualTypeId}&from=${encodeURIComponent(chicagoAt(day, '00:00'))}&to=${encodeURIComponent(chicagoAt(day + 1, '00:00'))}`;

    const slots = await api().get(query(3)).set(client.auth);
    expect(slots.body.items.map((s: {startAt: string}) => s.startAt)).toEqual(
      [
        chicagoAt(3, '09:00'),
        chicagoAt(3, '09:30'),
        chicagoAt(3, '10:00'),
        chicagoAt(3, '10:30'),
        chicagoAt(3, '11:00'),
      ].map(iso => new Date(iso).toISOString()),
    );

    await api()
      .post('/api/v1/coach/availability/exceptions')
      .set(coach.auth)
      .send({date: chicagoDate(3), start: '10:00', end: '11:00'});
    const withException = await api().get(query(3)).set(client.auth);
    expect(withException.body.items).toHaveLength(2); // 09:00 and 11:00

    await api()
      .post('/api/v1/coach/availability/exceptions')
      .set(coach.auth)
      .send({date: chicagoDate(3), reason: 'Vacation'});
    expect((await api().get(query(3)).set(client.auth)).body.items).toHaveLength(0);

    const booked = await api()
      .post('/api/v1/bookings')
      .set(client.auth)
      .send({sessionTypeId: coach.individualTypeId, startAt: chicagoAt(4, '10:00')});
    expect(booked.status).toBe(201);
    const after = await api().get(query(4)).set(client.auth);
    expect(after.body.items.map((s: {startAt: string}) => s.startAt)).toEqual(
      [chicagoAt(4, '09:00'), chicagoAt(4, '11:00')].map(iso => new Date(iso).toISOString()),
    );
  });

  it('keeps local working hours across the DST change in Chicago', () => {
    // US DST ends on Sunday 2026-11-01: Saturday is CDT (UTC-5), Monday is CST (UTC-6).
    const slots = computeSlots({
      timezone: 'America/Chicago',
      weekly: [6, 1].map(weekday => ({weekday, start: '09:00', end: '10:00'})),
      exceptions: [],
      durationMin: 60,
      from: new Date('2026-10-31T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
      locked: new Set(),
      notBefore: new Date(0),
    });
    expect(slots.map(s => s.startAt.toISOString())).toEqual([
      '2026-10-31T14:00:00.000Z',
      '2026-11-02T15:00:00.000Z',
    ]);
  });

  it('skips the nonexistent local hour on spring-forward day', () => {
    // 2027-03-14: 02:00-03:00 does not exist in Chicago.
    const slots = computeSlots({
      timezone: 'America/Chicago',
      weekly: [{weekday: 0, start: '01:00', end: '04:00'}],
      exceptions: [],
      durationMin: 30,
      from: new Date('2027-03-14T00:00:00Z'),
      to: new Date('2027-03-15T12:00:00Z'),
      locked: new Set(),
      notBefore: new Date(0),
    });
    const local = slots.map(s => s.startAt.toISOString());
    expect(local).toEqual([
      '2027-03-14T07:00:00.000Z',
      '2027-03-14T07:30:00.000Z',
      '2027-03-14T08:00:00.000Z',
      '2027-03-14T08:30:00.000Z',
    ]);
  });
});
