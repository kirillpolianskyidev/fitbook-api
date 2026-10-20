import type {Types} from 'mongoose';

import {AppError} from '../../lib/errors.js';
import {hashPassword, verifyPassword} from '../../lib/password.js';
import type {HomeArea, Role} from '../../lib/schemas.js';
import {toIso} from '../../lib/time.js';
import {AvailabilityModel} from '../../models/availability.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {RefreshTokenModel} from '../../models/refreshToken.js';
import {TrialClaimModel} from '../../models/trialClaim.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import type {UserDto} from './users.schemas.js';

type SummarySource = {
  _id: Types.ObjectId;
  firstName: string;
  lastName?: string | null;
  avatarUrl?: string | null;
};

export function toUserDto(user: UserDoc): UserDto {
  return {
    id: user.id,
    email: user.email,
    role: (user.role as Role | null) ?? null,
    firstName: user.firstName,
    lastName: user.lastName ?? '',
    avatarUrl: user.avatarUrl ?? null,
    homeArea: user.homeArea
      ? {
          city: user.homeArea.city,
          state: user.homeArea.state as HomeArea['state'],
          country: 'US',
          timezone: user.homeArea.timezone,
        }
      : null,
    onboardingCompleted: user.onboardingCompleted,
    trialUsed: user.trialUsed,
    settings: {theme: (user.settings?.theme ?? 'system') as 'light' | 'dark' | 'system'},
    authProviders: user.authProviders.map(p => p.provider as 'password' | 'google' | 'apple'),
    createdAt: toIso(user.get('createdAt') as Date),
  };
}

export const toUserSummary = (user: SummarySource) => ({
  id: user._id.toString(),
  firstName: user.firstName,
  lastName: user.lastName ?? '',
  avatarUrl: user.avatarUrl ?? null,
});

/** Every coach has a profile and an availability document. Safe to call repeatedly. */
export async function ensureCoachSetup(user: UserDoc) {
  if (user.role !== 'coach') {
    return;
  }
  await CoachProfileModel.updateOne(
    {userId: user._id},
    {
      $setOnInsert: {
        userId: user._id,
        specializations: [],
        certifications: [],
        highlights: [],
        languages: ['English'],
        kinds: [],
        isPublished: false,
        cancellationPolicy: {freeCancelHours: 24},
        rating: {average: 0, count: 0},
      },
      $set: {city: user.homeArea?.city ?? '', state: user.homeArea?.state ?? ''},
    },
    {upsert: true},
  );
  await AvailabilityModel.updateOne(
    {coachId: user._id},
    {$setOnInsert: {coachId: user._id, weekly: [], exceptions: []}},
    {upsert: true},
  );
}

export async function completeOnboarding(
  user: UserDoc,
  input: {role: Role; homeArea: HomeArea; firstName?: string; lastName?: string},
) {
  if (user.onboardingCompleted && user.role && user.role !== input.role) {
    throw new AppError('FORBIDDEN', 'The role cannot be changed after onboarding.');
  }
  user.role = input.role;
  user.homeArea = input.homeArea;
  if (input.firstName) user.firstName = input.firstName;
  if (input.lastName !== undefined) user.lastName = input.lastName;
  user.onboardingCompleted = true;
  await user.save();
  await ensureCoachSetup(user);
  return user;
}

export async function updateMe(
  user: UserDoc,
  input: {
    firstName?: string;
    lastName?: string;
    avatarUrl?: string | null;
    homeArea?: HomeArea;
    settings?: {theme: 'light' | 'dark' | 'system'};
  },
) {
  if (input.firstName !== undefined) user.firstName = input.firstName;
  if (input.lastName !== undefined) user.lastName = input.lastName;
  if (input.avatarUrl !== undefined) user.avatarUrl = input.avatarUrl ?? undefined;
  if (input.homeArea) user.homeArea = input.homeArea;
  if (input.settings) user.settings = input.settings;
  await user.save();
  if (input.homeArea) {
    await ensureCoachSetup(user);
  }
  return user;
}

export async function changePassword(
  user: UserDoc,
  currentPassword: string | undefined,
  newPassword: string,
) {
  if (user.passwordHash) {
    if (!currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect.');
    }
  }
  user.passwordHash = await hashPassword(newPassword);
  if (!user.authProviders.some(p => p.provider === 'password')) {
    user.authProviders.push({provider: 'password'});
  }
  await user.save();
  await RefreshTokenModel.updateMany({userId: user._id, revokedAt: null}, {revokedAt: new Date()});
}

export async function trialStatus(user: UserDoc) {
  if (user.trialUsed || (await TrialClaimModel.exists({emailKey: user.emailKey}))) {
    return {eligible: false, reason: 'TRIAL_ALREADY_USED' as const};
  }
  return {eligible: true};
}

export const findUserById = (id: string | Types.ObjectId) => UserModel.findById(id);
