import {logger} from '../lib/logger.js';
import {BookingModel} from '../models/booking.js';
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
}
