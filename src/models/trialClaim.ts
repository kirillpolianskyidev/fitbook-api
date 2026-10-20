import {model, Schema} from 'mongoose';

/** Guarantees one free trial per canonical email, across accounts and login methods. */
const trialClaimSchema = new Schema(
  {
    emailKey: {type: String, required: true, unique: true},
    userId: {type: Schema.Types.ObjectId, required: true},
    bookingId: {type: Schema.Types.ObjectId, default: null},
  },
  {timestamps: true},
);

export const TrialClaimModel = model('TrialClaim', trialClaimSchema);
