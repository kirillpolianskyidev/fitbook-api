import {z} from 'zod';

import {MoneySchema, objectId} from '../../lib/schemas.js';
import {UserSummarySchema} from '../users/users.schemas.js';

const PositiveMoney = MoneySchema.refine(m => m.amountCents > 0, {
  message: 'Must be greater than 0',
  path: ['amountCents'],
});

export const PackageSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    credits: z.number().int(),
    price: MoneySchema,
    validityDays: z.number().int(),
    isActive: z.boolean(),
    pricePerCredit: MoneySchema.meta({description: 'price / credits, rounded to the cent'}),
  })
  .meta({id: 'Package'});

export const ClientPackageSchema = z
  .object({
    id: z.string(),
    packageId: z.string(),
    title: z.string(),
    coach: UserSummarySchema,
    creditsTotal: z.number().int(),
    creditsLeft: z.number().int(),
    price: MoneySchema.meta({description: 'What was paid'}),
    purchasedAt: z.string(),
    expiresAt: z.string(),
    expired: z
      .boolean()
      .meta({description: 'expiresAt has passed: the credits left cannot be used'}),
  })
  .meta({id: 'ClientPackage'});

export const MyPackagesSchema = z
  .object({
    items: z.array(ClientPackageSchema),
    creditsAvailable: z.number().int().meta({
      description: 'Sum of creditsLeft of purchases that are not expired (for coachId if given)',
    }),
  })
  .meta({id: 'MyPackages'});

export const CreatePackageBody = z
  .object({
    title: z.string().trim().min(1).max(60),
    credits: z.number().int().min(1).max(100),
    price: PositiveMoney,
    validityDays: z.number().int().min(7).max(365).default(90),
  })
  .meta({id: 'CreatePackageRequest'});

export const UpdatePackageBody = z
  .object({
    title: z.string().trim().min(1).max(60).optional(),
    credits: z.number().int().min(1).max(100).optional(),
    price: PositiveMoney.optional(),
    validityDays: z.number().int().min(7).max(365).optional(),
    isActive: z.boolean().optional(),
  })
  .meta({id: 'UpdatePackageRequest'});

export const MyPackagesQuery = z.object({coachId: objectId.optional()});
