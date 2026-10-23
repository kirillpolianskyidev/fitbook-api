import {route} from '../../lib/route.js';
import {IdParams, itemsOf} from '../../lib/schemas.js';
import {registerJob} from '../../jobs/index.js';
import {WaitlistEntrySchema} from './waitlist.schemas.js';
import * as service from './waitlist.service.js';

const tags = ['Waitlist'];

route({
  method: 'post',
  path: '/group-sessions/:id/waitlist',
  tags,
  summary: 'Join the waitlist of a full upcoming group session',
  description:
    'When a place frees up it is held for the first waiting client until min(now + 2h, start - 15 min) ' +
    '(`status: offered`, Socket.IO `waitlist:offered`); they book it with the usual POST /bookings { sessionId }.',
  auth: 'client',
  params: IdParams,
  response: WaitlistEntrySchema,
  errors: ['NOT_FOUND', 'SESSION_NOT_FULL', 'ALREADY_BOOKED', 'ALREADY_ON_WAITLIST'],
  handler: ({user, params}) => service.joinWaitlist(user, params.id),
});

route({
  method: 'delete',
  path: '/group-sessions/:id/waitlist',
  tags,
  summary: 'Leave the waitlist (an offer passes to the next client)',
  auth: 'client',
  status: 204,
  params: IdParams,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    await service.leaveWaitlist(user, params.id);
  },
});

route({
  method: 'get',
  path: '/me/waitlist',
  tags,
  summary: 'My waiting and offered waitlist entries (offers first, then by session start)',
  auth: 'client',
  response: itemsOf(WaitlistEntrySchema),
  handler: ({user}) => service.myWaitlist(user),
});

registerJob({name: 'sweepWaitlists', everyMs: 60_000, run: () => service.sweepWaitlists()});
