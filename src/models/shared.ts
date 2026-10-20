import {Schema} from 'mongoose';

export const moneySchema = new Schema(
  {
    amountCents: {type: Number, required: true, min: 0},
    currency: {type: String, enum: ['USD'], default: 'USD'},
  },
  {_id: false},
);

export const homeAreaSchema = new Schema(
  {
    city: {type: String, required: true, trim: true},
    state: {type: String, required: true},
    country: {type: String, enum: ['US'], default: 'US'},
    timezone: {type: String, required: true},
  },
  {_id: false},
);

export const locationSchema = new Schema(
  {
    name: {type: String, required: true},
    address: {type: String, required: true},
    city: {type: String, required: true},
    state: {type: String, required: true},
    country: {type: String, enum: ['US'], default: 'US'},
    lat: {type: Number, required: true},
    lng: {type: Number, required: true},
    placeId: String,
    comment: String,
  },
  {_id: false},
);
