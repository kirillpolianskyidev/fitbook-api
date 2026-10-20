import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

import {locationSchema} from './shared.js';

const coachProfileSchema = new Schema(
  {
    userId: {type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true},
    headline: {type: String, default: ''},
    bio: {type: String, default: ''},
    specializations: {type: [String], default: []},
    experienceYears: {type: Number, default: 0},
    certifications: {
      type: [new Schema({title: String, issuer: String, year: Number}, {_id: false})],
      default: [],
    },
    highlights: {type: [String], default: []},
    languages: {type: [String], default: ['English']},
    defaultLocation: {type: locationSchema, default: null},
    cancellationPolicy: {
      type: new Schema(
        {freeCancelHours: {type: Number, min: 0, max: 72, default: 24}},
        {_id: false},
      ),
      default: () => ({freeCancelHours: 24}),
    },
    rating: {
      type: new Schema(
        {average: {type: Number, default: 0}, count: {type: Number, default: 0}},
        {_id: false},
      ),
      default: () => ({average: 0, count: 0}),
    },
    isPublished: {type: Boolean, default: false},
    // Denormalized for catalog filtering and "price from".
    city: {type: String, default: ''},
    state: {type: String, default: ''},
    priceFromCents: {type: Number, default: null},
    kinds: {type: [String], default: []},
  },
  {timestamps: true},
);

coachProfileSchema.index({isPublished: 1, state: 1, city: 1});
coachProfileSchema.index({specializations: 1});

export type CoachProfile = InferSchemaType<typeof coachProfileSchema>;
export type CoachProfileDoc = HydratedDocument<CoachProfile>;
export const CoachProfileModel = model('CoachProfile', coachProfileSchema);
