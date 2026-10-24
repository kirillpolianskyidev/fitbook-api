import type {Types} from 'mongoose';
import type {z} from 'zod';

import {toLocationDto} from '../../lib/dto.js';
import {AppError, isDuplicateKeyError} from '../../lib/errors.js';
import type {HomeArea, Location} from '../../lib/schemas.js';
import {AvailabilityModel} from '../../models/availability.js';
import {CoachProfileModel, type CoachProfileDoc} from '../../models/coachProfile.js';
import {FavoriteModel} from '../../models/favorite.js';
import {SessionTypeModel} from '../../models/sessionType.js';
import {TrainingSessionModel} from '../../models/trainingSession.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {DateTime} from 'luxon';

import {listActivePackages, toPackageDto} from '../packages/packages.service.js';
import {coachAvailability, TIME_OF_DAY, type TimeOfDay} from './coachAvailability.js';
import {findSlots, toSessionDto} from '../sessions/sessions.service.js';
import {toSessionTypeDto} from '../sessionTypes/sessionTypes.service.js';
import {refreshWaitlists, waitlistInfo} from '../waitlist/waitlist.service.js';
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
  // A place to train: a default location or online trainings.
  if (!profile.defaultLocation && !profile.online?.enabled) missing.push('defaultLocation');
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
    online: {
      enabled: Boolean(profile.online?.enabled),
      meetingUrl: profile.online?.meetingUrl ?? null,
    },
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
  const {online, ...rest} = input;
  if (online) {
    const meetingUrl =
      online.meetingUrl === undefined
        ? (profile.online?.meetingUrl ?? null)
        : online.meetingUrl || null;
    if (meetingUrl !== null && (!/^https:\/\/\S+$/i.test(meetingUrl) || meetingUrl.length > 500)) {
      throw new AppError('VALIDATION_ERROR', undefined, {
        fields: {meetingUrl: 'Must be an https:// link up to 500 characters'},
      });
    }
    if (online.enabled && !meetingUrl) {
      throw new AppError('VALIDATION_ERROR', undefined, {
        fields: {meetingUrl: 'A meeting link is required to turn on online trainings'},
      });
    }
    if (!online.enabled && profile.online?.enabled) {
      const onlineTypes = await SessionTypeModel.exists({
        coachId: coach._id,
        isActive: true,
        format: {$in: ['online', 'both']},
      });
      if (onlineTypes) throw new AppError('ONLINE_TYPES_ACTIVE');
    }
    profile.set('online', {enabled: online.enabled, meetingUrl});
  }
  profile.set(rest);
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

/** Ids of the viewer's favorite coaches (clients only). */
export async function favoriteCoachIds(viewer: UserDoc) {
  if (viewer.role !== 'client') return new Set<string>();
  const favorites = await FavoriteModel.find({clientId: viewer._id}).select('coachId').lean();
  return new Set(favorites.map(f => f.coachId.toString()));
}

function toCoachCard(
  profile: CoachProfileDoc,
  user: UserLean,
  isFavorite: boolean,
  nextAvailableAt: Date | null,
): CoachCard {
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
    languages: profile.languages,
    location: profile.defaultLocation
      ? {
          lat: profile.defaultLocation.lat,
          lng: profile.defaultLocation.lng,
          name: profile.defaultLocation.name,
          city: profile.defaultLocation.city,
          state: profile.defaultLocation.state,
        }
      : null,
    nextAvailableAt: nextAvailableAt?.toISOString() ?? null,
    formats: (profile.formats ?? ['in_person']) as ('in_person' | 'online')[],
    isFavorite,
  };
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Published coaches with filters. Without an explicit state filter, coaches from the viewer's
 * state are listed first, each bucket sorted by rating.
 */
/** Coach cards for profiles, in order, with favorites and next available time. */
async function toCoachCards(profiles: CoachProfileDoc[], favorites: Set<string>) {
  const users = await UserModel.find({_id: {$in: profiles.map(p => p.userId)}}).lean();
  const byId = new Map(users.map(u => [u._id.toString(), u as unknown as UserLean]));
  const cards = await Promise.all(
    profiles.map(async profile => {
      const user = byId.get(profile.userId.toString());
      if (!user?.homeArea) return null;
      const {nextAvailableAt} = await coachAvailability(profile.userId);
      return toCoachCard(profile, user, favorites.has(profile.userId.toString()), nextAvailableAt);
    }),
  );
  return cards.filter((card): card is CoachCard => card !== null);
}

/** Does the coach have free time starting in one of these parts of the day (viewer's time zone)? */
function matchesTimeOfDay(starts: Date[], parts: TimeOfDay[], zone: string) {
  return starts.some(start => {
    const local = DateTime.fromJSDate(start, {zone});
    const minutes = local.hour * 60 + local.minute;
    return parts.some(part => minutes >= TIME_OF_DAY[part][0] && minutes < TIME_OF_DAY[part][1]);
  });
}

const DB_SORTS = {
  recommended: {'rating.average': -1, 'rating.count': -1, _id: 1},
  rating: {'rating.average': -1, 'rating.count': -1, _id: 1},
  price_asc: {priceFromCents: 1, _id: 1},
  price_desc: {priceFromCents: -1, _id: 1},
} as const;

/**
 * Published coaches with filters and sorting. "recommended": coaches from the viewer's state first (unless a
 * state filter is given), each bucket by rating. Time-of-day filters and "next_available" need the coaches'
 * free times, so they are evaluated in memory over all matching coaches.
 */
export async function listCoaches(viewer: UserDoc, query: z.infer<typeof CoachListQuery>) {
  const filter: Record<string, unknown> = {isPublished: true};
  const and: Record<string, unknown>[] = [];
  const favorites = await favoriteCoachIds(viewer);
  if (query.favorites) and.push({userId: {$in: [...favorites]}});
  if (query.specialization) filter.specializations = query.specialization;
  if (query.state) filter.state = query.state;
  if (query.city) filter.city = new RegExp(`^${escapeRegex(query.city)}$`, 'i');
  if (query.kind) filter.kinds = query.kind;
  if (query.format) filter.formats = query.format;
  if (query.bbox) {
    filter['defaultLocation.lng'] = {$gte: query.bbox.minLng, $lte: query.bbox.maxLng};
    filter['defaultLocation.lat'] = {$gte: query.bbox.minLat, $lte: query.bbox.maxLat};
  }
  if (query.language) filter.languages = new RegExp(`^${escapeRegex(query.language)}$`, 'i');
  if (query.priceMin !== undefined || query.priceMax !== undefined) {
    const coachIds = await SessionTypeModel.distinct('coachId', {
      isActive: true,
      'price.amountCents': {
        ...(query.priceMin !== undefined && {$gte: query.priceMin}),
        ...(query.priceMax !== undefined && {$lte: query.priceMax}),
      },
    });
    and.push({userId: {$in: coachIds}});
  }
  if (query.trial) {
    const coachIds = await SessionTypeModel.distinct('coachId', {
      isActive: true,
      kind: 'individual',
    });
    and.push({userId: {$in: coachIds}});
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    const users = await UserModel.find({
      role: 'coach',
      $or: [{firstName: pattern}, {lastName: pattern}],
    })
      .select('_id')
      .lean();
    and.push({$or: [{headline: pattern}, {userId: {$in: users.map(u => u._id)}}]});
  }
  if (and.length) filter.$and = and;

  const skip = (query.page - 1) * query.pageSize;
  const page = (items: CoachCard[], total: number) => ({
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
  });

  // In memory: time-of-day filter and next-available sorting.
  if (query.timeOfDay || query.sort === 'next_available') {
    let profiles = await CoachProfileModel.find(filter).sort(DB_SORTS.recommended);
    const availability = new Map(
      await Promise.all(
        profiles.map(async p => [p.userId.toString(), await coachAvailability(p.userId)] as const),
      ),
    );
    if (query.timeOfDay) {
      const parts = query.timeOfDay.split(',') as TimeOfDay[];
      const zone = viewer.homeArea?.timezone ?? 'America/Chicago';
      profiles = profiles.filter(p => {
        const a = availability.get(p.userId.toString())!;
        return matchesTimeOfDay([...a.individual, ...a.group], parts, zone);
      });
    }
    if (query.sort === 'next_available') {
      const at = (p: CoachProfileDoc) =>
        availability.get(p.userId.toString())!.nextAvailableAt?.getTime() ?? Infinity;
      profiles.sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
    } else if (query.sort === 'price_asc' || query.sort === 'price_desc') {
      const dir = query.sort === 'price_asc' ? 1 : -1;
      profiles.sort(
        (a, b) =>
          dir * ((a.priceFromCents ?? Infinity) - (b.priceFromCents ?? Infinity)) ||
          a.id.localeCompare(b.id),
      );
    }
    const slice = profiles.slice(skip, skip + query.pageSize);
    return page(await toCoachCards(slice, favorites), profiles.length);
  }

  const viewerState = viewer.homeArea?.state;
  const sort = DB_SORTS[query.sort as keyof typeof DB_SORTS];
  let profiles: CoachProfileDoc[];
  let total: number;
  if (query.sort === 'recommended' && !query.state && viewerState) {
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
  return page(await toCoachCards(profiles, favorites), total);
}

/** Values for the catalog filter screen. */
export async function catalogFilters() {
  const published = await CoachProfileModel.find({isPublished: true})
    .select('userId languages')
    .lean();
  const languages = [...new Set(published.flatMap(p => p.languages ?? []))].sort((a, b) =>
    a.localeCompare(b),
  );
  const [range] = await SessionTypeModel.aggregate<{min: number; max: number}>([
    {$match: {isActive: true, coachId: {$in: published.map(p => p.userId)}}},
    {$group: {_id: null, min: {$min: '$price.amountCents'}, max: {$max: '$price.amountCents'}}},
  ]);
  const money = (amountCents: number | undefined) =>
    amountCents === undefined ? null : {amountCents, currency: 'USD' as const};
  return {languages, price: {min: money(range?.min), max: money(range?.max)}};
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

/** Favorite coaches of the client (published ones), most recently added first. */
export async function listFavoriteCoaches(client: UserDoc) {
  const favorites = await FavoriteModel.find({clientId: client._id})
    .sort({createdAt: -1, _id: -1})
    .lean();
  const ids = favorites.map(f => f.coachId);
  const [profiles, users] = await Promise.all([
    CoachProfileModel.find({userId: {$in: ids}, isPublished: true}),
    UserModel.find({_id: {$in: ids}, role: 'coach'}).lean(),
  ]);
  const profileById = new Map(profiles.map(p => [p.userId.toString(), p]));
  const userById = new Map(users.map(u => [u._id.toString(), u as unknown as UserLean]));
  const items: CoachCard[] = [];
  for (const id of ids) {
    const profile = profileById.get(id.toString());
    const user = userById.get(id.toString());
    if (profile && user?.homeArea) {
      const {nextAvailableAt} = await coachAvailability(profile.userId);
      items.push(toCoachCard(profile, user, true, nextAvailableAt));
    }
  }
  return {items};
}

/** Adds a favorite (idempotent). Only published coaches. */
export async function addFavorite(client: UserDoc, coachId: string) {
  await getPublishedCoach(coachId);
  try {
    await FavoriteModel.updateOne(
      {clientId: client._id, coachId},
      {$setOnInsert: {clientId: client._id, coachId}},
      {upsert: true},
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error; // a parallel PUT inserted it
  }
}

export async function removeFavorite(client: UserDoc, coachId: string) {
  await FavoriteModel.deleteOne({clientId: client._id, coachId});
}

export async function getCoachDetails(coachId: string, viewer: UserDoc) {
  const {profile, user} = await getPublishedCoach(coachId);
  const [types, packages] = await Promise.all([
    SessionTypeModel.find({coachId, isActive: true}).sort({kind: 1, 'price.amountCents': 1}),
    listActivePackages(coachId),
  ]);
  const favorites = await favoriteCoachIds(viewer);
  return {
    ...toCoachCard(
      profile,
      user,
      favorites.has(coachId),
      (await coachAvailability(profile.userId)).nextAvailableAt,
    ),
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

export async function getCoachGroupSessions(
  coachId: string,
  from: Date,
  to: Date,
  viewerId: Types.ObjectId,
) {
  await getPublishedCoach(coachId);
  const query = () =>
    TrainingSessionModel.find({
      coachId,
      kind: 'group',
      status: 'scheduled',
      startAt: {$gte: from > new Date() ? from : new Date(), $lt: to},
    }).sort({startAt: 1});
  // Waitlists (expired offers, free places) are brought up to date before reading the counts.
  await refreshWaitlists((await query().select('_id')).map(s => s._id));
  const sessions = await query();
  const waitlists = await waitlistInfo(
    sessions.map(s => s._id),
    viewerId,
  );
  return {
    items: sessions.map(session => ({
      ...toSessionDto(session),
      waitlist: waitlists.get(session.id as string)!,
    })),
  };
}

export type {Location};
