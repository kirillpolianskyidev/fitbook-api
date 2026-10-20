import {Types} from 'mongoose';

import {AppError} from '../../lib/errors.js';
import {BookingModel} from '../../models/booking.js';
import {CoachProfileModel} from '../../models/coachProfile.js';
import {ConversationModel, type ConversationDoc} from '../../models/conversation.js';
import {MessageModel, type MessageDoc} from '../../models/message.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {emitToUsers} from '../../realtime/socket.js';
import {toUserSummary} from '../users/users.service.js';

type Role = 'coach' | 'client';
const otherRole = (role: Role): Role => (role === 'coach' ? 'client' : 'coach');

export function toMessageDto(message: MessageDoc) {
  return {
    id: message.id as string,
    conversationId: message.conversationId.toString(),
    senderId: message.senderId.toString(),
    senderRole: message.senderRole as Role,
    text: message.text,
    createdAt: message.createdAt.toISOString(),
    readAt: message.readAt?.toISOString() ?? null,
  };
}

export async function toConversationDtos(viewer: UserDoc, conversations: ConversationDoc[]) {
  const role = viewer.role as Role;
  const otherIds = conversations.map(c => (role === 'coach' ? c.clientId : c.coachId));
  const others = await UserModel.find({_id: {$in: otherIds}})
    .select('firstName lastName avatarUrl')
    .lean();
  const byId = new Map(others.map(o => [o._id.toString(), o]));
  return conversations.map(c => {
    const otherId = (role === 'coach' ? c.clientId : c.coachId).toString();
    const other = byId.get(otherId);
    return {
      id: c.id as string,
      coachId: c.coachId.toString(),
      clientId: c.clientId.toString(),
      participant: other
        ? toUserSummary(other)
        : {id: otherId, firstName: '', lastName: '', avatarUrl: null},
      lastMessage: c.lastMessage?.text
        ? {
            text: c.lastMessage.text,
            senderId: c.lastMessage.senderId!.toString(),
            createdAt: c.lastMessage.createdAt!.toISOString(),
          }
        : null,
      unreadCount: c.unread?.[role] ?? 0,
      lastActivityAt: c.lastActivityAt.toISOString(),
    };
  });
}

export async function listConversations(user: UserDoc) {
  const filter = user.role === 'coach' ? {coachId: user._id} : {clientId: user._id};
  const conversations = await ConversationModel.find(filter).sort({lastActivityAt: -1}).limit(100);
  return {items: await toConversationDtos(user, conversations)};
}

export async function getOrCreateConversation(
  user: UserDoc,
  input: {coachId?: string; clientId?: string},
) {
  let coachId: Types.ObjectId;
  let clientId: Types.ObjectId;
  if (user.role === 'client') {
    if (!input.coachId)
      throw new AppError('VALIDATION_ERROR', undefined, {fields: {coachId: 'Required'}});
    coachId = new Types.ObjectId(input.coachId);
    clientId = user._id;
    if (!(await CoachProfileModel.exists({userId: coachId, isPublished: true}))) {
      throw new AppError('NOT_FOUND', 'Coach not found.');
    }
  } else {
    if (!input.clientId)
      throw new AppError('VALIDATION_ERROR', undefined, {fields: {clientId: 'Required'}});
    coachId = user._id;
    clientId = new Types.ObjectId(input.clientId);
    if (!(await BookingModel.exists({coachId, clientId}))) {
      throw new AppError('FORBIDDEN', 'You can message clients who booked with you.');
    }
  }
  const conversation = (await ConversationModel.findOneAndUpdate(
    {coachId, clientId},
    {$setOnInsert: {coachId, clientId, lastActivityAt: new Date()}},
    {upsert: true, returnDocument: 'after'},
  ))!;
  const [dto] = await toConversationDtos(user, [conversation]);
  return dto!;
}

export async function getConversationForMember(user: UserDoc, conversationId: string) {
  const conversation = await ConversationModel.findById(conversationId);
  if (!conversation) throw new AppError('NOT_FOUND', 'Conversation not found.');
  if (!conversation.coachId.equals(user._id) && !conversation.clientId.equals(user._id)) {
    throw new AppError('FORBIDDEN');
  }
  return conversation;
}

export async function listMessages(
  user: UserDoc,
  conversationId: string,
  before: string | undefined,
  limit: number,
) {
  const conversation = await getConversationForMember(user, conversationId);
  const filter: Record<string, unknown> = {conversationId: conversation._id};
  if (before) filter._id = {$lt: new Types.ObjectId(before)};
  const messages = await MessageModel.find(filter)
    .sort({_id: -1})
    .limit(limit + 1);
  const page = messages.slice(0, limit);
  return {
    items: page.map(toMessageDto),
    nextCursor: messages.length > limit ? page[page.length - 1]!.id : null,
  };
}

export async function sendMessage(user: UserDoc, conversationId: string, text: string) {
  const conversation = await getConversationForMember(user, conversationId);
  const role = user.role as Role;
  const message = await MessageModel.create({
    conversationId: conversation._id,
    senderId: user._id,
    senderRole: role,
    text,
  });
  const updated = await ConversationModel.findByIdAndUpdate(
    conversation._id,
    {
      $set: {
        lastMessage: {text, senderId: user._id, createdAt: message.createdAt},
        lastActivityAt: message.createdAt,
      },
      $inc: {[`unread.${otherRole(role)}`]: 1},
    },
    {returnDocument: 'after'},
  );
  const dto = toMessageDto(message);
  const recipients = [conversation.coachId.toString(), conversation.clientId.toString()];
  emitToUsers(recipients, 'message:new', {conversationId: conversation.id, message: dto});
  if (updated) {
    for (const viewerId of recipients) {
      const viewer = await UserModel.findById(viewerId);
      if (viewer) {
        const [conversationDto] = await toConversationDtos(viewer, [updated]);
        emitToUsers([viewerId], 'conversation:updated', {conversation: conversationDto});
      }
    }
  }
  return dto;
}

export async function markRead(user: UserDoc, conversationId: string) {
  const conversation = await getConversationForMember(user, conversationId);
  const role = user.role as Role;
  const readAt = new Date();
  await MessageModel.updateMany(
    {conversationId: conversation._id, senderId: {$ne: user._id}, readAt: null},
    {$set: {readAt}},
  );
  await ConversationModel.updateOne({_id: conversation._id}, {$set: {[`unread.${role}`]: 0}});
  const otherId = (role === 'coach' ? conversation.clientId : conversation.coachId).toString();
  emitToUsers([otherId], 'message:read', {
    conversationId: conversation.id,
    readerId: user.id,
    readAt: readAt.toISOString(),
  });
}

export async function otherParticipantId(user: UserDoc, conversationId: string) {
  const conversation = await getConversationForMember(user, conversationId);
  return (
    conversation.coachId.equals(user._id) ? conversation.clientId : conversation.coachId
  ).toString();
}
