import {OAuth2Client} from 'google-auth-library';
import {createRemoteJWKSet, jwtVerify} from 'jose';

import {env, googleClientIds} from '../../config/env.js';
import {AppError} from '../../lib/errors.js';

export type SocialIdentity = {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
};

const googleClient = new OAuth2Client();
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

async function verifyGoogle(idToken: string): Promise<SocialIdentity> {
  if (googleClientIds.length === 0) {
    throw new AppError(
      'SOCIAL_TOKEN_INVALID',
      'Google sign-in is not configured (GOOGLE_CLIENT_IDS).',
    );
  }
  try {
    const ticket = await googleClient.verifyIdToken({idToken, audience: googleClientIds});
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new Error('missing claims');
    }
    return {
      providerUserId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      firstName: payload.given_name,
      lastName: payload.family_name,
      avatarUrl: payload.picture,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SOCIAL_TOKEN_INVALID');
  }
}

async function verifyApple(identityToken: string): Promise<SocialIdentity> {
  if (!env.APPLE_BUNDLE_ID) {
    throw new AppError(
      'SOCIAL_TOKEN_INVALID',
      'Apple sign-in is not configured (APPLE_BUNDLE_ID).',
    );
  }
  try {
    const {payload} = await jwtVerify(identityToken, appleJwks, {
      issuer: 'https://appleid.apple.com',
      audience: env.APPLE_BUNDLE_ID,
    });
    if (!payload.sub || typeof payload.email !== 'string') {
      throw new Error('missing claims');
    }
    return {
      providerUserId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SOCIAL_TOKEN_INVALID');
  }
}

/** Indirection so tests can replace the verifiers without network access. */
export const socialVerifiers = {google: verifyGoogle, apple: verifyApple};
