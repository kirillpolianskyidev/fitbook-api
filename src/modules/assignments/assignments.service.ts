import {Types} from 'mongoose';
import type {z} from 'zod';

import {AppError} from '../../lib/errors.js';
import {AssignmentModel, type AssignmentDoc} from '../../models/assignment.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {emitToUsers} from '../../realtime/socket.js';
import {coachClient} from '../progress/progress.service.js';
import {toUserSummary} from '../users/users.service.js';
import type {
  CreateAssignmentBody,
  ExerciseResultBody,
  MyAssignmentsQuery,
  UpdateAssignmentBody,
} from './assignments.schemas.js';

type Status = 'open' | 'in_progress' | 'done' | 'partial';
type Result = {status: 'done' | 'partial' | 'skipped'; note?: string | null; updatedAt: Date};
type Exercise = {
  _id: Types.ObjectId;
  name: string;
  sets?: number | null;
  reps?: string | null;
  duration?: string | null;
  note?: string | null;
  videoUrl?: string | null;
  result?: Result | null;
};

const exercisesOf = (assignment: AssignmentDoc) => assignment.exercises as unknown as Exercise[];

export function progressOf(exercises: Exercise[]) {
  const count = (status: Result['status']) =>
    exercises.filter(e => e.result?.status === status).length;
  const progress = {
    done: count('done'),
    partial: count('partial'),
    skipped: count('skipped'),
    total: exercises.length,
  };
  const marked = progress.done + progress.partial + progress.skipped;
  const status: Status =
    marked === 0
      ? 'open'
      : marked < progress.total
        ? 'in_progress'
        : progress.done === progress.total
          ? 'done'
          : 'partial';
  return {status, progress};
}

export async function toAssignmentDtos(assignments: AssignmentDoc[]) {
  const ids = [...new Set(assignments.flatMap(a => [a.coachId.toString(), a.clientId.toString()]))];
  const users = await UserModel.find({_id: {$in: ids}})
    .select('firstName lastName avatarUrl')
    .lean();
  const byId = new Map(users.map(u => [u._id.toString(), u]));
  const summary = (id: Types.ObjectId) => {
    const user = byId.get(id.toString());
    return user
      ? toUserSummary(user)
      : {id: id.toString(), firstName: '', lastName: '', avatarUrl: null};
  };
  return assignments.map(a => {
    const exercises = exercisesOf(a);
    return {
      id: a.id as string,
      coach: summary(a.coachId),
      client: summary(a.clientId),
      title: a.title,
      note: a.note ?? null,
      dueDate: a.dueDate ?? null,
      exercises: exercises.map(e => ({
        id: e._id.toString(),
        name: e.name,
        sets: e.sets ?? null,
        reps: e.reps ?? null,
        duration: e.duration ?? null,
        note: e.note ?? null,
        videoUrl: e.videoUrl ?? null,
        result: e.result
          ? {
              status: e.result.status,
              note: e.result.note ?? null,
              updatedAt: e.result.updatedAt.toISOString(),
            }
          : null,
      })),
      ...progressOf(exercises),
      clientNote: a.clientNote ?? null,
      createdAt: (a.get('createdAt') as Date).toISOString(),
      updatedAt: (a.get('updatedAt') as Date).toISOString(),
    };
  });
}

export async function toAssignmentDto(assignment: AssignmentDoc) {
  const [dto] = await toAssignmentDtos([assignment]);
  return dto!;
}

// ---------------------------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------------------------

export async function listClientAssignments(coach: UserDoc, clientId: string) {
  const client = await coachClient(coach, clientId);
  const items = await AssignmentModel.find({coachId: coach._id, clientId: client._id}).sort({
    createdAt: -1,
    _id: -1,
  });
  return {items: await toAssignmentDtos(items)};
}

export async function createAssignment(
  coach: UserDoc,
  clientId: string,
  input: z.output<typeof CreateAssignmentBody>,
) {
  const client = await coachClient(coach, clientId);
  const assignment = await AssignmentModel.create({
    coachId: coach._id,
    clientId: client._id,
    title: input.title,
    note: input.note,
    dueDate: input.dueDate,
    exercises: input.exercises.map(e => ({...e, result: null})),
    clientNote: null,
  });
  const dto = await toAssignmentDto(assignment);
  emitToUsers([client.id as string], 'assignment:new', {assignment: dto});
  return dto;
}

async function ownAssignment(coach: UserDoc, id: string) {
  const assignment = await AssignmentModel.findOne({_id: id, coachId: coach._id});
  if (!assignment) throw new AppError('NOT_FOUND', 'Assignment not found.');
  return assignment;
}

export async function updateAssignment(
  coach: UserDoc,
  id: string,
  input: z.output<typeof UpdateAssignmentBody>,
) {
  const assignment = await ownAssignment(coach, id);
  if (input.title !== undefined) assignment.title = input.title;
  if (input.note !== undefined) assignment.note = input.note || null;
  if (input.dueDate !== undefined) assignment.dueDate = input.dueDate;
  if (input.exercises) {
    const existing = new Map(exercisesOf(assignment).map(e => [e._id.toString(), e]));
    const unknown = input.exercises.filter(e => e.id && !existing.has(e.id)).map(e => e.id);
    if (unknown.length) {
      throw new AppError('VALIDATION_ERROR', undefined, {
        fields: {exercises: `Unknown exercise id: ${unknown.join(', ')}`},
      });
    }
    assignment.set(
      'exercises',
      input.exercises.map(({id: exerciseId, ...fields}) => ({
        ...(exerciseId
          ? {_id: new Types.ObjectId(exerciseId), result: existing.get(exerciseId)!.result ?? null}
          : {result: null}),
        ...fields,
      })),
    );
  }
  await assignment.save();
  return toAssignmentDto(assignment);
}

export async function deleteAssignment(coach: UserDoc, id: string) {
  const assignment = await ownAssignment(coach, id);
  await assignment.deleteOne();
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

/** Nearest dueDate first, then without a date; newer first inside each group. */
function clientOrder(a: AssignmentDoc, b: AssignmentDoc) {
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return (
    (b.get('createdAt') as Date).getTime() - (a.get('createdAt') as Date).getTime() ||
    b._id.toString().localeCompare(a._id.toString())
  );
}

export async function myAssignments(client: UserDoc, query: z.output<typeof MyAssignmentsQuery>) {
  const all = await AssignmentModel.find({clientId: client._id});
  const items = all
    .filter(a => {
      if (query.status === 'all') return true;
      const {status} = progressOf(exercisesOf(a));
      return status === 'open' || status === 'in_progress';
    })
    .sort(clientOrder);
  return {items: await toAssignmentDtos(items)};
}

async function clientAssignment(client: UserDoc, id: string) {
  const assignment = await AssignmentModel.findOne({_id: id, clientId: client._id});
  if (!assignment) throw new AppError('NOT_FOUND', 'Assignment not found.');
  return assignment;
}

export async function getMyAssignment(client: UserDoc, id: string) {
  return toAssignmentDto(await clientAssignment(client, id));
}

async function savedByClient(assignment: AssignmentDoc) {
  await assignment.save();
  const dto = await toAssignmentDto(assignment);
  emitToUsers([assignment.coachId.toString()], 'assignment:updated', {assignment: dto});
  return dto;
}

function exerciseOf(assignment: AssignmentDoc, exerciseId: string) {
  const exercise = assignment.exercises.id(exerciseId);
  if (!exercise) throw new AppError('NOT_FOUND', 'Exercise not found.');
  return exercise;
}

export async function setExerciseResult(
  client: UserDoc,
  id: string,
  exerciseId: string,
  input: z.output<typeof ExerciseResultBody>,
) {
  const assignment = await clientAssignment(client, id);
  exerciseOf(assignment, exerciseId).set('result', {
    status: input.status,
    note: input.note,
    updatedAt: new Date(),
  });
  return savedByClient(assignment);
}

export async function clearExerciseResult(client: UserDoc, id: string, exerciseId: string) {
  const assignment = await clientAssignment(client, id);
  exerciseOf(assignment, exerciseId).set('result', null);
  return savedByClient(assignment);
}

export async function setClientNote(client: UserDoc, id: string, note: string | null) {
  const assignment = await clientAssignment(client, id);
  assignment.clientNote = note || null;
  return savedByClient(assignment);
}
