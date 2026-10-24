import {z} from 'zod';

import {dateYMD, MoneySchema, objectId} from '../../lib/schemas.js';

export const DiscountSchema = z
  .object({
    type: z.enum(['percent', 'amount']),
    value: z.number().int().meta({description: 'percent: 1-100; amount: cents > 0'}),
  })
  .meta({id: 'Discount'});

const ValidDiscount = DiscountSchema.superRefine((d, ctx) => {
  if (d.type === 'percent' && (d.value < 1 || d.value > 100)) {
    ctx.addIssue({code: 'custom', path: ['value'], message: 'Percent must be 1-100'});
  }
  if (d.type === 'amount' && d.value < 1) {
    ctx.addIssue({code: 'custom', path: ['value'], message: 'Amount must be greater than 0'});
  }
});

const AppliesTo = z
  .array(z.enum(['bookings', 'packages']))
  .min(1)
  .max(2)
  .refine(list => new Set(list).size === list.length, 'Must be unique');

export const PromoCodeSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    discount: DiscountSchema,
    validFrom: z.string().nullable(),
    validUntil: z.string().nullable(),
    maxUses: z.number().int().nullable(),
    usesCount: z.number().int(),
    newClientsOnly: z.boolean(),
    appliesTo: z.array(z.enum(['bookings', 'packages'])),
    isActive: z.boolean(),
    createdAt: z.string(),
  })
  .meta({id: 'PromoCode'});

const dateRange = <T extends {validFrom?: string | null; validUntil?: string | null}>(body: T) =>
  !body.validFrom || !body.validUntil || body.validFrom <= body.validUntil;

export const CreatePromoCodeBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{4,20}$/, '4-20 letters A-Z and digits 0-9')
      .transform(code => code.toUpperCase()),
    discount: ValidDiscount,
    validFrom: dateYMD.nullable().optional(),
    validUntil: dateYMD.nullable().optional(),
    maxUses: z.number().int().min(1).nullable().optional(),
    newClientsOnly: z.boolean().default(false),
    appliesTo: AppliesTo.default(['bookings', 'packages']),
    isActive: z.boolean().default(true),
  })
  .refine(dateRange, {message: 'validFrom must not be after validUntil', path: ['validUntil']})
  .meta({id: 'CreatePromoCodeRequest'});

export const UpdatePromoCodeBody = z
  .object({
    discount: ValidDiscount.optional(),
    validFrom: dateYMD.nullable().optional(),
    validUntil: dateYMD.nullable().optional(),
    maxUses: z.number().int().min(1).nullable().optional(),
    newClientsOnly: z.boolean().optional(),
    appliesTo: AppliesTo.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(dateRange, {message: 'validFrom must not be after validUntil', path: ['validUntil']})
  .meta({id: 'UpdatePromoCodeRequest'});

export const PromoCheckBody = z
  .object({
    coachId: objectId,
    code: z.string().trim().min(1).max(40),
    target: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('booking'),
        sessionTypeId: objectId
          .nullable()
          .optional()
          .meta({description: 'Individual training type'}),
        sessionId: objectId.nullable().optional().meta({description: 'Group session'}),
        count: z
          .number()
          .int()
          .min(1)
          .max(84)
          .default(1)
          .meta({description: 'Trainings of a series'}),
      }),
      z.object({type: z.literal('package'), packageId: objectId}),
    ]),
  })
  .meta({id: 'PromoCheckRequest'});

export const PromoQuoteSchema = z
  .object({
    code: z.string(),
    label: z.string().meta({example: '−20%'}),
    unitPrice: MoneySchema.meta({description: 'One training / package before the discount'}),
    unitDiscount: MoneySchema,
    total: MoneySchema.meta({description: 'For all count trainings, after the discount'}),
    totalDiscount: MoneySchema,
  })
  .meta({id: 'PromoQuote'});

export const AppliedPromoSchema = z
  .object({code: z.string(), discount: MoneySchema})
  .meta({id: 'AppliedPromo'});

export const promoCodeField = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .optional()
  .meta({description: "Coach's promo code (not with isTrial / useCredits)"});

/** Errors of requests that accept a promoCode. */
const PROMO_ERRORS = [
  'PROMO_INVALID',
  'PROMO_EXPIRED',
  'PROMO_USED_UP',
  'PROMO_ALREADY_USED',
  'PROMO_NEW_CLIENTS_ONLY',
  'PROMO_NOT_APPLICABLE',
] as const;
export const promoErrors = [...PROMO_ERRORS];
