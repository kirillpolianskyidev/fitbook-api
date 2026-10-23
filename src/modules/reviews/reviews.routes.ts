import {route} from '../../lib/route.js';
import {IdParams} from '../../lib/schemas.js';
import {MyReviewSchema, ReviewBody, ReviewListQuery, ReviewPageSchema} from './reviews.schemas.js';
import * as service from './reviews.service.js';

const tags = ['Reviews'];

route({
  method: 'get',
  path: '/coaches/:id/reviews',
  tags,
  summary: 'Reviews of a coach, newest first, with a rating summary',
  auth: 'user',
  params: IdParams,
  query: ReviewListQuery,
  response: ReviewPageSchema,
  errors: ['NOT_FOUND'],
  handler: ({params, query}) => service.listReviews(params.id, query),
});

route({
  method: 'get',
  path: '/coaches/:id/my-review',
  tags,
  summary: 'My review of the coach and what I can do with it',
  auth: 'client',
  params: IdParams,
  response: MyReviewSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params}) => service.getMyReview(user, params.id),
});

route({
  method: 'put',
  path: '/coaches/:id/my-review',
  tags,
  summary: 'Create (201) or update (200) my review of the coach',
  description:
    'One review per client per coach. Creating needs at least one completed training with the coach ' +
    '(REVIEW_NOT_ALLOWED). It can be changed during 24 hours after creation (REVIEW_EDIT_WINDOW_PASSED), ' +
    'not deleted. Coach rating is recalculated from the reviews.',
  auth: 'client',
  status: 200,
  alsoStatus: 201,
  params: IdParams,
  body: ReviewBody,
  response: MyReviewSchema,
  errors: ['NOT_FOUND', 'REVIEW_NOT_ALLOWED', 'REVIEW_EDIT_WINDOW_PASSED'],
  handler: async ({user, params, body, setStatus}) => {
    const {created, result} = await service.putMyReview(user, params.id, body);
    if (created) setStatus(201);
    return result;
  },
});
