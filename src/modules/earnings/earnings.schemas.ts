import {z} from 'zod';

import {dateYMD, MoneySchema} from '../../lib/schemas.js';
import {UserSummarySchema} from '../users/users.schemas.js';

export const EarningsQuery = z.object({
  period: z.enum(['week', 'month', 'year']).default('week'),
  date: dateYMD
    .optional()
    .meta({description: "Any day inside the period (coach's time zone), default today"}),
});

export const EarningsSchema = z
  .object({
    period: z.enum(['week', 'month', 'year']),
    from: z.string().meta({description: 'First day of the period (YYYY-MM-DD)'}),
    to: z.string().meta({description: 'Last day of the period (YYYY-MM-DD)'}),
    total: MoneySchema.meta({description: 'Earned trainings + packages sold in the period'}),
    upcoming: MoneySchema.meta({
      description: 'Paid trainings later in the period (not started yet)',
    }),
    previousTotal: MoneySchema,
    changePercent: z.number().int().nullable().meta({description: 'null when previousTotal is 0'}),
    breakdown: z.object({
      individual: MoneySchema,
      group: MoneySchema,
      packages: MoneySchema,
      refunds: MoneySchema.meta({description: 'Money refunded in the period (informational)'}),
    }),
    counts: z.object({
      trainings: z.number().int(),
      packagesSold: z.number().int(),
      clients: z.number().int(),
    }),
    chart: z
      .array(z.object({start: z.string(), amount: MoneySchema}))
      .meta({description: 'week: 7 days, month: every day, year: 12 months'}),
    topClients: z.array(
      z.object({client: UserSummarySchema, amount: MoneySchema, trainings: z.number().int()}),
    ),
  })
  .meta({id: 'Earnings'});
