import {z} from 'zod';

import {
  HomeAreaSchema,
  LocationSchema,
  MoneySchema,
  SessionKindSchema,
  SpecializationSchema,
} from '../../lib/schemas.js';
import {PackageSchema} from '../packages/packages.schemas.js';
import {SessionTypeSchema} from '../sessionTypes/sessionTypes.schemas.js';

export const CertificationSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    issuer: z.string().trim().max(120).default(''),
    year: z.number().int().min(1950).max(2100).nullable().default(null),
  })
  .meta({id: 'Certification'});

export const RatingSchema = z
  .object({average: z.number(), count: z.number().int()})
  .meta({id: 'Rating'});
export const CancellationPolicySchema = z
  .object({freeCancelHours: z.number().int().min(0).max(72)})
  .meta({
    id: 'CancellationPolicy',
    description: 'Clients may cancel only if at least this many hours remain',
  });

export const CoachProfileSchema = z
  .object({
    userId: z.string(),
    headline: z.string(),
    bio: z.string(),
    specializations: z.array(SpecializationSchema),
    experienceYears: z.number().int(),
    certifications: z.array(CertificationSchema),
    highlights: z.array(z.string()),
    languages: z.array(z.string()),
    defaultLocation: LocationSchema.nullable(),
    cancellationPolicy: CancellationPolicySchema,
    rating: RatingSchema,
    isPublished: z.boolean(),
    completeness: z.object({complete: z.boolean(), missing: z.array(z.string())}),
  })
  .meta({id: 'CoachProfile'});

export const UpdateCoachProfileBody = z.object({
  headline: z.string().trim().max(120).optional(),
  bio: z.string().trim().max(2000).optional(),
  specializations: z.array(SpecializationSchema).max(5).optional(),
  experienceYears: z.number().int().min(0).max(60).optional(),
  certifications: z.array(CertificationSchema).max(15).optional(),
  highlights: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  languages: z.array(z.string().trim().min(2).max(40)).max(8).optional(),
  defaultLocation: LocationSchema.nullable().optional(),
});

export const PublishBody = z.object({isPublished: z.boolean()});

export const CoachCardSchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    avatarUrl: z.string().nullable(),
    headline: z.string(),
    specializations: z.array(SpecializationSchema),
    experienceYears: z.number().int(),
    rating: RatingSchema,
    homeArea: HomeAreaSchema,
    priceFrom: MoneySchema.nullable(),
    kinds: z.array(SessionKindSchema),
    isFavorite: z.boolean().meta({description: 'In my favorites (always false for coaches)'}),
  })
  .meta({id: 'CoachCard'});

export const CoachDetailsSchema = CoachCardSchema.extend({
  bio: z.string(),
  certifications: z.array(CertificationSchema),
  highlights: z.array(z.string()),
  languages: z.array(z.string()),
  defaultLocation: LocationSchema.nullable(),
  cancellationPolicy: CancellationPolicySchema,
  sessionTypes: z.array(SessionTypeSchema),
  packages: z.array(PackageSchema).meta({description: 'Active packages of the coach'}),
}).meta({id: 'CoachDetails'});

export const CoachListQuery = z.object({
  search: z.string().trim().max(80).optional(),
  specialization: SpecializationSchema.optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().length(2).toUpperCase().optional(),
  kind: SessionKindSchema.optional(),
  favorites: z.stringbool().optional().meta({description: 'true: only my favorite coaches'}),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
