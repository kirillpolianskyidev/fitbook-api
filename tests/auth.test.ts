import {afterEach, describe, expect, it, vi} from 'vitest';

import {outbox} from '../src/lib/mailer.js';
import {socialVerifiers} from '../src/modules/auth/social.js';
import {api, CHICAGO, login, registerUser, useTestDb} from './helpers.js';

useTestDb();
afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth', () => {
  it('registers clients and coaches with home area and returns tokens', async () => {
    const client = await registerUser('client');
    const me = await api().get('/api/v1/me').set(client.auth);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      role: 'client',
      homeArea: CHICAGO,
      onboardingCompleted: true,
      trialUsed: false,
    });

    const coach = await registerUser('coach');
    const coachMe = await api().get('/api/v1/me').set(coach.auth);
    expect(coachMe.body.coachProfile).toEqual({isPublished: false, headline: ''});
  });

  it('requires home area and a strong password', async () => {
    const res = await api().post('/api/v1/auth/register').send({
      email: 'x@test.dev',
      password: 'short',
      firstName: 'A',
      lastName: 'B',
      role: 'client',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details.fields)).toEqual(
      expect.arrayContaining(['password', 'homeArea']),
    );
  });

  it('rejects duplicate emails case-insensitively', async () => {
    await registerUser('client', {email: 'Dup@Test.dev'});
    const res = await api().post('/api/v1/auth/register').send({
      email: 'dup@test.dev',
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
      role: 'client',
      homeArea: CHICAGO,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('logs in and rejects wrong passwords', async () => {
    const {user} = await registerUser('client');
    const ok = await api()
      .post('/api/v1/auth/login')
      .send({email: user.email, password: 'Password123!'});
    expect(ok.status).toBe(200);
    expect(ok.body.verification.purpose).toBe('login');
    expect(ok.body.tokens).toBeUndefined();
    expect((await login(user.email)).user.id).toBe(user.id);
    const bad = await api().post('/api/v1/auth/login').send({email: user.email, password: 'nope'});
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const {refreshToken} = await registerUser('client');
    const first = await api().post('/api/v1/auth/refresh').send({refreshToken});
    expect(first.status).toBe(200);
    const reuse = await api().post('/api/v1/auth/refresh').send({refreshToken});
    expect(reuse.status).toBe(401);
    const afterReuse = await api()
      .post('/api/v1/auth/refresh')
      .send({refreshToken: first.body.refreshToken});
    expect(afterReuse.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const {auth, refreshToken} = await registerUser('client');
    expect((await api().post('/api/v1/auth/logout').set(auth).send({refreshToken})).status).toBe(
      204,
    );
    expect((await api().post('/api/v1/auth/refresh').send({refreshToken})).status).toBe(401);
  });

  it('rejects missing and malformed tokens', async () => {
    expect((await api().get('/api/v1/me')).body.error.code).toBe('UNAUTHORIZED');
    expect((await api().get('/api/v1/me').set({Authorization: 'Bearer abc'})).status).toBe(401);
  });

  it('resets the password with an emailed code', async () => {
    const {user, refreshToken} = await registerUser('client');
    outbox.length = 0;
    expect(
      (await api().post('/api/v1/auth/password/forgot').send({email: user.email})).status,
    ).toBe(204);
    expect(
      (await api().post('/api/v1/auth/password/forgot').send({email: 'nobody@test.dev'})).status,
    ).toBe(204);
    expect(outbox).toHaveLength(1);
    const code = /reset code is (\d{6})/.exec(outbox[0]!.text)![1]!;

    const wrong = await api()
      .post('/api/v1/auth/password/verify-code')
      .send({email: user.email, code: code === '000000' ? '111111' : '000000'});
    expect(wrong.body.error.code).toBe('RESET_CODE_INVALID');

    const verified = await api()
      .post('/api/v1/auth/password/verify-code')
      .send({email: user.email, code});
    expect(verified.status).toBe(200);
    const reset = await api()
      .post('/api/v1/auth/password/reset')
      .send({resetToken: verified.body.resetToken, newPassword: 'NewPassword9'});
    expect(reset.status).toBe(200);
    expect(reset.body.user.id).toBe(user.id);
    const me = await api()
      .get('/api/v1/me')
      .set({Authorization: `Bearer ${reset.body.tokens.accessToken}`});
    expect(me.status).toBe(200);
    // All old sessions are signed out.
    expect((await api().post('/api/v1/auth/refresh').send({refreshToken})).status).toBe(401);
    expect(
      (await api().post('/api/v1/auth/login').send({email: user.email, password: 'NewPassword9'}))
        .status,
    ).toBe(200);
    expect(
      (await api().post('/api/v1/auth/login').send({email: user.email, password: 'Password123!'}))
        .status,
    ).toBe(401);
  });

  it('locks the reset code after too many attempts', async () => {
    const {user} = await registerUser('client');
    await api().post('/api/v1/auth/password/forgot').send({email: user.email});
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await api()
        .post('/api/v1/auth/password/verify-code')
        .send({email: user.email, code: '999999'});
    }
    expect(last!.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('social sign-in creates an account that must complete onboarding', async () => {
    vi.spyOn(socialVerifiers, 'google').mockResolvedValue({
      providerUserId: 'g-123',
      email: 'Sam.Social@gmail.com',
      emailVerified: true,
      firstName: 'Sam',
      lastName: 'Social',
    });
    const signIn = await api().post('/api/v1/auth/google').send({idToken: 'fake-google-token'});
    expect(signIn.status).toBe(200);
    expect(signIn.body.user).toMatchObject({onboardingCompleted: false, role: null});
    const auth = {Authorization: `Bearer ${signIn.body.tokens.accessToken}`};

    const blocked = await api().get('/api/v1/coaches').set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ONBOARDING_REQUIRED');

    const onboarded = await api()
      .post('/api/v1/me/onboarding')
      .set(auth)
      .send({role: 'client', homeArea: CHICAGO});
    expect(onboarded.status).toBe(200);
    expect(onboarded.body).toMatchObject({role: 'client', onboardingCompleted: true});

    const again = await api().post('/api/v1/auth/google').send({idToken: 'fake-google-token'});
    expect(again.body.user.id).toBe(signIn.body.user.id);
    vi.restoreAllMocks();
  });

  it('links Apple sign-in to an existing verified email account', async () => {
    const {user} = await registerUser('client', {email: 'link@test.dev'});
    vi.spyOn(socialVerifiers, 'apple').mockResolvedValue({
      providerUserId: 'a-1',
      email: 'link@test.dev',
      emailVerified: true,
    });
    const res = await api().post('/api/v1/auth/apple').send({identityToken: 'fake-apple-token'});
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.authProviders).toEqual(['password', 'apple']);
    vi.restoreAllMocks();
  });

  it('rejects invalid social tokens', async () => {
    const res = await api().post('/api/v1/auth/google').send({idToken: 'not-a-real-token'});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SOCIAL_TOKEN_INVALID');
  });

  it('updates profile settings and changes password', async () => {
    const {auth, user} = await registerUser('client');
    const patched = await api()
      .patch('/api/v1/me')
      .set(auth)
      .send({settings: {theme: 'dark'}, firstName: 'Jamie'});
    expect(patched.body).toMatchObject({firstName: 'Jamie', settings: {theme: 'dark'}});
    const wrong = await api()
      .patch('/api/v1/me/password')
      .set(auth)
      .send({currentPassword: 'x', newPassword: 'Another123'});
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const changed = await api()
      .patch('/api/v1/me/password')
      .set(auth)
      .send({currentPassword: 'Password123!', newPassword: 'Another123'});
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      accessTokenExpiresAt: expect.any(String),
    });
    expect(
      (await api().post('/api/v1/auth/login').send({email: user.email, password: 'Another123'}))
        .status,
    ).toBe(200);
  });
});
