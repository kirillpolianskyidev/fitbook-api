import {model, Schema, type InferSchemaType} from 'mongoose';

/**
 * One document per 30-minute block a scheduled session occupies.
 * The unique index makes double booking impossible without multi-document transactions.
 */
const slotLockSchema = new Schema({
  coachId: {type: Schema.Types.ObjectId, required: true},
  slotStart: {type: Date, required: true},
  sessionId: {type: Schema.Types.ObjectId, required: true, index: true},
});

slotLockSchema.index({coachId: 1, slotStart: 1}, {unique: true});

export type SlotLock = InferSchemaType<typeof slotLockSchema>;
export const SlotLockModel = model('SlotLock', slotLockSchema);
