import {emailKey, normalizeEmail} from '../../lib/emailKey.js';
import {AppError, isDuplicateKeyError} from '../../lib/errors.js';
import {signResetToken, verifyResetToken} from '../../lib/jwt.js';
import {sendMail} from '../../lib/mailer.js';
import {hashPassword, randomCode, sha256, verifyPassword} from '../../lib/password.js';
import type {HomeArea, Role} from '../../lib/schemas.js';
import {AvailabilityModel} from '../../models/availability.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {EmailVerificationModel} from '../../models/emailVerification.js';
import {PasswordResetModel} from '../../models/passwordReset.js';
import {RefreshTokenModel} from '../../models/refreshToken.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {ensureCoachSetup, toUserDto} from '../users/users.service.js';
import {socialVerifiers, type SocialIdentity} from './social.js';
import {issueTokens, revokeAllRefreshTokens} from './tokens.js';
import {
  checkCode,
  invalidateVerifications,
  resendCode,
  startVerification,
} from './verification.service.js';

const RESET_CODE_TTL_MIN = 15;
const RESET_MAX_ATTEMPTS = 5;

/** bcrypt hash of a random string: compared when the email is unknown so timing does not reveal accounts. */
const DUMMY_PASSWORD_HASH = '$2b$12$umTX1N3EcR95t3e4elcc0u7kG1P5AXLtfidvFqPLotkK9IEf0AJ/6';

const authResult = async (user: UserDoc, userAgent?: string) => ({
  user: toUserDto(user),
  tokens: await issueTokens(user, undefined, userAgent),
});

type RegisterInput = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: Role;
  homeArea: HomeArea;
};

/**
 * Creates an unverified account (or overwrites an unverified one with the same email) and emails a signup code.
 * No tokens until POST /auth/verify.
 */
export async function register(input: RegisterInput) {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const profile = {
    passwordHash,
    role: input.role,
    firstName: input.firstName,
    lastName: input.lastName,
    homeArea: input.homeArea,
    authProviders: [{provider: 'password' as const}],
    providerKeys: [],
    onboardingCompleted: true,
  };

  // Two tries: a parallel registration of the same email may create the user between find and create.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await UserModel.findOne({email});
    if (existing?.emailVerifiedAt) {
      throw new AppError('EMAIL_TAKEN');
    }
    if (existing) {
      // Unverified accounts are not "taken": the user went back from the code screen and fixed something.
      existing.set(profile);
      await existing.save();
      await removeUnverifiedLeftovers(existing);
      return startVerification(existing, 'signup');
    }
    try {
      const user = await UserModel.create({
        email,
        emailKey: emailKey(email),
        emailVerifiedAt: null,
        ...profile,
      });
      return startVerification(user, 'signup');
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  throw new AppError('EMAIL_TAKEN');
}

/** An unverified account never had tokens; drop anything created for it before (old coach setup, sessions). */
async function removeUnverifiedLeftovers(user: UserDoc) {
  await Promise.all([
    invalidateVerifications(user._id),
    revokeAllRefreshTokens(user),
    user.role === 'coach'
      ? Promise.resolve()
      : Promise.all([
          CoachProfileModel.deleteMany({userId: user._id}),
          AvailabilityModel.deleteMany({coachId: user._id}),
        ]),
  ]);
}

/** Checks the password and emails a code. Tokens come from POST /auth/verify. */
export async function login(input: {email: string; password: string}) {
  const user = await UserModel.findOne({email: normalizeEmail(input.email)});
  const passwordOk = await verifyPassword(
    input.password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );
  if (!user?.passwordHash || !passwordOk) {
    throw new AppError('INVALID_CREDENTIALS');
  }
  return startVerification(user, user.emailVerifiedAt ? 'login' : 'signup');
}

/** Second step of register / login: the code is correct -> (verify the email) -> new session. */
export async function verify(input: {verificationId: string; code: string}, userAgent?: string) {
  const {user, purpose} = await checkCode(input.verificationId, input.code);
  if (purpose === 'signup' && !user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
    await user.save();
    await ensureCoachSetup(user);
  }
  return authResult(user, userAgent);
}

export const resendVerification = (verificationId: string) => resendCode(verificationId);

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
      if (!user.emailVerifiedAt) {
        // Someone registered this email with a password but never confirmed it. The provider proves the
        // email belongs to this person, so the unconfirmed account is discarded (prevents account pre-hijacking).
        await discardUnverifiedAccount(user);
        user = null;
      } else {
        user.authProviders.push({provider, providerUserId: identity.providerUserId});
        user.providerKeys.push(providerKey);
        await user.save();
      }
    }
    if (!user) {
      user = await UserModel.create({
        email,
        emailKey: emailKey(email),
        emailVerifiedAt: identity.emailVerified ? new Date() : null,
        firstName: identity.firstName ?? email.split('@')[0] ?? 'FitBook',
        lastName: identity.lastName ?? '',
        avatarUrl: identity.avatarUrl,
        authProviders: [{provider, providerUserId: identity.providerUserId}],
        providerKeys: [providerKey],
        onboardingCompleted: false,
      });
    }
  }
  if (!user.emailVerifiedAt && identity.emailVerified) {
    user.emailVerifiedAt = new Date();
    await user.save();
  }
  return authResult(user, userAgent);
}

async function discardUnverifiedAccount(user: UserDoc) {
  await Promise.all([
    EmailVerificationModel.deleteMany({userId: user._id}),
    RefreshTokenModel.deleteMany({userId: user._id}),
    PasswordResetModel.deleteMany({userId: user._id}),
    CoachProfileModel.deleteMany({userId: user._id}),
    AvailabilityModel.deleteMany({coachId: user._id}),
  ]);
  await UserModel.deleteOne({_id: user._id, emailVerifiedAt: null});
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

/**
 * Sets the new password, signs out every session and starts a new one. The reset code proved the email,
 * so an unverified account becomes verified and no extra sign-in code is needed.
 */
export async function resetPassword(resetToken: string, newPassword: string, userAgent?: string) {
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
  // Single use, atomically.
  const used = await PasswordResetModel.updateOne(
    {_id: reset._id, usedAt: null},
    {usedAt: new Date()},
  );
  if (used.modifiedCount !== 1) {
    throw new AppError('RESET_CODE_EXPIRED');
  }
  user.passwordHash = await hashPassword(newPassword);
  if (!user.authProviders.some(p => p.provider === 'password')) {
    user.authProviders.push({provider: 'password'});
  }
  const wasVerified = Boolean(user.emailVerifiedAt);
  user.emailVerifiedAt ??= new Date();
  await user.save();
  if (!wasVerified) {
    await ensureCoachSetup(user);
  }
  await revokeAllRefreshTokens(user);
  // Codes sent for the old password must not work any more.
  await invalidateVerifications(user._id);
  return authResult(user, userAgent);
}
