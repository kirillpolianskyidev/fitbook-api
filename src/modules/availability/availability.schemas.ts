import {z} from 'zod';

import {dateYMD, timeHHmm} from '../../lib/schemas.js';
import {minutesOf} from '../../lib/time.js';

export const WeeklyEntrySchema = z
  .object({
    weekday: z.number().int().min(0).max(6).meta({description: '0 = Sunday ... 6 = Saturday'}),
    start: timeHHmm,
    end: timeHHmm.or(z.literal('24:00')),
  })
  .refine(e => minutesOf(e.start) < minutesOf(e.end), {
    message: 'start must be before end',
    path: ['end'],
  })
  .meta({id: 'WeeklyAvailability'});

export const ExceptionSchema = z
  .object({
    date: dateYMD,
    start: timeHHmm.optional(),
    end: timeHHmm.optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .refine(e => (e.start === undefined) === (e.end === undefined), {
    message: 'Provide both start and end, or neither for a whole day off',
    path: ['end'],
  })
  .meta({id: 'AvailabilityException'});

export const AvailabilitySchema = z
  .object({
    timezone: z.string(),
    weekly: z.array(WeeklyEntrySchema),
    exceptions: z.array(ExceptionSchema),
  })
  .meta({id: 'Availability'});

export const PutWeeklyBody = z.object({
  weekly: z
    .array(WeeklyEntrySchema)
    .max(50)
    .refine(entries => {
      const byDay = new Map<number, [number, number][]>();
      for (const e of entries) {
        const list = byDay.get(e.weekday) ?? [];
        list.push([minutesOf(e.start), minutesOf(e.end)]);
        byDay.set(e.weekday, list);
      }
      return [...byDay.values()].every(list =>
        list.sort((a, b) => a[0] - b[0]).every((item, i) => i === 0 || item[0] >= list[i - 1]![1]),
      );
    }, 'Intervals of the same weekday must not overlap'),
});

export const DateParams = z.object({date: dateYMD});
