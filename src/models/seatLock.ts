import {model, Schema} from 'mongoose';

/**
 * One document per taken seat of a group session. Unique (sessionId, seat) caps the participants at the
 * capacity and unique (sessionId, clientId) prevents double joins, both without transactions.
 */
const seatLockSchema = new Schema({
  sessionId: {type: Schema.Types.ObjectId, required: true},
  seat: {type: Number, required: true},
  clientId: {type: Schema.Types.ObjectId, required: true},
});

seatLockSchema.index({sessionId: 1, seat: 1}, {unique: true});
seatLockSchema.index({sessionId: 1, clientId: 1}, {unique: true});

export const SeatLockModel = model('SeatLock', seatLockSchema);
