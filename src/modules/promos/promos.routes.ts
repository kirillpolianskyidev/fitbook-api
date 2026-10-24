import {route} from '../../lib/route.js';
import {IdParams, itemsOf} from '../../lib/schemas.js';
import {
  CreatePromoCodeBody,
  PromoCheckBody,
  PromoCodeSchema,
  PromoQuoteSchema,
  UpdatePromoCodeBody,
  promoErrors,
} from './promos.schemas.js';
import * as service from './promos.service.js';

const coachTags = ['Coach: promo codes'];

route({
  method: 'get',
  path: '/coach/promo-codes',
  tags: coachTags,
  summary: 'My promo codes, newest first',
  auth: 'coach',
  response: itemsOf(PromoCodeSchema),
  handler: async ({user}) => ({
    items: (await service.listPromoCodes(user._id)).map(service.toPromoCodeDto),
  }),
});

route({
  method: 'post',
  path: '/coach/promo-codes',
  tags: coachTags,
  summary: 'Create a promo code (percent or amount off bookings and / or packages)',
  auth: 'coach',
  body: CreatePromoCodeBody,
  response: PromoCodeSchema,
  errors: ['PROMO_CODE_TAKEN'],
  handler: async ({user, body}) =>
    service.toPromoCodeDto(await service.createPromoCode(user._id, body)),
});

route({
  method: 'patch',
  path: '/coach/promo-codes/:id',
  tags: coachTags,
  summary: 'Update a promo code (everything but the code)',
  auth: 'coach',
  params: IdParams,
  body: UpdatePromoCodeBody,
  response: PromoCodeSchema,
  errors: ['NOT_FOUND'],
  handler: async ({user, params, body}) =>
    service.toPromoCodeDto(await service.updatePromoCode(user._id, params.id, body)),
});

route({
  method: 'delete',
  path: '/coach/promo-codes/:id',
  tags: coachTags,
  summary: 'Delete a promo code (deactivated instead if it was used)',
  auth: 'coach',
  status: 204,
  params: IdParams,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    await service.deletePromoCode(user._id, params.id);
  },
});

route({
  method: 'post',
  path: '/promo-codes/check',
  tags: ['Promo codes'],
  summary:
    'Check a promo code for a booking (count trainings) or a package and get the discounted price',
  auth: 'client',
  status: 200,
  body: PromoCheckBody,
  response: PromoQuoteSchema,
  errors: ['NOT_FOUND', ...promoErrors],
  handler: ({user, body}) => service.checkPromo(user, body),
});
