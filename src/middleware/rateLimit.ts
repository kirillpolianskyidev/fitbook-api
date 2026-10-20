import rateLimit, {ipKeyGenerator} from 'express-rate-limit';
import type {Request} from 'express';

import {isTest} from '../config/env.js';
import {AppError} from '../lib/errors.js';

const handler = () => {
  throw new AppError('RATE_LIMITED');
};

/** Strict limit for credential endpoints, keyed by IP + email. */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: isTest ? 1000 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
    return `${ipKeyGenerator(req.ip ?? '')}:${email}`;
  },
  handler,
});

export const apiRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: isTest ? 100_000 : 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
});
