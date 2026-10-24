import {logger} from '../lib/logger.js';
import {refreshCoachCatalogFields} from '../modules/sessionTypes/sessionTypes.service.js';
import {BookingModel} from '../models/booking.js';
import {CoachProfileModel} from '../models/coachProfile.js';
import {ReviewModel} from '../models/review.js';
import {UserModel} from '../models/user.js';

/**
 * Idempotent data migrations. Run on every server start (before it accepts requests) and by `npm run migrate`.
 */
export async function runMigrations() {
  // 2026-10: email verification. Users created before it have no `emailVerifiedAt` field: they count as
  // verified (including the seed / demo accounts). New users get an explicit null until they enter the code.
  const verified = await UserModel.updateMany(
    {emailVerifiedAt: {$exists: false}},
    [{$set: {emailVerifiedAt: {$ifNull: ['$createdAt', '$$NOW']}}}],
    {updatePipeline: true},
  );
  if (verified.modifiedCount > 0) {
    logger.info(
      {users: verified.modifiedCount},
      'Migration: marked existing users as email-verified',
    );
  }

  // 2026-10: refunds. Every cancellation of a paid booking now refunds the full price; paid bookings cancelled
  // before that are marked refunded at their cancellation time.
  const refunded = await BookingModel.updateMany(
    {status: 'cancelled', 'payment.status': 'paid'},
    [
      {
        $set: {
          'payment.status': 'refunded',
          'payment.refundedAt': {$ifNull: ['$cancelledAt', '$$NOW']},
        },
      },
    ],
    {updatePipeline: true},
  );
  if (refunded.modifiedCount > 0) {
    logger.info(
      {bookings: refunded.modifiedCount},
      'Migration: marked cancelled paid bookings refunded',
    );
  }

  // 2026-10: reviews. coachProfile.rating is calculated from reviews; profiles whose stored rating does not match
  // their reviews (e.g. ratings typed into older seed data) are recalculated.
  const [summaries, profiles] = await Promise.all([
    ReviewModel.aggregate<{_id: unknown; count: number; sum: number}>([
      {$group: {_id: '$coachId', count: {$sum: 1}, sum: {$sum: '$rating'}}},
    ]),
    CoachProfileModel.find().select('userId rating').lean(),
  ]);
  const byCoach = new Map(summaries.map(s => [String(s._id), s]));
  let fixed = 0;
  for (const profile of profiles) {
    const s = byCoach.get(profile.userId.toString());
    const count = s?.count ?? 0;
    const average = s ? Math.round((s.sum / s.count) * 100) / 100 : 0;
    if (profile.rating?.count !== count || profile.rating?.average !== average) {
      await CoachProfileModel.updateOne({_id: profile._id}, {$set: {rating: {average, count}}});
      fixed += 1;
    }
  }
  if (fixed > 0) {
    logger.info({coaches: fixed}, 'Migration: coach ratings recalculated from reviews');
  }

  // 2026-10: online trainings. Profiles created before have no denormalized `formats` (catalog filter).
  const withoutFormats = await CoachProfileModel.find({formats: {$exists: false}})
    .select('userId')
    .lean();
  for (const profile of withoutFormats) await refreshCoachCatalogFields(profile.userId);
  if (withoutFormats.length > 0) {
    logger.info({coaches: withoutFormats.length}, 'Migration: coach formats calculated');
  }
}
