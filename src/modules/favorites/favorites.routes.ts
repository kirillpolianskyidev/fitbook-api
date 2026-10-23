import {z} from 'zod';

import {route} from '../../lib/route.js';
import {itemsOf, objectId} from '../../lib/schemas.js';
import {CoachCardSchema} from '../coaches/coaches.schemas.js';
import * as coaches from '../coaches/coaches.service.js';

const tags = ['Favorites'];
const CoachIdParams = z.object({coachId: objectId});

route({
  method: 'get',
  path: '/me/favorites',
  tags,
  summary: 'My favorite coaches (most recently added first)',
  auth: 'client',
  response: itemsOf(CoachCardSchema),
  handler: ({user}) => coaches.listFavoriteCoaches(user),
});

route({
  method: 'put',
  path: '/me/favorites/:coachId',
  tags,
  summary: 'Add a coach to my favorites (idempotent)',
  auth: 'client',
  status: 204,
  params: CoachIdParams,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    await coaches.addFavorite(user, params.coachId);
  },
});

route({
  method: 'delete',
  path: '/me/favorites/:coachId',
  tags,
  summary: 'Remove a coach from my favorites (idempotent)',
  auth: 'client',
  status: 204,
  params: CoachIdParams,
  handler: async ({user, params}) => {
    await coaches.removeFavorite(user, params.coachId);
  },
});
