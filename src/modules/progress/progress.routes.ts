import {route} from '../../lib/route.js';
import {IdParams, itemsOf} from '../../lib/schemas.js';
import {
  ClientIdParams,
  CoachClientProgressSchema,
  GoalBody,
  MeasurementBody,
  MeasurementSchema,
  MeasurementsQuery,
  ProgressQuery,
  ProgressSchema,
} from './progress.schemas.js';
import * as service from './progress.service.js';

const tags = ['Progress'];

route({
  method: 'get',
  path: '/me/progress',
  tags,
  summary:
    'My training stats: totals, this week, weekly chart, streak and goal (weeks start on Monday)',
  auth: 'client',
  query: ProgressQuery,
  response: ProgressSchema,
  handler: ({user, query}) => service.progressOf(user, query.weeks),
});

route({
  method: 'put',
  path: '/me/goal',
  tags,
  summary: 'Set (1-14) or remove (null) my weekly training goal',
  auth: 'client',
  status: 200,
  body: GoalBody,
  response: GoalBody,
  handler: ({user, body}) => service.setGoal(user, body.trainingsPerWeek),
});

route({
  method: 'get',
  path: '/me/measurements',
  tags,
  summary: 'My body measurements, newest first',
  auth: 'client',
  query: MeasurementsQuery,
  response: itemsOf(MeasurementSchema),
  handler: ({user, query}) => service.listMeasurements(user._id, query),
});

route({
  method: 'post',
  path: '/me/measurements',
  tags,
  summary: 'Save a measurement (201); the same type on the same day replaces the value (200)',
  auth: 'client',
  alsoStatus: 200,
  body: MeasurementBody,
  response: MeasurementSchema,
  handler: async ({user, body, setStatus}) => {
    const {created, measurement} = await service.saveMeasurement(user, body);
    if (!created) setStatus(200);
    return measurement;
  },
});

route({
  method: 'delete',
  path: '/me/measurements/:id',
  tags,
  summary: 'Delete a measurement',
  auth: 'client',
  status: 204,
  params: IdParams,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    await service.deleteMeasurement(user, params.id);
  },
});

const coachTags = ['Coach: clients'];

route({
  method: 'get',
  path: '/coach/clients/:clientId/progress',
  tags: coachTags,
  summary:
    "A client's progress with me (totals and weekly: my trainings only) and latest measurements",
  auth: 'coach',
  params: ClientIdParams,
  query: ProgressQuery,
  response: CoachClientProgressSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params, query}) =>
    service.coachClientProgress(user, params.clientId, query.weeks),
});

route({
  method: 'get',
  path: '/coach/clients/:clientId/measurements',
  tags: coachTags,
  summary: "A client's body measurements (clients share them with their coaches)",
  auth: 'coach',
  params: ClientIdParams,
  query: MeasurementsQuery,
  response: itemsOf(MeasurementSchema),
  errors: ['NOT_FOUND'],
  handler: async ({user, params, query}) =>
    service.listMeasurements((await service.coachClient(user, params.clientId))._id, query),
});
