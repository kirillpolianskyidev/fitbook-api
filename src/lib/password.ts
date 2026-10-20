import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const COST = 12;

export const hashPassword = (password: string) => bcrypt.hash(password, COST);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/** SHA-256 for opaque tokens and codes (refresh tokens, reset codes). */
export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

export const randomCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
