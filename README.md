# FitBook API

Backend for **FitBook**, a mobile app for booking personal and group trainings with coaches.
Node.js 22 + Express 5 + TypeScript + MongoDB (Mongoose) + Socket.IO.

- Clients: find coaches (city/state, specialization), see profiles and prices, book individual trainings (single,
  recurring series, one free trial per email) or join group sessions, mock payment, cancellation by the coach's
  policy, shared notes before/after a training, chat, device calendar export.
- Coaches: profile, training types and prices (individual / group with capacity), weekly availability and days off,
  cancellation policy, group sessions (with weekly repeat), work calendar with participants, clients, chat.

Specification: [`docs/SPEC.md`](docs/SPEC.md). Contract for the mobile app: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).
Interactive docs while the server runs: http://localhost:3000/docs.

## Requirements

- Node.js 22+ (`node -v`)
- MongoDB running locally on `127.0.0.1:27017` (`mongosh --quiet --eval "db.version()"`)
  - Homebrew: `brew services start mongodb-community`
- Optional: Docker for Mailpit (to see password-reset emails)

## Setup

```bash
npm install
cp .env.example .env
# put two long random secrets into .env:
sed -i '' "s/change-me-to-a-long-random-string/$(openssl rand -hex 32)/; s/change-me-to-another-long-random-string/$(openssl rand -hex 32)/" .env

npm run seed:reset     # creates the "fitbook" database with demo data
npm run dev            # http://localhost:3000  (docs: /docs)
```

Optional Mailpit (password-reset emails appear at http://localhost:8025):

```bash
docker run -d --name mailpit -p 8025:8025 -p 1025:1025 axllent/mailpit
```

Without Mailpit the email (with the code) is printed in the server log.

## Demo accounts

Password for all: `Password123!`

| Email                   | Who                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `coach@fitbook.dev`     | Alex Carter, coach in Chicago: full schedule, group classes, clients, chats                            |
| `client@fitbook.dev`    | Jamie Lee, client in Chicago: trial used, Tue/Thu series, notes, chats, pending and cancelled bookings |
| `newclient@fitbook.dev` | Riley Chen, client with the free trial still available                                                 |
| `newcoach@fitbook.dev`  | Taylor Morgan, coach with an incomplete, unpublished profile                                           |

Seed data: 10 published coaches (8 in Chicago, 1 in New York, 1 in Miami), 20 clients, ~6 weeks of past and
~3 weeks of upcoming trainings, notes, chats. Dates are generated relative to "now", so reseed any time to get a
fresh-looking demo: `npm run seed:reset`.

## Scripts

| Script                                | What it does                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`                         | Start with reload (tsx watch)                                                                |
| `npm run build` / `npm start`         | Compile to `dist/` and run                                                                   |
| `npm test`                            | Integration tests (Vitest + supertest) on the `fitbook_test` database                        |
| `npm run validate`                    | typecheck + lint + format check + tests                                                      |
| `npm run seed` / `npm run seed:reset` | Seed an empty database / drop and recreate the demo data                                     |
| `npm run smoke`                       | End-to-end checks against the seeded database (creates a few records - reseed afterwards)    |
| `npm run openapi`                     | Write `docs/openapi.json`                                                                    |
| `npm run contract`                    | Rebuild `docs/API_CONTRACT.md` (run `npm run smoke -- --examples` first to refresh examples) |

## Mobile app connection

| App runs on      | Base URL                                                     |
| ---------------- | ------------------------------------------------------------ |
| iOS Simulator    | `http://localhost:3000/api/v1`                               |
| Android Emulator | `http://10.0.2.2:3000/api/v1`                                |
| Real device      | `http://<mac-lan-ip>:3000/api/v1` (`ipconfig getifaddr en0`) |

Google / Apple sign-in need `GOOGLE_CLIENT_IDS` / `APPLE_BUNDLE_ID` in `.env`; everything else works without them.

## Project structure

```
src/
  app.ts, server.ts          Express app (used by tests) and HTTP + Socket.IO server with background jobs
  config/env.ts              zod-validated environment
  lib/                       route() helper (auth, validation, OpenAPI), errors, jwt, slots, time, mailer
  models/                    Mongoose models
  modules/<area>/            routes + service + schemas per area (auth, users, coaches, sessionTypes,
                             availability, sessions, bookings, notes, chat)
  realtime/socket.ts         Socket.IO auth, rooms and chat events
  jobs/                      release unpaid bookings (every minute), complete past sessions (every 10 minutes)
  seed/                      demo data and seed script
  scripts/                   smoke test, OpenAPI and contract generators
tests/                       integration tests
docs/                        SPEC.md, API_CONTRACT.md, openapi.json, examples.json
```

Every endpoint is declared once with `route()`: auth level and role, zod schemas for body/query/params/response,
and documented error codes. The same declaration validates requests, strips and checks responses, and generates
the OpenAPI document, so the docs cannot drift from the code.

## Implementation notes

- **No double booking without transactions.** Each scheduled session reserves its 30-minute blocks in `slotlocks`
  (unique `coachId + slotStart`), and each group seat is a document in `seatlocks` (unique `sessionId + seat` and
  `sessionId + clientId`). Works on a standalone local MongoDB, which has no multi-document transactions.
- **One free trial per email**: `trialclaims` has a unique canonical email (lowercase, `+tag` removed, Gmail dots
  removed), so aliases and other login methods cannot get a second trial.
- **Time zones**: availability is local to the coach (`homeArea.timezone`); slots are computed with Luxon and tested
  across the DST change in Chicago. All API dates are UTC.
- **Refresh tokens rotate**; reusing an old one revokes the whole session family.
- Deviations from SPEC.md: Vitest instead of Jest (same API, native ESM/TypeScript); `bcryptjs` (pure JS, no
  native build); MongoDB URL uses `127.0.0.1` instead of `localhost` (on macOS `localhost` may resolve to IPv6,
  which MongoDB does not listen on by default); unpaid (`pending_payment`) bookings can be cancelled any time before
  the start, the coach's free-cancellation window applies to confirmed bookings.
