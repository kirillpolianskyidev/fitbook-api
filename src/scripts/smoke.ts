/**
 * Smoke test against the seeded development database (run `npm run seed:reset` first).
 * It creates a few bookings, notes and messages, so reseed afterwards for a clean demo.
 *
 *   npm run smoke                 # run the checks
 *   npm run smoke -- --examples   # also write docs/examples.json (used to build API_CONTRACT.md)
 */
import './smokeEnv.js';

import {writeFile} from 'node:fs/promises';

import {DateTime} from 'luxon';
import request from 'supertest';

import {createApp} from '../app.js';
import {connectDb, disconnectDb} from '../db/connect.js';
import {DEMO_PASSWORD} from '../seed/data.js';

const app = createApp();
const examples: Record<string, unknown> = {};
let failures = 0;

type Res = {status: number; body: Record<string, unknown> & {[key: string]: unknown}};

async function step(
  name: string,
  run: () => Promise<Res>,
  expectStatus: number,
  exampleKey?: string,
) {
  const res = await run();
  const ok = res.status === expectStatus;
  if (!ok) failures += 1;
  console.log(
    `${ok ? '✓' : '✗'} ${name} -> ${res.status}${ok ? '' : ` (expected ${expectStatus}) ${JSON.stringify(res.body)}`}`,
  );
  if (exampleKey) examples[exampleKey] = res.body;
  return res;
}

const api = () => request(app);
const bearer = (token: string) => ({Authorization: `Bearer ${token}`});

/** Trims long lists of objects in examples so the contract stays readable (string lists stay complete). */
function trimLists(value: unknown, max = 2): unknown {
  if (Array.isArray(value)) {
    const isObjectList = value.some(v => v && typeof v === 'object');
    return (isObjectList ? value.slice(0, max) : value).map(v => trimLists(v, max));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimLists(v, max)]));
  }
  return value;
}

async function main() {
  await connectDb();
  const v1 = '/api/v1';

  await step('health', () => api().get(`${v1}/health`), 200, 'health');

  const clientLogin = await step(
    'client login (step 1: password -> emailed code)',
    () =>
      api().post(`${v1}/auth/login`).send({email: 'client@fitbook.dev', password: DEMO_PASSWORD}),
    200,
    'verification',
  );
  const clientVerificationId = (clientLogin.body.verification as {id: string}).id;
  await step(
    'resend too early',
    () => api().post(`${v1}/auth/verify/resend`).send({verificationId: clientVerificationId}),
    429,
    'errorResendTooEarly',
  );
  await step(
    'wrong code',
    () =>
      api().post(`${v1}/auth/verify`).send({verificationId: clientVerificationId, code: '999999'}),
    400,
    'errorCodeInvalid',
  );
  const login = await step(
    'client login (step 2: code -> session)',
    () =>
      api()
        .post(`${v1}/auth/verify`)
        .send({verificationId: clientVerificationId, code: process.env.AUTH_DEV_FIXED_CODE}),
    200,
    'authResult',
  );
  await step(
    'code is single use',
    () =>
      api()
        .post(`${v1}/auth/verify`)
        .send({verificationId: clientVerificationId, code: process.env.AUTH_DEV_FIXED_CODE}),
    400,
    'errorCodeExpired',
  );
  const client = bearer((login.body.tokens as {accessToken: string}).accessToken);
  const coachVerification = await step(
    'coach login',
    () =>
      api().post(`${v1}/auth/login`).send({email: 'coach@fitbook.dev', password: DEMO_PASSWORD}),
    200,
  );
  const coachLogin = await step(
    'coach verify',
    () =>
      api()
        .post(`${v1}/auth/verify`)
        .send({
          verificationId: (coachVerification.body.verification as {id: string}).id,
          code: process.env.AUTH_DEV_FIXED_CODE,
        }),
    200,
  );
  const coach = bearer((coachLogin.body.tokens as {accessToken: string}).accessToken);
  const coachId = (coachLogin.body.user as {id: string}).id;

  await step(
    'wrong password',
    () => api().post(`${v1}/auth/login`).send({email: 'client@fitbook.dev', password: 'nope'}),
    401,
    'errorInvalidCredentials',
  );
  await step(
    'refresh',
    () =>
      api()
        .post(`${v1}/auth/refresh`)
        .send({refreshToken: (login.body.tokens as {refreshToken: string}).refreshToken}),
    200,
    'tokens',
  );
  await step('me', () => api().get(`${v1}/me`).set(client), 200, 'me');
  await step(
    'trial status (used)',
    () => api().get(`${v1}/me/trial`).set(client),
    200,
    'trialStatus',
  );

  const coaches = await step(
    'coach catalog (Chicago first)',
    () => api().get(`${v1}/coaches?pageSize=3`).set(client),
    200,
    'coachList',
  );
  const firstState = (coaches.body.items as {homeArea: {state: string}}[])[0]?.homeArea.state ?? '';
  console.log(`  first coach state: ${firstState}, total: ${coaches.body.total}`);
  await step(
    'catalog filter',
    () => api().get(`${v1}/coaches?specialization=yoga`).set(client),
    200,
  );
  const details = await step(
    'coach details',
    () => api().get(`${v1}/coaches/${coachId}`).set(client),
    200,
    'coachDetails',
  );
  const individualType = (
    details.body.sessionTypes as {id: string; kind: string; durationMin: number}[]
  ).find(t => t.kind === 'individual' && t.durationMin === 60)!;

  const from = DateTime.now().setZone('America/Chicago').startOf('day').plus({days: 7});
  const slots = await step(
    'slots next week',
    () =>
      api()
        .get(`${v1}/coaches/${coachId}/slots`)
        .query({
          sessionTypeId: individualType.id,
          from: from.toUTC().toISO(),
          to: from.plus({days: 2}).toUTC().toISO(),
        })
        .set(client),
    200,
    'slots',
  );
  const freeSlots = slots.body.items as {startAt: string}[];
  console.log(`  ${freeSlots.length} free slots`);

  const groups = await step(
    'group sessions',
    () =>
      api()
        .get(`${v1}/coaches/${coachId}/group-sessions`)
        .query({
          from: DateTime.now().toUTC().toISO(),
          to: DateTime.now().plus({days: 14}).toUTC().toISO(),
        })
        .set(client),
    200,
    'groupSessions',
  );

  const booked = await step(
    'book individual slot',
    () =>
      api()
        .post(`${v1}/bookings`)
        .set(client)
        .send({sessionTypeId: individualType.id, startAt: freeSlots[0]!.startAt}),
    201,
    'bookingPending',
  );
  const bookingId = booked.body.id as string;
  await step(
    'book same slot again',
    () =>
      api()
        .post(`${v1}/bookings`)
        .set(client)
        .send({sessionTypeId: individualType.id, startAt: freeSlots[0]!.startAt}),
    409,
    'errorSlotUnavailable',
  );
  await step(
    'trial again',
    () =>
      api()
        .post(`${v1}/bookings`)
        .set(client)
        .send({sessionTypeId: individualType.id, startAt: freeSlots[2]!.startAt, isTrial: true}),
    409,
    'errorTrialUsed',
  );
  await step(
    'pay booking',
    () => api().post(`${v1}/bookings/${bookingId}/pay`).set(client),
    200,
    'bookingConfirmed',
  );
  await step(
    'calendar event',
    () => api().get(`${v1}/bookings/${bookingId}/calendar-event`).set(client),
    200,
    'calendarEvent',
  );
  await step(
    'add note',
    () =>
      api()
        .post(`${v1}/bookings/${bookingId}/notes`)
        .set(client)
        .send({phase: 'before', text: 'Please focus on hip mobility today.'}),
    201,
    'note',
  );

  const groupItems = groups.body.items as {id: string; spotsLeft: number}[];
  const openGroup = groupItems.find(g => g.spotsLeft > 0);
  if (openGroup) {
    const joined = await api().post(`${v1}/bookings`).set(client).send({sessionId: openGroup.id});
    console.log(
      `${joined.status === 201 || joined.status === 409 ? '✓' : '✗'} join group session -> ${joined.status}`,
    );
    if (joined.status === 201) examples.bookingGroup = joined.body;
  }
  const fullGroup = groupItems.find(g => g.spotsLeft === 0);
  if (fullGroup)
    await step(
      'join full group',
      () => api().post(`${v1}/bookings`).set(client).send({sessionId: fullGroup.id}),
      409,
      'errorSessionFull',
    );

  const weekday = from.plus({days: 1}).weekday % 7;
  const preview = await step(
    'series preview',
    () =>
      api()
        .post(`${v1}/bookings/series/preview`)
        .set(client)
        .send({
          sessionTypeId: individualType.id,
          weekdays: [weekday],
          time: '18:00',
          weeks: 3,
          startDate: from.toISODate(),
        }),
    200,
    'seriesPreview',
  );
  const dates = (preview.body.items as {date: string; available: boolean}[]).map(i => i.date);
  await step(
    'series booking',
    () =>
      api()
        .post(`${v1}/bookings/series`)
        .set(client)
        .send({
          sessionTypeId: individualType.id,
          weekdays: [weekday],
          time: '18:00',
          weeks: 3,
          startDate: from.toISODate(),
          dates,
        }),
    201,
    'seriesResult',
  );

  const upcoming = await step(
    'upcoming bookings',
    () => api().get(`${v1}/bookings?scope=upcoming&pageSize=5`).set(client),
    200,
    'bookingList',
  );
  const past = await step(
    'past bookings',
    () => api().get(`${v1}/bookings?scope=past&pageSize=3`).set(client),
    200,
  );
  const pastWithNotes = (past.body.items as {id: string; notesCount: number}[]).find(
    b => b.notesCount > 0,
  );
  if (pastWithNotes)
    await step(
      'notes of a past training',
      () => api().get(`${v1}/bookings/${pastWithNotes.id}/notes`).set(client),
      200,
      'notes',
    );

  const soon = (upcoming.body.items as {id: string; status: string; cancellable: boolean}[]).find(
    b => b.status === 'confirmed' && !b.cancellable,
  );
  if (soon)
    await step(
      'cancel inside policy window',
      () => api().post(`${v1}/bookings/${soon.id}/cancel`).set(client).send({}),
      409,
      'errorCancellationWindow',
    );
  await step(
    'cancel the new booking',
    () =>
      api()
        .post(`${v1}/bookings/${bookingId}/cancel`)
        .set(client)
        .send({reason: 'Schedule change'}),
    200,
    'bookingCancelled',
  );

  const conversations = await step(
    'conversations',
    () => api().get(`${v1}/conversations`).set(client),
    200,
    'conversations',
  );
  const conversationId = (conversations.body.items as {id: string}[])[0]!.id;
  await step(
    'messages',
    () => api().get(`${v1}/conversations/${conversationId}/messages?limit=3`).set(client),
    200,
    'messages',
  );
  await step(
    'send message',
    () =>
      api()
        .post(`${v1}/conversations/${conversationId}/messages`)
        .set(client)
        .send({text: 'See you tomorrow!'}),
    201,
    'message',
  );
  await step(
    'mark read',
    () => api().post(`${v1}/conversations/${conversationId}/read`).set(client),
    204,
  );

  await step(
    'coach profile',
    () => api().get(`${v1}/coach/profile`).set(coach),
    200,
    'coachProfile',
  );
  await step(
    'coach session types',
    () => api().get(`${v1}/coach/session-types`).set(coach),
    200,
    'sessionTypes',
  );
  await step(
    'coach availability',
    () => api().get(`${v1}/coach/availability`).set(coach),
    200,
    'availability',
  );
  const schedule = await step(
    'coach schedule this week',
    () =>
      api()
        .get(`${v1}/coach/schedule`)
        .query({
          from: DateTime.now().toUTC().toISO(),
          to: DateTime.now().plus({days: 7}).toUTC().toISO(),
        })
        .set(coach),
    200,
    'schedule',
  );
  console.log(`  ${(schedule.body.items as unknown[]).length} sessions this week`);
  await step(
    'coach clients',
    () => api().get(`${v1}/coach/clients`).set(coach),
    200,
    'coachClients',
  );
  await step(
    'client calling coach endpoint',
    () => api().get(`${v1}/coach/schedule`).set(client),
    403,
    'errorForbidden',
  );
  await step(
    'validation error',
    () => api().post(`${v1}/auth/register`).send({email: 'bad'}),
    400,
    'errorValidation',
  );

  if (process.argv.includes('--examples')) {
    await writeFile('docs/examples.json', `${JSON.stringify(trimLists(examples), null, 2)}\n`);
    console.log('\nWrote docs/examples.json');
  }
  await disconnectDb();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll smoke checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(async error => {
  console.error(error);
  await disconnectDb();
  process.exit(1);
});
