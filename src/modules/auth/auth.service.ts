import crypto from 'node:crypto';

import {env} from '../../config/env.js';
import {emailKey, normalizeEmail} from '../../lib/emailKey.js';
import {AppError, isDuplicateKeyError} from '../../lib/errors.js';
import {signAccessToken, signResetToken, verifyResetToken} from '../../lib/jwt.js';
import {sendMail} from '../../lib/mailer.js';
import {hashPassword, randomCode, randomToken, sha256, verifyPassword} from '../../lib/password.js';
import type {HomeArea, Role} from '../../lib/schemas.js';
import {PasswordResetModel} from '../../models/passwordReset.js';
import {RefreshTokenModel} from '../../models/refreshToken.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {ensureCoachSetup, toUserDto} from '../users/users.service.js';
import {socialVerifiers, type SocialIdentity} from './social.js';

const RESET_CODE_TTL_MIN = 15;
const RESET_MAX_ATTEMPTS = 5;

async function issueTokens(
  user: UserDoc,
  familyId: string = crypto.randomUUID(),
  userAgent?: string,
) {
  const access = signAccessToken(user.id, user.role ?? null);
  const refreshToken = randomToken();
  await RefreshTokenModel.create({
    userId: user._id,
    familyId,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000),
    userAgent,
  });
  return {
    accessToken: access.token,
    refreshToken,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
  };
}

const authResult = async (user: UserDoc, userAgent?: string) => ({
  user: toUserDto(user),
  tokens: await issueTokens(user, undefined, userAgent),
});

export async function register(
  input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: Role;
    homeArea: HomeArea;
  },
  userAgent?: string,
) {
  const email = normalizeEmail(input.email);
  try {
    const user = await UserModel.create({
      email,
      emailKey: emailKey(email),
      passwordHash: await hashPassword(input.password),
      role: input.role,
      firstName: input.firstName,
      lastName: input.lastName,
      homeArea: input.homeArea,
      authProviders: [{provider: 'password'}],
      onboardingCompleted: true,
    });
    await ensureCoachSetup(user);
    return authResult(user, userAgent);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new AppError('EMAIL_TAKEN');
    }
    throw error;
  }
}

export async function login(input: {email: string; password: string}, userAgent?: string) {
  const user = await UserModel.findOne({email: normalizeEmail(input.email)});
  if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new AppError('INVALID_CREDENTIALS');
  }
  return authResult(user, userAgent);
}

async function socialSignIn(
  provider: 'google' | 'apple',
  identity: SocialIdentity,
  userAgent?: string,
) {
  const providerKey = `${provider}:${identity.providerUserId}`;
  let user = await UserModel.findOne({providerKeys: providerKey});
  if (!user) {
    const email = normalizeEmail(identity.email);
    user = await UserModel.findOne({email});
    if (user) {
      // Link the provider to the existing account only for verified emails.
      if (!identity.emailVerified) {
        throw new AppError('SOCIAL_TOKEN_INVALID', 'Email is not verified by the provider.');
      }
      user.authProviders.push({provider, providerUserId: identity.providerUserId});
      user.providerKeys.push(providerKey);
      await user.save();
    } else {
      user = await UserModel.create({
        email,
        emailKey: emailKey(email),
        firstName: identity.firstName ?? email.split('@')[0] ?? 'FitBook',
        lastName: identity.lastName ?? '',
        avatarUrl: identity.avatarUrl,
        authProviders: [{provider, providerUserId: identity.providerUserId}],
        providerKeys: [providerKey],
        onboardingCompleted: false,
      });
    }
  }
  return authResult(user, userAgent);
}

export async function signInWithGoogle(idToken: string, userAgent?: string) {
  return socialSignIn('google', await socialVerifiers.google(idToken), userAgent);
}

export async function signInWithApple(
  input: {identityToken: string; firstName?: string; lastName?: string},
  userAgent?: string,
) {
  const identity = await socialVerifiers.apple(input.identityToken);
  // Apple sends the name only on the first sign-in, from the device.
  return socialSignIn(
    'apple',
    {...identity, firstName: input.firstName, lastName: input.lastName},
    userAgent,
  );
}

/** Rotating refresh tokens. Reusing an already rotated token revokes the whole family. */
export async function refresh(refreshToken: string, userAgent?: string) {
  const record = await RefreshTokenModel.findOne({tokenHash: sha256(refreshToken)});
  if (!record || record.expiresAt < new Date()) {
    throw new AppError('UNAUTHORIZED', 'Refresh token is invalid or expired.');
  }
  if (record.revokedAt) {
    await RefreshTokenModel.updateMany(
      {familyId: record.familyId, revokedAt: null},
      {revokedAt: new Date()},
    );
    throw new AppError('UNAUTHORIZED', 'Refresh token was already used. Please sign in again.');
  }
  const user = await UserModel.findById(record.userId);
  if (!user) {
    throw new AppError('UNAUTHORIZED');
  }
  const tokens = await issueTokens(user, record.familyId, userAgent);
  record.revokedAt = new Date();
  record.replacedByHash = sha256(tokens.refreshToken);
  await record.save();
  return tokens;
}

export async function logout(user: UserDoc, refreshToken: string) {
  await RefreshTokenModel.updateOne(
    {userId: user._id, tokenHash: sha256(refreshToken), revokedAt: null},
    {revokedAt: new Date()},
  );
}

export async function forgotPassword(email: string) {
  const user = await UserModel.findOne({email: normalizeEmail(email)});
  if (!user) {
    return; // No user enumeration.
  }
  const code = randomCode();
  await PasswordResetModel.updateMany({userId: user._id, usedAt: null}, {usedAt: new Date()});
  await PasswordResetModel.create({
    userId: user._id,
    codeHash: sha256(code),
    expiresAt: new Date(Date.now() + RESET_CODE_TTL_MIN * 60_000),
  });
  await sendMail({
    to: user.email,
    subject: 'Your FitBook password reset code',
    text: `Hi ${user.firstName},\n\nYour password reset code is ${code}. It is valid for ${RESET_CODE_TTL_MIN} minutes.\n\nIf you did not request it, ignore this email.\n\nFitBook`,
  });
}

export async function verifyResetCode(email: string, code: string) {
  const user = await UserModel.findOne({email: normalizeEmail(email)});
  const reset = user
    ? await PasswordResetModel.findOne({userId: user._id, usedAt: null}).sort({createdAt: -1})
    : null;
  if (!user || !reset) {
    throw new AppError('RESET_CODE_INVALID');
  }
  if (reset.attempts >= RESET_MAX_ATTEMPTS) {
    throw new AppError('TOO_MANY_ATTEMPTS');
  }
  if (reset.expiresAt < new Date()) {
    throw new AppError('RESET_CODE_EXPIRED');
  }
  if (reset.codeHash !== sha256(code)) {
    reset.attempts += 1;
    await reset.save();
    throw new AppError(
      reset.attempts >= RESET_MAX_ATTEMPTS ? 'TOO_MANY_ATTEMPTS' : 'RESET_CODE_INVALID',
    );
  }
  reset.verifiedAt = new Date();
  await reset.save();
  return {resetToken: signResetToken(user.id, reset.id)};
}

export async function resetPassword(resetToken: string, newPassword: string) {
  const payload = verifyResetToken(resetToken);
  const reset = await PasswordResetModel.findOne({
    _id: payload.rid,
    userId: payload.sub,
    usedAt: null,
  });
  if (!reset?.verifiedAt) {
    throw new AppError('RESET_CODE_EXPIRED');
  }
  const user = await UserModel.findById(payload.sub);
  if (!user) {
    throw new AppError('RESET_CODE_EXPIRED');
  }
  user.passwordHash = await hashPassword(newPassword);
  if (!user.authProviders.some(p => p.provider === 'password')) {
    user.authProviders.push({provider: 'password'});
  }
  await user.save();
  reset.usedAt = new Date();
  await reset.save();
  await RefreshTokenModel.updateMany({userId: user._id, revokedAt: null}, {revokedAt: new Date()});
}
