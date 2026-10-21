import mongoose from 'mongoose';
import request from 'supertest';
import {afterAll, beforeAll, beforeEach} from 'vitest';

import {createApp} from '../src/app.js';
import {mongoUri} from '../src/config/env.js';
import {connectDb, disconnectDb} from '../src/db/connect.js';
import {outbox} from '../src/lib/mailer.js';
import * as models from '../src/models/index.js';

export const app = createApp();
export const api = () => request(app);

/** Connects to the test DB once per file and wipes collections before every test. */
export function useTestDb() {
  beforeAll(async () => {
    if (!mongoUri.includes('test')) {
      throw new Error(`Refusing to run tests against a non-test database: ${mongoUri}`);
    }
    await connectDb(mongoUri);
    await Promise.all(
      Object.values(models)
        .filter(isModel)
        .map(model => model.syncIndexes()),
    );
  });
  beforeEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map(c => c.deleteMany({})));
  });
  afterAll(async () => {
    await disconnectDb();
  });
}

function isModel(value: unknown): value is mongoose.Model<unknown> {
  return typeof value === 'function' && 'syncIndexes' in value;
}

export const CHICAGO = {
  city: 'Chicago',
  state: 'IL',
  country: 'US',
  timezone: 'America/Chicago',
} as const;

let counter = 0;
export async function registerUser(
  role: 'coach' | 'client',
  overrides: Record<string, unknown> = {},
) {
  counter += 1;
  const body = {
    email: `${role}${counter}@test.dev`,
    password: 'Password123!',
    firstName: role === 'coach' ? 'Coach' : 'Client',
    lastName: `N${counter}`,
    role,
    homeArea: CHICAGO,
    ...overrides,
  };
  const res = await api().post('/api/v1/auth/register').send(body);
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const session = await verifyWithEmailedCode(body.email as string, res.body.verification.id);
  return {
    user: session.user as {id: string; email: string},
    token: session.tokens.accessToken as string,
    refreshToken: session.tokens.refreshToken as string,
    auth: {Authorization: `Bearer ${session.tokens.accessToken}`},
  };
}

/** The last code emailed to this address (tests collect emails in `outbox`). */
export function lastCode(email: string) {
  const mail = outbox.findLast(m => m.to === email.toLowerCase() && /code: \d{6}/.test(m.subject));
  if (!mail) throw new Error(`no code emailed to ${email}`);
  return /(\d{6})/.exec(mail.subject)![1]!;
}

export async function verifyWithEmailedCode(email: string, verificationId: string) {
  const res = await api()
    .post('/api/v1/auth/verify')
    .send({verificationId, code: lastCode(email)});
  if (res.status !== 200) {
    throw new Error(`verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as {user: {id: string; email: string}; tokens: Record<string, string>};
}

/** Email + password sign-in including the code step. */
export async function login(email: string, password = 'Password123!') {
  const res = await api().post('/api/v1/auth/login').send({email, password});
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return verifyWithEmailedCode(email, res.body.verification.id);
}
