import {z} from 'zod';

import {HomeAreaSchema, RoleSchema} from '../../lib/schemas.js';
import {PasswordSchema, UserSchema} from '../users/users.schemas.js';

export const TokensSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    accessTokenExpiresAt: z.string(),
  })
  .meta({id: 'Tokens'});

export const AuthResultSchema = z
  .object({user: UserSchema, tokens: TokensSchema})
  .meta({id: 'AuthResult'});

export const RegisterBody = z.object({
  email: z.email().max(254),
  password: PasswordSchema,
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  role: RoleSchema,
  homeArea: HomeAreaSchema,
});

export const LoginBody = z.object({email: z.email(), password: z.string().min(1)});
export const GoogleBody = z.object({idToken: z.string().min(10)});
export const AppleBody = z.object({
  identityToken: z.string().min(10),
  firstName: z.string().trim().max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
});
export const RefreshBody = z.object({refreshToken: z.string().min(10)});
export const ForgotBody = z.object({email: z.email()});
export const VerifyCodeBody = z.object({email: z.email(), code: z.string().regex(/^\d{6}$/)});
export const ResetBody = z.object({resetToken: z.string().min(10), newPassword: PasswordSchema});
export const ResetTokenSchema = z.object({resetToken: z.string()}).meta({id: 'ResetToken'});
