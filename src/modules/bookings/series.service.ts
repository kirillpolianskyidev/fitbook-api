import {DateTime} from 'luxon';
import type {z} from 'zod';

import {AppError} from '../../lib/errors.js';
import {BOOKING_LEAD_MINUTES, isWholeDayOff} from '../../lib/slots.js';
import {addMinutes, isOnSlotGrid, zonedDateTime} from '../../lib/time.js';
import {AvailabilityModel} from '../../models/availability.js';
import {BookingModel, type BookingDoc} from '../../models/booking.js';
import {BookingSeriesModel, type BookingSeriesDoc} from '../../models/bookingSeries.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {SessionTypeModel} from '../../models/sessionType.js';
import {TrainingSessionModel} from '../../models/trainingSession.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {coachTimezone, isFreeSlot} from '../sessions/sessions.service.js';
import {toUserSummary} from '../users/users.service.js';
import type {SeriesExtendBody, SeriesRescheduleBody} from './bookings.schemas.js';
import {
  assertDatesInPreview,
  bookSeriesDates,
  cancelByClient,
  previewSeries,
  rescheduleBooking,
  seriesType,
  toBookingDtos,
} from './bookings.service.js';

const ACTIVE = ['pending_payment', 'confirmed'];
const EXTEND_GRACE_DAYS = 14;
type Reason = 'UNAVAILABLE' | 'PAST' | 'EXCEPTION';

// ---------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------

async function findSeries(seriesId: string) {
  const series = await BookingSeriesModel.findById(seriesId);
  if (!series) throw new AppError('NOT_FOUND', 'Series not found.');
  return series;
}

/** The client of the series (actions) or also its coach (reading). */
async function accessibleSeries(user: UserDoc, seriesId: string, allowCoach = false) {
  const series = await findSeries(seriesId);
  const isClient = series.clientId.equals(user._id);
  const isCoach = allowCoach && series.coachId.equals(user._id);
  if (!isClient && !isCoach) throw new AppError('FORBIDDEN');
  return series;
}

const seriesBookings = (series: BookingSeriesDoc) =>
  BookingModel.find({seriesId: series._id}).sort({startAt: 1});

/** Same window as rescheduling one booking: active, not started, before the free-cancellation deadline. */
async function movableBookings(series: BookingSeriesDoc, bookings: BookingDoc[]) {
  const profile = await CoachProfileModel.findOne({userId: series.coachId}).lean();
  const hours = profile?.cancellationPolicy?.freeCancelHours ?? 24;
  const now = Date.now();
  return bookings.filter(b => {
    if (!ACTIVE.includes(b.status) || b.startAt.getTime() <= now) return false;
    return b.status === 'pending_payment' || now <= b.startAt.getTime() - hours * 3600_000;
  });
}

async function seriesFormat(series: BookingSeriesDoc, bookings: BookingDoc[]) {
  if (series.format) return series.format as 'in_person' | 'online';
  const first = bookings[0];
  const session = first
    ? await TrainingSessionModel.findById(first.sessionId).select('format').lean()
    : null;
  return (session?.format ?? 'in_person') as 'in_person' | 'online';
}

// ---------------------------------------------------------------------------------------------
// GET /bookings/series/:id
// ---------------------------------------------------------------------------------------------

async function seriesState(series: BookingSeriesDoc, bookings: BookingDoc[]) {
  const [type, timezone] = await Promise.all([
    SessionTypeModel.findById(series.sessionTypeId),
    coachTimezone(series.coachId),
  ]);
  const now = new Date();
  const upcoming = bookings.filter(b => ACTIVE.includes(b.status) && b.startAt > now);
  const kept = bookings.filter(b => b.status !== 'cancelled');
  const last = (kept.length ? kept : bookings).at(-1) ?? null;
  const recentEnough =
    last !== null && last.endAt.getTime() >= now.getTime() - EXTEND_GRACE_DAYS * 86_400_000;
  const canExtend = Boolean(type?.isActive) && (upcoming.length > 0 || recentEnough);
  // Monday of the week after the last training (coach time zone); without trainings: next Monday.
  const base = last
    ? DateTime.fromJSDate(last.startAt, {zone: timezone})
    : DateTime.now().setZone(timezone);
  const extendFrom = base.startOf('week').plus({weeks: 1}).toISODate()!;
  return {type, timezone, upcoming, last, canExtend, extendFrom};
}

export async function getSeries(user: UserDoc, seriesId: string) {
  const series = await accessibleSeries(user, seriesId, true);
  const bookings = await seriesBookings(series);
  const state = await seriesState(series, bookings);
  const coach = await UserModel.findById(series.coachId)
    .select('firstName lastName avatarUrl')
    .lean();
  return {
    id: series.id as string,
    sessionType: {
      id: series.sessionTypeId.toString(),
      title: state.type?.title ?? '',
      durationMin: state.type?.durationMin ?? 0,
      isActive: Boolean(state.type?.isActive),
    },
    coach: coach
      ? toUserSummary(coach)
      : {id: series.coachId.toString(), firstName: '', lastName: '', avatarUrl: null},
    weekdays: series.weekdays,
    time: series.time,
    timezone: state.timezone,
    format: await seriesFormat(series, bookings),
    bookings: await toBookingDtos(bookings, user._id),
    upcomingCount: state.upcoming.length,
    nextAt: state.upcoming[0]?.startAt.toISOString() ?? null,
    lastAt: state.last?.startAt.toISOString() ?? null,
    canExtend: state.canExtend,
    extendFrom: state.extendFrom,
  };
}

// ---------------------------------------------------------------------------------------------
// Cancel all upcoming
// ---------------------------------------------------------------------------------------------

export async function cancelSeries(client: UserDoc, seriesId: string, reason?: string) {
  const series = await accessibleSeries(client, seriesId);
  const now = new Date();
  const upcoming = (await seriesBookings(series)).filter(
    b => ACTIVE.includes(b.status) && b.startAt > now,
  );
  const cancelled: BookingDoc[] = [];
  const kept: {bookingId: string; startAt: string; reason: string}[] = [];
  for (const booking of upcoming) {
    try {
      cancelled.push(await cancelByClient(client, booking.id as string, reason));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      kept.push({
        bookingId: booking.id as string,
        startAt: booking.startAt.toISOString(),
        reason: error.code,
      });
    }
  }
  if (cancelled.length === 0) {
    throw new AppError(
      'CANCELLATION_WINDOW_PASSED',
      'No booking of this series can be cancelled any more.',
    );
  }
  return {cancelled: await toBookingDtos(cancelled, client._id), kept};
}

// ---------------------------------------------------------------------------------------------
// Reschedule all upcoming (new weekdays / time)
// ---------------------------------------------------------------------------------------------

type PlanItem = {
  booking: BookingDoc;
  date: string;
  startAt: Date;
  endAt: Date;
  available: boolean;
  reason: Reason | null;
};

/** Pairs the movable bookings (in order) with the first dates of the new pattern from startDate. */
async function reschedulePlan(
  series: BookingSeriesDoc,
  input: z.infer<typeof SeriesRescheduleBody>,
) {
  const timezone = await coachTimezone(series.coachId);
  const today = DateTime.now().setZone(timezone).toISODate()!;
  if (input.startDate < today) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {startDate: 'Cannot be in the past'},
    });
  }
  const movable = await movableBookings(series, await seriesBookings(series));
  if (movable.length === 0) throw new AppError('RESCHEDULE_WINDOW_PASSED');

  const availability = await AvailabilityModel.findOne({coachId: series.coachId}).lean();
  const exceptions = availability?.exceptions ?? [];
  const notBefore = addMinutes(new Date(), BOOKING_LEAD_MINUTES);
  const dates: string[] = [];
  for (
    let day = DateTime.fromISO(input.startDate, {zone: timezone});
    dates.length < movable.length && dates.length < 400;
    day = day.plus({days: 1})
  ) {
    if (input.weekdays.includes(day.weekday % 7)) dates.push(day.toISODate()!);
  }

  const items: PlanItem[] = [];
  for (const [index, booking] of movable.entries()) {
    const date = dates[index]!;
    const startAt = zonedDateTime(date, input.time, timezone);
    const durationMs = booking.endAt.getTime() - booking.startAt.getTime();
    const endAt = new Date(startAt.getTime() + durationMs);
    let reason: Reason | null = null;
    if (startAt < notBefore) reason = 'PAST';
    else if (
      !isOnSlotGrid(startAt) ||
      !(await isFreeSlot(series.coachId, durationMs / 60_000, startAt, booking.sessionId))
    ) {
      reason =
        isWholeDayOff(date, exceptions) || exceptions.some(e => e.date === date)
          ? 'EXCEPTION'
          : 'UNAVAILABLE';
    }
    items.push({booking, date, startAt, endAt, available: reason === null, reason});
  }
  return items;
}

const planDto = (item: PlanItem) => ({
  bookingId: item.booking.id as string,
  fromStartAt: item.booking.startAt.toISOString(),
  date: item.date,
  startAt: item.startAt.toISOString(),
  endAt: item.endAt.toISOString(),
  available: item.available,
  reason: item.reason,
});

export async function previewSeriesReschedule(
  client: UserDoc,
  seriesId: string,
  input: z.infer<typeof SeriesRescheduleBody>,
) {
  const series = await accessibleSeries(client, seriesId);
  return {items: (await reschedulePlan(series, input)).map(planDto)};
}

export async function rescheduleSeries(
  client: UserDoc,
  seriesId: string,
  input: z.infer<typeof SeriesRescheduleBody>,
) {
  const series = await accessibleSeries(client, seriesId);
  const plan = await reschedulePlan(series, input);
  const moved: BookingDoc[] = [];
  const kept: {bookingId: string; reason: string}[] = [];
  for (const item of plan) {
    if (!item.available) {
      kept.push({bookingId: item.booking.id as string, reason: item.reason ?? 'UNAVAILABLE'});
      continue;
    }
    try {
      moved.push(
        await rescheduleBooking(client, item.booking.id as string, {
          startAt: item.startAt.toISOString(),
        }),
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      kept.push({
        bookingId: item.booking.id as string,
        reason: error.code === 'SLOT_UNAVAILABLE' ? 'UNAVAILABLE' : error.code,
      });
    }
  }
  series.weekdays = input.weekdays;
  series.time = input.time;
  await series.save();
  return {moved: await toBookingDtos(moved, client._id), kept};
}

// ---------------------------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------------------------

async function extendInput(series: BookingSeriesDoc, weeks: number) {
  const bookings = await seriesBookings(series);
  const state = await seriesState(series, bookings);
  return {
    state,
    preview: {
      sessionTypeId: series.sessionTypeId.toString(),
      weekdays: series.weekdays,
      time: series.time,
      weeks,
      startDate: state.extendFrom,
      format: await seriesFormat(series, bookings),
    },
  };
}

export async function previewSeriesExtend(client: UserDoc, seriesId: string, weeks: number) {
  const series = await accessibleSeries(client, seriesId);
  const {state, preview} = await extendInput(series, weeks);
  if (!state.canExtend) throw new AppError('SERIES_NOT_EXTENDABLE');
  return {items: await previewSeries(preview)};
}

export async function extendSeries(
  client: UserDoc,
  seriesId: string,
  input: z.infer<typeof SeriesExtendBody>,
) {
  const series = await accessibleSeries(client, seriesId);
  await seriesType(series.sessionTypeId.toString()); // SESSION_TYPE_INACTIVE first
  const {state, preview} = await extendInput(series, input.weeks);
  if (!state.canExtend) throw new AppError('SERIES_NOT_EXTENDABLE');
  const items = await previewSeries(preview);
  assertDatesInPreview(input.dates, items);
  const result = await bookSeriesDates(client, series, items, {
    sessionTypeId: preview.sessionTypeId,
    dates: input.dates,
    useCredits: input.useCredits,
    format: preview.format,
    promoCode: input.promoCode,
  });
  series.weeks += input.weeks;
  await series.save();
  return {seriesId: series.id as string, ...result};
}
