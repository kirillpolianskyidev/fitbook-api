import {z} from 'zod';

import {route} from '../../lib/route.js';
import {IdParams, itemsOf, objectId, RoleSchema} from '../../lib/schemas.js';
import {UserSummarySchema} from '../users/users.schemas.js';
import * as service from './chat.service.js';

export const MessageSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    senderId: z.string(),
    senderRole: RoleSchema,
    text: z.string(),
    createdAt: z.string(),
    readAt: z.string().nullable(),
  })
  .meta({id: 'Message'});

export const ConversationSchema = z
  .object({
    id: z.string(),
    coachId: z.string(),
    clientId: z.string(),
    participant: UserSummarySchema.meta({description: 'The other person in the conversation'}),
    lastMessage: z
      .object({text: z.string(), senderId: z.string(), createdAt: z.string()})
      .nullable(),
    unreadCount: z.number().int(),
    lastActivityAt: z.string(),
  })
  .meta({id: 'Conversation'});

const tags = ['Chat'];

route({
  method: 'get',
  path: '/conversations',
  tags,
  summary: 'My conversations, most recent first, with unread counts',
  auth: 'user',
  response: itemsOf(ConversationSchema),
  handler: ({user}) => service.listConversations(user),
});

route({
  method: 'post',
  path: '/conversations',
  tags,
  summary: 'Open (get or create) a conversation: clients pass coachId, coaches pass clientId',
  auth: 'user',
  status: 200,
  body: z.object({coachId: objectId.optional(), clientId: objectId.optional()}),
  response: ConversationSchema,
  errors: ['NOT_FOUND', 'FORBIDDEN'],
  handler: ({user, body}) => service.getOrCreateConversation(user, body),
});

route({
  method: 'get',
  path: '/conversations/:id/messages',
  tags,
  summary: 'Messages, newest first. Pass nextCursor as `before` to load older ones.',
  auth: 'user',
  params: IdParams,
  query: z.object({
    before: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  }),
  response: z.object({items: z.array(MessageSchema), nextCursor: z.string().nullable()}),
  errors: ['NOT_FOUND', 'FORBIDDEN'],
  handler: ({user, params, query}) =>
    service.listMessages(user, params.id, query.before, query.limit),
});

route({
  method: 'post',
  path: '/conversations/:id/messages',
  tags,
  summary: 'Send a message (also delivered in realtime via Socket.IO)',
  auth: 'user',
  params: IdParams,
  body: z.object({text: z.string().trim().min(1).max(2000)}),
  response: MessageSchema,
  errors: ['NOT_FOUND', 'FORBIDDEN'],
  handler: ({user, params, body}) => service.sendMessage(user, params.id, body.text),
});

route({
  method: 'post',
  path: '/conversations/:id/read',
  tags,
  summary: 'Mark all messages from the other person as read',
  auth: 'user',
  status: 204,
  params: IdParams,
  errors: ['NOT_FOUND', 'FORBIDDEN'],
  handler: async ({user, params}) => {
    await service.markRead(user, params.id);
  },
});
