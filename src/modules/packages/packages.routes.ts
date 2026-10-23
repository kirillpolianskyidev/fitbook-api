import {route} from '../../lib/route.js';
import {IdParams, itemsOf} from '../../lib/schemas.js';
import {
  ClientPackageSchema,
  CreatePackageBody,
  MyPackagesQuery,
  MyPackagesSchema,
  PackageSchema,
  UpdatePackageBody,
} from './packages.schemas.js';
import * as service from './packages.service.js';

const coachTags = ['Coach: packages'];

route({
  method: 'get',
  path: '/coach/packages',
  tags: coachTags,
  summary: 'My packages (active and inactive)',
  auth: 'coach',
  response: itemsOf(PackageSchema),
  handler: async ({user}) => ({
    items: (await service.listOwnPackages(user._id)).map(service.toPackageDto),
  }),
});

route({
  method: 'post',
  path: '/coach/packages',
  tags: coachTags,
  summary: 'Create a package (N credits for a price, valid validityDays after purchase)',
  auth: 'coach',
  body: CreatePackageBody,
  response: PackageSchema,
  handler: async ({user, body}) =>
    service.toPackageDto(await service.createPackage(user._id, body)),
});

route({
  method: 'patch',
  path: '/coach/packages/:id',
  tags: coachTags,
  summary: 'Update a package (applies to new purchases only)',
  auth: 'coach',
  params: IdParams,
  body: UpdatePackageBody,
  response: PackageSchema,
  errors: ['NOT_FOUND'],
  handler: async ({user, params, body}) =>
    service.toPackageDto(await service.updatePackage(user._id, params.id, body)),
});

route({
  method: 'delete',
  path: '/coach/packages/:id',
  tags: coachTags,
  summary: 'Delete a package (deactivated instead if it was already bought)',
  auth: 'coach',
  status: 204,
  params: IdParams,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    await service.deletePackage(user._id, params.id);
  },
});

const clientTags = ['Packages'];

route({
  method: 'post',
  path: '/packages/:id/purchase',
  tags: clientTags,
  summary: 'Buy a package (mock payment, paid immediately)',
  auth: 'client',
  params: IdParams,
  response: ClientPackageSchema,
  errors: ['NOT_FOUND', 'PACKAGE_INACTIVE'],
  handler: ({user, params}) => service.purchasePackage(user, params.id),
});

route({
  method: 'get',
  path: '/me/packages',
  tags: clientTags,
  summary: 'My purchased packages and available credits (optionally for one coach)',
  auth: 'client',
  query: MyPackagesQuery,
  response: MyPackagesSchema,
  handler: ({user, query}) => service.myPackages(user, query.coachId),
});
