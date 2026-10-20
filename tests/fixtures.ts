import {DateTime} from 'luxon';

import {api, registerUser} from './helpers.js';

export const CHICAGO_TZ = 'America/Chicago';

export const LAKEFRONT = {
  name: 'North Avenue Beach',
  address: '1600 N Lake Shore Dr, Chicago, IL 60613',
  city: 'Chicago',
  state: 'IL',
  lat: 41.9167,
  lng: -87.6253,
};

/** A local date in Chicago N days from today at hh:mm, as an ISO UTC string. */
export function chicagoAt(daysFromToday: number, time: string) {
  const [hour, minute] = time.split(':').map(Number);
  return DateTime.now()
    .setZone(CHICAGO_TZ)
    .startOf('day')
    .plus({days: daysFromToday})
    .set({hour, minute})
    .toUTC()
    .toISO()!;
}

export const chicagoDate = (daysFromToday: number) =>
  DateTime.now().setZone(CHICAGO_TZ).startOf('day').plus({days: daysFromToday}).toISODate()!;

export const weekdayOf = (daysFromToday: number) =>
  DateTime.now().setZone(CHICAGO_TZ).startOf('day').plus({days: daysFromToday}).weekday % 7;

type CoachOptions = {
  freeCancelHours?: number;
  homeArea?: Record<string, string>;
  groupCapacity?: number;
};

/** A published coach working 06:00-22:00 every day with one individual and one group training type. */
export async function publishedCoach(options: CoachOptions = {}) {
  const coach = await registerUser('coach', options.homeArea ? {homeArea: options.homeArea} : {});
  const profile = await api()
    .put('/api/v1/coach/profile')
    .set(coach.auth)
    .send({
      headline: 'Strength & conditioning coach',
      bio: 'Certified strength coach helping busy people get strong with simple, sustainable programs.',
      specializations: ['strength', 'hiit'],
      experienceYears: 8,
      defaultLocation: LAKEFRONT,
    });
  if (profile.status !== 200) throw new Error(JSON.stringify(profile.body));
  const individual = await api()
    .post('/api/v1/coach/session-types')
    .set(coach.auth)
    .send({
      title: '1:1 Strength',
      kind: 'individual',
      durationMin: 60,
      price: {amountCents: 6500, currency: 'USD'},
    });
  const group = await api()
    .post('/api/v1/coach/session-types')
    .set(coach.auth)
    .send({
      title: 'Bootcamp',
      kind: 'group',
      durationMin: 60,
      capacity: options.groupCapacity ?? 3,
      price: {amountCents: 2000, currency: 'USD'},
    });
  await api()
    .put('/api/v1/coach/availability')
    .set(coach.auth)
    .send({
      weekly: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({weekday, start: '06:00', end: '22:00'})),
    });
  if (options.freeCancelHours !== undefined) {
    await api()
      .put('/api/v1/coach/settings/cancellation')
      .set(coach.auth)
      .send({freeCancelHours: options.freeCancelHours});
  }
  const published = await api()
    .post('/api/v1/coach/profile/publish')
    .set(coach.auth)
    .send({isPublished: true});
  if (published.status !== 200) throw new Error(JSON.stringify(published.body));
  return {
    ...coach,
    individualTypeId: individual.body.id as string,
    groupTypeId: group.body.id as string,
  };
}

export async function groupSession(
  coach: {auth: Record<string, string>; groupTypeId: string},
  startAt: string,
) {
  const res = await api()
    .post('/api/v1/coach/group-sessions')
    .set(coach.auth)
    .send({sessionTypeId: coach.groupTypeId, startAt});
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.created[0].id as string;
}
