import {z} from 'zod';

import {
  dateYMD,
  isoDateTime,
  LocationSchema,
  MoneySchema,
  objectId,
  SessionKindSchema,
  timeHHmm,
} from '../../lib/schemas.js';
import {UserSummarySchema} from '../users/users.schemas.js';

export const BookingStatusSchema = z
  .enum(['pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show'])
  .meta({id: 'BookingStatus'});

export const NoShowSchema = z
  .object({markedAt: z.string(), refunded: z.boolean()})
  .meta({id: 'NoShow'});

/** No-show fields shared by Booking and Participant. */
export const NoShowFields = {
  noShow: NoShowSchema.nullable().meta({
    description: 'Set when the coach marked the client as a no-show',
  }),
  noShowMarkable: z.boolean().meta({
    description: 'The coach making the request can mark a no-show now (always false for clients)',
  }),
  noShowUndoable: z.boolean().meta({
    description: 'The coach can remove the no-show now (inside the window and not refunded)',
  }),
  noShowDeadline: z.string().meta({description: 'startAt + 48h: end of the no-show window'}),
};

export const NoShowBody = z
  .object({
    refund: z.boolean().meta({
      description:
        'true: full refund like a coach cancellation (credit back for credit bookings); false: the payment stays',
    }),
  })
  .meta({id: 'NoShowRequest'});

export const PaymentSchema = z
  .object({
    status: z.enum(['unpaid', 'paid', 'refunded', 'not_required']).meta({
      description:
        'refunded: a paid booking was cancelled (by the client before the deadline, by the coach or by the ' +
        'system) and the full price was returned.',
    }),
    method: z.enum(['mock', 'credits']).meta({
      description: 'mock: (mock) card payment; credits: paid with 1 credit of a package',
    }),
    paidAt: z.string().nullable(),
    clientPackageId: z
      .string()
      .nullable()
      .meta({description: 'Purchase the credit came from (method = credits), otherwise null'}),
    refundedAt: z.string().nullable().meta({description: 'When the full price was returned'}),
  })
  .meta({id: 'Payment'});

export const BookingSchema = z
  .object({
    id: z.string(),
    status: BookingStatusSchema,
    isTrial: z.boolean(),
    price: MoneySchema,
    payment: PaymentSchema,
    expiresAt: z
      .string()
      .nullable()
      .meta({description: 'Unpaid bookings are released at this time'}),
    startAt: z.string(),
    endAt: z.string(),
    seriesId: z.string().nullable(),
    cancellable: z.boolean().meta({description: 'Whether the client can still cancel right now'}),
    reschedulable: z.boolean().meta({
      description:
        'Whether the current user (the client of the booking) can move it to another time right now',
    }),
    rescheduledAt: z
      .string()
      .nullable()
      .meta({description: 'When the booking was last rescheduled'}),
    ...NoShowFields,
    cancelDeadline: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    cancelledBy: z.enum(['coach', 'client', 'system']).nullable(),
    cancelReason: z.string().nullable(),
    session: z.object({
      id: z.string(),
      sessionTypeId: z.string().meta({description: 'Training type of the session ("Book again")'}),
      title: z.string(),
      kind: SessionKindSchema,
      location: LocationSchema.nullable(),
      capacity: z.number().int(),
      participantsCount: z.number().int(),
    }),
    coach: UserSummarySchema,
    client: UserSummarySchema,
    notesCount: z.number().int(),
    createdAt: z.string(),
  })
  .meta({id: 'Booking'});

const useCredits = z.boolean().default(false).meta({
  description: 'Pay with 1 credit of a package of this coach: the booking is confirmed immediately',
});
const notTrialWithCredits = {
  message: 'useCredits cannot be combined with isTrial',
  path: ['useCredits'],
};

const IndividualBookingBody = z
  .object({
    sessionTypeId: objectId,
    startAt: isoDateTime,
    isTrial: z.boolean().default(false),
    useCredits,
    location: LocationSchema.optional().meta({
      description: 'Overrides the training location (optional)',
    }),
  })
  .refine(body => !(body.isTrial && body.useCredits), notTrialWithCredits)
  .meta({id: 'IndividualBookingRequest'});

const GroupBookingBody = z
  .object({
    sessionId: objectId,
    isTrial: z.boolean().optional().meta({description: 'Not allowed for group sessions'}),
    useCredits,
  })
  .refine(body => !(body.isTrial && body.useCredits), notTrialWithCredits)
  .meta({id: 'GroupBookingRequest'});

export const CreateBookingBody = z.union([IndividualBookingBody, GroupBookingBody]);

export const SeriesPreviewBody = z.object({
  sessionTypeId: objectId,
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .refine(days => new Set(days).size === days.length, 'Weekdays must be unique')
    .meta({description: '0 = Sunday ... 6 = Saturday'}),
  time: timeHHmm.meta({description: "Start time in the coach's time zone"}),
  weeks: z.number().int().min(1).max(12),
  startDate: dateYMD,
});

export const SeriesBody = SeriesPreviewBody.extend({
  dates: z.array(dateYMD).min(1).max(84).meta({description: 'Dates chosen from the preview'}),
  useCredits: z.boolean().default(false).meta({
    description:
      '1 credit per booked date; all bookings confirmed. Not enough credits -> INSUFFICIENT_CREDITS, nothing booked',
  }),
});

export const SeriesPreviewItemSchema = z
  .object({
    date: z.string(),
    startAt: z.string(),
    endAt: z.string(),
    available: z.boolean(),
    reason: z.enum(['UNAVAILABLE', 'PAST', 'EXCEPTION']).optional(),
  })
  .meta({id: 'SeriesPreviewItem'});

export const SeriesResultSchema = z
  .object({
    seriesId: z.string(),
    bookings: z.array(BookingSchema),
    skipped: z.array(
      z.object({date: z.string(), reason: z.enum(['UNAVAILABLE', 'PAST', 'EXCEPTION'])}),
    ),
  })
  .meta({id: 'SeriesResult'});

export const BookingListQuery = z.object({
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
  status: BookingStatusSchema.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const RescheduleBody = z
  .object({
    startAt: isoDateTime
      .optional()
      .meta({description: 'Individual bookings: the new start (a free slot of the same type)'}),
    sessionId: objectId
      .optional()
      .meta({description: 'Group bookings: another upcoming group session of the same type'}),
  })
  .refine(body => (body.startAt === undefined) !== (body.sessionId === undefined), {
    message: 'Send exactly one of startAt (individual) or sessionId (group)',
    path: ['startAt'],
  })
  .meta({id: 'RescheduleRequest'});

export const CancelBody = z.object({reason: z.string().trim().max(300).optional()});
export const CoachCancelBody = z.object({reason: z.string().trim().min(1).max(300)});

export const CalendarEventSchema = z
  .object({
    title: z.string(),
    startAt: z.string(),
    endAt: z.string(),
    timezone: z.string(),
    location: z
      .object({name: z.string(), address: z.string(), lat: z.number(), lng: z.number()})
      .nullable(),
    notes: z.string(),
  })
  .meta({id: 'CalendarEvent', description: 'Data for adding the training to the device calendar'});

export type BookingDto = z.input<typeof BookingSchema>;
