import type {Types} from 'mongoose';

import {toLocationDto, toMoneyDto} from '../../lib/dto.js';
import {AppError} from '../../lib/errors.js';
import type {Location, Money} from '../../lib/schemas.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {SessionTypeModel, type SessionTypeDoc} from '../../models/sessionType.js';
import {TrainingSessionModel} from '../../models/trainingSession.js';
import type {SessionTypeDto} from './sessionTypes.schemas.js';

export function toSessionTypeDto(type: SessionTypeDoc): SessionTypeDto {
  return {
    id: type.id,
    coachId: type.coachId.toString(),
    title: type.title,
    kind: type.kind as 'individual' | 'group',
    durationMin: type.durationMin,
    price: toMoneyDto(type.price),
    capacity: type.capacity,
    location: toLocationDto(type.location),
    description: type.description ?? '',
    isActive: type.isActive,
  };
}

/** Keeps the catalog's denormalized "price from" and "kinds" in sync with active session types. */
export async function refreshCoachCatalogFields(coachId: Types.ObjectId | string) {
  const types = await SessionTypeModel.find({coachId, isActive: true}).lean();
  const priceFromCents = types.length ? Math.min(...types.map(t => t.price.amountCents)) : null;
  const kinds = [...new Set(types.map(t => t.kind))].sort();
  await CoachProfileModel.updateOne({userId: coachId}, {priceFromCents, kinds});
}

export const listOwnSessionTypes = (coachId: Types.ObjectId) =>
  SessionTypeModel.find({coachId}).sort({isActive: -1, createdAt: 1});

export async function createSessionType(
  coachId: Types.ObjectId,
  input: {
    title: string;
    kind: 'individual' | 'group';
    durationMin: number;
    price: Money;
    capacity?: number;
    location?: Location | null;
    description?: string;
  },
) {
  const type = await SessionTypeModel.create({
    ...input,
    coachId,
    capacity: input.kind === 'individual' ? 1 : input.capacity,
  });
  await refreshCoachCatalogFields(coachId);
  return type;
}

export async function getOwnSessionType(coachId: Types.ObjectId, id: string) {
  const type = await SessionTypeModel.findOne({_id: id, coachId});
  if (!type) {
    throw new AppError('NOT_FOUND', 'Training type not found.');
  }
  return type;
}

export async function updateSessionType(
  coachId: Types.ObjectId,
  id: string,
  input: Partial<{
    title: string;
    durationMin: number;
    price: Money;
    capacity: number;
    location: Location | null;
    description: string;
    isActive: boolean;
  }>,
) {
  const type = await getOwnSessionType(coachId, id);
  if (input.capacity !== undefined && type.kind === 'individual') {
    throw new AppError('VALIDATION_ERROR', 'Individual trainings always have capacity 1.', {
      fields: {capacity: 'Not allowed for individual trainings'},
    });
  }
  type.set(input);
  await type.save();
  await refreshCoachCatalogFields(coachId);
  return type;
}

/** Hard delete when never used, otherwise deactivate (existing bookings keep working). */
export async function deleteSessionType(coachId: Types.ObjectId, id: string) {
  const type = await getOwnSessionType(coachId, id);
  const used = await TrainingSessionModel.exists({sessionTypeId: type._id});
  if (used) {
    type.isActive = false;
    await type.save();
  } else {
    await type.deleteOne();
  }
  await refreshCoachCatalogFields(coachId);
}
