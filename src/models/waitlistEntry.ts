import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

const WAITLIST_STATUSES = ['waiting', 'offered', 'booked', 'expired', 'left'] as const;

/** A client queued for a full group session. Order = joinedAt. */
const waitlistEntrySchema = new Schema(
  {
    sessionId: {type: Schema.Types.ObjectId, ref: 'TrainingSession', required: true},
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    status: {type: String, enum: WAITLIST_STATUSES, required: true, default: 'waiting'},
    joinedAt: {type: Date, required: true},
    offeredAt: {type: Date, default: null},
    offerExpiresAt: {type: Date, default: null},
    // `${sessionId}:${clientId}` while waiting/offered; removed otherwise (sparse unique: one active entry).
    activeKey: {type: String},
  },
  {timestamps: true},
);

waitlistEntrySchema.index({activeKey: 1}, {unique: true, sparse: true});
waitlistEntrySchema.index({sessionId: 1, status: 1, joinedAt: 1});
waitlistEntrySchema.index({clientId: 1, status: 1});
waitlistEntrySchema.index({status: 1, offerExpiresAt: 1});

export type WaitlistEntry = InferSchemaType<typeof waitlistEntrySchema>;
export type WaitlistEntryDoc = HydratedDocument<WaitlistEntry>;
export const WaitlistEntryModel = model('WaitlistEntry', waitlistEntrySchema);
