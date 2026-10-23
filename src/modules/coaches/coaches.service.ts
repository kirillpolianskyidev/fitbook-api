import type {Types} from 'mongoose';
import type {z} from 'zod';

import {toLocationDto} from '../../lib/dto.js';
import {AppError} from '../../lib/errors.js';
import type {HomeArea, Location} from '../../lib/schemas.js';
import {AvailabilityModel} from '../../models/availability.js';
import {CoachProfileModel, type CoachProfileDoc} from '../../models/coachProfile.js';
import {SessionTypeModel} from '../../models/sessionType.js';
import {TrainingSessionModel} from '../../models/trainingSession.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {listActivePackages, toPackageDto} from '../packages/packages.service.js';
import {findSlots, toSessionDto} from '../sessions/sessions.service.js';
import {toSessionTypeDto} from '../sessionTypes/sessionTypes.service.js';
import type {CoachCardSchema, CoachListQuery, UpdateCoachProfileBody} from './coaches.schemas.js';

type Specialization = z.infer<typeof UpdateCoachProfileBody>['specializations'] & {};
type CoachCard = z.input<typeof CoachCardSchema>;

async function getOwnProfile(coach: UserDoc) {
  const profile = await CoachProfileModel.findOne({userId: coach._id});
  if (!profile) {
    throw new AppError('NOT_FOUND', 'Coach profile not found.');
  }
  return profile;
}

export async function profileCompleteness(profile: CoachProfileDoc) {
  const missing: string[] = [];
  if (!profile.headline) missing.push('headline');
  if (!profile.bio || profile.bio.length < 40) missing.push('bio');
  if (!profile.specializations.length) missing.push('specializations');
  const [activeTypes, availability] = await Promise.all([
    SessionTypeModel.countDocuments({coachId: profile.userId, isActive: true}),
    AvailabilityModel.findOne({coachId: profile.userId}).lean(),
  ]);
  if (!activeTypes) missing.push('sessionTypes');
  if (!availability?.weekly?.length) missing.push('availability');
  return {complete: missing.length === 0, missing};
}

const certificationsOf = (profile: CoachProfileDoc) =>
  profile.certifications.map(c => ({
    title: c.title ?? '',
    issuer: c.issuer ?? '',
    year: c.year ?? null,
  }));

export async function toCoachProfileDto(profile: CoachProfileDoc) {
  return {
    userId: profile.userId.toString(),
    headline: profile.headline ?? '',
    bio: profile.bio ?? '',
    specializations: profile.specializations as Specialization,
    experienceYears: profile.experienceYears ?? 0,
    certifications: certificationsOf(profile),
    highlights: profile.highlights,
    languages: profile.languages,
    defaultLocation: toLocationDto(profile.defaultLocation),
    cancellationPolicy: {freeCancelHours: profile.cancellationPolicy?.freeCancelHours ?? 24},
    rating: {average: profile.rating?.average ?? 0, count: profile.rating?.count ?? 0},
    isPublished: profile.isPublished,
    completeness: await profileCompleteness(profile),
  };
}

export async function getMyProfile(coach: UserDoc) {
  return toCoachProfileDto(await getOwnProfile(coach));
}

export async function updateMyProfile(
  coach: UserDoc,
  input: z.infer<typeof UpdateCoachProfileBody>,
) {
  const profile = await getOwnProfile(coach);
  profile.set(input);
  await profile.save();
  if (profile.isPublished && !(await profileCompleteness(profile)).complete) {
    profile.isPublished = false;
    await profile.save();
  }
  return toCoachProfileDto(profile);
}

export async function setPublished(coach: UserDoc, isPublished: boolean) {
  const profile = await getOwnProfile(coach);
  if (isPublished) {
    const completeness = await profileCompleteness(profile);
    if (!completeness.complete) {
      throw new AppError('PROFILE_INCOMPLETE', undefined, {missing: completeness.missing});
    }
  }
  profile.isPublished = isPublished;
  await profile.save();
  return toCoachProfileDto(profile);
}

export async function setCancellationPolicy(coach: UserDoc, freeCancelHours: number) {
  const profile = await getOwnProfile(coach);
  profile.set('cancellationPolicy', {freeCancelHours});
  await profile.save();
  return toCoachProfileDto(profile);
}

type UserLean = {
  _id: Types.ObjectId;
  firstName: string;
  lastName?: string | null;
  avatarUrl?: string | null;
  homeArea?: HomeArea | null;
};

function toCoachCard(profile: CoachProfileDoc, user: UserLean): CoachCard {
  return {
    id: user._id.toString(),
    firstName: user.firstName,
    lastName: user.lastName ?? '',
    avatarUrl: user.avatarUrl ?? null,
    headline: profile.headline ?? '',
    specializations: profile.specializations as Specialization,
    experienceYears: profile.experienceYears ?? 0,
    rating: {average: profile.rating?.average ?? 0, count: profile.rating?.count ?? 0},
    homeArea: {
      city: user.homeArea!.city,
      state: user.homeArea!.state,
      country: 'US',
      timezone: user.homeArea!.timezone,
    },
    priceFrom:
      profile.priceFromCents == null
        ? null
        : {amountCents: profile.priceFromCents, currency: 'USD'},
    kinds: profile.kinds as ('individual' | 'group')[],
  };
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Published coaches with filters. Without an explicit state filter, coaches from the viewer's
 * state are listed first, each bucket sorted by rating.
 */
export async function listCoaches(viewer: UserDoc, query: z.infer<typeof CoachListQuery>) {
  const filter: Record<string, unknown> = {isPublished: true};
  if (query.specialization) filter.specializations = query.specialization;
  if (query.state) filter.state = query.state;
  if (query.city) filter.city = new RegExp(`^${escapeRegex(query.city)}$`, 'i');
  if (query.kind) filter.kinds = query.kind;
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    const users = await UserModel.find({
      role: 'coach',
      $or: [{firstName: pattern}, {lastName: pattern}],
    })
      .select('_id')
      .lean();
    filter.$or = [{headline: pattern}, {userId: {$in: users.map(u => u._id)}}];
  }

  const viewerState = viewer.homeArea?.state;
  const sort = {'rating.average': -1 as const, 'rating.count': -1 as const, _id: 1 as const};
  const skip = (query.page - 1) * query.pageSize;
  let profiles: CoachProfileDoc[];
  let total: number;

  if (!query.state && viewerState) {
    const local = {...filter, state: viewerState};
    const other = {...filter, state: {$ne: viewerState}};
    const [localCount, otherCount] = await Promise.all([
      CoachProfileModel.countDocuments(local),
      CoachProfileModel.countDocuments(other),
    ]);
    total = localCount + otherCount;
    const fromLocal = await CoachProfileModel.find(local)
      .sort(sort)
      .skip(skip)
      .limit(query.pageSize);
    const remaining = query.pageSize - fromLocal.length;
    const fromOther =
      remaining > 0
        ? await CoachProfileModel.find(other)
            .sort(sort)
            .skip(Math.max(0, skip - localCount))
            .limit(remaining)
        : [];
    profiles = [...fromLocal, ...fromOther];
  } else {
    [total, profiles] = await Promise.all([
      CoachProfileModel.countDocuments(filter),
      CoachProfileModel.find(filter).sort(sort).skip(skip).limit(query.pageSize),
    ]);
  }

  const users = await UserModel.find({_id: {$in: profiles.map(p => p.userId)}}).lean();
  const byId = new Map(users.map(u => [u._id.toString(), u as unknown as UserLean]));
  const items = profiles
    .map(profile => {
      const user = byId.get(profile.userId.toString());
      return user?.homeArea ? toCoachCard(profile, user) : null;
    })
    .filter((card): card is CoachCard => card !== null);
  return {items, page: query.page, pageSize: query.pageSize, total};
}

async function getPublishedCoach(coachId: string) {
  const [profile, user] = await Promise.all([
    CoachProfileModel.findOne({userId: coachId, isPublished: true}),
    UserModel.findOne({_id: coachId, role: 'coach'}).lean(),
  ]);
  if (!profile || !user?.homeArea) {
    throw new AppError('NOT_FOUND', 'Coach not found.');
  }
  return {profile, user: user as unknown as UserLean};
}

export async function getCoachDetails(coachId: string) {
  const {profile, user} = await getPublishedCoach(coachId);
  const [types, packages] = await Promise.all([
    SessionTypeModel.find({coachId, isActive: true}).sort({kind: 1, 'price.amountCents': 1}),
    listActivePackages(coachId),
  ]);
  return {
    ...toCoachCard(profile, user),
    bio: profile.bio ?? '',
    certifications: certificationsOf(profile),
    highlights: profile.highlights,
    languages: profile.languages,
    defaultLocation: toLocationDto(profile.defaultLocation),
    cancellationPolicy: {freeCancelHours: profile.cancellationPolicy?.freeCancelHours ?? 24},
    sessionTypes: types.map(toSessionTypeDto),
    packages: packages.map(toPackageDto),
  };
}

export async function getCoachSlots(coachId: string, sessionTypeId: string, from: Date, to: Date) {
  await getPublishedCoach(coachId);
  const type = await SessionTypeModel.findOne({_id: sessionTypeId, coachId});
  if (!type) {
    throw new AppError('NOT_FOUND', 'Training type not found.');
  }
  if (!type.isActive) {
    throw new AppError('SESSION_TYPE_INACTIVE');
  }
  if (type.kind !== 'individual') {
    throw new AppError(
      'VALIDATION_ERROR',
      'Slots are available for individual trainings. Use group-sessions for groups.',
      {
        fields: {sessionTypeId: 'Must be an individual training type'},
      },
    );
  }
  const slots = await findSlots(coachId, type.durationMin, from, to);
  return {
    items: slots.map(s => ({startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString()})),
  };
}

export async function getCoachGroupSessions(coachId: string, from: Date, to: Date) {
  await getPublishedCoach(coachId);
  const sessions = await TrainingSessionModel.find({
    coachId,
    kind: 'group',
    status: 'scheduled',
    startAt: {$gte: from > new Date() ? from : new Date(), $lt: to},
  }).sort({startAt: 1});
  return {items: sessions.map(toSessionDto)};
}

export type {Location};
