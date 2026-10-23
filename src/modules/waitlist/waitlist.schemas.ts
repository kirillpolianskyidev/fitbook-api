import {z} from 'zod';

import {MoneySchema} from '../../lib/schemas.js';
import {TrainingSessionSchema} from '../sessions/sessions.schemas.js';
import {UserSummarySchema} from '../users/users.schemas.js';

export const WaitlistStatusSchema = z
  .enum(['waiting', 'offered', 'booked', 'expired', 'left'])
  .meta({id: 'WaitlistStatus'});

export const WaitlistEntrySchema = z
  .object({
    id: z.string(),
    status: WaitlistStatusSchema,
    position: z
      .number()
      .int()
      .nullable()
      .meta({description: 'Place among the waiting entries (1 = next). null unless waiting'}),
    offerExpiresAt: z
      .string()
      .nullable()
      .meta({description: 'Until when the held place can be booked (status offered only)'}),
    joinedAt: z.string(),
    session: z.object({
      id: z.string(),
      title: z.string(),
      startAt: z.string(),
      endAt: z.string(),
      price: MoneySchema,
      coach: UserSummarySchema,
    }),
  })
  .meta({id: 'WaitlistEntry'});

export const SessionWaitlistSchema = z
  .object({
    count: z.number().int().meta({description: 'Waiting entries'}),
    myStatus: z.enum(['waiting', 'offered']).nullable(),
    myPosition: z.number().int().nullable(),
    offerExpiresAt: z.string().nullable(),
  })
  .meta({id: 'SessionWaitlist'});

export const GroupSessionSchema = TrainingSessionSchema.extend({
  waitlist: SessionWaitlistSchema,
}).meta({id: 'GroupSession'});
