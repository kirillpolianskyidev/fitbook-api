import {z} from 'zod';

import {dateYMD} from '../../lib/schemas.js';

export const MEASUREMENT_TYPES = {
  weight: {unit: 'lb', min: 50, max: 700},
  body_fat: {unit: '%', min: 2, max: 70},
  waist: {unit: 'in', min: 15, max: 80},
} as const;
export type MeasurementType = keyof typeof MEASUREMENT_TYPES;

export const MeasurementTypeSchema = z.enum(['weight', 'body_fat', 'waist']).meta({
  id: 'MeasurementType',
  description: 'weight: lb (50-700), body_fat: % (2-70), waist: in (15-80)',
});

export const MeasurementSchema = z
  .object({
    id: z.string(),
    type: MeasurementTypeSchema,
    value: z.number(),
    unit: z.enum(['lb', '%', 'in']),
    measuredAt: z.string().meta({description: 'Local date YYYY-MM-DD'}),
    note: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({id: 'Measurement'});

export const ProgressSchema = z
  .object({
    totals: z.object({
      completed: z.number().int(),
      thisMonth: z
        .number()
        .int()
        .meta({description: 'Completed this calendar month (client time zone)'}),
      coaches: z.number().int().meta({description: 'Different coaches trained with'}),
    }),
    goal: z.object({trainingsPerWeek: z.number().int().nullable()}),
    thisWeek: z.object({
      weekStart: z
        .string()
        .meta({description: 'Monday of the current week (YYYY-MM-DD, client time zone)'}),
      completed: z.number().int(),
      planned: z.number().int().meta({description: 'Confirmed bookings later this week'}),
    }),
    streakWeeks: z.number().int().meta({
      description:
        'Consecutive weeks meeting the goal (>= 1 training without a goal), up to the last finished week or the current week if its goal is already met',
    }),
    weekly: z
      .array(z.object({weekStart: z.string(), completed: z.number().int()}))
      .meta({description: '`weeks` items, oldest first; the last one is the current week'}),
  })
  .meta({id: 'Progress'});

export const CoachClientProgressSchema = ProgressSchema.extend({
  measurements: z.object({
    latest: z.object({
      weight: MeasurementSchema.nullable(),
      body_fat: MeasurementSchema.nullable(),
      waist: MeasurementSchema.nullable(),
    }),
  }),
}).meta({id: 'CoachClientProgress'});

export const ProgressQuery = z.object({
  weeks: z.coerce.number().int().min(4).max(52).default(12),
});

export const GoalBody = z
  .object({trainingsPerWeek: z.number().int().min(1).max(14).nullable()})
  .meta({id: 'Goal'});

export const MeasurementsQuery = z.object({
  type: MeasurementTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

const oneDecimal = (value: number) => Math.abs(Math.round(value * 10) - value * 10) < 1e-9;

export const MeasurementBody = z
  .object({
    type: MeasurementTypeSchema,
    value: z.number().refine(oneDecimal, 'At most 1 decimal place'),
    measuredAt: dateYMD
      .optional()
      .meta({description: 'Local date, default today; not in the future'}),
    note: z.string().trim().max(200).optional(),
  })
  .superRefine((body, ctx) => {
    const range = MEASUREMENT_TYPES[body.type];
    if (body.value < range.min || body.value > range.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Must be between ${range.min} and ${range.max} ${range.unit}`,
      });
    }
  })
  .meta({id: 'MeasurementRequest'});

export const ClientIdParams = z.object({clientId: z.string().regex(/^[0-9a-f]{24}$/i)});
