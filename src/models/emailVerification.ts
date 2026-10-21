import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

const VERIFICATION_PURPOSES = ['signup', 'login'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

/** A pending email-code check: confirm the email on sign up, or the second step of a password sign-in. */
const emailVerificationSchema = new Schema(
  {
    // Unguessable random id (128 bits, hex) returned to the app.
    _id: {type: String, required: true},
    userId: {type: Schema.Types.ObjectId, required: true, index: true},
    purpose: {type: String, enum: VERIFICATION_PURPOSES, required: true},
    // HMAC of the current 6-digit code; the plain code is never stored.
    codeHash: {type: String, required: true},
    codeExpiresAt: {type: Date, required: true},
    // Wrong attempts for the current code.
    attempts: {type: Number, default: 0},
    resendAvailableAt: {type: Date, required: true},
    resendCount: {type: Number, default: 0},
    // Lifetime of the whole verification (all resends included).
    expiresAt: {type: Date, required: true},
    consumedAt: {type: Date, default: null},
    // Replaced by a newer verification for the same user, or the password changed.
    invalidatedAt: {type: Date, default: null},
  },
  {timestamps: true},
);

// Old records are removed by MongoDB one day after they expire.
emailVerificationSchema.index({expiresAt: 1}, {expireAfterSeconds: 86_400});

export type EmailVerification = InferSchemaType<typeof emailVerificationSchema>;
export type EmailVerificationDoc = HydratedDocument<EmailVerification>;
export const EmailVerificationModel = model('EmailVerification', emailVerificationSchema);
