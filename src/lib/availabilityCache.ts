/**
 * Short-lived cache of each coach's free times for the next 14 days (catalog "next available" and time-of-day
 * filters). Every change of slots, seats, working hours or training types invalidates the coach's entry.
 */
export const AVAILABILITY_TTL_MS = 5 * 60_000;

type Entry<T> = {expiresAt: number; value: Promise<T>};
const cache = new Map<string, Entry<unknown>>();

export function cachedAvailability<T>(coachId: string, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(coachId) as Entry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = compute();
  cache.set(coachId, {expiresAt: Date.now() + AVAILABILITY_TTL_MS, value});
  value.catch(() => cache.delete(coachId));
  return value;
}

export function invalidateAvailability(coachId: {toString(): string} | null | undefined) {
  if (coachId) cache.delete(coachId.toString());
}
