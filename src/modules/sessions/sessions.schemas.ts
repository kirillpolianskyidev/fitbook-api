import {z} from 'zod';

import {
  isoDateTime,
  LocationSchema,
  MoneySchema,
  objectId,
  SessionKindSchema,
  TrainingFormatSchema,
} from '../../lib/schemas.js';

export const SessionStatusSchema = z
  .enum(['scheduled', 'cancelled', 'completed'])
  .meta({id: 'SessionStatus'});

export const TrainingSessionSchema = z
  .object({
    id: z.string(),
    coachId: z.string(),
    sessionTypeId: z.string(),
    kind: SessionKindSchema,
    format: TrainingFormatSchema,
    title: z.string(),
    startAt: z.string(),
    endAt: z.string(),
    durationMin: z.number().int(),
    capacity: z.number().int(),
    participantsCount: z.number().int(),
    spotsLeft: z.number().int(),
    price: MoneySchema,
    location: LocationSchema.nullable(),
    status: SessionStatusSchema,
    cancelReason: z.string().nullable(),
  })
  .meta({id: 'TrainingSession'});

export const SlotSchema = z.object({startAt: z.string(), endAt: z.string()}).meta({id: 'Slot'});

/** Adds the from < to and maximum length checks to a query schema with `from` and `to`. */
export const withRange = <
  T extends z.ZodObject<{from: typeof isoDateTime; to: typeof isoDateTime}>,
>(
  schema: T,
  maxDays: number,
) =>
  schema
    .refine(q => new Date(q.from) < new Date(q.to), {
      message: 'from must be before to',
      path: ['to'],
    })
    .refine(q => new Date(q.to).getTime() - new Date(q.from).getTime() <= maxDays * 86_400_000, {
      message: `Range must be at most ${maxDays} days`,
      path: ['to'],
    });

export const RangeQuery = z
  .object({from: isoDateTime, to: isoDateTime})
  .refine(q => new Date(q.from) < new Date(q.to), {message: 'from must be before to', path: ['to']})
  .refine(q => new Date(q.to).getTime() - new Date(q.from).getTime() <= 62 * 86_400_000, {
    message: 'Range must be at most 62 days',
    path: ['to'],
  });

export const SlotsQuery = z
  .object({sessionTypeId: objectId, from: isoDateTime, to: isoDateTime})
  .refine(q => new Date(q.from) < new Date(q.to), {message: 'from must be before to', path: ['to']})
  .refine(q => new Date(q.to).getTime() - new Date(q.from).getTime() <= 31 * 86_400_000, {
    message: 'Range must be at most 31 days',
    path: ['to'],
  });

export type TrainingSessionDto = z.input<typeof TrainingSessionSchema>;
