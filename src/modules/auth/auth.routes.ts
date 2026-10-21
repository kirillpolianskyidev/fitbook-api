import {route} from '../../lib/route.js';
import {
  authRateLimit,
  emailSendRateLimit,
  verificationIpRateLimit,
  verificationRateLimit,
} from '../../middleware/rateLimit.js';
import {
  AppleBody,
  AuthResultSchema,
  ForgotBody,
  GoogleBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  ResendBody,
  ResetBody,
  ResetTokenSchema,
  TokensSchema,
  VerificationResultSchema,
  VerifyBody,
  VerifyCodeBody,
} from './auth.schemas.js';
import * as auth from './auth.service.js';

const tags = ['Auth'];

route({
  method: 'post',
  path: '/auth/register',
  tags,
  summary:
    'Register with email and password (role and home area required). Emails a 6-digit code; ' +
    'tokens come from POST /auth/verify.',
  description:
    'An email of an unverified account is not taken: that account is overwritten with the new data and ' +
    'its previous codes stop working.',
  auth: 'public',
  middleware: [authRateLimit, emailSendRateLimit],
  body: RegisterBody,
  response: VerificationResultSchema,
  errors: ['EMAIL_TAKEN', 'RATE_LIMITED'],
  handler: ({body}) => auth.register(body),
});

route({
  method: 'post',
  path: '/auth/login',
  tags,
  summary:
    'Check email and password and email a 6-digit code (purpose "login", or "signup" for an ' +
    'unverified email). Tokens come from POST /auth/verify.',
  auth: 'public',
  status: 200,
  middleware: [authRateLimit, emailSendRateLimit],
  body: LoginBody,
  response: VerificationResultSchema,
  errors: ['INVALID_CREDENTIALS', 'RATE_LIMITED'],
  handler: ({body}) => auth.login(body),
});

route({
  method: 'post',
  path: '/auth/verify',
  tags,
  summary: 'Check the emailed code and start a session',
  description:
    'Errors in order: NOT_FOUND (unknown id), VERIFICATION_CODE_EXPIRED (used, code older than 10 minutes ' +
    'or verification older than 30 minutes), TOO_MANY_ATTEMPTS (5 wrong codes; a resend resets it), ' +
    'VERIFICATION_CODE_INVALID (details.attemptsLeft). A signup verification also confirms the email.',
  auth: 'public',
  status: 200,
  middleware: [verificationIpRateLimit, verificationRateLimit],
  body: VerifyBody,
  response: AuthResultSchema,
  errors: [
    'VERIFICATION_CODE_INVALID',
    'VERIFICATION_CODE_EXPIRED',
    'NOT_FOUND',
    'TOO_MANY_ATTEMPTS',
    'RATE_LIMITED',
  ],
  handler: ({body, req}) => auth.verify(body, req.get('user-agent')),
});

route({
  method: 'post',
  path: '/auth/verify/resend',
  tags,
  summary: 'Email a new code for the same verification (old code stops working, attempts reset)',
  description:
    'Allowed from resendAvailableAt (60 seconds after each send), at most 5 times. Too early -> ' +
    'RATE_LIMITED with details.retryAfterSeconds. Used, expired or resend limit reached -> ' +
    'VERIFICATION_CODE_EXPIRED (sign in / sign up again).',
  auth: 'public',
  status: 200,
  middleware: [verificationIpRateLimit, verificationRateLimit],
  body: ResendBody,
  response: VerificationResultSchema,
  errors: ['VERIFICATION_CODE_EXPIRED', 'NOT_FOUND', 'RATE_LIMITED'],
  handler: ({body}) => auth.resendVerification(body.verificationId),
});

route({
  method: 'post',
  path: '/auth/google',
  tags,
  summary:
    'Sign in with a Google ID token (no email code). New accounts must complete POST /me/onboarding.',
  auth: 'public',
  status: 200,
  body: GoogleBody,
  response: AuthResultSchema,
  errors: ['SOCIAL_TOKEN_INVALID'],
  handler: ({body, req}) => auth.signInWithGoogle(body.idToken, req.get('user-agent')),
});

route({
  method: 'post',
  path: '/auth/apple',
  tags,
  summary:
    'Sign in with an Apple identity token (no email code). New accounts must complete POST /me/onboarding.',
  auth: 'public',
  status: 200,
  body: AppleBody,
  response: AuthResultSchema,
  errors: ['SOCIAL_TOKEN_INVALID'],
  handler: ({body, req}) => auth.signInWithApple(body, req.get('user-agent')),
});

route({
  method: 'post',
  path: '/auth/refresh',
  tags,
  summary: 'Exchange a refresh token for new tokens (rotation; reuse revokes the session family)',
  auth: 'public',
  status: 200,
  body: RefreshBody,
  response: TokensSchema,
  errors: ['UNAUTHORIZED'],
  handler: ({body, req}) => auth.refresh(body.refreshToken, req.get('user-agent')),
});

route({
  method: 'post',
  path: '/auth/logout',
  tags,
  summary: 'Revoke a refresh token',
  auth: 'user',
  allowNotOnboarded: true,
  status: 204,
  body: RefreshBody,
  handler: async ({user, body}) => {
    await auth.logout(user, body.refreshToken);
  },
});

route({
  method: 'post',
  path: '/auth/password/forgot',
  tags,
  summary: 'Email a 6-digit reset code (always 204, no user enumeration)',
  auth: 'public',
  status: 204,
  middleware: [authRateLimit],
  body: ForgotBody,
  errors: ['RATE_LIMITED'],
  handler: async ({body}) => {
    await auth.forgotPassword(body.email);
  },
});

route({
  method: 'post',
  path: '/auth/password/verify-code',
  tags,
  summary: 'Verify the reset code and get a short-lived reset token',
  auth: 'public',
  status: 200,
  middleware: [authRateLimit],
  body: VerifyCodeBody,
  response: ResetTokenSchema,
  errors: ['RESET_CODE_INVALID', 'RESET_CODE_EXPIRED', 'TOO_MANY_ATTEMPTS', 'RATE_LIMITED'],
  handler: ({body}) => auth.verifyResetCode(body.email, body.code),
});

route({
  method: 'post',
  path: '/auth/password/reset',
  tags,
  summary:
    'Set a new password with the reset token: signs out all sessions, confirms the email and starts a new ' +
    'session (no extra code)',
  auth: 'public',
  status: 200,
  middleware: [authRateLimit],
  body: ResetBody,
  response: AuthResultSchema,
  errors: ['RESET_CODE_EXPIRED', 'RATE_LIMITED'],
  handler: ({body, req}) =>
    auth.resetPassword(body.resetToken, body.newPassword, req.get('user-agent')),
});
