import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

import {locationSchema, moneySchema} from './shared.js';

const sessionTypeSchema = new Schema(
  {
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true, index: true},
    title: {type: String, required: true, trim: true},
    kind: {type: String, enum: ['individual', 'group'], required: true},
    durationMin: {type: Number, required: true},
    price: {type: moneySchema, required: true},
    capacity: {type: Number, required: true, default: 1},
    location: {type: locationSchema, default: null},
    description: {type: String, default: ''},
    isActive: {type: Boolean, default: true},
  },
  {timestamps: true},
);

export type SessionType = InferSchemaType<typeof sessionTypeSchema>;
export type SessionTypeDoc = HydratedDocument<SessionType>;
export const SessionTypeModel = model('SessionType', sessionTypeSchema);
