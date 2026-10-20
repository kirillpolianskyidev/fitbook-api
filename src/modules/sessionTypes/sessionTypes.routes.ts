import {route} from '../../lib/route.js';
import {IdParams, itemsOf} from '../../lib/schemas.js';
import {
  CreateSessionTypeBody,
  SessionTypeSchema,
  UpdateSessionTypeBody,
} from './sessionTypes.schemas.js';
import * as service from './sessionTypes.service.js';

const tags = ['Coach: training types'];

route({
  method: 'get',
  path: '/coach/session-types',
  tags,
  summary: 'My training types (individual and group, with prices)',
  auth: 'coach',
  response: itemsOf(SessionTypeSchema),
  handler: async ({user}) => ({
    items: (await service.listOwnSessionTypes(user._id)).map(service.toSessionTypeDto),
  }),
});

route({
  method: 'post',
  path: '/coach/session-types',
  tags,
  summary: 'Create a training type',
  auth: 'coach',
  body: CreateSessionTypeBody,
  response: SessionTypeSchema,
  handler: async ({user, body}) =>
    service.toSessionTypeDto(await service.createSessionType(user._id, body)),
});

route({
  method: 'patch',
  path: '/coach/session-types/:id',
  tags,
  summary: 'Update a training type (price, title, duration, capacity, location, active)',
  description: 'Existing bookings keep the price they were booked with.',
  auth: 'coach',
  params: IdParams,
  body: UpdateSessionTypeBody,
  response: SessionTypeSchema,
  errors: ['NOT_FOUND'],
  handler: async ({user, params, body}) =>
    service.toSessionTypeDto(await service.updateSessionType(user._id, params.id, body)),
});

route({
  method: 'delete',
  path: '/coach/session-types/:id',
  tags,
  summary: 'Delete a training type (deactivated instead if it was already used)',
  auth: 'coach',
  status: 204,
  params: IdParams,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    await service.deleteSessionType(user._id, params.id);
  },
});
