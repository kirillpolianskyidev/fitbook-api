import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {io as connect, type Socket} from 'socket.io-client';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {attachRealtime, detachRealtime} from '../src/realtime/socket.js';
import {chicagoAt, publishedCoach} from './fixtures.js';
import {api, app, registerUser, useTestDb} from './helpers.js';

useTestDb();

async function bookedPair() {
  const coach = await publishedCoach();
  const client = await registerUser('client');
  const booking = await api()
    .post('/api/v1/bookings')
    .set(client.auth)
    .send({sessionTypeId: coach.individualTypeId, startAt: chicagoAt(5, '10:00')});
  return {coach, client, bookingId: booking.body.id as string};
}

describe('notes', () => {
  it('both participants write and edit notes before and after the training', async () => {
    const {coach, client, bookingId} = await bookedPair();
    const created = await api()
      .post(`/api/v1/bookings/${bookingId}/notes`)
      .set(client.auth)
      .send({phase: 'before', text: 'Left knee is sore, please go easy on squats.'});
    expect(created.status).toBe(201);
    expect(created.body.author).toMatchObject({id: client.user.id, role: 'client'});

    const edited = await api()
      .patch(`/api/v1/notes/${created.body.id}`)
      .set(coach.auth)
      .send({text: 'Left knee is sore. Plan: box squats instead of back squats.'});
    expect(edited.body).toMatchObject({
      author: {role: 'client'},
      lastEditedBy: {id: coach.user.id, role: 'coach'},
    });

    await api()
      .post(`/api/v1/bookings/${bookingId}/notes`)
      .set(coach.auth)
      .send({phase: 'after', text: 'Great session, +5 kg next time.'});
    const notes = await api().get(`/api/v1/bookings/${bookingId}/notes`).set(client.auth);
    expect(notes.body.before).toHaveLength(1);
    expect(notes.body.after).toHaveLength(1);
    expect(
      (await api().get(`/api/v1/bookings/${bookingId}`).set(client.auth)).body.notesCount,
    ).toBe(2);
  });

  it('outsiders cannot read or edit notes', async () => {
    const {client, bookingId} = await bookedPair();
    const note = await api()
      .post(`/api/v1/bookings/${bookingId}/notes`)
      .set(client.auth)
      .send({phase: 'before', text: 'Private'});
    const stranger = await registerUser('client');
    expect(
      (await api().get(`/api/v1/bookings/${bookingId}/notes`).set(stranger.auth)).body.error.code,
    ).toBe('FORBIDDEN');
    expect(
      (await api().patch(`/api/v1/notes/${note.body.id}`).set(stranger.auth).send({text: 'x'})).body
        .error.code,
    ).toBe('FORBIDDEN');
    expect((await api().delete(`/api/v1/notes/${note.body.id}`).set(client.auth)).status).toBe(204);
  });
});

describe('chat', () => {
  it('opens a conversation, tracks unread counts and pages messages', async () => {
    const {coach, client} = await bookedPair();
    const conversation = await api()
      .post('/api/v1/conversations')
      .set(client.auth)
      .send({coachId: coach.user.id});
    expect(conversation.status).toBe(200);
    const again = await api()
      .post('/api/v1/conversations')
      .set(coach.auth)
      .send({clientId: client.user.id});
    expect(again.body.id).toBe(conversation.body.id);

    for (const text of ['Hi coach!', 'Is parking available?', 'See you Tuesday']) {
      await api()
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .set(client.auth)
        .send({text});
    }
    const coachList = await api().get('/api/v1/conversations').set(coach.auth);
    expect(coachList.body.items[0]).toMatchObject({
      unreadCount: 3,
      participant: {id: client.user.id},
      lastMessage: {text: 'See you Tuesday'},
    });

    const page1 = await api()
      .get(`/api/v1/conversations/${conversation.body.id}/messages?limit=2`)
      .set(coach.auth);
    expect(page1.body.items.map((m: {text: string}) => m.text)).toEqual([
      'See you Tuesday',
      'Is parking available?',
    ]);
    const page2 = await api()
      .get(
        `/api/v1/conversations/${conversation.body.id}/messages?limit=2&before=${page1.body.nextCursor}`,
      )
      .set(coach.auth);
    expect(page2.body).toMatchObject({items: [{text: 'Hi coach!'}], nextCursor: null});

    expect(
      (await api().post(`/api/v1/conversations/${conversation.body.id}/read`).set(coach.auth))
        .status,
    ).toBe(204);
    expect(
      (await api().get('/api/v1/conversations').set(coach.auth)).body.items[0].unreadCount,
    ).toBe(0);
    const read = await api()
      .get(`/api/v1/conversations/${conversation.body.id}/messages`)
      .set(client.auth);
    expect(read.body.items.every((m: {readAt: string | null}) => m.readAt !== null)).toBe(true);
  });

  it('coaches can only message their clients; outsiders cannot read', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    expect(
      (await api().post('/api/v1/conversations').set(coach.auth).send({clientId: client.user.id}))
        .body.error.code,
    ).toBe('FORBIDDEN');
    const conversation = await api()
      .post('/api/v1/conversations')
      .set(client.auth)
      .send({coachId: coach.user.id});
    const stranger = await registerUser('client');
    expect(
      (await api().get(`/api/v1/conversations/${conversation.body.id}/messages`).set(stranger.auth))
        .body.error.code,
    ).toBe('FORBIDDEN');
  });

  describe('realtime', () => {
    let server: http.Server;
    let url: string;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      server = http.createServer(app);
      attachRealtime(server);
      await new Promise<void>(resolve => server.listen(0, resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      sockets.forEach(s => s.disconnect());
      detachRealtime();
      await new Promise(resolve => server.close(resolve));
    });

    const open = (token: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = connect(url, {
          auth: {token},
          transports: ['websocket'],
          reconnection: false,
        });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
      });

    it('delivers messages, typing and read receipts in realtime', async () => {
      const {coach, client} = await bookedPair();
      const conversation = await api()
        .post('/api/v1/conversations')
        .set(client.auth)
        .send({coachId: coach.user.id});
      const coachSocket = await open(coach.token);
      const clientSocket = await open(client.token);

      const received = new Promise<{message: {text: string}}>(resolve =>
        coachSocket.once('message:new', resolve),
      );
      await api()
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .set(client.auth)
        .send({text: 'Hello from REST'});
      expect((await received).message.text).toBe('Hello from REST');

      const viaSocket = new Promise<{message: {text: string}}>(resolve =>
        coachSocket.once('message:new', resolve),
      );
      const ack = await clientSocket.emitWithAck('message:send', {
        conversationId: conversation.body.id,
        text: 'Hello from socket',
      });
      expect(ack).toMatchObject({ok: true, data: {text: 'Hello from socket'}});
      expect((await viaSocket).message.text).toBe('Hello from socket');

      const typing = new Promise<{conversationId: string}>(resolve =>
        coachSocket.once('typing', resolve),
      );
      await clientSocket.emitWithAck('typing', {conversationId: conversation.body.id});
      expect((await typing).conversationId).toBe(conversation.body.id);

      const receipt = new Promise<{readerId: string}>(resolve =>
        clientSocket.once('message:read', resolve),
      );
      await coachSocket.emitWithAck('conversation:read', {conversationId: conversation.body.id});
      expect((await receipt).readerId).toBe(coach.user.id);
    });

    it('rejects sockets without a valid token', async () => {
      await expect(open('bad-token')).rejects.toThrow('UNAUTHORIZED');
    });
  });
});
