import {IANAZone} from 'luxon';
import {Types} from 'mongoose';
import {z} from 'zod';

import {ERROR_STATUS} from './errors.js';

export const US_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

export const SPECIALIZATIONS = [
  'strength',
  'yoga',
  'running',
  'boxing',
  'pilates',
  'crossfit',
  'swimming',
  'tennis',
  'hiit',
  'mobility',
] as const;

export const objectId = z
  .string()
  .refine(value => Types.ObjectId.isValid(value), 'Invalid id')
  .meta({description: 'Object id', example: '6650f0c2a1b2c3d4e5f60718'});

export const isoDateTime = z.iso
  .datetime({offset: true})
  .meta({example: '2026-11-03T15:00:00.000Z'});
export const timeHHmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):(00|30)$/, 'Use HH:mm on a 30-minute grid')
  .meta({example: '09:00'});
export const dateYMD = z.iso.date().meta({example: '2026-11-03'});
export const timezone = z
  .string()
  .refine(value => IANAZone.isValidZone(value), 'Invalid IANA time zone')
  .meta({example: 'America/Chicago'});

export const RoleSchema = z.enum(['coach', 'client']).meta({id: 'Role'});
export const ThemeSchema = z.enum(['light', 'dark', 'system']).meta({id: 'Theme'});
export const SpecializationSchema = z.enum(SPECIALIZATIONS).meta({id: 'Specialization'});
export const SessionKindSchema = z.enum(['individual', 'group']).meta({id: 'SessionKind'});

export const MoneySchema = z
  .object({
    amountCents: z.number().int().min(0).meta({example: 4500}),
    currency: z.literal('USD'),
  })
  .meta({id: 'Money'});

export const HomeAreaSchema = z
  .object({
    city: z.string().trim().min(1).max(80).meta({example: 'Chicago'}),
    state: z.enum(US_STATES).meta({example: 'IL'}),
    country: z.literal('US').default('US'),
    timezone,
  })
  .meta({id: 'HomeArea', description: 'Where the user trains or coaches'});

export const LocationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).meta({example: 'North Avenue Beach'}),
    address: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .meta({example: '1600 N Lake Shore Dr, Chicago, IL 60613'}),
    city: z.string().trim().min(1).max(80),
    state: z.enum(US_STATES),
    country: z.literal('US').default('US'),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    placeId: z.string().max(200).optional(),
    comment: z.string().trim().max(300).optional(),
  })
  .meta({id: 'Location'});

export const IdParams = z.object({id: objectId});

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });

export const itemsOf = <T extends z.ZodType>(item: T) => z.object({items: z.array(item)});

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(
        Object.keys(ERROR_STATUS) as [keyof typeof ERROR_STATUS, ...(keyof typeof ERROR_STATUS)[]],
      ),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .meta({id: 'ErrorResponse'});

export type Money = z.infer<typeof MoneySchema>;
export type HomeArea = z.infer<typeof HomeAreaSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Role = z.infer<typeof RoleSchema>;
