import {z} from 'zod';

import {LocationSchema, MoneySchema, SessionKindSchema} from '../../lib/schemas.js';

export const SessionTypeSchema = z
  .object({
    id: z.string(),
    coachId: z.string(),
    title: z.string(),
    kind: SessionKindSchema,
    durationMin: z.number().int(),
    price: MoneySchema,
    capacity: z.number().int(),
    location: LocationSchema.nullable(),
    description: z.string(),
    isActive: z.boolean(),
  })
  .meta({id: 'SessionType'});

const duration = z.number().int().min(30).max(180).multipleOf(30);

export const CreateSessionTypeBody = z
  .object({
    title: z.string().trim().min(2).max(80),
    kind: SessionKindSchema,
    durationMin: duration,
    price: MoneySchema,
    capacity: z
      .number()
      .int()
      .min(2)
      .max(30)
      .optional()
      .meta({description: 'Group only (2..30). Individual is always 1.'}),
    location: LocationSchema.nullable().optional(),
    description: z.string().trim().max(1000).optional(),
  })
  .refine(body => body.kind === 'individual' || body.capacity !== undefined, {
    message: 'Capacity is required for group sessions',
    path: ['capacity'],
  });

export const UpdateSessionTypeBody = z.object({
  title: z.string().trim().min(2).max(80).optional(),
  durationMin: duration.optional(),
  price: MoneySchema.optional(),
  capacity: z.number().int().min(2).max(30).optional(),
  location: LocationSchema.nullable().optional(),
  description: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
});

export type SessionTypeDto = z.input<typeof SessionTypeSchema>;
