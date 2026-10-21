import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

import {moneySchema} from './shared.js';

const bookingSchema = new Schema(
  {
    sessionId: {type: Schema.Types.ObjectId, ref: 'TrainingSession', required: true},
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    seriesId: {type: Schema.Types.ObjectId, ref: 'BookingSeries', default: null},
    status: {
      type: String,
      enum: ['pending_payment', 'confirmed', 'cancelled', 'completed'],
      required: true,
    },
    isTrial: {type: Boolean, default: false},
    price: {type: moneySchema, required: true},
    payment: {
      type: new Schema(
        {
          status: {
            type: String,
            enum: ['unpaid', 'paid', 'refunded', 'not_required'],
            required: true,
          },
          method: {type: String, enum: ['mock'], default: 'mock'},
          paidAt: Date,
          // Set when a paid booking is cancelled: the full price goes back to the client (mock, instant).
          refundedAt: Date,
        },
        {_id: false},
      ),
      required: true,
    },
    expiresAt: {type: Date, default: null},
    startAt: {type: Date, required: true},
    endAt: {type: Date, required: true},
    cancelledAt: Date,
    cancelledBy: {type: String, enum: ['coach', 'client', 'system']},
    cancelReason: String,
    // `${sessionId}:${clientId}` while the booking is active; removed ($unset) when cancelled,
    // so a client can re-join a session later. Must stay absent (not null) for the sparse index.
    activeKey: {type: String},
  },
  {timestamps: true},
);

bookingSchema.index({clientId: 1, startAt: 1});
bookingSchema.index({coachId: 1, startAt: 1});
bookingSchema.index({sessionId: 1});
bookingSchema.index({status: 1, expiresAt: 1});
// One active booking per client per session. Cancelled bookings clear activeKey (sparse unique).
bookingSchema.index({activeKey: 1}, {unique: true, sparse: true});

export type Booking = InferSchemaType<typeof bookingSchema>;
export type BookingDoc = HydratedDocument<Booking>;
export const BookingModel = model('Booking', bookingSchema);
