import {DateTime} from 'luxon';

import {addMinutes, minutesOf, SLOT_MINUTES} from './time.js';

export type WeeklyEntry = {weekday: number; start?: string | null; end?: string | null};
export type ExceptionEntry = {date?: string | null; start?: string | null; end?: string | null};

export type SlotQuery = {
  timezone: string;
  weekly: WeeklyEntry[];
  exceptions: ExceptionEntry[];
  durationMin: number;
  from: Date;
  to: Date;
  /** Epoch ms of every locked 30-minute block of the coach. */
  locked: Set<number>;
  /** Earliest allowed start (now + lead time). */
  notBefore: Date;
};

export type Slot = {startAt: Date; endAt: Date};

export const BOOKING_LEAD_MINUTES = 120;

/** Luxon weekday (1 = Monday ... 7 = Sunday) -> 0 = Sunday ... 6 = Saturday. */
const toWeekday = (dt: DateTime) => dt.weekday % 7;

type Interval = [number, number]; // minutes since local midnight

function subtract(intervals: Interval[], cut: Interval): Interval[] {
  return intervals.flatMap(([s, e]) => {
    if (cut[1] <= s || cut[0] >= e) return [[s, e] as Interval];
    const parts: Interval[] = [];
    if (cut[0] > s) parts.push([s, cut[0]]);
    if (cut[1] < e) parts.push([cut[1], e]);
    return parts;
  });
}

/** Working intervals of one local date after exceptions. */
export function workingIntervals(
  date: DateTime,
  weekly: WeeklyEntry[],
  exceptions: ExceptionEntry[],
): Interval[] {
  const weekday = toWeekday(date);
  let intervals: Interval[] = weekly
    .filter(w => w.weekday === weekday && w.start && w.end)
    .map(w => [minutesOf(w.start!), minutesOf(w.end!)] as Interval);
  const iso = date.toISODate();
  for (const exception of exceptions.filter(e => e.date === iso)) {
    if (!exception.start || !exception.end) {
      return [];
    }
    intervals = subtract(intervals, [minutesOf(exception.start), minutesOf(exception.end)]);
  }
  return intervals;
}

export const isWholeDayOff = (date: string, exceptions: ExceptionEntry[]) =>
  exceptions.some(e => e.date === date && (!e.start || !e.end));

function localInstant(date: DateTime, minutes: number): Date | null {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const dt = date.set({hour, minute, second: 0, millisecond: 0});
  // Skip local times that do not exist (spring-forward gap).
  if (dt.hour !== hour || dt.minute !== minute) return null;
  return dt.toUTC().toJSDate();
}

/** Free start times for a duration, on a 30-minute grid, inside working hours and outside locked blocks. */
export function computeSlots(query: SlotQuery): Slot[] {
  const slots: Slot[] = [];
  let day = DateTime.fromJSDate(query.from, {zone: query.timezone}).startOf('day');
  const lastDay = DateTime.fromJSDate(query.to, {zone: query.timezone}).startOf('day');
  const blocksNeeded = query.durationMin / SLOT_MINUTES;

  while (day <= lastDay) {
    for (const [start, end] of workingIntervals(day, query.weekly, query.exceptions)) {
      for (let m = start; m + query.durationMin <= end; m += SLOT_MINUTES) {
        const startAt = localInstant(day, m);
        if (!startAt || startAt < query.from || startAt >= query.to || startAt < query.notBefore)
          continue;
        let free = true;
        for (let b = 0; b < blocksNeeded; b += 1) {
          if (query.locked.has(startAt.getTime() + b * SLOT_MINUTES * 60_000)) {
            free = false;
            break;
          }
        }
        if (free) slots.push({startAt, endAt: addMinutes(startAt, query.durationMin)});
      }
    }
    day = day.plus({days: 1});
  }
  return slots;
}
