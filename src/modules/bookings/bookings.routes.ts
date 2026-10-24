import {z} from 'zod';

import {route} from '../../lib/route.js';
import {IdParams, pageOf} from '../../lib/schemas.js';
import {
  BookingListQuery,
  BookingSchema,
  CalendarEventSchema,
  CancelBody,
  CoachCancelBody,
  CreateBookingBody,
  NoShowBody,
  RescheduleBody,
  SeriesBody,
  SeriesCancelResultSchema,
  SeriesExtendBody,
  SeriesExtendPreviewBody,
  SeriesReschedulePreviewSchema,
  SeriesRescheduleBody,
  SeriesRescheduleResultSchema,
  SeriesSchema,
  SeriesPreviewBody,
  SeriesPreviewItemSchema,
  SeriesResultSchema,
} from './bookings.schemas.js';
import {promoErrors} from '../promos/promos.schemas.js';
import * as service from './bookings.service.js';
import {markNoShow, undoNoShow} from './noShow.js';
import * as seriesService from './series.service.js';

const tags = ['Bookings'];

route({
  method: 'post',
  path: '/bookings',
  tags,
  summary: 'Book an individual training (optionally the free trial) or join a group session',
  description:
    'Individual: `{sessionTypeId, startAt, isTrial?, useCredits?, location?}`. Group: `{sessionId, useCredits?}`. ' +
    'Paid bookings start as `pending_payment` and are released if not paid in time; the free trial and bookings ' +
    'paid with a credit (`useCredits: true`, NO_CREDITS if none) are confirmed immediately.',
  auth: 'client',
  body: CreateBookingBody,
  response: BookingSchema,
  errors: [
    'NOT_FOUND',
    'SLOT_UNAVAILABLE',
    'SESSION_FULL',
    'ALREADY_BOOKED',
    'TRIAL_ALREADY_USED',
    'TRIAL_NOT_ALLOWED',
    'SESSION_TYPE_INACTIVE',
    'NO_CREDITS',
    ...promoErrors,
  ],
  handler: async ({user, body}) => {
    const booking =
      'sessionId' in body
        ? await service.joinGroupSession(
            user,
            body.sessionId,
            body.isTrial,
            body.useCredits,
            body.promoCode,
          )
        : await service.createIndividualBooking(user, body);
    return service.toBookingDto(booking);
  },
});

route({
  method: 'post',
  path: '/bookings/series/preview',
  tags,
  summary: 'Preview a recurring series: which dates are free',
  auth: 'client',
  status: 200,
  body: SeriesPreviewBody,
  response: z.object({items: z.array(SeriesPreviewItemSchema)}),
  errors: ['NOT_FOUND', 'SESSION_TYPE_INACTIVE'],
  handler: async ({body}) => ({items: await service.previewSeries(body)}),
});

route({
  method: 'post',
  path: '/bookings/series',
  tags,
  summary: 'Book the chosen dates of a recurring series (taken dates are skipped)',
  auth: 'client',
  body: SeriesBody,
  response: SeriesResultSchema,
  errors: ['NOT_FOUND', 'SESSION_TYPE_INACTIVE', 'INSUFFICIENT_CREDITS', ...promoErrors],
  handler: ({user, body}) => service.createSeries(user, body),
});

route({
  method: 'post',
  path: '/bookings/series/:id/pay',
  tags,
  summary: 'Pay all pending bookings of a series (mock payment)',
  auth: 'client',
  status: 200,
  params: IdParams,
  response: z.object({bookings: z.array(BookingSchema), paidCount: z.number().int()}),
  errors: ['NOT_FOUND', 'BOOKING_NOT_PAYABLE'],
  handler: ({user, params}) => service.paySeries(user, params.id),
});

route({
  method: 'get',
  path: '/bookings',
  tags,
  summary: 'My bookings for the calendar: upcoming (ascending) or past (descending)',
  auth: 'client',
  query: BookingListQuery,
  response: pageOf(BookingSchema),
  handler: ({user, query}) => service.listClientBookings(user, query),
});

route({
  method: 'get',
  path: '/bookings/:id',
  tags,
  summary: 'Booking details (client or coach of the booking)',
  auth: 'user',
  params: IdParams,
  response: BookingSchema,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) =>
    service.toBookingDto(await service.getBookingForParticipant(user, params.id), user._id),
});

route({
  method: 'post',
  path: '/bookings/:id/pay',
  tags,
  summary: 'Pay a pending booking (mock payment)',
  auth: 'client',
  status: 200,
  params: IdParams,
  response: BookingSchema,
  errors: ['NOT_FOUND', 'BOOKING_NOT_PAYABLE'],
  handler: async ({user, params}) =>
    service.toBookingDto(await service.payBooking(user, params.id)),
});

route({
  method: 'post',
  path: '/bookings/:id/cancel',
  tags,
  summary:
    "Cancel my booking (confirmed bookings only within the coach's free-cancellation window)",
  auth: 'client',
  status: 200,
  params: IdParams,
  body: CancelBody,
  response: BookingSchema,
  errors: ['NOT_FOUND', 'CANCELLATION_WINDOW_PASSED'],
  handler: async ({user, params, body}) =>
    service.toBookingDto(await service.cancelByClient(user, params.id, body.reason)),
});

route({
  method: 'post',
  path: '/bookings/:id/reschedule',
  tags,
  summary: 'Move my booking to another time (individual) or another group session (group)',
  description:
    'Individual: `{startAt}` - a free slot of the same training type (as returned by /coaches/:id/slots; the ' +
    "booking's own slot does not block it). Group: `{sessionId}` - another upcoming group session of the same " +
    'type with free places. Allowed while `reschedulable` (same window as cancelling). Payment, trial, price, ' +
    'notes, location and series stay; the old slot / place is released.',
  auth: 'client',
  status: 200,
  params: IdParams,
  body: RescheduleBody,
  response: BookingSchema,
  errors: [
    'FORBIDDEN',
    'NOT_FOUND',
    'RESCHEDULE_WINDOW_PASSED',
    'SLOT_UNAVAILABLE',
    'SESSION_FULL',
    'ALREADY_BOOKED',
  ],
  handler: async ({user, params, body}) =>
    service.toBookingDto(await service.rescheduleBooking(user, params.id, body), user._id),
});

route({
  method: 'get',
  path: '/bookings/:id/calendar-event',
  tags,
  summary: 'Event data for adding the training to the device calendar',
  auth: 'user',
  params: IdParams,
  response: CalendarEventSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params}) => service.calendarEvent(user, params.id),
});

route({
  method: 'post',
  path: '/coach/bookings/:id/cancel',
  tags: ['Coach: schedule'],
  summary: 'Cancel a booking of mine with a reason (any time before the start)',
  auth: 'coach',
  status: 200,
  params: IdParams,
  body: CoachCancelBody,
  response: BookingSchema,
  errors: ['NOT_FOUND', 'CANCELLATION_WINDOW_PASSED'],
  handler: async ({user, params, body}) =>
    service.toBookingDto(await service.cancelByCoach(user, params.id, body.reason), user._id),
});

route({
  method: 'post',
  path: '/coach/bookings/:id/no-show',
  tags: ['Coach: schedule'],
  summary: 'Mark the client as a no-show (from the start until 48 hours later)',
  description:
    '`refund: true` returns the payment like a coach cancellation (a credit goes back to its package); ' +
    '`refund: false` keeps it. Ignored for trial / free bookings. Group sessions: per participant booking.',
  auth: 'coach',
  status: 200,
  params: IdParams,
  body: NoShowBody,
  response: BookingSchema,
  errors: ['NOT_FOUND', 'FORBIDDEN', 'NO_SHOW_WINDOW_PASSED', 'NO_SHOW_NOT_ALLOWED'],
  handler: async ({user, params, body}) =>
    service.toBookingDto(await markNoShow(user, params.id, body.refund), user._id),
});

route({
  method: 'delete',
  path: '/coach/bookings/:id/no-show',
  tags: ['Coach: schedule'],
  summary: 'Remove a no-show (only without a refund, inside the 48-hour window)',
  auth: 'coach',
  status: 200,
  params: IdParams,
  response: BookingSchema,
  errors: [
    'NOT_FOUND',
    'FORBIDDEN',
    'NO_SHOW_WINDOW_PASSED',
    'NO_SHOW_NOT_ALLOWED',
    'NO_SHOW_REFUNDED',
  ],
  handler: async ({user, params}) =>
    service.toBookingDto(await undoNoShow(user, params.id), user._id),
});

const seriesTags = ['Bookings: series'];

route({
  method: 'get',
  path: '/bookings/series/:id',
  tags: seriesTags,
  summary:
    'A recurring series: pattern, all bookings, upcoming count and whether it can be extended',
  auth: 'user',
  params: IdParams,
  response: SeriesSchema,
  errors: ['NOT_FOUND', 'FORBIDDEN'],
  handler: ({user, params}) => seriesService.getSeries(user, params.id),
});

route({
  method: 'post',
  path: '/bookings/series/:id/cancel',
  tags: seriesTags,
  summary: 'Cancel every upcoming booking of the series (same rules as one cancellation)',
  description: 'Bookings past their deadline are kept and listed in `kept`. None cancelled -> 409.',
  auth: 'client',
  status: 200,
  params: IdParams,
  body: CancelBody,
  response: SeriesCancelResultSchema,
  errors: ['NOT_FOUND', 'FORBIDDEN', 'CANCELLATION_WINDOW_PASSED'],
  handler: ({user, params, body}) => seriesService.cancelSeries(user, params.id, body.reason),
});

route({
  method: 'post',
  path: '/bookings/series/:id/reschedule/preview',
  tags: seriesTags,
  summary: 'Preview moving all movable upcoming bookings to new weekdays / time',
  description:
    'Movable bookings (reschedulable, by start) are paired in order with the first dates of the new pattern from ' +
    '`startDate`. No movable booking -> RESCHEDULE_WINDOW_PASSED.',
  auth: 'client',
  status: 200,
  params: IdParams,
  body: SeriesRescheduleBody,
  response: SeriesReschedulePreviewSchema,
  errors: ['NOT_FOUND', 'FORBIDDEN', 'RESCHEDULE_WINDOW_PASSED'],
  handler: ({user, params, body}) => seriesService.previewSeriesReschedule(user, params.id, body),
});

route({
  method: 'post',
  path: '/bookings/series/:id/reschedule',
  tags: seriesTags,
  summary: 'Move all movable upcoming bookings to new weekdays / time (taken dates stay unchanged)',
  auth: 'client',
  status: 200,
  params: IdParams,
  body: SeriesRescheduleBody,
  response: SeriesRescheduleResultSchema,
  errors: ['NOT_FOUND', 'FORBIDDEN', 'RESCHEDULE_WINDOW_PASSED'],
  handler: ({user, params, body}) => seriesService.rescheduleSeries(user, params.id, body),
});

route({
  method: 'post',
  path: '/bookings/series/:id/extend/preview',
  tags: seriesTags,
  summary:
    'Preview extending the series by N weeks from extendFrom (same format as the series preview)',
  auth: 'client',
  status: 200,
  params: IdParams,
  body: SeriesExtendPreviewBody,
  response: z.object({items: z.array(SeriesPreviewItemSchema)}),
  errors: ['NOT_FOUND', 'FORBIDDEN', 'SERIES_NOT_EXTENDABLE'],
  handler: async ({user, params, body}) =>
    seriesService.previewSeriesExtend(user, params.id, body.weeks),
});

route({
  method: 'post',
  path: '/bookings/series/:id/extend',
  tags: seriesTags,
  summary: 'Extend the series: book the chosen dates into the same series',
  description:
    'Like POST /bookings/series: new bookings are pending_payment (pay with /bookings/series/:id/pay) or ' +
    'confirmed with useCredits.',
  auth: 'client',
  params: IdParams,
  body: SeriesExtendBody,
  response: SeriesResultSchema,
  errors: [
    'NOT_FOUND',
    'FORBIDDEN',
    'SERIES_NOT_EXTENDABLE',
    'SESSION_TYPE_INACTIVE',
    'INSUFFICIENT_CREDITS',
    ...promoErrors,
  ],
  handler: ({user, params, body}) => seriesService.extendSeries(user, params.id, body),
});
