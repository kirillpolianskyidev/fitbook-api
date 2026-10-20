import {z} from 'zod';

import {isDbUp} from '../../db/connect.js';
import {route} from '../../lib/route.js';

route({
  method: 'get',
  path: '/health',
  tags: ['Service'],
  summary: 'Health check',
  auth: 'public',
  response: z.object({status: z.literal('ok'), db: z.enum(['up', 'down']), time: z.string()}),
  handler: () => ({
    status: 'ok' as const,
    db: isDbUp() ? ('up' as const) : ('down' as const),
    time: new Date().toISOString(),
  }),
});
