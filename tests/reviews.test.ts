import {describe, expect, it} from 'vitest';

import {BookingModel} from '../src/models/booking.js';
import {ReviewModel} from '../src/models/review.js';
import {chicagoAt, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
type Coach = Awaited<ReturnType<typeof publishedCoach>>;

let day = 0;
/** A client with one completed training with the coach. */
async function trainedClient(coach: Coach, overrides: Record<string, unknown> = {}) {
  const client = await registerUser('client', overrides);
  const booking = await api()
    .post(`${v1}/bookings`)
    .set(client.auth)
    .send({
      sessionTypeId: coach.individualTypeId,
      startAt: chicagoAt(3 + (day++ % 25), '10:00'),
    });
  await BookingModel.updateOne({_id: booking.body.id}, {status: 'completed'});
  return client;
}
const putReview = (auth: Auth, coachId: string, body: Record<string, unknown>) =>
  api().put(`${v1}/coaches/${coachId}/my-review`).set(auth).send(body);
const coachRating = async (auth: Auth, coachId: string) =>
  (await api().get(`${v1}/coaches/${coachId}`).set(auth)).body.rating;

describe('reviews', () => {
  it('creates a review after a completed training; author is "First L."', async () => {
    const coach = await publishedCoach();
    const client = await trainedClient(coach, {firstName: 'Jamie', lastName: 'lee'});
    const state = await api().get(`${v1}/coaches/${coach.user.id}/my-review`).set(client.auth);
    expect(state.body).toEqual({review: null, canCreate: true, editableUntil: null});

    const created = await putReview(client.auth, coach.user.id, {
      rating: 5,
      text: '  Great technique cues.  ',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      canCreate: false,
      review: {
        rating: 5,
        text: 'Great technique cues.',
        author: {id: client.user.id, name: 'Jamie L.', avatarUrl: null},
      },
    });
    expect(Date.parse(created.body.editableUntil)).toBe(
      Date.parse(created.body.review.createdAt) + 24 * 3600_000,
    );
    expect(await coachRating(client.auth, coach.user.id)).toEqual({average: 5, count: 1});
  });

  it('without a completed training -> REVIEW_NOT_ALLOWED; coach role -> FORBIDDEN', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    // A confirmed (not completed) booking is not enough.
    await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({sessionTypeId: coach.individualTypeId, startAt: chicagoAt(6, '10:00'), isTrial: true});
    const state = await api().get(`${v1}/coaches/${coach.user.id}/my-review`).set(client.auth);
    expect(state.body.canCreate).toBe(false);
    const res = await putReview(client.auth, coach.user.id, {rating: 4});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'REVIEW_NOT_ALLOWED',
      message: 'You can review a coach after your first completed training.',
    });
    expect((await putReview(coach.auth, coach.user.id, {rating: 4})).body.error.code).toBe(
      'FORBIDDEN',
    );
  });

  it('a second PUT within 24 hours updates; after 24 hours -> REVIEW_EDIT_WINDOW_PASSED', async () => {
    const coach = await publishedCoach();
    const client = await trainedClient(coach);
    const first = await putReview(client.auth, coach.user.id, {rating: 3, text: 'Ok'});
    const second = await putReview(client.auth, coach.user.id, {rating: 4, text: ''});
    expect(second.status).toBe(200);
    expect(second.body.review).toMatchObject({id: first.body.review.id, rating: 4, text: null});
    expect(await ReviewModel.countDocuments()).toBe(1);
    expect(await coachRating(client.auth, coach.user.id)).toEqual({average: 4, count: 1});

    await ReviewModel.collection.updateOne(
      {_id: (await ReviewModel.findOne())!._id},
      {$set: {createdAt: new Date(Date.now() - 24 * 3600_000 - 1000)}},
    );
    const late = await putReview(client.auth, coach.user.id, {rating: 1});
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({
      code: 'REVIEW_EDIT_WINDOW_PASSED',
      message: 'Reviews can be changed only during 24 hours.',
    });
    expect((await ReviewModel.findOne())!.rating).toBe(4);
  });

  it('validates rating and text', async () => {
    const coach = await publishedCoach();
    const client = await trainedClient(coach);
    for (const body of [
      {rating: 0},
      {rating: 6},
      {rating: 4.5},
      {},
      {rating: 5, text: 'x'.repeat(1001)},
    ]) {
      const res = await putReview(client.auth, coach.user.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(
      (await putReview(client.auth, coach.user.id, {rating: 5, text: 'x'.repeat(1000)})).status,
    ).toBe(201);
  });

  it('recalculates the coach rating and returns a paged list with a summary', async () => {
    const coach = await publishedCoach();
    const ratings = [5, 4, 5, 2, 5];
    for (const rating of ratings) {
      const client = await trainedClient(coach);
      await putReview(client.auth, coach.user.id, {rating});
    }
    const viewer = await registerUser('client');
    expect(await coachRating(viewer.auth, coach.user.id)).toEqual({average: 4.2, count: 5});
    const catalog = await api().get(`${v1}/coaches`).set(viewer.auth);
    expect(catalog.body.items.find((c: {id: string}) => c.id === coach.user.id).rating).toEqual({
      average: 4.2,
      count: 5,
    });

    const page1 = await api()
      .get(`${v1}/coaches/${coach.user.id}/reviews?page=1&pageSize=2`)
      .set(viewer.auth);
    expect(page1.body).toMatchObject({
      page: 1,
      pageSize: 2,
      total: 5,
      summary: {average: 4.2, count: 5, distribution: {'1': 0, '2': 1, '3': 0, '4': 1, '5': 3}},
    });
    expect(page1.body.items.map((r: {rating: number}) => r.rating)).toEqual([5, 2]); // newest first
    const page3 = await api()
      .get(`${v1}/coaches/${coach.user.id}/reviews?page=3&pageSize=2`)
      .set(viewer.auth);
    expect(page3.body.items.map((r: {rating: number}) => r.rating)).toEqual([5]);
    // Coaches can read reviews too; pageSize is capped at 50.
    expect((await api().get(`${v1}/coaches/${coach.user.id}/reviews`).set(coach.auth)).status).toBe(
      200,
    );
    expect(
      (await api().get(`${v1}/coaches/${coach.user.id}/reviews?pageSize=51`).set(viewer.auth))
        .status,
    ).toBe(400);
  });

  it('unknown coach -> NOT_FOUND', async () => {
    const client = await registerUser('client');
    const unknown = '0123456789abcdef01234567';
    expect((await api().get(`${v1}/coaches/${unknown}/reviews`).set(client.auth)).status).toBe(404);
    expect((await api().get(`${v1}/coaches/${unknown}/my-review`).set(client.auth)).status).toBe(
      404,
    );
    expect((await putReview(client.auth, unknown, {rating: 5})).status).toBe(404);
  });
});
