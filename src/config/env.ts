import 'dotenv/config';
import {z} from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/fitbook'),
  MONGODB_URI_TEST: z.string().min(1).default('mongodb://127.0.0.1:27017/fitbook_test'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: z.string().default('*'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  MAIL_FROM: z.string().default('FitBook <no-reply@fitbook.dev>'),
  GOOGLE_CLIENT_IDS: z.string().default(''),
  APPLE_BUNDLE_ID: z.string().default(''),
  PENDING_PAYMENT_TTL_MIN: z.coerce.number().int().positive().default(15),
  /**
   * Development / e2e helper: this 6-digit code is accepted by POST /auth/verify in addition to the emailed one.
   * Ignored when NODE_ENV=production.
   */
  AUTH_DEV_FIXED_CODE: z.preprocess(
    value => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^\d{6}$/, 'Must be exactly 6 digits')
      .optional(),
  ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isTest = env.NODE_ENV === 'test';
export const isProduction = env.NODE_ENV === 'production';
export const mongoUri = isTest ? env.MONGODB_URI_TEST : env.MONGODB_URI;
export const googleClientIds = env.GOOGLE_CLIENT_IDS.split(',')
  .map(id => id.trim())
  .filter(Boolean);
