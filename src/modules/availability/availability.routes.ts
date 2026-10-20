import {route} from '../../lib/route.js';
import {
  AvailabilitySchema,
  DateParams,
  ExceptionSchema,
  PutWeeklyBody,
} from './availability.schemas.js';
import * as service from './availability.service.js';

const tags = ['Coach: availability'];

route({
  method: 'get',
  path: '/coach/availability',
  tags,
  summary: 'My weekly working hours and exceptions (times are local to my time zone)',
  auth: 'coach',
  response: AvailabilitySchema,
  handler: ({user}) => service.getAvailability(user),
});

route({
  method: 'put',
  path: '/coach/availability',
  tags,
  summary: 'Replace weekly working hours',
  auth: 'coach',
  body: PutWeeklyBody,
  response: AvailabilitySchema,
  handler: ({user, body}) => service.setWeekly(user, body.weekly),
});

route({
  method: 'post',
  path: '/coach/availability/exceptions',
  tags,
  summary: 'Add or replace an exception for a date (no start/end = whole day off)',
  auth: 'coach',
  status: 200,
  body: ExceptionSchema,
  response: AvailabilitySchema,
  handler: ({user, body}) => service.addException(user, body),
});

route({
  method: 'delete',
  path: '/coach/availability/exceptions/:date',
  tags,
  summary: 'Remove the exception of a date',
  auth: 'coach',
  params: DateParams,
  response: AvailabilitySchema,
  handler: ({user, params}) => service.removeException(user, params.date),
});
