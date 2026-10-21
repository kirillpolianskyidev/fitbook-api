import crypto from 'node:crypto';

import {env} from '../../config/env.js';
import {signAccessToken} from '../../lib/jwt.js';
import {randomToken, sha256} from '../../lib/password.js';
import {RefreshTokenModel} from '../../models/refreshToken.js';
import type {UserDoc} from '../../models/user.js';

/** Issues an access token and a refresh token. A new `familyId` starts a new session. */
export async function issueTokens(
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

/** Signs the user out everywhere: revokes every active refresh token. */
export const revokeAllRefreshTokens = (user: UserDoc) =>
  RefreshTokenModel.updateMany({userId: user._id, revokedAt: null}, {revokedAt: new Date()});
