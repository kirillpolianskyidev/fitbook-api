import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

/** Body measurement of a client: one value per type per day. */
const measurementSchema = new Schema(
  {
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    type: {type: String, enum: ['weight', 'body_fat', 'waist'], required: true},
    value: {type: Number, required: true},
    // Local date of the client (YYYY-MM-DD).
    measuredAt: {type: String, required: true},
    note: {type: String, default: null},
  },
  {timestamps: true},
);

measurementSchema.index({clientId: 1, type: 1, measuredAt: 1}, {unique: true});
measurementSchema.index({clientId: 1, measuredAt: -1});

export type Measurement = InferSchemaType<typeof measurementSchema>;
export type MeasurementDoc = HydratedDocument<Measurement>;
export const MeasurementModel = model('Measurement', measurementSchema);
