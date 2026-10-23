import {model, Schema} from 'mongoose';

/** A client's favorite coach. */
const favoriteSchema = new Schema(
  {
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
  },
  {timestamps: true},
);

favoriteSchema.index({clientId: 1, coachId: 1}, {unique: true});
favoriteSchema.index({clientId: 1, createdAt: -1});

export const FavoriteModel = model('Favorite', favoriteSchema);
