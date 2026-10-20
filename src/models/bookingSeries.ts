import {model, Schema, type InferSchemaType} from 'mongoose';

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
  },
  {timestamps: true},
);

export type BookingSeries = InferSchemaType<typeof bookingSeriesSchema>;
export const BookingSeriesModel = model('BookingSeries', bookingSeriesSchema);
