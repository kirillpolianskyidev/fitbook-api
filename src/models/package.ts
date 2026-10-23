import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

import {moneySchema} from './shared.js';

/** A package a coach sells: N credits for a price, valid for validityDays after purchase. */
const packageSchema = new Schema(
  {
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true, index: true},
    title: {type: String, required: true, trim: true},
    credits: {type: Number, required: true, min: 1, max: 100},
    price: {type: moneySchema, required: true},
    validityDays: {type: Number, required: true, min: 7, max: 365, default: 90},
    isActive: {type: Boolean, default: true},
  },
  {timestamps: true},
);

export type Package = InferSchemaType<typeof packageSchema>;
export type PackageDoc = HydratedDocument<Package>;
export const PackageModel = model('Package', packageSchema);

/** One purchase of a package. 1 credit = 1 training with the coach (individual or a group place). */
const clientPackageSchema = new Schema(
  {
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    packageId: {type: Schema.Types.ObjectId, ref: 'Package', required: true, index: true},
    // Snapshot at purchase time: later package changes apply to new purchases only.
    title: {type: String, required: true},
    creditsTotal: {type: Number, required: true},
    creditsLeft: {type: Number, required: true, min: 0},
    price: {type: moneySchema, required: true},
    purchasedAt: {type: Date, required: true},
    expiresAt: {type: Date, required: true},
  },
  {timestamps: true},
);

// Credit lookup: the client's usable purchases with a coach, soonest to expire first.
clientPackageSchema.index({clientId: 1, coachId: 1, expiresAt: 1});

export type ClientPackage = InferSchemaType<typeof clientPackageSchema>;
export type ClientPackageDoc = HydratedDocument<ClientPackage>;
export const ClientPackageModel = model('ClientPackage', clientPackageSchema);
