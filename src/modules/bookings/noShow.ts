import type {Types} from 'mongoose';

import {AppError} from '../../lib/errors.js';
import {BookingModel, type BookingDoc} from '../../models/booking.js';
import type {UserDoc} from '../../models/user.js';
import {returnCredit} from '../packages/packages.service.js';

export const NO_SHOW_WINDOW_MS = 48 * 3600_000;

type BookingLike = {
  coachId: Types.ObjectId;
  status: string;
  startAt: Date;
  noShow?: {markedAt?: Date | null; refunded?: boolean | null} | null;
};

const inWindow = (startAt: Date, now = Date.now()) =>
  now >= startAt.getTime() && now <= startAt.getTime() + NO_SHOW_WINDOW_MS;

/** No-show fields of a booking for the viewer (only the booking's coach can mark / undo). */
export function noShowFields(booking: BookingLike, viewerId?: Types.ObjectId) {
  const isCoach = Boolean(viewerId && booking.coachId.equals(viewerId));
  const open = inWindow(booking.startAt);
  const noShow = booking.status === 'no_show' && booking.noShow?.markedAt ? booking.noShow : null;
  return {
    noShow: noShow
      ? {markedAt: noShow.markedAt!.toISOString(), refunded: Boolean(noShow.refunded)}
      : null,
    noShowMarkable: isCoach && open && ['confirmed', 'completed'].includes(booking.status),
    noShowUndoable: isCoach && open && noShow !== null && !noShow.refunded,
    noShowDeadline: new Date(booking.startAt.getTime() + NO_SHOW_WINDOW_MS).toISOString(),
  };
}

async function coachBooking(coach: UserDoc, bookingId: string) {
  const booking = await BookingModel.findById(bookingId);
  if (!booking) throw new AppError('NOT_FOUND', 'Booking not found.');
  if (!booking.coachId.equals(coach._id)) throw new AppError('FORBIDDEN');
  return booking;
}

/**
 * Marks the client as a no-show. refund: true returns the payment like a coach cancellation (a credit goes back
 * to its purchase); refund is ignored for free / trial bookings.
 */
export async function markNoShow(coach: UserDoc, bookingId: string, refund: boolean) {
  const booking = await coachBooking(coach, bookingId);
  if (!['confirmed', 'completed'].includes(booking.status)) {
    throw new AppError('NO_SHOW_NOT_ALLOWED');
  }
  if (!inWindow(booking.startAt)) throw new AppError('NO_SHOW_WINDOW_PASSED');

  const now = new Date();
  const refunds = refund && booking.payment.status === 'paid';
  const marked = await BookingModel.findOneAndUpdate(
    {_id: booking._id, status: {$in: ['confirmed', 'completed']}},
    {
      $set: {
        status: 'no_show',
        noShow: {markedAt: now, refunded: refunds},
        ...(refunds && {'payment.status': 'refunded', 'payment.refundedAt': now}),
      },
    },
    {returnDocument: 'after'},
  );
  if (!marked) throw new AppError('NO_SHOW_NOT_ALLOWED');
  if (refunds && marked.payment.method === 'credits' && marked.payment.clientPackageId) {
    await returnCredit(marked.payment.clientPackageId);
  }
  return marked;
}

/** Removes a no-show (only without a refund): back to completed if the training is over, else confirmed. */
export async function undoNoShow(coach: UserDoc, bookingId: string): Promise<BookingDoc> {
  const booking = await coachBooking(coach, bookingId);
  if (booking.status !== 'no_show') throw new AppError('NO_SHOW_NOT_ALLOWED');
  if (!inWindow(booking.startAt)) throw new AppError('NO_SHOW_WINDOW_PASSED');
  if (booking.noShow?.refunded) throw new AppError('NO_SHOW_REFUNDED');
  const restored = await BookingModel.findOneAndUpdate(
    {_id: booking._id, status: 'no_show', 'noShow.refunded': {$ne: true}},
    {$set: {status: booking.endAt <= new Date() ? 'completed' : 'confirmed', noShow: null}},
    {returnDocument: 'after'},
  );
  if (!restored) throw new AppError('NO_SHOW_NOT_ALLOWED');
  return restored;
}
