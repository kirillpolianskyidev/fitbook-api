import {route} from '../../lib/route.js';
import {IdParams, itemsOf, pageOf} from '../../lib/schemas.js';
import {
  RangeQuery,
  SlotSchema,
  SlotsQuery,
  TrainingSessionSchema,
} from '../sessions/sessions.schemas.js';
import {
  CancellationPolicySchema,
  CoachCardSchema,
  CoachDetailsSchema,
  CoachListQuery,
  CoachProfileSchema,
  PublishBody,
  UpdateCoachProfileBody,
} from './coaches.schemas.js';
import * as service from './coaches.service.js';

route({
  method: 'get',
  path: '/coaches',
  tags: ['Coaches'],
  summary: 'Coach catalog (published coaches; my state first unless a state filter is given)',
  auth: 'user',
  query: CoachListQuery,
  response: pageOf(CoachCardSchema),
  handler: ({user, query}) => service.listCoaches(user, query),
});

route({
  method: 'get',
  path: '/coaches/:id',
  tags: ['Coaches'],
  summary: 'Coach profile: bio, experience, certifications, highlights, training types and prices',
  auth: 'user',
  params: IdParams,
  response: CoachDetailsSchema,
  errors: ['NOT_FOUND'],
  handler: ({params}) => service.getCoachDetails(params.id),
});

route({
  method: 'get',
  path: '/coaches/:id/slots',
  tags: ['Coaches'],
  summary: 'Free start times for an individual training type (range up to 31 days)',
  auth: 'client',
  params: IdParams,
  query: SlotsQuery,
  response: itemsOf(SlotSchema),
  errors: ['NOT_FOUND', 'SESSION_TYPE_INACTIVE'],
  handler: ({params, query}) =>
    service.getCoachSlots(params.id, query.sessionTypeId, new Date(query.from), new Date(query.to)),
});

route({
  method: 'get',
  path: '/coaches/:id/group-sessions',
  tags: ['Coaches'],
  summary: 'Upcoming group sessions of a coach with spots left',
  auth: 'client',
  params: IdParams,
  query: RangeQuery,
  response: itemsOf(TrainingSessionSchema),
  errors: ['NOT_FOUND'],
  handler: ({params, query}) =>
    service.getCoachGroupSessions(params.id, new Date(query.from), new Date(query.to)),
});

const coachTags = ['Coach: profile'];

route({
  method: 'get',
  path: '/coach/profile',
  tags: coachTags,
  summary: 'My coach profile with completeness',
  auth: 'coach',
  response: CoachProfileSchema,
  handler: ({user}) => service.getMyProfile(user),
});

route({
  method: 'put',
  path: '/coach/profile',
  tags: coachTags,
  summary: 'Update my coach profile (unpublishes automatically if it becomes incomplete)',
  auth: 'coach',
  body: UpdateCoachProfileBody,
  response: CoachProfileSchema,
  handler: ({user, body}) => service.updateMyProfile(user, body),
});

route({
  method: 'post',
  path: '/coach/profile/publish',
  tags: coachTags,
  summary: 'Publish or hide my profile in the catalog',
  auth: 'coach',
  status: 200,
  body: PublishBody,
  response: CoachProfileSchema,
  errors: ['PROFILE_INCOMPLETE'],
  handler: ({user, body}) => service.setPublished(user, body.isPublished),
});

route({
  method: 'put',
  path: '/coach/settings/cancellation',
  tags: coachTags,
  summary: 'Set how many hours before a training clients can still cancel',
  auth: 'coach',
  body: CancellationPolicySchema,
  response: CoachProfileSchema,
  handler: ({user, body}) => service.setCancellationPolicy(user, body.freeCancelHours),
});
