import {z} from 'zod';

import {HomeAreaSchema, RoleSchema, ThemeSchema} from '../../lib/schemas.js';

export const UserSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    role: RoleSchema.nullable(),
    firstName: z.string(),
    lastName: z.string(),
    avatarUrl: z.string().nullable(),
    homeArea: HomeAreaSchema.nullable(),
    onboardingCompleted: z.boolean(),
    trialUsed: z.boolean(),
    settings: z.object({theme: ThemeSchema}),
    authProviders: z.array(z.enum(['password', 'google', 'apple'])),
    createdAt: z.string(),
  })
  .meta({id: 'User'});

export const UserSummarySchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .meta({id: 'UserSummary'});

export const UpdateMeBody = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
  avatarUrl: z.url().max(500).nullable().optional(),
  homeArea: HomeAreaSchema.optional(),
  settings: z.object({theme: ThemeSchema}).optional(),
});

export const OnboardingBody = z.object({
  role: RoleSchema,
  homeArea: HomeAreaSchema,
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
});

export const PasswordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/\d/, 'Must contain a digit');

export const ChangePasswordBody = z.object({
  currentPassword: z.string().optional(),
  newPassword: PasswordSchema,
});

export const TrialStatusSchema = z
  .object({eligible: z.boolean(), reason: z.literal('TRIAL_ALREADY_USED').optional()})
  .meta({id: 'TrialStatus'});

export type UserDto = z.input<typeof UserSchema>;
