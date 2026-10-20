import {DateTime} from 'luxon';

export const SLOT_MINUTES = 30;

export const toIso = (date: Date) => date.toISOString();
export const toIsoOrNull = (date: Date | null | undefined) => (date ? date.toISOString() : null);

/** "HH:mm" -> minutes since midnight. */
export function minutesOf(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/** Local date (YYYY-MM-DD) + local time (HH:mm) in a zone -> UTC Date. */
export function zonedDateTime(date: string, time: string, zone: string): Date {
  return DateTime.fromISO(`${date}T${time}`, {zone}).toUTC().toJSDate();
}

/** All 30-minute block starts covered by [start, end). */
export function slotBlocks(start: Date, end: Date): Date[] {
  const blocks: Date[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += SLOT_MINUTES * 60_000) {
    blocks.push(new Date(t));
  }
  return blocks;
}

export const addMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60_000);

/** True if the instant falls exactly on a :00 or :30 boundary. */
export const isOnSlotGrid = (date: Date) =>
  date.getUTCSeconds() === 0 &&
  date.getUTCMilliseconds() === 0 &&
  date.getUTCMinutes() % SLOT_MINUTES === 0;
