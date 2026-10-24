import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

const bookingSeriesSchema = new Schema(
  {
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true, index: true},
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    sessionTypeId: {type: Schema.Types.ObjectId, ref: 'SessionType', required: true},
    weekdays: {type: [Number], required: true},
    time: {type: String, required: true},
    weeks: {type: Number, required: true},
    startDate: {type: String, required: true},
    bookingIds: {type: [Schema.Types.ObjectId], default: []},
    skippedDates: {type: [String], default: []},
    // in_person | online (individual series); older series: taken from their bookings.
    format: {type: String, enum: ['in_person', 'online'], default: null},
  },
  {timestamps: true},
);

export type BookingSeries = InferSchemaType<typeof bookingSeriesSchema>;
export type BookingSeriesDoc = HydratedDocument<BookingSeries>;
export const BookingSeriesModel = model('BookingSeries', bookingSeriesSchema);
