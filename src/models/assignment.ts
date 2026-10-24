import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

const resultSchema = new Schema(
  {
    status: {type: String, enum: ['done', 'partial', 'skipped'], required: true},
    note: {type: String, default: null},
    updatedAt: {type: Date, required: true},
  },
  {_id: false},
);

const exerciseSchema = new Schema({
  name: {type: String, required: true},
  sets: {type: Number, default: null},
  reps: {type: String, default: null},
  duration: {type: String, default: null},
  note: {type: String, default: null},
  videoUrl: {type: String, default: null},
  // The client's mark; kept when the coach edits the exercise.
  result: {type: resultSchema, default: null},
});

/** Homework from a coach to a client: a list of exercises the client marks as done / partial / skipped. */
const assignmentSchema = new Schema(
  {
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    title: {type: String, required: true},
    note: {type: String, default: null},
    // YYYY-MM-DD or null.
    dueDate: {type: String, default: null},
    exercises: {type: [exerciseSchema], default: []},
    clientNote: {type: String, default: null},
  },
  {timestamps: true},
);

assignmentSchema.index({coachId: 1, clientId: 1, createdAt: -1});
assignmentSchema.index({clientId: 1, createdAt: -1});

export type Assignment = InferSchemaType<typeof assignmentSchema>;
export type AssignmentDoc = HydratedDocument<Assignment>;
export const AssignmentModel = model('Assignment', assignmentSchema);
