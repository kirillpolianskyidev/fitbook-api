import {model, Schema} from 'mongoose';

const refreshTokenSchema = new Schema(
  {
    userId: {type: Schema.Types.ObjectId, required: true, index: true},
    familyId: {type: String, required: true, index: true},
    tokenHash: {type: String, required: true, unique: true},
    expiresAt: {type: Date, required: true},
    revokedAt: {type: Date, default: null},
    replacedByHash: {type: String, default: null},
    userAgent: String,
  },
  {timestamps: true},
);

export const RefreshTokenModel = model('RefreshToken', refreshTokenSchema);
