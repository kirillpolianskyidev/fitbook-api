import {DateTime} from 'luxon';
import type {Types} from 'mongoose';
import type {z} from 'zod';

import {AppError, isDuplicateKeyError} from '../../lib/errors.js';
import {BookingModel} from '../../models/booking.js';
import {ClientPackageModel, PackageModel} from '../../models/package.js';
import {PromoCodeModel, PromoRedemptionModel, type PromoCodeDoc} from '../../models/promoCode.js';
import {SessionTypeModel} from '../../models/sessionType.js';
import {TrainingSessionModel} from '../../models/trainingSession.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import type {CreatePromoCodeBody, PromoCheckBody, UpdatePromoCodeBody} from './promos.schemas.js';

type Applies = 'bookings' | 'packages';
const usd = (amountCents: number) => ({amountCents, currency: 'USD' as const});

export function toPromoCodeDto(promo: PromoCodeDoc) {
  return {
    id: promo.id as string,
    code: promo.code,
    discount: {type: promo.discount.type as 'percent' | 'amount', value: promo.discount.value},
    validFrom: promo.validFrom ?? null,
    validUntil: promo.validUntil ?? null,
    maxUses: promo.maxUses ?? null,
    usesCount: promo.usesCount,
    newClientsOnly: promo.newClientsOnly,
    appliesTo: promo.appliesTo as Applies[],
    isActive: promo.isActive,
    createdAt: (promo.get('createdAt') as Date).toISOString(),
  };
}

/** Discount of one price (never more than the price). */
export function discountOf(promo: {discount: {type: string; value: number}}, priceCents: number) {
  const raw =
    promo.discount.type === 'percent'
      ? Math.round((priceCents * promo.discount.value) / 100)
      : promo.discount.value;
  return Math.min(priceCents, Math.max(0, raw));
}

function labelOf(promo: PromoCodeDoc) {
  if (promo.discount.type === 'percent') return `−${promo.discount.value}%`;
  const cents = promo.discount.value;
  return `−$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------------
// Coach CRUD
// ---------------------------------------------------------------------------------------------

export const listPromoCodes = (coachId: Types.ObjectId) =>
  PromoCodeModel.find({coachId}).sort({createdAt: -1, _id: -1});

export async function createPromoCode(
  coachId: Types.ObjectId,
  input: z.output<typeof CreatePromoCodeBody>,
) {
  try {
    return await PromoCodeModel.create({coachId, ...input, usesCount: 0});
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError('PROMO_CODE_TAKEN');
    throw error;
  }
}

async function ownPromo(coachId: Types.ObjectId, id: string) {
  const promo = await PromoCodeModel.findOne({_id: id, coachId});
  if (!promo) throw new AppError('NOT_FOUND', 'Promo code not found.');
  return promo;
}

export async function updatePromoCode(
  coachId: Types.ObjectId,
  id: string,
  input: z.output<typeof UpdatePromoCodeBody>,
) {
  const promo = await ownPromo(coachId, id);
  promo.set(input);
  const from = promo.validFrom;
  const until = promo.validUntil;
  if (from && until && from > until) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {validUntil: 'validFrom must not be after validUntil'},
    });
  }
  await promo.save();
  return promo;
}

/** Deleted, or deactivated if it was already used. */
export async function deletePromoCode(coachId: Types.ObjectId, id: string) {
  const promo = await ownPromo(coachId, id);
  if (promo.usesCount > 0 || (await PromoRedemptionModel.exists({promoCodeId: promo._id}))) {
    promo.isActive = false;
    await promo.save();
  } else {
    await promo.deleteOne();
  }
}

// ---------------------------------------------------------------------------------------------
// Validation and redemption
// ---------------------------------------------------------------------------------------------

/** Finds the code and checks every rule for this client. */
export async function validPromo(
  client: UserDoc,
  coachId: Types.ObjectId | string,
  code: string,
  appliesTo: Applies,
) {
  const promo = await PromoCodeModel.findOne({coachId, code: code.trim().toUpperCase()});
  if (!promo || !promo.isActive) throw new AppError('PROMO_INVALID');
  if (!promo.appliesTo.includes(appliesTo)) throw new AppError('PROMO_NOT_APPLICABLE');
  const coach = await UserModel.findById(coachId).select('homeArea').lean();
  const today = DateTime.now()
    .setZone(coach?.homeArea?.timezone ?? 'America/Chicago')
    .toISODate()!;
  if (
    (promo.validFrom && today < promo.validFrom) ||
    (promo.validUntil && today > promo.validUntil)
  ) {
    throw new AppError('PROMO_EXPIRED');
  }
  if (promo.maxUses !== null && promo.maxUses !== undefined && promo.usesCount >= promo.maxUses) {
    throw new AppError('PROMO_USED_UP');
  }
  if (await PromoRedemptionModel.exists({promoCodeId: promo._id, clientId: client._id})) {
    throw new AppError('PROMO_ALREADY_USED');
  }
  if (promo.newClientsOnly) {
    const [booked, bought] = await Promise.all([
      BookingModel.exists({clientId: client._id, coachId, status: {$ne: 'cancelled'}}),
      ClientPackageModel.exists({clientId: client._id, coachId}),
    ]);
    if (booked || bought) throw new AppError('PROMO_NEW_CLIENTS_ONLY');
  }
  return promo;
}

export type Redemption = {
  promo: PromoCodeDoc;
  /** Undo the use (the booking / purchase failed). */
  release: () => Promise<void>;
};

/**
 * Validates and uses the code once for this client (race-safe: unique redemption per client, capped counter).
 * Call `release()` if the booking / purchase that uses it fails.
 */
export async function redeemPromo(
  client: UserDoc,
  coachId: Types.ObjectId | string,
  code: string,
  appliesTo: Applies,
  target: 'booking' | 'series' | 'package',
): Promise<Redemption> {
  const promo = await validPromo(client, coachId, code, appliesTo);
  let redemption;
  try {
    redemption = await PromoRedemptionModel.create({
      promoCodeId: promo._id,
      clientId: client._id,
      target,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new AppError('PROMO_ALREADY_USED');
    throw error;
  }
  const counted = await PromoCodeModel.updateOne(
    {
      _id: promo._id,
      isActive: true,
      $or: [{maxUses: null}, {$expr: {$lt: ['$usesCount', '$maxUses']}}],
    },
    {$inc: {usesCount: 1}},
  );
  if (counted.modifiedCount !== 1) {
    await redemption.deleteOne();
    throw new AppError('PROMO_USED_UP');
  }
  return {
    promo,
    release: async () => {
      await redemption.deleteOne();
      await PromoCodeModel.updateOne(
        {_id: promo._id, usesCount: {$gt: 0}},
        {$inc: {usesCount: -1}},
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Client check
// ---------------------------------------------------------------------------------------------

export async function checkPromo(client: UserDoc, input: z.output<typeof PromoCheckBody>) {
  let unitPrice: number;
  let count = 1;
  if (input.target.type === 'package') {
    const pkg = await PackageModel.findOne({_id: input.target.packageId, coachId: input.coachId});
    if (!pkg) throw new AppError('NOT_FOUND', 'Package not found.');
    unitPrice = pkg.price.amountCents;
  } else if (input.target.sessionId) {
    const session = await TrainingSessionModel.findOne({
      _id: input.target.sessionId,
      coachId: input.coachId,
      kind: 'group',
    });
    if (!session) throw new AppError('NOT_FOUND', 'Group session not found.');
    unitPrice = session.price.amountCents;
    count = input.target.count;
  } else if (input.target.sessionTypeId) {
    const type = await SessionTypeModel.findOne({
      _id: input.target.sessionTypeId,
      coachId: input.coachId,
    });
    if (!type) throw new AppError('NOT_FOUND', 'Training type not found.');
    unitPrice = type.price.amountCents;
    count = input.target.count;
  } else {
    throw new AppError('VALIDATION_ERROR', undefined, {
      fields: {target: 'sessionTypeId (individual) or sessionId (group) is required'},
    });
  }
  const promo = await validPromo(
    client,
    input.coachId,
    input.code,
    input.target.type === 'package' ? 'packages' : 'bookings',
  );
  const unitDiscount = discountOf(promo, unitPrice);
  return {
    code: promo.code,
    label: labelOf(promo),
    unitPrice: usd(unitPrice),
    unitDiscount: usd(unitDiscount),
    total: usd((unitPrice - unitDiscount) * count),
    totalDiscount: usd(unitDiscount * count),
  };
}
