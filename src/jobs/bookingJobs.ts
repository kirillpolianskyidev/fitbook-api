import {
  completePastSessions,
  releaseExpiredPendingBookings,
} from '../modules/bookings/bookings.service.js';
import {registerJob} from './index.js';

registerJob({
  name: 'releaseExpiredPendingBookings',
  everyMs: 60_000,
  run: () => releaseExpiredPendingBookings(),
});
registerJob({
  name: 'completePastSessions',
  everyMs: 10 * 60_000,
  run: () => completePastSessions(),
});
