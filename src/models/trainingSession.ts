import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

import {locationSchema, moneySchema} from './shared.js';

const trainingSessionSchema = new Schema(
  {
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    sessionTypeId: {type: Schema.Types.ObjectId, ref: 'SessionType', required: true},
    kind: {type: String, enum: ['individual', 'group'], required: true},
    title: {type: String, required: true},
    startAt: {type: Date, required: true},
    endAt: {type: Date, required: true},
    capacity: {type: Number, required: true},
    participantsCount: {type: Number, default: 0},
    // Places held for waitlist offers (group sessions): taken for everybody but the offered client.
    heldCount: {type: Number, default: 0},
    price: {type: moneySchema, required: true},
    location: {type: locationSchema, default: null},
    status: {type: String, enum: ['scheduled', 'cancelled', 'completed'], default: 'scheduled'},
    cancelReason: String,
  },
  {timestamps: true},
);

trainingSessionSchema.index({coachId: 1, startAt: 1});
trainingSessionSchema.index({status: 1, endAt: 1});

export type TrainingSession = InferSchemaType<typeof trainingSessionSchema>;
export type TrainingSessionDoc = HydratedDocument<TrainingSession>;
export const TrainingSessionModel = model('TrainingSession', trainingSessionSchema);
