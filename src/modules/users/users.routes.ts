import {route} from '../../lib/route.js';
import {TokensSchema} from '../auth/auth.schemas.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {
  ChangePasswordBody,
  OnboardingBody,
  TrialStatusSchema,
  UpdateMeBody,
  UserSchema,
} from './users.schemas.js';
import {
  changePassword,
  completeOnboarding,
  toUserDto,
  trialStatus,
  updateMe,
} from './users.service.js';
import {z} from 'zod';

const MeSchema = UserSchema.extend({
  coachProfile: z
    .object({isPublished: z.boolean(), headline: z.string()})
    .nullable()
    .meta({description: 'Present for coaches'}),
}).meta({id: 'Me'});

route({
  method: 'get',
  path: '/me',
  tags: ['Me'],
  summary: 'Current user',
  auth: 'user',
  allowNotOnboarded: true,
  response: MeSchema,
  handler: async ({user}) => {
    const profile =
      user.role === 'coach' ? await CoachProfileModel.findOne({userId: user._id}).lean() : null;
    return {
      ...toUserDto(user),
      coachProfile: profile ? {isPublished: profile.isPublished, headline: profile.headline} : null,
    };
  },
});

route({
  method: 'patch',
  path: '/me',
  tags: ['Me'],
  summary: 'Update name, avatar, home area or theme',
  auth: 'user',
  allowNotOnboarded: true,
  body: UpdateMeBody,
  response: UserSchema,
  handler: async ({user, body}) => toUserDto(await updateMe(user, body)),
});

route({
  method: 'post',
  path: '/me/onboarding',
  tags: ['Me'],
  summary: 'Complete onboarding for social sign-in accounts (role + home area)',
  auth: 'user',
  allowNotOnboarded: true,
  status: 200,
  body: OnboardingBody,
  response: UserSchema,
  errors: ['FORBIDDEN'],
  handler: async ({user, body}) => toUserDto(await completeOnboarding(user, body)),
});

route({
  method: 'patch',
  path: '/me/password',
  tags: ['Me'],
  summary:
    'Change or set password (current password required if one exists). Signs out all other sessions and ' +
    'returns a new token pair for this device.',
  auth: 'user',
  allowNotOnboarded: true,
  status: 200,
  body: ChangePasswordBody,
  response: TokensSchema,
  errors: ['INVALID_CREDENTIALS'],
  handler: ({user, body, req}) =>
    changePassword(user, body.currentPassword, body.newPassword, req.get('user-agent')),
});

route({
  method: 'get',
  path: '/me/trial',
  tags: ['Me'],
  summary: 'Is the free trial still available for me?',
  auth: 'client',
  response: TrialStatusSchema,
  handler: ({user}) => trialStatus(user),
});
