import {describe, expect, it} from 'vitest';

import {chicagoAt, chicagoDate, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;

/** A coach and a client who booked a training with them. */
async function coachWithClient() {
  const coach = await publishedCoach();
  const client = await registerUser('client');
  const booked = await api()
    .post(`${v1}/bookings`)
    .set(client.auth)
    .send({sessionTypeId: coach.individualTypeId, startAt: chicagoAt(2, '09:00')});
  if (booked.status !== 201) throw new Error(JSON.stringify(booked.body));
  return {coach, client};
}

const exercises = [
  {name: 'Goblet squat', sets: 3, reps: '10', videoUrl: 'https://example.com/squat'},
  {name: 'Plank', duration: '45 sec'},
  {name: 'Walk', note: 'Easy pace', duration: '30 min'},
];

async function assign(coach: {auth: Auth}, clientId: string, body: Record<string, unknown> = {}) {
  const res = await api()
    .post(`${v1}/coach/clients/${clientId}/assignments`)
    .set(coach.auth)
    .send({title: 'Week 1', exercises, ...body});
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body;
}
const mark = (auth: Auth, id: string, exerciseId: string, status: string, note?: string) =>
  api()
    .put(`${v1}/me/assignments/${id}/exercises/${exerciseId}/result`)
    .set(auth)
    .send({status, ...(note && {note})});

describe('assignments: coach', () => {
  it('creates and lists for own clients only; others -> NOT_FOUND', async () => {
    const {coach, client} = await coachWithClient();
    const created = await assign(coach, client.user.id, {
      note: 'Do it twice',
      dueDate: chicagoDate(5),
    });
    expect(created).toMatchObject({
      coach: {id: coach.user.id},
      client: {id: client.user.id},
      title: 'Week 1',
      note: 'Do it twice',
      dueDate: chicagoDate(5),
      status: 'open',
      progress: {done: 0, partial: 0, skipped: 0, total: 3},
      clientNote: null,
    });
    expect(created.exercises[0]).toMatchObject({
      id: expect.any(String),
      name: 'Goblet squat',
      sets: 3,
      reps: '10',
      duration: null,
      note: null,
      videoUrl: 'https://example.com/squat',
      result: null,
    });
    const second = await assign(coach, client.user.id, {title: 'Week 2'});
    const list = await api()
      .get(`${v1}/coach/clients/${client.user.id}/assignments`)
      .set(coach.auth);
    expect(list.body.items.map((a: {id: string}) => a.id)).toEqual([second.id, created.id]);

    // A client without a booking with this coach.
    const stranger = await registerUser('client');
    const foreign = await api()
      .post(`${v1}/coach/clients/${stranger.user.id}/assignments`)
      .set(coach.auth)
      .send({title: 'x', exercises});
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
    // Another coach cannot edit it.
    const otherCoach = await publishedCoach();
    expect(
      (
        await api()
          .patch(`${v1}/coach/assignments/${created.id}`)
          .set(otherCoach.auth)
          .send({title: 'Hacked'})
      ).status,
    ).toBe(404);
    // Validation.
    const bad = await api()
      .post(`${v1}/coach/clients/${client.user.id}/assignments`)
      .set(coach.auth)
      .send({title: '', exercises: [{name: 'x', videoUrl: 'http://insecure.com', sets: 0}]});
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details.fields)).toEqual(
      expect.arrayContaining(['title', 'exercises.0.videoUrl', 'exercises.0.sets']),
    );
    expect(
      (await api().get(`${v1}/coach/clients/${client.user.id}/assignments`).set(client.auth))
        .status,
    ).toBe(403);
  });

  it('PATCH keeps results of exercises with the same id, adds new ones, removes missing', async () => {
    const {coach, client} = await coachWithClient();
    const created = await assign(coach, client.user.id);
    const [squat, plank, walk] = created.exercises;
    await mark(client.auth, created.id, squat.id, 'done');
    await mark(client.auth, created.id, walk.id, 'skipped');

    const res = await api()
      .patch(`${v1}/coach/assignments/${created.id}`)
      .set(coach.auth)
      .send({
        title: 'Week 1 (updated)',
        dueDate: null,
        exercises: [
          {id: squat.id, name: 'Goblet squat', sets: 4, reps: '8'},
          {id: plank.id, name: 'Side plank', duration: '30 sec'},
          {name: 'Lunges', sets: 3, reps: '12'},
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({title: 'Week 1 (updated)', dueDate: null});
    expect(res.body.exercises).toHaveLength(3);
    expect(res.body.exercises[0]).toMatchObject({
      id: squat.id,
      sets: 4,
      reps: '8',
      videoUrl: null,
      result: {status: 'done'},
    });
    expect(res.body.exercises[1]).toMatchObject({id: plank.id, name: 'Side plank', result: null});
    expect(res.body.exercises[2]).toMatchObject({name: 'Lunges', result: null});
    expect(res.body.exercises.map((e: {id: string}) => e.id)).not.toContain(walk.id);
    expect(res.body.progress).toEqual({done: 1, partial: 0, skipped: 0, total: 3});

    const unknown = await api()
      .patch(`${v1}/coach/assignments/${created.id}`)
      .set(coach.auth)
      .send({exercises: [{id: walk.id, name: 'Walk'}]});
    expect(unknown.status).toBe(400);

    expect(
      (await api().delete(`${v1}/coach/assignments/${created.id}`).set(coach.auth)).status,
    ).toBe(204);
    expect((await api().get(`${v1}/me/assignments/${created.id}`).set(client.auth)).status).toBe(
      404,
    );
  });
});

describe('assignments: client', () => {
  it('statuses open -> in_progress -> partial / done; clearing a mark; client note', async () => {
    const {coach, client} = await coachWithClient();
    const a = await assign(coach, client.user.id);
    const ids = a.exercises.map((e: {id: string}) => e.id) as string[];

    const first = await mark(client.auth, a.id, ids[0]!, 'done', 'Felt good');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: 'in_progress',
      progress: {done: 1, partial: 0, skipped: 0, total: 3},
    });
    expect(first.body.exercises[0].result).toEqual({
      status: 'done',
      note: 'Felt good',
      updatedAt: expect.any(String),
    });
    await mark(client.auth, a.id, ids[1]!, 'partial');
    const all = await mark(client.auth, a.id, ids[2]!, 'skipped');
    expect(all.body).toMatchObject({
      status: 'partial',
      progress: {done: 1, partial: 1, skipped: 1, total: 3},
    });
    await mark(client.auth, a.id, ids[1]!, 'done');
    const done = await mark(client.auth, a.id, ids[2]!, 'done');
    expect(done.body.status).toBe('done');

    const cleared = await api()
      .delete(`${v1}/me/assignments/${a.id}/exercises/${ids[2]}/result`)
      .set(client.auth);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({status: 'in_progress', progress: {done: 2}});
    expect(cleared.body.exercises[2].result).toBeNull();

    const note = await api()
      .put(`${v1}/me/assignments/${a.id}/note`)
      .set(client.auth)
      .send({note: 'Knee hurt a bit'});
    expect(note.body.clientNote).toBe('Knee hurt a bit');
    const removed = await api()
      .put(`${v1}/me/assignments/${a.id}/note`)
      .set(client.auth)
      .send({note: null});
    expect(removed.body.clientNote).toBeNull();

    const badStatus = await mark(client.auth, a.id, ids[0]!, 'maybe');
    expect(badStatus.status).toBe(400);
    const badExercise = await mark(client.auth, a.id, '0123456789abcdef01234567', 'done');
    expect(badExercise.status).toBe(404);
  });

  it('status=active filter and dueDate order; others cannot see my assignments', async () => {
    const {coach, client} = await coachWithClient();
    const noDateOld = await assign(coach, client.user.id, {title: 'No date old'});
    const later = await assign(coach, client.user.id, {title: 'Later', dueDate: chicagoDate(10)});
    const soon = await assign(coach, client.user.id, {title: 'Soon', dueDate: chicagoDate(2)});
    const noDateNew = await assign(coach, client.user.id, {title: 'No date new'});
    const finished = await assign(coach, client.user.id, {
      title: 'Finished',
      dueDate: chicagoDate(1),
      exercises: [{name: 'Run'}],
    });
    await mark(client.auth, finished.id, finished.exercises[0].id, 'done');

    const active = await api().get(`${v1}/me/assignments`).set(client.auth);
    expect(active.status).toBe(200);
    expect(active.body.items.map((a: {id: string}) => a.id)).toEqual([
      soon.id,
      later.id,
      noDateNew.id,
      noDateOld.id,
    ]);
    const all = await api().get(`${v1}/me/assignments?status=all`).set(client.auth);
    expect(all.body.items.map((a: {id: string}) => a.id)).toEqual([
      finished.id,
      soon.id,
      later.id,
      noDateNew.id,
      noDateOld.id,
    ]);

    const other = await registerUser('client');
    expect((await api().get(`${v1}/me/assignments`).set(other.auth)).body.items).toEqual([]);
    expect((await api().get(`${v1}/me/assignments/${soon.id}`).set(other.auth)).status).toBe(404);
    expect((await mark(other.auth, soon.id, soon.exercises[0].id, 'done')).status).toBe(404);
    expect((await api().get(`${v1}/me/assignments/${soon.id}`).set(client.auth)).status).toBe(200);
  });
});
