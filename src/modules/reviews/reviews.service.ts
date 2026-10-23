import {Types} from 'mongoose';
import type {z} from 'zod';

import {AppError, isDuplicateKeyError} from '../../lib/errors.js';
import {BookingModel} from '../../models/booking.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {ReviewModel, type ReviewDoc} from '../../models/review.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import type {ReviewBody, ReviewListQuery} from './reviews.schemas.js';

export const REVIEW_EDIT_WINDOW_MS = 24 * 3600_000;

type Author = {
  _id: Types.ObjectId;
  firstName: string;
  lastName?: string | null;
  avatarUrl?: string | null;
};

/** "Jamie Lee" -> "Jamie L." (public name without the full last name). */
export function publicName(firstName: string, lastName?: string | null) {
  const initial = lastName?.trim().charAt(0).toUpperCase();
  return initial ? `${firstName} ${initial}.` : firstName;
}

function toReviewDto(review: ReviewDoc, author: Author | undefined) {
  return {
    id: review.id as string,
    rating: review.rating,
    text: review.text ?? null,
    author: {
      id: review.clientId.toString(),
      name: author ? publicName(author.firstName, author.lastName) : 'FitBook client',
      avatarUrl: author?.avatarUrl ?? null,
    },
    createdAt: (review.get('createdAt') as Date).toISOString(),
    updatedAt: (review.get('updatedAt') as Date).toISOString(),
  };
}

async function toReviewDtos(reviews: ReviewDoc[]) {
  const authors = await UserModel.find({_id: {$in: reviews.map(r => r.clientId)}})
    .select('firstName lastName avatarUrl')
    .lean();
  const byId = new Map(authors.map(a => [a._id.toString(), a as unknown as Author]));
  return reviews.map(r => toReviewDto(r, byId.get(r.clientId.toString())));
}

/** Reviews can be listed / written for coaches that exist and are visible in the catalog. */
async function assertCoach(coachId: string) {
  if (!Types.ObjectId.isValid(coachId)) throw new AppError('NOT_FOUND', 'Coach not found.');
  const [profile, user] = await Promise.all([
    CoachProfileModel.exists({userId: coachId, isPublished: true}),
    UserModel.exists({_id: coachId, role: 'coach'}),
  ]);
  if (!profile || !user) {
    throw new AppError('NOT_FOUND', 'Coach not found.');
  }
}

export async function reviewSummary(coachId: string | Types.ObjectId) {
  const rows = await ReviewModel.aggregate<{_id: number; n: number}>([
    {$match: {coachId: new Types.ObjectId(coachId.toString())}},
    {$group: {_id: '$rating', n: {$sum: 1}}},
  ]);
  const distribution = {'1': 0, '2': 0, '3': 0, '4': 0, '5': 0};
  let count = 0;
  let sum = 0;
  for (const row of rows) {
    distribution[String(row._id) as keyof typeof distribution] = row.n;
    count += row.n;
    sum += row._id * row.n;
  }
  const average = count ? Math.round((sum / count) * 100) / 100 : 0;
  return {average, count, distribution};
}

/** coachProfile.rating is denormalized from the reviews (catalog sorting); call after every change. */
export async function refreshCoachRating(coachId: string | Types.ObjectId) {
  const {average, count} = await reviewSummary(coachId);
  await CoachProfileModel.updateOne({userId: coachId}, {$set: {rating: {average, count}}});
}

export async function listReviews(coachId: string, query: z.infer<typeof ReviewListQuery>) {
  await assertCoach(coachId);
  const [total, reviews, summary] = await Promise.all([
    ReviewModel.countDocuments({coachId}),
    ReviewModel.find({coachId})
      .sort({createdAt: -1, _id: -1})
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize),
    reviewSummary(coachId),
  ]);
  return {
    items: await toReviewDtos(reviews),
    page: query.page,
    pageSize: query.pageSize,
    total,
    summary,
  };
}

const hasCompletedTraining = (client: UserDoc, coachId: string) =>
  BookingModel.exists({clientId: client._id, coachId, status: 'completed'});

const editableUntil = (review: ReviewDoc) =>
  new Date((review.get('createdAt') as Date).getTime() + REVIEW_EDIT_WINDOW_MS);

async function myReviewState(client: UserDoc, coachId: string, review: ReviewDoc | null) {
  if (review) {
    const [dto] = await toReviewDtos([review]);
    return {review: dto!, canCreate: false, editableUntil: editableUntil(review).toISOString()};
  }
  return {
    review: null,
    canCreate: Boolean(await hasCompletedTraining(client, coachId)),
    editableUntil: null,
  };
}

export async function getMyReview(client: UserDoc, coachId: string) {
  await assertCoach(coachId);
  return myReviewState(client, coachId, await ReviewModel.findOne({coachId, clientId: client._id}));
}

/** Creates (created: true) or updates the client's review of the coach. */
export async function putMyReview(
  client: UserDoc,
  coachId: string,
  input: z.output<typeof ReviewBody>,
) {
  await assertCoach(coachId);
  let review = await ReviewModel.findOne({coachId, clientId: client._id});
  let created = false;
  if (!review) {
    if (!(await hasCompletedTraining(client, coachId))) {
      throw new AppError('REVIEW_NOT_ALLOWED');
    }
    try {
      review = await ReviewModel.create({
        coachId,
        clientId: client._id,
        rating: input.rating,
        text: input.text,
      });
      created = true;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Created by a parallel request: continue as an update.
      review = await ReviewModel.findOne({coachId, clientId: client._id});
    }
  }
  if (!created && review) {
    if (Date.now() >= editableUntil(review).getTime()) {
      throw new AppError('REVIEW_EDIT_WINDOW_PASSED');
    }
    review.rating = input.rating;
    review.text = input.text;
    await review.save();
  }
  await refreshCoachRating(coachId);
  return {created, result: await myReviewState(client, coachId, review)};
}
