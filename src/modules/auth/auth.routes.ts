import {route} from '../../lib/route.js';
import {authRateLimit} from '../../middleware/rateLimit.js';
import {
  AppleBody,
  AuthResultSchema,
  ForgotBody,
  GoogleBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  ResetBody,
  ResetTokenSchema,
  TokensSchema,
  VerifyCodeBody,
} from './auth.schemas.js';
import * as auth from './auth.service.js';

const tags = ['Auth'];

route({
  method: 'post',
  path: '/auth/register',
  tags,
  summary: 'Register with email and password (role and home area required)',
  auth: 'public',
  middleware: [authRateLimit],
  body: RegisterBody,
  response: AuthResultSchema,
  errors: ['EMAIL_TAKEN', 'RATE_LIMITED'],
  handler: ({body, req}) => auth.register(body, req.get('user-agent')),
});

route({
  method: 'post',
  path: '/auth/login',
  tags,
  summary: 'Sign in with email and password',
  auth: 'public',
  status: 200,
  middleware: [authRateLimit],
  body: LoginBody,
  response: AuthResultSchema,
  errors: ['INVALID_CREDENTIALS', 'RATE_LIMITED'],
  handler: ({body, req}) => auth.login(body, req.get('user-agent')),
});

route({
  method: 'post',
  path: '/auth/google',
  tags,
  summary: 'Sign in with a Google ID token. New accounts must complete POST /me/onboarding.',
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
  summary: 'Sign in with an Apple identity token. New accounts must complete POST /me/onboarding.',
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
  summary: 'Set a new password with the reset token (signs out all sessions)',
  auth: 'public',
  status: 204,
  body: ResetBody,
  errors: ['RESET_CODE_EXPIRED'],
  handler: async ({body}) => {
    await auth.resetPassword(body.resetToken, body.newPassword);
  },
});
