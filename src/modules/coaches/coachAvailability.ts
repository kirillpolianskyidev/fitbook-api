import type {Types} from 'mongoose';

import {cachedAvailability} from '../../lib/availabilityCache.js';
import {SessionTypeModel} from '../../models/sessionType.js';
import {TrainingSessionModel} from '../../models/trainingSession.js';
import {findSlots} from '../sessions/sessions.service.js';

export const AVAILABILITY_DAYS = 14;

export type CoachAvailability = {
  /** Free individual slot starts of all active individual types (sorted, unique). */
  individual: Date[];
  /** Starts of upcoming group sessions with a free place (sorted). */
  group: Date[];
  /** Earliest individual slot; for coaches with only group types the earliest free group place. */
  nextAvailableAt: Date | null;
};

async function compute(coachId: string): Promise<CoachAvailability> {
  const from = new Date();
  const to = new Date(from.getTime() + AVAILABILITY_DAYS * 86_400_000);
  const types = await SessionTypeModel.find({coachId, isActive: true}).lean();
  const individualTypes = types.filter(t => t.kind === 'individual');
  const durations = [...new Set(individualTypes.map(t => t.durationMin))];
  const starts = new Set<number>();
  for (const duration of durations) {
    try {
      for (const slot of await findSlots(coachId, duration, from, to))
        starts.add(slot.startAt.getTime());
    } catch {
      // No time zone / not a coach: no slots.
    }
  }
  const individual = [...starts].sort((a, b) => a - b).map(ms => new Date(ms));
  const sessions = await TrainingSessionModel.find({
    coachId,
    kind: 'group',
    status: 'scheduled',
    startAt: {$gt: from, $lt: to},
  })
    .select('startAt capacity participantsCount heldCount')
    .sort({startAt: 1})
    .lean();
  const group = sessions
    .filter(s => s.capacity - s.participantsCount - (s.heldCount ?? 0) > 0)
    .map(s => s.startAt);
  const nextAvailableAt = individualTypes.length ? (individual[0] ?? null) : (group[0] ?? null);
  return {individual, group, nextAvailableAt};
}

export const coachAvailability = (coachId: Types.ObjectId | string) =>
  cachedAvailability(coachId.toString(), () => compute(coachId.toString()));

export const TIME_OF_DAY = {
  morning: [5 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 23 * 60],
} as const;
export type TimeOfDay = keyof typeof TIME_OF_DAY;
