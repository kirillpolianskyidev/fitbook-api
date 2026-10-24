import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

/** A coach's promo code: percent or amount off bookings and / or packages. */
const promoCodeSchema = new Schema(
  {
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    // Stored upper-case; clients may type any case.
    code: {type: String, required: true},
    discount: {
      type: new Schema(
        {
          type: {type: String, enum: ['percent', 'amount'], required: true},
          value: {type: Number, required: true},
        },
        {_id: false},
      ),
      required: true,
    },
    // Inclusive dates in the coach's time zone (YYYY-MM-DD), each optional.
    validFrom: {type: String, default: null},
    validUntil: {type: String, default: null},
    maxUses: {type: Number, default: null},
    usesCount: {type: Number, default: 0},
    newClientsOnly: {type: Boolean, default: false},
    appliesTo: {type: [String], enum: ['bookings', 'packages'], default: ['bookings', 'packages']},
    isActive: {type: Boolean, default: true},
  },
  {timestamps: true},
);
promoCodeSchema.index({coachId: 1, code: 1}, {unique: true});

export type PromoCode = InferSchemaType<typeof promoCodeSchema>;
export type PromoCodeDoc = HydratedDocument<PromoCode>;
export const PromoCodeModel = model('PromoCode', promoCodeSchema);

/** One use of a code by a client (each client can use a code once). */
const promoRedemptionSchema = new Schema(
  {
    promoCodeId: {type: Schema.Types.ObjectId, ref: 'PromoCode', required: true},
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    target: {type: String, enum: ['booking', 'series', 'package'], required: true},
  },
  {timestamps: true},
);
promoRedemptionSchema.index({promoCodeId: 1, clientId: 1}, {unique: true});

export const PromoRedemptionModel = model('PromoRedemption', promoRedemptionSchema);
