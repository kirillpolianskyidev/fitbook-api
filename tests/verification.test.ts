import mongoose from 'mongoose';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {env} from '../src/config/env.js';
import {runMigrations} from '../src/db/migrations.js';
import {mailTransport, outbox} from '../src/lib/mailer.js';
import {EmailVerificationModel} from '../src/models/emailVerification.js';
import {UserModel} from '../src/models/user.js';
import {socialVerifiers} from '../src/modules/auth/social.js';
import {api, CHICAGO, lastCode, login, registerUser, useTestDb} from './helpers.js';

useTestDb();
beforeEach(() => {
  outbox.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  env.AUTH_DEV_FIXED_CODE = undefined;
  env.NODE_ENV = 'test';
  env.SMTP_USER = '';
});

const v1 = '/api/v1';
const PASSWORD = 'Password123!';
let n = 0;
const newEmail = () => `verify${(n += 1)}@test.dev`;
const registerBody = (email: string, overrides: Record<string, unknown> = {}) => ({
  email,
  password: PASSWORD,
  firstName: 'Jamie',
  lastName: 'Lee',
  role: 'client',
  homeArea: CHICAGO,
  ...overrides,
});
const register = (email: string, overrides: Record<string, unknown> = {}) =>
  api().post(`${v1}/auth/register`).send(registerBody(email, overrides));
const verify = (verificationId: string, code: string) =>
  api().post(`${v1}/auth/verify`).send({verificationId, code});
const resend = (verificationId: string) =>
  api().post(`${v1}/auth/verify/resend`).send({verificationId});
const wrongCodeFor = (code: string) => (code === '111111' ? '222222' : '111111');
/** Moves the resend cooldown into the past instead of waiting 60 seconds. */
const allowResend = (id: string) =>
  EmailVerificationModel.updateOne({_id: id}, {resendAvailableAt: new Date(Date.now() - 1000)});

describe('email verification: sign up', () => {
  it('register -> code by email -> verify -> session, and the email is verified', async () => {
    const email = newEmail();
    const res = await register(email);
    expect(res.status).toBe(201);
    expect(res.body.tokens).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    const {verification} = res.body;
    expect(verification).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      purpose: 'signup',
      email,
      codeLength: 6,
      expiresAt: expect.any(String),
      resendAvailableAt: expect.any(String),
    });
    const ttl = Date.parse(verification.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    const cooldown = Date.parse(verification.resendAvailableAt) - Date.now();
    expect(cooldown).toBeGreaterThan(50_000);
    expect(cooldown).toBeLessThanOrEqual(60_000);

    expect(outbox).toHaveLength(1);
    const mail = outbox[0]!;
    const code = lastCode(email);
    expect(mail.subject).toBe(`Your FitBook code: ${code}`);
    expect(mail.text).toContain(code);
    expect(mail.text).toContain('It expires in 10 minutes.');
    expect(mail.text).toContain('Confirm your email to finish creating your FitBook account.');

    // The plain code is never stored.
    const stored = await EmailVerificationModel.findById(verification.id).lean();
    expect(stored!.codeHash).not.toContain(code);
    expect(stored!.codeHash).toHaveLength(64);
    expect((await UserModel.findOne({email}))!.emailVerifiedAt).toBeNull();

    const ok = await verify(verification.id, code);
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({email, role: 'client', onboardingCompleted: true});
    expect(ok.body.tokens).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      accessTokenExpiresAt: expect.any(String),
    });
    const me = await api()
      .get(`${v1}/me`)
      .set({Authorization: `Bearer ${ok.body.tokens.accessToken}`});
    expect(me.status).toBe(200);
    expect((await UserModel.findOne({email}))!.emailVerifiedAt).toBeInstanceOf(Date);

    // Single use.
    const again = await verify(verification.id, code);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('VERIFICATION_CODE_EXPIRED');
  });

  it('re-registering an unverified email updates that account', async () => {
    const email = newEmail();
    const first = await register(email, {firstName: 'Typo', role: 'coach'});
    const firstCode = lastCode(email);
    const second = await register(email, {
      firstName: 'Jamie',
      role: 'client',
      password: 'Different123',
    });
    expect(second.status).toBe(201);
    expect(second.body.verification.id).not.toBe(first.body.verification.id);
    expect(await UserModel.countDocuments({email})).toBe(1);

    // The first verification no longer works.
    const old = await verify(first.body.verification.id, firstCode);
    expect(old.body.error.code).toBe('VERIFICATION_CODE_EXPIRED');

    const ok = await verify(second.body.verification.id, lastCode(email));
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({firstName: 'Jamie', role: 'client'});
    const me = await api()
      .get(`${v1}/me`)
      .set({Authorization: `Bearer ${ok.body.tokens.accessToken}`});
    expect(me.body.coachProfile).toBeNull();
    expect((await api().post(`${v1}/auth/login`).send({email, password: PASSWORD})).status).toBe(
      401,
    );
    expect(
      (await api().post(`${v1}/auth/login`).send({email, password: 'Different123'})).status,
    ).toBe(200);
  });

  it('a verified email is taken', async () => {
    const {user} = await registerUser('client');
    const res = await register(user.email.toUpperCase());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('creates the coach profile once the email is verified', async () => {
    const coach = await registerUser('coach');
    const me = await api().get(`${v1}/me`).set(coach.auth);
    expect(me.body.coachProfile).toEqual({isPublished: false, headline: ''});
  });
});

describe('email verification: password sign-in', () => {
  it('login -> code -> verify -> session', async () => {
    const {user} = await registerUser('client');
    outbox.length = 0;
    const res = await api().post(`${v1}/auth/login`).send({email: user.email, password: PASSWORD});
    expect(res.status).toBe(200);
    expect(res.body.tokens).toBeUndefined();
    expect(res.body.verification).toMatchObject({purpose: 'login', email: user.email});
    expect(outbox[0]!.text).toContain(
      "Use this code to sign in to FitBook. If this wasn't you, change your password.",
    );
    const ok = await verify(res.body.verification.id, lastCode(user.email));
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(user.id);
  });

  it('wrong password does not send a code', async () => {
    const {user} = await registerUser('client');
    outbox.length = 0;
    const bad = await api()
      .post(`${v1}/auth/login`)
      .send({email: user.email, password: 'nope1234'});
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await api()
      .post(`${v1}/auth/login`)
      .send({email: 'nobody@test.dev', password: PASSWORD});
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(outbox).toHaveLength(0);
  });

  it('signing in to an unverified account sends a signup code and verifies the email', async () => {
    const email = newEmail();
    await register(email);
    const res = await api().post(`${v1}/auth/login`).send({email, password: PASSWORD});
    expect(res.body.verification.purpose).toBe('signup');
    expect(outbox.at(-1)!.text).toContain('Confirm your email');
    expect((await verify(res.body.verification.id, lastCode(email))).status).toBe(200);
    expect((await UserModel.findOne({email}))!.emailVerifiedAt).toBeInstanceOf(Date);

    const next = await api().post(`${v1}/auth/login`).send({email, password: PASSWORD});
    expect(next.body.verification.purpose).toBe('login');
  });

  it('a new sign-in invalidates the previous pending code', async () => {
    const {user} = await registerUser('client');
    const first = await api()
      .post(`${v1}/auth/login`)
      .send({email: user.email, password: PASSWORD});
    const firstCode = lastCode(user.email);
    await api().post(`${v1}/auth/login`).send({email: user.email, password: PASSWORD});
    const res = await verify(first.body.verification.id, firstCode);
    expect(res.body.error.code).toBe('VERIFICATION_CODE_EXPIRED');
  });
});

describe('POST /auth/verify errors', () => {
  async function pending() {
    const email = newEmail();
    const res = await register(email);
    return {email, id: res.body.verification.id as string, code: lastCode(email)};
  }

  it('validates the code format and unknown ids', async () => {
    const {id} = await pending();
    for (const code of ['12345', '1234567', 'abcdef', '12 456']) {
      const res = await verify(id, code);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields.code).toBeDefined();
    }
    const unknown = await verify('0'.repeat(32), '123456');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
  });

  it('wrong codes increment attempts; after 5 -> TOO_MANY_ATTEMPTS even for the right code', async () => {
    const {id, code} = await pending();
    for (let i = 1; i <= 5; i += 1) {
      const res = await verify(id, wrongCodeFor(code));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VERIFICATION_CODE_INVALID');
      expect(res.body.error.message).toBe('The code is incorrect.');
      expect(res.body.error.details.attemptsLeft).toBe(5 - i);
      expect((await EmailVerificationModel.findById(id))!.attempts).toBe(i);
    }
    const locked = await verify(id, code);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('parallel wrong guesses cannot exceed the attempt limit', async () => {
    const {id, code} = await pending();
    await Promise.all(Array.from({length: 12}, () => verify(id, wrongCodeFor(code))));
    expect((await EmailVerificationModel.findById(id))!.attempts).toBe(5);
  });

  it('an expired code (10 min) -> VERIFICATION_CODE_EXPIRED', async () => {
    const {id, code} = await pending();
    await EmailVerificationModel.updateOne({_id: id}, {codeExpiresAt: new Date(Date.now() - 1)});
    const res = await verify(id, code);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VERIFICATION_CODE_EXPIRED',
      message: 'The code has expired. Request a new one.',
    });
  });

  it('an expired verification (30 min) -> VERIFICATION_CODE_EXPIRED for verify and resend', async () => {
    const {id, code} = await pending();
    await EmailVerificationModel.updateOne(
      {_id: id},
      {expiresAt: new Date(Date.now() - 1), resendAvailableAt: new Date(Date.now() - 1)},
    );
    expect((await verify(id, code)).body.error.code).toBe('VERIFICATION_CODE_EXPIRED');
    expect((await resend(id)).body.error.code).toBe('VERIFICATION_CODE_EXPIRED');
  });

  it('AUTH_DEV_FIXED_CODE works outside production only', async () => {
    const {user} = await registerUser('client');
    env.AUTH_DEV_FIXED_CODE = '000000';
    const code = '000000';
    const first = await api()
      .post(`${v1}/auth/login`)
      .send({email: user.email, password: PASSWORD});
    if (lastCode(user.email) !== code) {
      env.NODE_ENV = 'production';
      expect((await verify(first.body.verification.id, code)).body.error.code).toBe(
        'VERIFICATION_CODE_INVALID',
      );
      env.NODE_ENV = 'test';
    }
    expect((await verify(first.body.verification.id, code)).status).toBe(200);
  });
});

describe('POST /auth/verify/resend', () => {
  it('is rate limited until resendAvailableAt', async () => {
    const email = newEmail();
    const {body} = await register(email);
    const res = await resend(body.verification.id);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(50);
    expect(res.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('sends a new code: the old one stops working and attempts reset', async () => {
    const email = newEmail();
    const {body} = await register(email);
    const id = body.verification.id as string;
    const oldCode = lastCode(email);
    for (let i = 0; i < 5; i += 1) await verify(id, wrongCodeFor(oldCode));
    expect((await verify(id, oldCode)).body.error.code).toBe('TOO_MANY_ATTEMPTS');

    await allowResend(id);
    const res = await resend(id);
    expect(res.status).toBe(200);
    expect(res.body.verification).toMatchObject({id, purpose: 'signup', email, codeLength: 6});
    expect(Date.parse(res.body.verification.resendAvailableAt)).toBeGreaterThan(
      Date.now() + 50_000,
    );
    expect(outbox).toHaveLength(2);
    const newCode = lastCode(email);

    const stored = await EmailVerificationModel.findById(id);
    expect(stored).toMatchObject({attempts: 0, resendCount: 1});
    if (newCode !== oldCode) {
      const old = await verify(id, oldCode);
      expect(old.body.error.code).toBe('VERIFICATION_CODE_INVALID');
      expect(old.body.error.details.attemptsLeft).toBe(4);
    }
    expect((await verify(id, newCode)).status).toBe(200);
  });

  it('allows at most 5 resends', async () => {
    const email = newEmail();
    const {body} = await register(email);
    const id = body.verification.id as string;
    for (let i = 0; i < 5; i += 1) {
      await allowResend(id);
      expect((await resend(id)).status).toBe(200);
    }
    await allowResend(id);
    const capped = await resend(id);
    expect(capped.status).toBe(400);
    expect(capped.body.error.code).toBe('VERIFICATION_CODE_EXPIRED');
    // The last code still works until it expires.
    expect((await verify(id, lastCode(email))).status).toBe(200);
  });

  it('unknown and used verifications', async () => {
    expect((await resend('f'.repeat(32))).body.error.code).toBe('NOT_FOUND');
    const email = newEmail();
    const {body} = await register(email);
    await verify(body.verification.id, lastCode(email));
    await allowResend(body.verification.id);
    expect((await resend(body.verification.id)).body.error.code).toBe('VERIFICATION_CODE_EXPIRED');
  });
});

describe('password reset and change', () => {
  async function resetFlow(email: string, newPassword: string) {
    await api().post(`${v1}/auth/password/forgot`).send({email});
    const code = /reset code is (\d{6})/.exec(outbox.at(-1)!.text)![1]!;
    const verified = await api().post(`${v1}/auth/password/verify-code`).send({email, code});
    return api()
      .post(`${v1}/auth/password/reset`)
      .send({resetToken: verified.body.resetToken, newPassword});
  }

  it('reset returns a session and verifies the email (no extra code)', async () => {
    const email = newEmail();
    const pendingSignup = await register(email);
    const res = await resetFlow(email, 'NewPassword9');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.tokens.accessToken).toEqual(expect.any(String));
    expect((await UserModel.findOne({email}))!.emailVerifiedAt).toBeInstanceOf(Date);
    // Codes sent before the reset no longer work.
    expect(
      (await verify(pendingSignup.body.verification.id, lastCode(email))).body.error.code,
    ).toBe('VERIFICATION_CODE_EXPIRED');
    const next = await api().post(`${v1}/auth/login`).send({email, password: 'NewPassword9'});
    expect(next.body.verification.purpose).toBe('login');
  });

  it('change password returns tokens for this device and revokes other sessions', async () => {
    const {user} = await registerUser('client');
    const a = await login(user.email);
    const b = await login(user.email);
    const changed = await api()
      .patch(`${v1}/me/password`)
      .set({Authorization: `Bearer ${a.tokens.accessToken}`})
      .send({currentPassword: PASSWORD, newPassword: 'Changed123'});
    expect(changed.status).toBe(200);
    expect(
      (await api().post(`${v1}/auth/refresh`).send({refreshToken: b.tokens.refreshToken})).status,
    ).toBe(401);
    expect(
      (await api().post(`${v1}/auth/refresh`).send({refreshToken: a.tokens.refreshToken})).status,
    ).toBe(401);
    const refreshed = await api()
      .post(`${v1}/auth/refresh`)
      .send({refreshToken: changed.body.refreshToken});
    expect(refreshed.status).toBe(200);
  });
});

describe('social sign-in and refresh', () => {
  it('Google sign-in needs no code and marks the email verified', async () => {
    vi.spyOn(socialVerifiers, 'google').mockResolvedValue({
      providerUserId: 'g-verify-1',
      email: 'social.verify@gmail.com',
      emailVerified: true,
    });
    const res = await api().post(`${v1}/auth/google`).send({idToken: 'fake-google-token'});
    expect(res.status).toBe(200);
    expect(res.body.tokens.accessToken).toEqual(expect.any(String));
    expect(outbox).toHaveLength(0);
    const user = await UserModel.findById(res.body.user.id);
    expect(user!.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('Apple sign-in sets emailVerifiedAt on an existing account and needs no code', async () => {
    const {user} = await registerUser('client');
    await UserModel.updateOne({_id: user.id}, {emailVerifiedAt: new Date('2026-01-01')});
    vi.spyOn(socialVerifiers, 'apple').mockResolvedValue({
      providerUserId: 'a-verify-1',
      email: user.email,
      emailVerified: true,
    });
    outbox.length = 0;
    const res = await api().post(`${v1}/auth/apple`).send({identityToken: 'fake-apple-token'});
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(outbox).toHaveLength(0);
  });

  it('a provider-verified sign-in discards an unconfirmed password account with the same email', async () => {
    const email = newEmail();
    await register(email, {password: 'Attacker123'});
    vi.spyOn(socialVerifiers, 'google').mockResolvedValue({
      providerUserId: 'g-owner',
      email,
      emailVerified: true,
      firstName: 'Owner',
    });
    const res = await api().post(`${v1}/auth/google`).send({idToken: 'fake-google-token'});
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      firstName: 'Owner',
      authProviders: ['google'],
      onboardingCompleted: false,
    });
    const login = await api().post(`${v1}/auth/login`).send({email, password: 'Attacker123'});
    expect(login.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refresh does not need a code', async () => {
    const {refreshToken} = await registerUser('client');
    outbox.length = 0;
    const res = await api().post(`${v1}/auth/refresh`).send({refreshToken});
    expect(res.status).toBe(200);
    expect(outbox).toHaveLength(0);
  });
});

describe('migration', () => {
  it('marks users created before email verification as verified', async () => {
    const createdAt = new Date('2026-10-20T13:32:43.217Z');
    await mongoose.connection.db!.collection('users').insertOne({
      email: 'legacy@test.dev',
      emailKey: 'legacy@test.dev',
      firstName: 'Legacy',
      authProviders: [],
      createdAt,
    });
    await runMigrations();
    await runMigrations(); // idempotent
    const legacy = await mongoose.connection.db!.collection('users').findOne({
      email: 'legacy@test.dev',
    });
    expect(legacy!.emailVerifiedAt).toEqual(createdAt);

    // Users that are waiting for their code stay unverified.
    const email = newEmail();
    await register(email);
    await runMigrations();
    expect((await UserModel.findOne({email}))!.emailVerifiedAt).toBeNull();
  });
});

describe('email delivery failures', () => {
  /** A real email service is configured, but it cannot be reached (e.g. a VPN blocks the SMTP port). */
  function smtpDown() {
    env.SMTP_USER = 'login@smtp-brevo.com';
    return vi.spyOn(mailTransport, 'deliver').mockRejectedValue(new Error('Connection timeout'));
  }
  const expectDeliveryFailed = (res: {
    status: number;
    body: {error: {code: string; message: string}};
  }) => {
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'EMAIL_DELIVERY_FAILED',
      message: "We couldn't send the email with your code. Try again in a few minutes.",
    });
  };

  it('register: 503, no usable verification, retry works once email is back', async () => {
    const email = newEmail();
    const deliver = smtpDown();
    expectDeliveryFailed(await register(email));
    expect(await EmailVerificationModel.countDocuments({invalidatedAt: null})).toBe(0);
    expect((await UserModel.findOne({email}))!.emailVerifiedAt).toBeNull();

    deliver.mockRestore();
    const retry = await register(email);
    expect(retry.status).toBe(201);
    expect((await verify(retry.body.verification.id, lastCode(email))).status).toBe(200);
  });

  it('login: 503 and the undelivered verification cannot be used', async () => {
    const {user} = await registerUser('client');
    env.AUTH_DEV_FIXED_CODE = '000000';
    smtpDown();
    expectDeliveryFailed(
      await api().post(`${v1}/auth/login`).send({email: user.email, password: PASSWORD}),
    );
    const pending = await EmailVerificationModel.findOne({invalidatedAt: null, consumedAt: null});
    expect(pending).toBeNull();
  });

  it('resend: 503, does not count as a resend and can be retried immediately', async () => {
    const email = newEmail();
    const {body} = await register(email);
    const id = body.verification.id as string;
    await allowResend(id);
    const deliver = smtpDown();
    expectDeliveryFailed(await resend(id));
    const stored = await EmailVerificationModel.findById(id);
    expect(stored!.resendCount).toBe(0);
    expect(stored!.resendAvailableAt.getTime()).toBeLessThanOrEqual(Date.now());

    deliver.mockRestore();
    const retry = await resend(id);
    expect(retry.status).toBe(200);
    expect((await verify(id, lastCode(email))).status).toBe(200);
  });

  it('forgot password stays 204 (no account enumeration)', async () => {
    const {user} = await registerUser('client');
    smtpDown();
    const res = await api().post(`${v1}/auth/password/forgot`).send({email: user.email});
    expect(res.status).toBe(204);
  });

  it('local development without SMTP credentials falls back to the log', async () => {
    vi.spyOn(mailTransport, 'deliver').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await register(newEmail());
    expect(res.status).toBe(201);
  });
});
