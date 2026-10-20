import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

const availabilitySchema = new Schema(
  {
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true},
    weekly: {
      type: [
        new Schema(
          {weekday: {type: Number, min: 0, max: 6, required: true}, start: String, end: String},
          {_id: false},
        ),
      ],
      default: [],
    },
    exceptions: {
      type: [new Schema({date: String, start: String, end: String, reason: String}, {_id: false})],
      default: [],
    },
  },
  {timestamps: true},
);

export type Availability = InferSchemaType<typeof availabilitySchema>;
export type AvailabilityDoc = HydratedDocument<Availability>;
export const AvailabilityModel = model('Availability', availabilitySchema);
