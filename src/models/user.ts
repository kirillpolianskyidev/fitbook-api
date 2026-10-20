import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

import {homeAreaSchema} from './shared.js';

const userSchema = new Schema(
  {
    email: {type: String, required: true, unique: true, lowercase: true, trim: true},
    emailKey: {type: String, required: true, index: true},
    passwordHash: {type: String},
    role: {type: String, enum: ['coach', 'client', null], default: null},
    firstName: {type: String, required: true, trim: true},
    lastName: {type: String, default: '', trim: true},
    avatarUrl: {type: String},
    homeArea: {type: homeAreaSchema, default: null},
    authProviders: {
      type: [
        new Schema(
          {
            provider: {type: String, enum: ['password', 'google', 'apple'], required: true},
            providerUserId: String,
          },
          {_id: false},
        ),
      ],
      default: [],
    },
    // "google:<sub>", "apple:<sub>" - exact lookup of social accounts.
    providerKeys: {type: [String], default: []},
    onboardingCompleted: {type: Boolean, default: false},
    trialUsed: {type: Boolean, default: false},
    settings: {
      type: new Schema(
        {theme: {type: String, enum: ['light', 'dark', 'system'], default: 'system'}},
        {_id: false},
      ),
      default: () => ({theme: 'system'}),
    },
  },
  {timestamps: true},
);

userSchema.index({providerKeys: 1});
userSchema.index({role: 1, 'homeArea.state': 1, 'homeArea.city': 1});

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<User>;
export const UserModel = model('User', userSchema);
