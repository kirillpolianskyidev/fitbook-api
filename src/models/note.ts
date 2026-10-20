import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

const noteSchema = new Schema(
  {
    bookingId: {type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true},
    coachId: {type: Schema.Types.ObjectId, required: true},
    clientId: {type: Schema.Types.ObjectId, required: true},
    phase: {type: String, enum: ['before', 'after'], required: true},
    text: {type: String, required: true, maxlength: 4000},
    authorId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    authorRole: {type: String, enum: ['coach', 'client'], required: true},
    lastEditedById: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    lastEditedByRole: {type: String, enum: ['coach', 'client'], required: true},
  },
  {timestamps: true},
);

export type Note = InferSchemaType<typeof noteSchema>;
export type NoteDoc = HydratedDocument<Note>;
export const NoteModel = model('Note', noteSchema);
