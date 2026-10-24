import {describe, expect, it} from 'vitest';

import {chicagoAt, groupSession, LAKEFRONT, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
const ZOOM = 'https://zoom.us/j/123456789';
const usd = (amountCents: number) => ({amountCents, currency: 'USD'});
const profile = (auth: Auth, body: Record<string, unknown>) =>
  api().put(`${v1}/coach/profile`).set(auth).send(body);
const createType = (auth: Auth, body: Record<string, unknown>) =>
  api()
    .post(`${v1}/coach/session-types`)
    .set(auth)
    .send({title: 'Online 1:1', kind: 'individual', durationMin: 60, price: usd(7000), ...body});

describe('online settings and training formats', () => {
  it('validates the meeting link and the online / format rules', async () => {
    const coach = await publishedCoach();
    const noUrl = await profile(coach.auth, {online: {enabled: true}});
    expect(noUrl.status).toBe(400);
    expect(noUrl.body.error.details.fields.meetingUrl).toBeDefined();
    const http = await profile(coach.auth, {
      online: {enabled: true, meetingUrl: 'http://zoom.us/j/1'},
    });
    expect(http.body.error.details.fields.meetingUrl).toBeDefined();

    const notEnabled = await createType(coach.auth, {format: 'online'});
    expect(notEnabled.status).toBe(409);
    expect(notEnabled.body.error).toMatchObject({
      code: 'ONLINE_NOT_ENABLED',
      message: 'Turn on online trainings in your profile first.',
    });

    const on = await profile(coach.auth, {online: {enabled: true, meetingUrl: ZOOM}});
    expect(on.status).toBe(200);
    expect(on.body.online).toEqual({enabled: true, meetingUrl: ZOOM});

    const groupBoth = await createType(coach.auth, {kind: 'group', capacity: 5, format: 'both'});
    expect(groupBoth.status).toBe(400);
    expect(groupBoth.body.error.details.fields.format).toBeDefined();
    const both = await createType(coach.auth, {format: 'both'});
    expect(both.status).toBe(201);
    expect(both.body.format).toBe('both');
    // Existing types default to in_person.
    const types = await api().get(`${v1}/coach/session-types`).set(coach.auth);
    expect(types.body.items.map((t: {format: string}) => t.format).sort()).toEqual([
      'both',
      'in_person',
      'in_person',
    ]);

    const off = await profile(coach.auth, {online: {enabled: false}});
    expect(off.status).toBe(409);
    expect(off.body.error).toMatchObject({
      code: 'ONLINE_TYPES_ACTIVE',
      message: 'Change your online trainings to in person before turning online off.',
    });
    await api()
      .patch(`${v1}/coach/session-types/${both.body.id}`)
      .set(coach.auth)
      .send({format: 'in_person'});
    const offOk = await profile(coach.auth, {online: {enabled: false}});
    expect(offOk.body.online).toEqual({enabled: false, meetingUrl: ZOOM});
    const reOnline = await api()
      .patch(`${v1}/coach/session-types/${both.body.id}`)
      .set(coach.auth)
      .send({format: 'online'});
    expect(reOnline.body.error.code).toBe('ONLINE_NOT_ENABLED');
  });

  it('an online-only coach (no default location) can publish', async () => {
    const coach = await registerUser('coach');
    await profile(coach.auth, {
      headline: 'Online yoga',
      bio: 'Calm, structured online yoga classes for every level, from your living room.',
      specializations: ['yoga'],
      experienceYears: 4,
    });
    expect(
      (await api().get(`${v1}/coach/profile`).set(coach.auth)).body.completeness.missing,
    ).toContain('defaultLocation');
    await profile(coach.auth, {online: {enabled: true, meetingUrl: ZOOM}});
    await createType(coach.auth, {format: 'online'});
    await api()
      .put(`${v1}/coach/availability`)
      .set(coach.auth)
      .send({weekly: [1, 2, 3].map(weekday => ({weekday, start: '08:00', end: '12:00'}))});
    const published = await api()
      .post(`${v1}/coach/profile/publish`)
      .set(coach.auth)
      .send({isPublished: true});
    expect(published.status).toBe(200);
    const client = await registerUser('client');
    const card = await api().get(`${v1}/coaches/${coach.user.id}`).set(client.auth);
    expect(card.body.formats).toEqual(['online']);
  });
});

describe('online bookings', () => {
  async function bothCoach() {
    const coach = await publishedCoach();
    await profile(coach.auth, {online: {enabled: true, meetingUrl: ZOOM}});
    const both = await createType(coach.auth, {
      format: 'both',
      title: 'Strength 1:1 (online or gym)',
    });
    return {coach, bothTypeId: both.body.id as string};
  }

  it('"both" types need a format; online bookings have no location and show the meeting link', async () => {
    const {coach, bothTypeId} = await bothCoach();
    const client = await registerUser('client');
    const missing = await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({sessionTypeId: bothTypeId, startAt: chicagoAt(5, '10:00')});
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.fields.format).toBeDefined();

    const online = await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({
        sessionTypeId: bothTypeId,
        startAt: chicagoAt(5, '10:00'),
        format: 'online',
        location: LAKEFRONT,
      });
    expect(online.status).toBe(201);
    expect(online.body).toMatchObject({
      format: 'online',
      meetingUrl: ZOOM,
      session: {format: 'online', location: null},
    });
    const inPerson = await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({sessionTypeId: bothTypeId, startAt: chicagoAt(6, '10:00'), format: 'in_person'});
    expect(inPerson.body).toMatchObject({format: 'in_person', meetingUrl: null});
    expect(inPerson.body.session.location).not.toBeNull();

    // A wrong format for a single-format type.
    const wrong = await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({
        sessionTypeId: coach.individualTypeId,
        startAt: chicagoAt(7, '10:00'),
        format: 'online',
      });
    expect(wrong.body.error.details.fields.format).toBeDefined();

    // The coach sees the link; the calendar event has it; reschedule keeps the format.
    expect(
      (await api().get(`${v1}/bookings/${online.body.id}`).set(coach.auth)).body.meetingUrl,
    ).toBe(ZOOM);
    const event = await api()
      .get(`${v1}/bookings/${online.body.id}/calendar-event`)
      .set(client.auth);
    expect(event.body).toMatchObject({location: null, meetingUrl: ZOOM});
    expect(event.body.notes).toContain(ZOOM);
    const moved = await api()
      .post(`${v1}/bookings/${online.body.id}/reschedule`)
      .set(client.auth)
      .send({startAt: chicagoAt(5, '14:00')});
    expect(moved.body).toMatchObject({format: 'online', meetingUrl: ZOOM});

    // Nobody else sees the link: not in the public profile, not for other clients.
    const other = await registerUser('client');
    const publicProfile = await api().get(`${v1}/coaches/${coach.user.id}`).set(other.auth);
    expect(JSON.stringify(publicProfile.body)).not.toContain(ZOOM);
    expect(publicProfile.body.formats).toEqual(['in_person', 'online']);
    expect((await api().get(`${v1}/bookings/${online.body.id}`).set(other.auth)).status).toBe(403);
  });

  it('group sessions take the format of their type; series accept format', async () => {
    const coach = await publishedCoach();
    await profile(coach.auth, {online: {enabled: true, meetingUrl: ZOOM}});
    const type = await createType(coach.auth, {
      kind: 'group',
      capacity: 5,
      format: 'online',
      title: 'Live HIIT',
    });
    const sessionId = await groupSession(
      {auth: coach.auth, groupTypeId: type.body.id},
      chicagoAt(4, '18:00'),
    );
    const client = await registerUser('client');
    const booked = await api().post(`${v1}/bookings`).set(client.auth).send({sessionId});
    expect(booked.body).toMatchObject({
      format: 'online',
      meetingUrl: ZOOM,
      session: {location: null},
    });

    const both = await createType(coach.auth, {format: 'both'});
    const startDate = chicagoAt(3, '00:00').slice(0, 10);
    const body = {
      sessionTypeId: both.body.id,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      time: '08:00',
      weeks: 1,
      startDate,
    };
    expect(
      (await api().post(`${v1}/bookings/series/preview`).set(client.auth).send(body)).status,
    ).toBe(400);
    const series = await api()
      .post(`${v1}/bookings/series`)
      .set(client.auth)
      .send({...body, format: 'online', dates: [startDate]});
    expect(series.status).toBe(201);
    expect(series.body.bookings[0]).toMatchObject({format: 'online', meetingUrl: ZOOM});
  });

  it('catalog: formats and the format filter', async () => {
    const {coach} = await bothCoach();
    const inPersonOnly = await publishedCoach();
    const client = await registerUser('client');
    const online = await api().get(`${v1}/coaches?format=online`).set(client.auth);
    expect(online.body.items.map((c: {id: string}) => c.id)).toEqual([coach.user.id]);
    expect(online.body.total).toBe(1);
    const inPerson = await api().get(`${v1}/coaches?format=in_person`).set(client.auth);
    expect(inPerson.body.total).toBe(2);
    const all = await api().get(`${v1}/coaches`).set(client.auth);
    const formats = Object.fromEntries(
      all.body.items.map((c: {id: string; formats: string[]}) => [c.id, c.formats]),
    );
    expect(formats[inPersonOnly.user.id]).toEqual(['in_person']);
    expect(JSON.stringify(all.body)).not.toContain(ZOOM);
  });
});
