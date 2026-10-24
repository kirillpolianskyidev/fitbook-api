import {z} from 'zod';

import {route} from '../../lib/route.js';
import {IdParams, isoDateTime, itemsOf, objectId} from '../../lib/schemas.js';
import {BookingStatusSchema, NoShowFields} from '../bookings/bookings.schemas.js';
import {UserSummarySchema} from '../users/users.schemas.js';
import * as service from './coachSessions.service.js';
import {TrainingSessionSchema, withRange} from './sessions.schemas.js';

const tags = ['Coach: schedule'];

const ParticipantSchema = z
  .object({
    bookingId: z.string(),
    status: BookingStatusSchema,
    isTrial: z.boolean(),
    ...NoShowFields,
    client: UserSummarySchema,
    notesCount: z.number().int(),
  })
  .meta({id: 'Participant'});

const ScheduleItemSchema = z
  .object({session: TrainingSessionSchema, participants: z.array(ParticipantSchema)})
  .meta({id: 'ScheduleItem'});

route({
  method: 'post',
  path: '/coach/group-sessions',
  tags,
  summary: 'Schedule a group session, optionally repeating on weekdays for N weeks',
  auth: 'coach',
  body: z.object({
    sessionTypeId: objectId,
    startAt: isoDateTime,
    repeat: z
      .object({
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        weeks: z.number().int().min(1).max(12),
      })
      .optional(),
  }),
  response: z.object({
    created: z.array(TrainingSessionSchema),
    skipped: z.array(z.object({startAt: z.string(), reason: z.literal('SLOT_UNAVAILABLE')})),
  }),
  errors: ['NOT_FOUND', 'SESSION_TYPE_INACTIVE'],
  handler: ({user, body}) => service.createGroupSessions(user, body),
});

route({
  method: 'post',
  path: '/coach/group-sessions/:id/cancel',
  tags,
  summary: 'Cancel an upcoming group session and all its bookings',
  auth: 'coach',
  status: 200,
  params: IdParams,
  body: z.object({reason: z.string().trim().min(1).max(300)}),
  response: TrainingSessionSchema,
  errors: ['NOT_FOUND', 'CANCELLATION_WINDOW_PASSED'],
  handler: ({user, params, body}) => service.cancelGroupSession(user, params.id, body.reason),
});

route({
  method: 'get',
  path: '/coach/schedule',
  tags,
  summary: 'My work calendar: sessions with participants in a range (up to 62 days)',
  auth: 'coach',
  query: withRange(
    z.object({
      from: isoDateTime,
      to: isoDateTime,
      includeCancelled: z
        .enum(['true', 'false'])
        .default('false')
        .transform(v => v === 'true'),
    }),
    62,
  ),
  response: itemsOf(ScheduleItemSchema),
  handler: ({user, query}) =>
    service.coachSchedule(user, new Date(query.from), new Date(query.to), query.includeCancelled),
});

route({
  method: 'get',
  path: '/coach/sessions/:id',
  tags,
  summary: 'One session with its participants',
  auth: 'coach',
  params: IdParams,
  response: ScheduleItemSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params}) => service.coachSessionDetails(user, params.id),
});

route({
  method: 'get',
  path: '/coach/clients',
  tags,
  summary: 'Clients who booked with me',
  description:
    'Sorted: clients with nextBookingAt (soonest first), then without it by lastTrainedAt (latest first), ' +
    'then the rest by firstName, lastName. Clients with only cancelled bookings are not listed.',
  auth: 'coach',
  query: z.object({search: z.string().trim().max(80).optional()}),
  response: itemsOf(
    UserSummarySchema.extend({
      totalBookings: z.number().int(),
      lastBookingAt: z.string().nullable().meta({
        description:
          'Latest startAt of any non-cancelled booking (may be in the future; kept for old apps)',
      }),
      nextBookingAt: z.string().nullable().meta({
        description: 'Nearest upcoming startAt of a pending_payment / confirmed booking',
      }),
      lastTrainedAt: z.string().nullable().meta({
        description: 'Latest started (startAt <= now) confirmed / completed booking',
      }),
    }).meta({
      id: 'CoachClient',
    }),
  ),
  handler: ({user, query}) => service.coachClients(user, query.search),
});
