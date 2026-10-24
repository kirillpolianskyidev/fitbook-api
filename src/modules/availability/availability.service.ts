import {invalidateAvailability} from '../../lib/availabilityCache.js';
import type {Types} from 'mongoose';

import {AvailabilityModel} from '../../models/availability.js';
import type {UserDoc} from '../../models/user.js';

type Weekly = {weekday: number; start: string; end: string};
type Exception = {date: string; start?: string; end?: string; reason?: string};

async function getOrCreate(coachId: Types.ObjectId) {
  return (
    (await AvailabilityModel.findOne({coachId})) ?? (await AvailabilityModel.create({coachId}))
  );
}

export function toAvailabilityDto(
  availability: {weekly: Weekly[] | unknown[]; exceptions: Exception[] | unknown[]},
  timezone: string,
) {
  const weekly = (availability.weekly as Weekly[])
    .map(w => ({weekday: w.weekday, start: w.start, end: w.end}))
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  const exceptions = (availability.exceptions as Exception[])
    .map(e => ({
      date: e.date,
      ...(e.start && {start: e.start}),
      ...(e.end && {end: e.end}),
      ...(e.reason && {reason: e.reason}),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {timezone, weekly, exceptions};
}

export async function getAvailability(coach: UserDoc) {
  return toAvailabilityDto(await getOrCreate(coach._id), coach.homeArea!.timezone);
}

export async function setWeekly(coach: UserDoc, weekly: Weekly[]) {
  const availability = await getOrCreate(coach._id);
  availability.set('weekly', weekly);
  await availability.save();
  invalidateAvailability(coach._id);
  return toAvailabilityDto(availability, coach.homeArea!.timezone);
}

export async function addException(coach: UserDoc, exception: Exception) {
  const availability = await getOrCreate(coach._id);
  const others = (availability.exceptions as Exception[]).filter(e => e.date !== exception.date);
  availability.set('exceptions', [...others, exception]);
  await availability.save();
  invalidateAvailability(coach._id);
  return toAvailabilityDto(availability, coach.homeArea!.timezone);
}

export async function removeException(coach: UserDoc, date: string) {
  const availability = await getOrCreate(coach._id);
  availability.set(
    'exceptions',
    (availability.exceptions as Exception[]).filter(e => e.date !== date),
  );
  await availability.save();
  invalidateAvailability(coach._id);
  return toAvailabilityDto(availability, coach.homeArea!.timezone);
}
