import type http from 'node:http';
import {Server, type Socket} from 'socket.io';
import {z} from 'zod';

import {AppError} from '../lib/errors.js';
import {verifyAccessToken} from '../lib/jwt.js';
import {logger} from '../lib/logger.js';
import {UserModel, type UserDoc} from '../models/user.js';

let io: Server | null = null;

const room = (userId: string) => `user:${userId}`;

/** Emits an event to every connected device of the given users. No-op when realtime is not attached (tests). */
export function emitToUsers(userIds: string[], event: string, payload: unknown) {
  if (!io) return;
  for (const id of new Set(userIds)) io.to(room(id)).emit(event, payload);
}

type Ack = (
  response: {ok: true; data?: unknown} | {ok: false; error: {code: string; message: string}},
) => void;

function errorAck(ack: Ack | undefined, error: unknown) {
  if (typeof ack !== 'function') return;
  if (error instanceof AppError)
    ack({ok: false, error: {code: error.code, message: error.message}});
  else if (error instanceof z.ZodError)
    ack({ok: false, error: {code: 'VALIDATION_ERROR', message: 'Invalid payload'}});
  else {
    logger.error({err: error}, 'Socket handler failed');
    ack({ok: false, error: {code: 'INTERNAL', message: 'Something went wrong.'}});
  }
}

const SendPayload = z.object({
  conversationId: z.string().length(24),
  text: z.string().trim().min(1).max(2000),
});
const ConversationPayload = z.object({conversationId: z.string().length(24)});

export function attachRealtime(server: http.Server) {
  io = new Server(server, {cors: {origin: true}});

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') throw new AppError('UNAUTHORIZED');
      const payload = verifyAccessToken(token);
      const user = await UserModel.findById(payload.sub);
      if (!user?.onboardingCompleted) throw new AppError('UNAUTHORIZED');
      socket.data.userId = user.id;
      next();
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'UNAUTHORIZED';
      next(Object.assign(new Error(code), {data: {code}}));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    void socket.join(room(userId));
    const loadUser = async (): Promise<UserDoc> => {
      const user = await UserModel.findById(userId);
      if (!user) throw new AppError('UNAUTHORIZED');
      return user;
    };
    // Lazy import avoids a circular dependency (chat service emits through this module).
    const chat = () => import('../modules/chat/chat.service.js');

    socket.on('message:send', async (payload: unknown, ack?: Ack) => {
      try {
        const {conversationId, text} = SendPayload.parse(payload);
        const message = await (await chat()).sendMessage(await loadUser(), conversationId, text);
        ack?.({ok: true, data: message});
      } catch (error) {
        errorAck(ack, error);
      }
    });

    socket.on('typing', async (payload: unknown, ack?: Ack) => {
      try {
        const {conversationId} = ConversationPayload.parse(payload);
        const otherId = await (await chat()).otherParticipantId(await loadUser(), conversationId);
        emitToUsers([otherId], 'typing', {conversationId, userId});
        ack?.({ok: true});
      } catch (error) {
        errorAck(ack, error);
      }
    });

    socket.on('conversation:read', async (payload: unknown, ack?: Ack) => {
      try {
        const {conversationId} = ConversationPayload.parse(payload);
        await (await chat()).markRead(await loadUser(), conversationId);
        ack?.({ok: true});
      } catch (error) {
        errorAck(ack, error);
      }
    });
  });

  return io;
}

export function detachRealtime() {
  void io?.close();
  io = null;
}
