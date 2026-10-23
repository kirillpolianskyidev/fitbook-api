import {z} from 'zod';

export const ReviewSchema = z
  .object({
    id: z.string(),
    rating: z.number().int().min(1).max(5),
    text: z.string().nullable(),
    author: z.object({
      id: z.string(),
      name: z.string().meta({description: 'First name + last initial, e.g. "Jamie L."'}),
      avatarUrl: z.string().nullable(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({id: 'Review'});

export const ReviewSummarySchema = z
  .object({
    average: z.number().meta({description: 'Rounded to 2 decimals; 0 without reviews'}),
    count: z.number().int(),
    distribution: z.object({
      '1': z.number().int(),
      '2': z.number().int(),
      '3': z.number().int(),
      '4': z.number().int(),
      '5': z.number().int(),
    }),
  })
  .meta({id: 'ReviewSummary'});

export const ReviewPageSchema = z
  .object({
    items: z.array(ReviewSchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    summary: ReviewSummarySchema,
  })
  .meta({id: 'ReviewPage'});

export const MyReviewSchema = z
  .object({
    review: ReviewSchema.nullable(),
    canCreate: z.boolean().meta({
      description: 'No review yet and at least one completed training with this coach',
    }),
    editableUntil: z.string().nullable().meta({
      description: 'review.createdAt + 24h; the review can be changed while now < editableUntil',
    }),
  })
  .meta({id: 'MyReview'});

export const ReviewListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const ReviewBody = z
  .object({
    rating: z.number().int().min(1).max(5),
    text: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .optional()
      .transform(value => (value ? value : null))
      .meta({description: 'Optional, trimmed, up to 1000 characters; empty -> null'}),
  })
  .meta({id: 'ReviewRequest'});
