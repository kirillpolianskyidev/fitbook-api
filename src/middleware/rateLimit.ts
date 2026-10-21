import rateLimit, {ipKeyGenerator} from 'express-rate-limit';
import type {Request} from 'express';

import {isTest} from '../config/env.js';
import {AppError} from '../lib/errors.js';

const handler = () => {
  throw new AppError('RATE_LIMITED');
};

const WINDOW_MS = 15 * 60_000;
const ip = (req: Request) => ipKeyGenerator(req.ip ?? '');
const bodyString = (req: Request, field: string) => {
  const value: unknown = req.body?.[field];
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 254) : '';
};

const limiter = (
  limit: number,
  keyGenerator: (req: Request) => string,
  options: {windowMs?: number; skip?: (req: Request) => boolean} = {},
) =>
  rateLimit({
    windowMs: options.windowMs ?? WINDOW_MS,
    limit: isTest ? 1000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator,
    skip: options.skip,
    handler,
  });

/** Strict limit for credential endpoints, keyed by IP + email. */
export const authRateLimit = limiter(10, req => `${ip(req)}:${bodyString(req, 'email')}`);

/** Endpoints that email a code (register, login): per email from any IP, against mail bombing. */
export const emailSendRateLimit = limiter(20, req => `email:${bodyString(req, 'email')}`, {
  windowMs: 60 * 60_000,
  // Without an email the request fails validation; do not let such requests share one bucket.
  skip: req => !bodyString(req, 'email'),
});

/** POST /auth/verify and /auth/verify/resend, per IP + verification id. */
export const verificationRateLimit = limiter(
  20,
  req => `${ip(req)}:${bodyString(req, 'verificationId')}`,
);

/** All code checks from one IP, whatever the verification id (guessing ids / codes at scale). */
export const verificationIpRateLimit = limiter(60, req => `ip:${ip(req)}`);

export const apiRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: isTest ? 100_000 : 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
});
