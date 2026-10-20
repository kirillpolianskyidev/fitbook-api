import jwt from 'jsonwebtoken';

import {env} from '../config/env.js';
import {AppError} from './errors.js';

type AccessPayload = {sub: string; role: string | null; typ: 'access'};
type ResetPayload = {sub: string; rid: string; typ: 'reset'};

export function signAccessToken(userId: string, role: string | null) {
  const token = jwt.sign({role, typ: 'access'}, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
  const decoded = jwt.decode(token) as {exp: number};
  return {token, expiresAt: new Date(decoded.exp * 1000)};
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') {
      throw new AppError('UNAUTHORIZED');
    }
    return {sub: payload.sub, role: (payload.role as string | null) ?? null, typ: 'access'};
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError('TOKEN_EXPIRED');
    }
    throw new AppError('UNAUTHORIZED');
  }
}

export function signResetToken(userId: string, resetId: string) {
  return jwt.sign({rid: resetId, typ: 'reset'}, env.JWT_REFRESH_SECRET, {
    subject: userId,
    expiresIn: '10m',
  });
}

export function verifyResetToken(token: string): ResetPayload {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as jwt.JwtPayload;
    if (
      payload.typ !== 'reset' ||
      typeof payload.sub !== 'string' ||
      typeof payload.rid !== 'string'
    ) {
      throw new Error('bad token');
    }
    return {sub: payload.sub, rid: payload.rid, typ: 'reset'};
  } catch {
    throw new AppError('RESET_CODE_EXPIRED');
  }
}
