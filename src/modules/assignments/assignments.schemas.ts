import {z} from 'zod';

import {dateYMD, objectId} from '../../lib/schemas.js';
import {UserSummarySchema} from '../users/users.schemas.js';

const ResultStatus = z.enum(['done', 'partial', 'skipped']);

export const ExerciseResultSchema = z
  .object({status: ResultStatus, note: z.string().nullable(), updatedAt: z.string()})
  .meta({id: 'ExerciseResult'});

export const ExerciseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    sets: z.number().int().nullable(),
    reps: z.string().nullable(),
    duration: z.string().nullable(),
    note: z.string().nullable(),
    videoUrl: z.string().nullable(),
    result: ExerciseResultSchema.nullable().meta({
      description: "The client's mark, null = not marked",
    }),
  })
  .meta({id: 'Exercise'});

export const AssignmentStatusSchema = z.enum(['open', 'in_progress', 'done', 'partial']).meta({
  id: 'AssignmentStatus',
  description:
    'open: nothing marked; in_progress: some exercises marked; done: all done; partial: all marked, not all done',
});

export const AssignmentSchema = z
  .object({
    id: z.string(),
    coach: UserSummarySchema,
    client: UserSummarySchema,
    title: z.string(),
    note: z.string().nullable(),
    dueDate: z.string().nullable().meta({description: 'YYYY-MM-DD'}),
    exercises: z.array(ExerciseSchema),
    status: AssignmentStatusSchema,
    progress: z.object({
      done: z.number().int(),
      partial: z.number().int(),
      skipped: z.number().int(),
      total: z.number().int(),
    }),
    clientNote: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({id: 'Assignment'});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform(value => (value ? value : null));

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine(value => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an https link')
  .nullable()
  .optional()
  .transform(value => value ?? null);

const exerciseFields = {
  name: z.string().trim().min(1).max(80),
  sets: z
    .number()
    .int()
    .min(1)
    .max(50)
    .nullable()
    .optional()
    .transform(value => value ?? null),
  reps: optionalText(20).meta({description: 'Free text, e.g. "8-10"'}),
  duration: optionalText(20).meta({description: 'Free text, e.g. "30 sec"'}),
  note: optionalText(500),
  videoUrl: httpsUrl,
};

const NewExercise = z.object(exerciseFields);
const EditExercise = z.object({
  id: objectId.optional().meta({
    description:
      'Existing exercise (updated, its result is kept); without id a new exercise is added',
  }),
  ...exerciseFields,
});

const assignmentFields = {
  title: z.string().trim().min(1).max(80),
  note: optionalText(2000),
  dueDate: dateYMD
    .nullable()
    .optional()
    .transform(value => value ?? null),
};

export const CreateAssignmentBody = z
  .object({...assignmentFields, exercises: z.array(NewExercise).min(1).max(30)})
  .meta({id: 'CreateAssignmentRequest'});

export const UpdateAssignmentBody = z
  .object({
    title: assignmentFields.title.optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    dueDate: dateYMD.nullable().optional(),
    exercises: z
      .array(EditExercise)
      .min(1)
      .max(30)
      .optional()
      .meta({description: 'The full new list: exercises missing from it are removed'}),
  })
  .meta({id: 'UpdateAssignmentRequest'});

export const MyAssignmentsQuery = z.object({
  status: z
    .enum(['active', 'all'])
    .default('active')
    .meta({description: 'active = open + in_progress'}),
});

export const AssignmentExerciseParams = z.object({id: objectId, exerciseId: objectId});

export const ExerciseResultBody = z
  .object({status: ResultStatus, note: optionalText(500)})
  .meta({id: 'ExerciseResultRequest'});

export const ClientNoteBody = z
  .object({note: z.string().trim().max(1000).nullable()})
  .meta({id: 'AssignmentClientNoteRequest'});
