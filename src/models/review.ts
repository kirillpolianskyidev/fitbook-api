import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

/** One review per client per coach; re-submitting updates it (during 24 hours after creation). */
const reviewSchema = new Schema(
  {
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    rating: {type: Number, min: 1, max: 5, required: true},
    text: {type: String, default: null},
  },
  {timestamps: true},
);

reviewSchema.index({coachId: 1, clientId: 1}, {unique: true});
reviewSchema.index({coachId: 1, createdAt: -1});

export type Review = InferSchemaType<typeof reviewSchema>;
export type ReviewDoc = HydratedDocument<Review>;
export const ReviewModel = model('Review', reviewSchema);
