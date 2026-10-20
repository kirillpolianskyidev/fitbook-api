import {model, Schema} from 'mongoose';

const passwordResetSchema = new Schema(
  {
    userId: {type: Schema.Types.ObjectId, required: true, index: true},
    codeHash: {type: String, required: true},
    expiresAt: {type: Date, required: true},
    attempts: {type: Number, default: 0},
    verifiedAt: {type: Date, default: null},
    usedAt: {type: Date, default: null},
  },
  {timestamps: true},
);

export const PasswordResetModel = model('PasswordReset', passwordResetSchema);
