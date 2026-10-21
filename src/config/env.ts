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
  /** Login / password (SMTP key) of a real SMTP service, e.g. Brevo. Empty -> local Mailpit without auth. */
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  /** true for implicit TLS (port 465); false uses STARTTLS (port 587), required when SMTP_USER is set. */
  SMTP_SECURE: z
    .enum(['true', 'false', ''])
    .default('')
    .transform(value => value === 'true'),
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

const parsed = EnvSchema.superRefine((value, ctx) => {
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASS)) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_PASS'],
      message: 'Set both SMTP_USER and SMTP_PASS',
    });
  }
  if (value.NODE_ENV === 'production' && !value.SMTP_USER) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_USER'],
      message: 'Production needs a real SMTP service (SMTP_HOST, SMTP_USER, SMTP_PASS)',
    });
  }
}).safeParse(process.env);
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
