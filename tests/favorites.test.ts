import {describe, expect, it} from 'vitest';

import {BookingModel} from '../src/models/booking.js';
import {FavoriteModel} from '../src/models/favorite.js';
import {chicagoAt, publishedCoach} from './fixtures.js';
import {api, registerUser, useTestDb} from './helpers.js';

useTestDb();

const v1 = '/api/v1';
type Auth = Record<string, string>;
const add = (auth: Auth, coachId: string) => api().put(`${v1}/me/favorites/${coachId}`).set(auth);
const remove = (auth: Auth, coachId: string) =>
  api().delete(`${v1}/me/favorites/${coachId}`).set(auth);
const ids = (items: {id: string}[]) => items.map(i => i.id);

describe('favorites', () => {
  it('add and remove are idempotent; list is most recent first', async () => {
    const [c1, c2, c3] = [await publishedCoach(), await publishedCoach(), await publishedCoach()];
    const client = await registerUser('client');
    for (const coach of [c1, c2, c3])
      expect((await add(client.auth, coach.user.id)).status).toBe(204);
    expect((await add(client.auth, c1.user.id)).status).toBe(204); // again: no duplicate, order kept
    expect(await FavoriteModel.countDocuments()).toBe(3);

    const list = await api().get(`${v1}/me/favorites`).set(client.auth);
    expect(ids(list.body.items)).toEqual([c3.user.id, c2.user.id, c1.user.id]);
    expect(list.body.items.every((c: {isFavorite: boolean}) => c.isFavorite)).toBe(true);
    expect(list.body.items[0]).toMatchObject({
      firstName: expect.any(String),
      rating: expect.any(Object),
    });

    expect((await remove(client.auth, c2.user.id)).status).toBe(204);
    expect((await remove(client.auth, c2.user.id)).status).toBe(204);
    expect((await remove(client.auth, '0123456789abcdef01234567')).status).toBe(204);
    const after = await api().get(`${v1}/me/favorites`).set(client.auth);
    expect(ids(after.body.items)).toEqual([c3.user.id, c1.user.id]);
  });

  it('isFavorite in the catalog and the profile; ?favorites=true filters with paging', async () => {
    const [c1, c2, c3] = [await publishedCoach(), await publishedCoach(), await publishedCoach()];
    const client = await registerUser('client');
    await add(client.auth, c1.user.id);
    await add(client.auth, c3.user.id);

    const catalog = await api().get(`${v1}/coaches?pageSize=50`).set(client.auth);
    const fav = Object.fromEntries(
      catalog.body.items.map((c: {id: string; isFavorite: boolean}) => [c.id, c.isFavorite]),
    );
    expect(fav).toEqual({[c1.user.id]: true, [c2.user.id]: false, [c3.user.id]: true});
    expect((await api().get(`${v1}/coaches/${c1.user.id}`).set(client.auth)).body.isFavorite).toBe(
      true,
    );
    expect((await api().get(`${v1}/coaches/${c2.user.id}`).set(client.auth)).body.isFavorite).toBe(
      false,
    );

    const onlyFav = await api().get(`${v1}/coaches?favorites=true&pageSize=1`).set(client.auth);
    expect(onlyFav.body).toMatchObject({total: 2, pageSize: 1});
    expect(onlyFav.body.items).toHaveLength(1);
    const page2 = await api()
      .get(`${v1}/coaches?favorites=true&pageSize=1&page=2`)
      .set(client.auth);
    expect([...ids(onlyFav.body.items), ...ids(page2.body.items)].sort()).toEqual(
      [c1.user.id, c3.user.id].sort(),
    );
    const notFiltered = await api().get(`${v1}/coaches?favorites=false`).set(client.auth);
    expect(notFiltered.body.total).toBe(3);

    // Coaches always see false.
    const asCoach = await api().get(`${v1}/coaches/${c1.user.id}`).set(c2.auth);
    expect(asCoach.body.isFavorite).toBe(false);
  });

  it('unknown or unpublished coach -> NOT_FOUND; coach role -> FORBIDDEN', async () => {
    const client = await registerUser('client');
    expect((await add(client.auth, '0123456789abcdef01234567')).status).toBe(404);
    const unpublished = await registerUser('coach');
    const res = await add(client.auth, unpublished.user.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    const coach = await publishedCoach();
    for (const call of [
      api().get(`${v1}/me/favorites`).set(coach.auth),
      add(coach.auth, coach.user.id),
      remove(coach.auth, coach.user.id),
    ]) {
      const r = await call;
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('every booking carries session.sessionTypeId ("Book again")', async () => {
    const coach = await publishedCoach();
    const client = await registerUser('client');
    const booking = await api()
      .post(`${v1}/bookings`)
      .set(client.auth)
      .send({sessionTypeId: coach.individualTypeId, startAt: chicagoAt(5, '10:00')});
    await BookingModel.updateOne(
      {_id: booking.body.id},
      {
        startAt: new Date(Date.now() - 3 * 86_400_000),
        endAt: new Date(Date.now() - 3 * 86_400_000 + 3600_000),
        status: 'completed',
      },
    );
    const past = await api().get(`${v1}/bookings?scope=past`).set(client.auth);
    expect(past.body.items[0].session.sessionTypeId).toBe(coach.individualTypeId);
    const details = await api().get(`${v1}/bookings/${booking.body.id}`).set(coach.auth);
    expect(details.body.session.sessionTypeId).toBe(coach.individualTypeId);
  });
});
