import {route} from '../../lib/route.js';
import {EarningsQuery, EarningsSchema} from './earnings.schemas.js';
import {coachEarnings} from './earnings.service.js';

route({
  method: 'get',
  path: '/coach/earnings',
  tags: ['Coach: earnings'],
  summary:
    'My earnings for a week, month or year (coach time zone): total, upcoming, breakdown, chart, top clients',
  description:
    'Earned = card-paid (mock) trainings that started in the period (confirmed, completed or no-show without ' +
    'refund); upcoming = paid trainings later in the period; packages by purchase date; credit bookings are not ' +
    'counted again; refunds are listed separately. total = earned + packages.',
  auth: 'coach',
  query: EarningsQuery,
  response: EarningsSchema,
  handler: ({user, query}) => coachEarnings(user, query.period, query.date),
});
