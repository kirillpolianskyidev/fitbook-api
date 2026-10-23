import type {Types} from 'mongoose';
import type {z} from 'zod';

import {toMoneyDto} from '../../lib/dto.js';
import {AppError} from '../../lib/errors.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {
  ClientPackageModel,
  PackageModel,
  type ClientPackageDoc,
  type PackageDoc,
} from '../../models/package.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {toUserSummary} from '../users/users.service.js';
import type {CreatePackageBody, UpdatePackageBody} from './packages.schemas.js';

const DAY_MS = 86_400_000;

export function toPackageDto(pkg: PackageDoc) {
  return {
    id: pkg.id as string,
    title: pkg.title,
    credits: pkg.credits,
    price: toMoneyDto(pkg.price),
    validityDays: pkg.validityDays,
    isActive: pkg.isActive,
    pricePerCredit: {
      amountCents: Math.round(pkg.price.amountCents / pkg.credits),
      currency: 'USD' as const,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------------------------

export const listOwnPackages = (coachId: Types.ObjectId) =>
  PackageModel.find({coachId}).sort({isActive: -1, credits: 1, createdAt: 1});

export const listActivePackages = (coachId: Types.ObjectId | string) =>
  PackageModel.find({coachId, isActive: true}).sort({credits: 1, createdAt: 1});

export const createPackage = (coachId: Types.ObjectId, input: z.output<typeof CreatePackageBody>) =>
  PackageModel.create({coachId, ...input, isActive: true});

async function ownPackage(coachId: Types.ObjectId, id: string) {
  const pkg = await PackageModel.findOne({_id: id, coachId});
  if (!pkg) throw new AppError('NOT_FOUND', 'Package not found.');
  return pkg;
}

/** Changes apply to new purchases only (purchases keep a snapshot). */
export async function updatePackage(
  coachId: Types.ObjectId,
  id: string,
  input: z.output<typeof UpdatePackageBody>,
) {
  const pkg = await ownPackage(coachId, id);
  pkg.set(input);
  await pkg.save();
  return pkg;
}

/** Deleted, or deactivated if somebody already bought it. */
export async function deletePackage(coachId: Types.ObjectId, id: string) {
  const pkg = await ownPackage(coachId, id);
  if (await ClientPackageModel.exists({packageId: pkg._id})) {
    pkg.isActive = false;
    await pkg.save();
  } else {
    await pkg.deleteOne();
  }
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

async function toClientPackageDtos(purchases: ClientPackageDoc[]) {
  const coaches = await UserModel.find({_id: {$in: purchases.map(p => p.coachId)}})
    .select('firstName lastName avatarUrl')
    .lean();
  const byId = new Map(coaches.map(c => [c._id.toString(), c]));
  const now = Date.now();
  return purchases.map(p => {
    const coach = byId.get(p.coachId.toString());
    return {
      id: p.id as string,
      packageId: p.packageId.toString(),
      title: p.title,
      coach: coach
        ? toUserSummary(coach)
        : {id: p.coachId.toString(), firstName: '', lastName: '', avatarUrl: null},
      creditsTotal: p.creditsTotal,
      creditsLeft: p.creditsLeft,
      price: toMoneyDto(p.price),
      purchasedAt: p.purchasedAt.toISOString(),
      expiresAt: p.expiresAt.toISOString(),
      expired: p.expiresAt.getTime() <= now,
    };
  });
}

/** Mock payment: the package is paid immediately. */
export async function purchasePackage(client: UserDoc, packageId: string) {
  const pkg = await PackageModel.findById(packageId);
  if (!pkg || !(await CoachProfileModel.exists({userId: pkg.coachId, isPublished: true}))) {
    throw new AppError('NOT_FOUND', 'Package not found.');
  }
  if (!pkg.isActive) {
    throw new AppError('PACKAGE_INACTIVE');
  }
  const purchasedAt = new Date();
  const purchase = await ClientPackageModel.create({
    clientId: client._id,
    coachId: pkg.coachId,
    packageId: pkg._id,
    title: pkg.title,
    creditsTotal: pkg.credits,
    creditsLeft: pkg.credits,
    price: pkg.price,
    purchasedAt,
    expiresAt: new Date(purchasedAt.getTime() + pkg.validityDays * DAY_MS),
  });
  const [dto] = await toClientPackageDtos([purchase]);
  return dto!;
}

export async function creditsAvailable(
  clientId: Types.ObjectId,
  coachId?: Types.ObjectId | string,
) {
  const purchases = await ClientPackageModel.find({
    clientId,
    ...(coachId && {coachId}),
    expiresAt: {$gt: new Date()},
    creditsLeft: {$gt: 0},
  })
    .select('creditsLeft')
    .lean();
  return purchases.reduce((sum, p) => sum + p.creditsLeft, 0);
}

/** Usable purchases first (soonest to expire first), then used up / expired ones (newest first). */
export async function myPackages(client: UserDoc, coachId?: string) {
  const purchases = await ClientPackageModel.find({
    clientId: client._id,
    ...(coachId && {coachId}),
  });
  const now = Date.now();
  const usable = (p: ClientPackageDoc) => p.creditsLeft > 0 && p.expiresAt.getTime() > now;
  purchases.sort((a, b) => {
    const ua = usable(a);
    const ub = usable(b);
    if (ua !== ub) return ua ? -1 : 1;
    return ua
      ? a.expiresAt.getTime() - b.expiresAt.getTime()
      : b.purchasedAt.getTime() - a.purchasedAt.getTime();
  });
  return {
    items: await toClientPackageDtos(purchases),
    creditsAvailable: await creditsAvailable(client._id, coachId),
  };
}

// ---------------------------------------------------------------------------------------------
// Credits (used by bookings)
// ---------------------------------------------------------------------------------------------

/** Takes 1 credit from the client's purchase with the coach that expires first. Throws NO_CREDITS. */
export async function takeCredit(clientId: Types.ObjectId, coachId: Types.ObjectId) {
  const purchase = await ClientPackageModel.findOneAndUpdate(
    {clientId, coachId, creditsLeft: {$gt: 0}, expiresAt: {$gt: new Date()}},
    {$inc: {creditsLeft: -1}},
    {sort: {expiresAt: 1, _id: 1}, returnDocument: 'after'},
  );
  if (!purchase) {
    throw new AppError('NO_CREDITS');
  }
  return purchase;
}

/** Puts a credit back into its purchase, unless the purchase has expired meanwhile (then it is lost). */
export async function returnCredit(clientPackageId: Types.ObjectId) {
  const result = await ClientPackageModel.updateOne(
    {
      _id: clientPackageId,
      expiresAt: {$gt: new Date()},
      $expr: {$lt: ['$creditsLeft', '$creditsTotal']},
    },
    {$inc: {creditsLeft: 1}},
  );
  return result.modifiedCount === 1;
}
