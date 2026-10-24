import {route} from '../../lib/route.js';
import {IdParams, itemsOf} from '../../lib/schemas.js';
import {ClientIdParams} from '../progress/progress.schemas.js';
import {
  AssignmentExerciseParams,
  AssignmentSchema,
  ClientNoteBody,
  CreateAssignmentBody,
  ExerciseResultBody,
  MyAssignmentsQuery,
  UpdateAssignmentBody,
} from './assignments.schemas.js';
import * as service from './assignments.service.js';

const coachTags = ['Coach: assignments'];

route({
  method: 'get',
  path: '/coach/clients/:clientId/assignments',
  tags: coachTags,
  summary: "A client's assignments from me, newest first",
  description: 'Only clients who have (or had) a booking with the coach, otherwise NOT_FOUND.',
  auth: 'coach',
  params: ClientIdParams,
  response: itemsOf(AssignmentSchema),
  errors: ['NOT_FOUND'],
  handler: ({user, params}) => service.listClientAssignments(user, params.clientId),
});

route({
  method: 'post',
  path: '/coach/clients/:clientId/assignments',
  tags: coachTags,
  summary: 'Give a client homework (Socket.IO `assignment:new` to the client)',
  auth: 'coach',
  params: ClientIdParams,
  body: CreateAssignmentBody,
  response: AssignmentSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params, body}) => service.createAssignment(user, params.clientId, body),
});

route({
  method: 'patch',
  path: '/coach/assignments/:id',
  tags: coachTags,
  summary: 'Edit an assignment',
  description:
    '`exercises` is the full new list: an item with an existing `id` is updated and keeps its result, an item ' +
    'without `id` is added, exercises missing from the list are removed.',
  auth: 'coach',
  params: IdParams,
  body: UpdateAssignmentBody,
  response: AssignmentSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params, body}) => service.updateAssignment(user, params.id, body),
});

route({
  method: 'delete',
  path: '/coach/assignments/:id',
  tags: coachTags,
  summary: 'Delete an assignment',
  auth: 'coach',
  status: 204,
  params: IdParams,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    await service.deleteAssignment(user, params.id);
  },
});

const clientTags = ['Assignments'];

route({
  method: 'get',
  path: '/me/assignments',
  tags: clientTags,
  summary: 'My assignments: nearest dueDate first, then without a date (newer first)',
  auth: 'client',
  query: MyAssignmentsQuery,
  response: itemsOf(AssignmentSchema),
  handler: ({user, query}) => service.myAssignments(user, query),
});

route({
  method: 'get',
  path: '/me/assignments/:id',
  tags: clientTags,
  summary: 'One of my assignments',
  auth: 'client',
  params: IdParams,
  response: AssignmentSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params}) => service.getMyAssignment(user, params.id),
});

route({
  method: 'put',
  path: '/me/assignments/:id/exercises/:exerciseId/result',
  tags: clientTags,
  summary:
    'Mark an exercise done / partial / skipped (Socket.IO `assignment:updated` to the coach)',
  auth: 'client',
  params: AssignmentExerciseParams,
  body: ExerciseResultBody,
  response: AssignmentSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params, body}) =>
    service.setExerciseResult(user, params.id, params.exerciseId, body),
});

route({
  method: 'delete',
  path: '/me/assignments/:id/exercises/:exerciseId/result',
  tags: clientTags,
  summary: 'Remove the mark of an exercise',
  auth: 'client',
  status: 200,
  params: AssignmentExerciseParams,
  response: AssignmentSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params}) => service.clearExerciseResult(user, params.id, params.exerciseId),
});

route({
  method: 'put',
  path: '/me/assignments/:id/note',
  tags: clientTags,
  summary: 'My note to the coach on the assignment (null removes it)',
  auth: 'client',
  params: IdParams,
  body: ClientNoteBody,
  response: AssignmentSchema,
  errors: ['NOT_FOUND'],
  handler: ({user, params, body}) => service.setClientNote(user, params.id, body.note),
});
