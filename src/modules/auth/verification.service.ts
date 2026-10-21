import crypto from 'node:crypto';

import {env, isProduction} from '../../config/env.js';
import {AppError} from '../../lib/errors.js';
import {logger} from '../../lib/logger.js';
import {sendMail} from '../../lib/mailer.js';
import {randomCode} from '../../lib/password.js';
import {
  EmailVerificationModel,
  type EmailVerificationDoc,
  type VerificationPurpose,
} from '../../models/emailVerification.js';
import {UserModel, type UserDoc} from '../../models/user.js';

export const CODE_LENGTH = 6 as const;
export const CODE_TTL_MS = 10 * 60_000;
export const VERIFICATION_TTL_MS = 30 * 60_000;
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_RESENDS = 5;

const MAIL_TEXT: Record<VerificationPurpose, string> = {
  signup: 'Confirm your email to finish creating your FitBook account.',
  login: "Use this code to sign in to FitBook. If this wasn't you, change your password.",
};

/** HMAC keyed by a server secret and bound to the verification id, so a leaked hash cannot be brute-forced offline. */
const hashCode = (verificationId: string, code: string) =>
  crypto
    .createHmac('sha256', env.JWT_REFRESH_SECRET)
    .update(`email-verification:${verificationId}:${code}`)
    .digest('hex');

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** AUTH_DEV_FIXED_CODE is accepted only outside production. */
const devFixedCode = () => (env.NODE_ENV === 'production' ? undefined : env.AUTH_DEV_FIXED_CODE);

const minDate = (a: Date, b: Date) => (a < b ? a : b);

export function toVerificationDto(verification: EmailVerificationDoc, email: string) {
  return {
    id: verification._id,
    purpose: verification.purpose as VerificationPurpose,
    email,
    codeLength: CODE_LENGTH,
    expiresAt: verification.codeExpiresAt.toISOString(),
    resendAvailableAt: verification.resendAvailableAt.toISOString(),
  };
}

async function sendCode(user: UserDoc, purpose: VerificationPurpose, code: string) {
  if (!isProduction) {
    logger.info({email: user.email, purpose, code}, 'Email verification code (non-production)');
  }
  await sendMail({
    to: user.email,
    subject: `Your FitBook code: ${code}`,
    text: `Hi ${user.firstName},\n\nYour FitBook code is ${code}. It expires in 10 minutes.\n\n${MAIL_TEXT[purpose]}\n\nFitBook`,
  });
}

/** Invalidates every pending (unconsumed) verification of the user. */
export const invalidateVerifications = (userId: UserDoc['_id']) =>
  EmailVerificationModel.updateMany(
    {userId, consumedAt: null, invalidatedAt: null},
    {invalidatedAt: new Date()},
  );

/** Creates a verification for the user (replacing pending ones) and emails the code. */
export async function startVerification(user: UserDoc, purpose: VerificationPurpose) {
  await invalidateVerifications(user._id);
  const now = Date.now();
  const id = crypto.randomBytes(16).toString('hex');
  const code = randomCode();
  const verification = await EmailVerificationModel.create({
    _id: id,
    userId: user._id,
    purpose,
    codeHash: hashCode(id, code),
    codeExpiresAt: new Date(now + CODE_TTL_MS),
    resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS),
    expiresAt: new Date(now + VERIFICATION_TTL_MS),
  });
  try {
    await sendCode(user, purpose, code);
  } catch (error) {
    // The code never reached the user: this verification must not be usable.
    await EmailVerificationModel.updateOne({_id: id}, {invalidatedAt: new Date()});
    throw error;
  }
  return {verification: toVerificationDto(verification, user.email)};
}

const isDead = (v: EmailVerificationDoc, now: Date) =>
  Boolean(v.consumedAt || v.invalidatedAt) || v.expiresAt <= now;

/**
 * Checks the code. Order: unknown id -> NOT_FOUND; consumed/expired -> VERIFICATION_CODE_EXPIRED;
 * attempts used up -> TOO_MANY_ATTEMPTS; wrong -> VERIFICATION_CODE_INVALID. Returns the verified user.
 */
export async function checkCode(verificationId: string, code: string) {
  const now = new Date();
  const verification = await EmailVerificationModel.findById(verificationId);
  if (!verification) {
    throw new AppError('NOT_FOUND', 'Verification not found.');
  }
  if (isDead(verification, now) || verification.codeExpiresAt <= now) {
    throw new AppError('VERIFICATION_CODE_EXPIRED');
  }
  if (verification.attempts >= MAX_ATTEMPTS) {
    throw new AppError('TOO_MANY_ATTEMPTS');
  }

  const fixed = devFixedCode();
  const correct =
    safeEqual(verification.codeHash, hashCode(verification._id, code)) ||
    (fixed !== undefined && safeEqual(fixed, code));

  if (!correct) {
    // Atomic increment bound to the current code, so parallel guesses cannot exceed the limit.
    const updated = await EmailVerificationModel.findOneAndUpdate(
      {
        _id: verification._id,
        codeHash: verification.codeHash,
        consumedAt: null,
        invalidatedAt: null,
        attempts: {$lt: MAX_ATTEMPTS},
      },
      {$inc: {attempts: 1}},
      {returnDocument: 'after'},
    );
    if (!updated) {
      throw new AppError('TOO_MANY_ATTEMPTS');
    }
    throw new AppError('VERIFICATION_CODE_INVALID', undefined, {
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - updated.attempts),
    });
  }

  // Single use: only one request can consume the verification.
  const consumed = await EmailVerificationModel.findOneAndUpdate(
    {
      _id: verification._id,
      codeHash: verification.codeHash,
      consumedAt: null,
      invalidatedAt: null,
      attempts: {$lt: MAX_ATTEMPTS},
    },
    {consumedAt: now},
    {returnDocument: 'after'},
  );
  if (!consumed) {
    throw new AppError('VERIFICATION_CODE_EXPIRED');
  }
  const user = await UserModel.findById(consumed.userId);
  if (!user) {
    throw new AppError('VERIFICATION_CODE_EXPIRED');
  }
  return {user, purpose: consumed.purpose as VerificationPurpose};
}

/** Sends a new code for the same verification (the old code stops working, attempts reset). */
export async function resendCode(verificationId: string) {
  const now = new Date();
  const verification = await EmailVerificationModel.findById(verificationId);
  if (!verification) {
    throw new AppError('NOT_FOUND', 'Verification not found.');
  }
  if (isDead(verification, now) || verification.resendCount >= MAX_RESENDS) {
    throw new AppError('VERIFICATION_CODE_EXPIRED');
  }
  if (now < verification.resendAvailableAt) {
    const retryAfterSeconds = Math.ceil((+verification.resendAvailableAt - +now) / 1000);
    throw new AppError('RATE_LIMITED', 'Wait before requesting a new code.', {retryAfterSeconds});
  }
  const user = await UserModel.findById(verification.userId);
  if (!user) {
    throw new AppError('VERIFICATION_CODE_EXPIRED');
  }

  const code = randomCode();
  const updated = await EmailVerificationModel.findOneAndUpdate(
    {
      _id: verification._id,
      consumedAt: null,
      invalidatedAt: null,
      resendCount: verification.resendCount,
      resendAvailableAt: {$lte: now},
    },
    {
      codeHash: hashCode(verification._id, code),
      attempts: 0,
      codeExpiresAt: minDate(new Date(+now + CODE_TTL_MS), verification.expiresAt),
      resendAvailableAt: new Date(+now + RESEND_COOLDOWN_MS),
      $inc: {resendCount: 1},
    },
    {returnDocument: 'after'},
  );
  if (!updated) {
    // A parallel resend won the race.
    throw new AppError('RATE_LIMITED', 'Wait before requesting a new code.', {
      retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_MS / 1000),
    });
  }
  try {
    await sendCode(user, updated.purpose as VerificationPurpose, code);
  } catch (error) {
    // Not delivered: it does not count as a resend and the user may retry right away.
    await EmailVerificationModel.updateOne(
      {_id: updated._id},
      {resendAvailableAt: new Date(), $inc: {resendCount: -1}},
    );
    throw error;
  }
  return {verification: toVerificationDto(updated, user.email)};
}
