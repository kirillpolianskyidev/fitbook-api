# FitBook API - Backend Specification (v1)

Backend for **FitBook**, a mobile app (React Native) where clients find personal coaches, book individual or group
trainings (single or recurring), keep shared notes per training and chat with their coach. Coaches manage their
profile, prices, availability, group classes and work calendar.

Everything runs locally: Node.js + Express + MongoDB on the developer's Mac.

---

## 1. Tech stack

| Area               | Choice                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Runtime            | Node.js 22 LTS, TypeScript (strict), ESM                                                                                      |
| HTTP               | Express 5                                                                                                                     |
| Database           | MongoDB (local), Mongoose 9                                                                                                   |
| Validation         | zod (request bodies, query, params, env)                                                                                      |
| API docs           | OpenAPI 3.1 generated from zod schemas (`@asteasolutions/zod-to-openapi`), Swagger UI at `/docs`, raw spec at `/openapi.json` |
| Auth               | JWT access token (15 min) + refresh token (30 days, rotating, stored hashed), bcrypt (cost 12)                                |
| Social login       | `google-auth-library` (verify Google ID token), `jose` (verify Apple identity token against Apple JWKS)                       |
| Realtime           | Socket.IO 4 (chat)                                                                                                            |
| Dates / time zones | `luxon` (IANA time zones)                                                                                                     |
| Email              | `nodemailer` -> Mailpit SMTP `localhost:1025` (fallback: log the email to the console)                                        |
| Security           | `helmet`, `cors`, `express-rate-limit`                                                                                        |
| Logging            | `pino` + `pino-http` (pretty in dev)                                                                                          |
| Tests              | Jest + `supertest` against a separate local DB `fitbook_test`                                                                 |
| Lint / format      | ESLint + Prettier                                                                                                             |

Environment (`.env`, validated with zod at startup; commit `.env.example`):

```
NODE_ENV=development
PORT=3000
MONGODB_URI=mongodb://localhost:27017/fitbook
MONGODB_URI_TEST=mongodb://localhost:27017/fitbook_test
JWT_ACCESS_SECRET=change-me
JWT_REFRESH_SECRET=change-me-too
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
CORS_ORIGINS=*
SMTP_HOST=localhost
SMTP_PORT=1025
MAIL_FROM="FitBook <no-reply@fitbook.dev>"
GOOGLE_CLIENT_IDS=            # comma-separated iOS/Android/web client IDs (optional in dev)
APPLE_BUNDLE_ID=              # e.g. com.company.fitbook (optional in dev)
PENDING_PAYMENT_TTL_MIN=15
```

npm scripts: `dev` (tsx watch), `build`, `start`, `test`, `lint`, `format`, `typecheck`, `seed`, `seed:reset`,
`openapi` (writes `docs/openapi.json`), `validate` (typecheck + lint + test).

---

## 2. Project structure

```
fitbook-api/
  src/
    app.ts                 # express app (no listen) - used by tests
    server.ts              # http server + socket.io + jobs
    config/env.ts          # zod-validated env
    db/connect.ts
    modules/
      auth/                # routes, controller, service, schemas (zod), tests
      users/
      coaches/             # public coach catalog + coach self-management
      availability/
      sessionTypes/
      sessions/            # training sessions (individual + group occurrences)
      bookings/            # bookings, series, payment (mock), cancellation, calendar event
      notes/
      chat/                # REST + socket handlers
    models/                # mongoose models
    middleware/            # auth, requireRole, validate, errorHandler, rateLimit
    lib/                   # errors (AppError), jwt, password, slots, time, mailer, pagination, openapi registry
    jobs/                  # releaseExpiredPendingBookings, completePastSessions
    seed/                  # seed data + scripts
  tests/                   # integration tests
  docs/
    SPEC.md                # this file
    API_CONTRACT.md        # generated at the end for the mobile app
    openapi.json
```

Each module: `*.routes.ts`, `*.controller.ts` (thin), `*.service.ts` (business rules), `*.schemas.ts` (zod,
also registered for OpenAPI). Business rules live in services, never in controllers or models.

---

## 3. Conventions

- Base path: `/api/v1`. JSON only.
- IDs: Mongo ObjectId, exposed as `id` (string). Never expose `_id`, `__v`, password or token hashes.
- Dates: ISO 8601 strings in UTC (`2026-11-03T15:00:00.000Z`). Weekly availability times are local coach time
  `"HH:mm"` interpreted in the coach's IANA `timezone`.
- Money: integer cents + currency: `{ "amountCents": 4500, "currency": "USD" }`.
- Lists: `{ "items": [...], "page": 1, "pageSize": 20, "total": 57 }` (query `page`, `pageSize` max 50).
  Chat messages use a cursor: `{ "items": [...], "nextCursor": "..." | null }`.
- Auth header: `Authorization: Bearer <accessToken>`.
- Every response with an error uses the error format in section 7.

---

## 4. Data model (Mongoose)

### Location (embedded)

```ts
{ name: string; address: string; city: string; state: string; country: 'US';
  lat: number; lng: number; placeId?: string; comment?: string }
```

### HomeArea (embedded) - where a user trains / coaches

```ts
{
  city: string;
  state: string; /* 2-letter, e.g. "IL" */
  country: 'US';
  timezone: string; /* IANA */
}
```

### users

| Field                | Type                                                                         | Notes                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| email                | string                                                                       | unique, lowercased, trimmed                                                                           |
| emailKey             | string                                                                       | normalized email for trial checks (lowercase; for gmail.com remove dots and `+tag` in the local part) |
| passwordHash         | string?                                                                      | absent for social-only accounts                                                                       |
| role                 | `'coach' \| 'client'` \| null                                                | null only until social onboarding is completed                                                        |
| firstName, lastName  | string                                                                       |                                                                                                       |
| avatarUrl            | string?                                                                      |                                                                                                       |
| homeArea             | HomeArea \| null                                                             | required for completed accounts                                                                       |
| emailVerifiedAt      | Date \| null                                                                 | null until the email is confirmed (code, Google / Apple, password reset)                              |
| authProviders        | `{ provider: 'password' \| 'google' \| 'apple', providerUserId?: string }[]` |                                                                                                       |
| onboardingCompleted  | boolean                                                                      | false for new social accounts until role + homeArea are set                                           |
| trialUsed            | boolean                                                                      | clients only                                                                                          |
| settings             | `{ theme: 'light' \| 'dark' \| 'system' }`                                   | default `system`                                                                                      |
| createdAt, updatedAt | Date                                                                         |                                                                                                       |

Indexes: `email` unique, `emailKey`, `authProviders.provider + authProviders.providerUserId` unique sparse,
`role + homeArea.state + homeArea.city`.

### emailVerifications

`{ _id (random 128-bit hex, returned as verification id), userId, purpose: 'signup' | 'login', codeHash
(HMAC-SHA256 of the 6 digits, never the plain code), codeExpiresAt (now + 10 min, renewed with every code), attempts
(wrong attempts for the current code, max 5), resendAvailableAt (now + 60 s after every send), resendCount (max 5),
expiresAt (createdAt + 30 min), consumedAt, invalidatedAt }`. A new verification invalidates the user's pending
ones. TTL index removes records one day after `expiresAt`.

### coachProfiles (1:1 with coach user)

| Field              | Type                                      | Notes                                                                                                   |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| userId             | ObjectId                                  | unique                                                                                                  |
| headline           | string                                    | e.g. "Strength & conditioning coach"                                                                    |
| bio                | string                                    | up to 2000 chars                                                                                        |
| specializations    | string[]                                  | from a fixed list: strength, yoga, running, boxing, pilates, crossfit, swimming, tennis, hiit, mobility |
| experienceYears    | number                                    |                                                                                                         |
| certifications     | `{ title, issuer, year }[]`               |                                                                                                         |
| highlights         | string[]                                  | short resume bullets ("Former D1 athlete", "500+ clients coached")                                      |
| languages          | string[]                                  |                                                                                                         |
| defaultLocation    | Location?                                 |                                                                                                         |
| cancellationPolicy | `{ freeCancelHours: number /* 0..72 */ }` | client may cancel only if `startAt - now >= freeCancelHours`                                            |
| rating             | `{ average: number; count: number }`      | seeded, read-only in v1                                                                                 |
| isPublished        | boolean                                   | coach appears in the catalog only when profile is complete and published                                |

### sessionTypes

| Field       | Type                      | Notes                                                   |
| ----------- | ------------------------- | ------------------------------------------------------- |
| coachId     | ObjectId                  |                                                         |
| title       | string                    | "1:1 Strength", "Sunrise Beach Yoga"                    |
| kind        | `'individual' \| 'group'` |                                                         |
| durationMin | number                    | 30..180, multiple of 30                                 |
| price       | Money                     | coach sets it; trial bookings are free regardless       |
| capacity    | number                    | 1 for individual; 2..30 for group                       |
| location    | Location?                 | falls back to coach defaultLocation                     |
| description | string?                   |                                                         |
| isActive    | boolean                   | inactive types cannot be booked; existing bookings stay |

### availabilities (1:1 with coach)

```ts
{ coachId, weekly: { weekday: 0..6 /* 0 = Sunday */; start: 'HH:mm'; end: 'HH:mm' }[],
  exceptions: { date: 'YYYY-MM-DD'; start?: 'HH:mm'; end?: 'HH:mm'; reason?: string }[] }  // no start/end = whole day off
```

### trainingSessions (concrete occurrences)

| Field                       | Type                                        | Notes                                                                     |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| coachId, sessionTypeId      | ObjectId                                    |                                                                           |
| kind                        | individual \| group                         | copied from type                                                          |
| startAt, endAt              | Date (UTC)                                  |                                                                           |
| capacity, participantsCount | number                                      |                                                                           |
| price                       | Money                                       | snapshot at creation                                                      |
| location                    | Location                                    | snapshot (individual bookings may override with a client-chosen location) |
| title                       | string                                      | snapshot                                                                  |
| status                      | `'scheduled' \| 'cancelled' \| 'completed'` |                                                                           |
| cancelReason                | string?                                     |                                                                           |

Individual sessions are created when a client books a free slot. Group sessions are created by the coach
(single or recurring) and clients join them.

### slotLocks (double-booking protection without transactions)

`{ coachId, slotStart: Date, sessionId }` with a **unique index on `{ coachId, slotStart }`**. Every scheduled
session (individual or group) inserts one lock per 30-minute block it covers. A duplicate-key error means the
time is taken -> `SLOT_UNAVAILABLE`. Locks are deleted when a session is cancelled or a pending booking expires.

### bookings

| Field                                                                | Type                                                                              | Notes                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| sessionId, coachId, clientId                                         | ObjectId                                                                          |                                                         |
| seriesId                                                             | ObjectId?                                                                         |                                                         |
| status                                                               | `'pending_payment' \| 'confirmed' \| 'cancelled' \| 'completed'`                  |                                                         |
| isTrial                                                              | boolean                                                                           |                                                         |
| price                                                                | Money                                                                             | 0 for trial                                             |
| payment                                                              | `{ status: 'unpaid' \| 'paid' \| 'not_required'; method: 'mock'; paidAt?: Date }` |                                                         |
| expiresAt                                                            | Date?                                                                             | for pending_payment                                     |
| cancelledAt, cancelledBy (`coach \| client \| system`), cancelReason |                                                                                   |                                                         |
| startAt, endAt                                                       | Date                                                                              | denormalized from the session for fast calendar queries |

Indexes: `clientId + startAt`, `coachId + startAt`, `sessionId + clientId` unique (a client can join a session once),
`status + expiresAt`.

### bookingSeries

`{ clientId, coachId, sessionTypeId, weekdays: number[], time: 'HH:mm', weeks: number, startDate: 'YYYY-MM-DD',
bookingIds: ObjectId[], skippedDates: string[] }`

### trialClaims

`{ emailKey (unique), userId, bookingId, createdAt }` - inserted atomically when a trial is booked; the unique
index guarantees one free trial per email even across accounts / login methods.

### notes

`{ bookingId, coachId, clientId, phase: 'before' | 'after', text (<= 4000), authorId, authorRole,
lastEditedById, lastEditedByRole, createdAt, updatedAt }`

### conversations / messages

- conversations: `{ coachId, clientId (unique pair), lastMessage?: { text, senderId, createdAt },
unread: { coach: number, client: number }, updatedAt }`
- messages: `{ conversationId, senderId, senderRole, text (<= 2000), createdAt, readAt? }`,
  index `conversationId + createdAt desc`.

### refreshTokens, passwordResets

- refreshTokens: `{ userId, tokenHash, expiresAt, revokedAt?, replacedBy?, userAgent? }`
- passwordResets: `{ userId, codeHash, expiresAt (15 min), attempts (max 5), usedAt? }`

---

## 5. Business rules

### Roles and access

- One login for everyone; `role` decides what is allowed. Middleware: `requireAuth`, `requireRole('coach')`,
  `requireRole('client')`, `requireOnboarded` (blocks everything except `/me*` and `/auth*` until onboarding is done).
- Participant checks: only the booking's coach or client can read it, its notes or its calendar event; only the two
  conversation members can read or write messages.

### Registration and onboarding

- Email registration requires: email, password (min 8, at least 1 letter and 1 digit), firstName, lastName,
  role, homeArea `{ city, state, timezone }` (country is always `US`).
- Email codes: register and every email + password login email a 6-digit code and return a `Verification`; tokens are
  issued only by `POST /auth/verify`. Register with the email of an unverified account overwrites that account;
  with a verified one -> `EMAIL_TAKEN`. Login of an unverified account gets `purpose: 'signup'`. Codes come from a
  CSPRNG, are stored as HMAC, compared in constant time and are single use. Refresh never asks for a code.
  `AUTH_DEV_FIXED_CODE` (6 digits) is accepted as a valid code outside production; non-production servers also log
  the code.
- Google / Apple sign-in (no email code): verify the token; find the user by provider id, then by email (link the
  provider; an unverified password account with that email is discarded instead, to prevent account pre-hijacking);
  otherwise create a user with `onboardingCompleted: false`. Sets `emailVerifiedAt` when the provider verified it. The client then calls `POST /me/onboarding`
  `{ role, homeArea, firstName?, lastName? }`.
- A new coach gets (once the email is verified) an empty coachProfile (`isPublished: false`), empty availability and default
  `cancellationPolicy.freeCancelHours = 24`. The coach becomes visible after filling headline, bio,
  specializations, experienceYears, at least one active session type and weekly availability, then publishing.

### Password reset

`forgot` always returns 204 (no user enumeration), emails a 6-digit code valid 15 minutes. `verify-code` returns a
short-lived `resetToken` (JWT, 10 min). `reset` sets the new password, confirms the email, revokes all refresh
tokens and pending email codes, and returns a new session (`AuthResult`). `PATCH /me/password` revokes all refresh
tokens and returns a new `Tokens` pair for the caller.
Max 5 wrong codes -> `TOO_MANY_ATTEMPTS`.

### Slots for individual bookings

`GET /coaches/:id/slots?sessionTypeId&from&to` (range <= 31 days):

1. Expand weekly availability into concrete intervals in the coach's time zone, minus exceptions.
2. Split into candidate starts every 30 minutes where `[start, start + durationMin]` fits fully.
3. Remove candidates overlapping existing slotLocks, and candidates starting in less than 2 hours from now.
4. Return `{ items: [{ startAt, endAt }] }` in UTC.

### Booking an individual training

`POST /bookings { sessionTypeId, startAt, isTrial?, location? }`:

1. Session type active and `kind = individual`; `startAt` must be a valid slot (same algorithm).
2. Create the trainingSession, insert slotLocks (duplicate -> `SLOT_UNAVAILABLE`, clean up).
3. Trial: client must not have `trialUsed`; insert trialClaim (duplicate -> `TRIAL_ALREADY_USED`); booking is
   `confirmed`, price 0, `payment.status = not_required`; set `user.trialUsed = true`.
4. Not trial: `pending_payment`, `expiresAt = now + PENDING_PAYMENT_TTL_MIN`.
5. Optional client `location` overrides the session location (stored on the session).

Trial rules: exactly one per account and per emailKey, individual only (group -> `TRIAL_NOT_ALLOWED`),
one trial in total (so with one coach only).

### Joining a group training

`POST /bookings { sessionId }`: session `scheduled`, in the future, kind group; atomically
`findOneAndUpdate({ _id, status: 'scheduled', participantsCount: { $lt: capacity } }, { $inc: { participantsCount: 1 } })`;
null -> `SESSION_FULL`. Unique `sessionId + clientId` -> `ALREADY_BOOKED`. Booking `pending_payment`.

### Recurring series (individual)

- `POST /bookings/series/preview { sessionTypeId, weekdays, time, weeks (1..12), startDate }` ->
  `{ items: [{ date, startAt, endAt, available, reason? }] }` where reason is `UNAVAILABLE` | `PAST` | `EXCEPTION`.
- `POST /bookings/series { sessionTypeId, weekdays, time, weeks, startDate, dates: ['YYYY-MM-DD', ...] }` books every
  listed date that is still free (same steps as a single booking, never trial) and returns
  `{ seriesId, bookings: [...], skipped: [{ date, reason }] }`. All created bookings are `pending_payment`.
- `POST /bookings/series/:id/pay` pays all pending bookings of the series at once (mock).

### Group sessions by the coach

`POST /coach/group-sessions { sessionTypeId, startAt, repeat?: { weekdays, weeks } }`: creates one or more
sessions, each must not overlap the coach's slotLocks (overlapping dates are returned in `skipped`).
`POST /coach/group-sessions/:id/cancel { reason }` cancels the session and all its bookings
(`cancelledBy: coach`), frees locks.

### Mock payment

`POST /bookings/:id/pay`: only the booking's client, only `pending_payment` and not expired, else
`BOOKING_NOT_PAYABLE`. Sets `payment = { status: 'paid', method: 'mock', paidAt }`, `status = confirmed`, clears
`expiresAt`.

Job every minute: pending bookings past `expiresAt` -> `cancelled` (`cancelledBy: system`, reason
`PAYMENT_EXPIRED`); decrement group participants or cancel the individual session and free its locks.

### Cancellation

- Client: allowed for `pending_payment` or `confirmed` future bookings only if
  `startAt - now >= coach.cancellationPolicy.freeCancelHours`, else `CANCELLATION_WINDOW_PASSED`
  (details include `freeCancelHours` and `deadline`). A cancelled trial does NOT give the trial back.
- Coach: may cancel any future booking of theirs with a reason.
- Cancelling an individual booking cancels its session and frees locks; for group it decrements participants.

### Completion

Job every 10 minutes: sessions whose `endAt < now` -> `completed`; their `confirmed` bookings -> `completed`.

### Notes

Both participants of a booking may create, edit and delete any note of that booking (phase `before` or `after`);
every change records `lastEditedById/Role`. Notes stay readable after completion; editing is allowed up to 30 days
after the training.

### Chat

- One conversation per coach-client pair; a client can start a conversation with any published coach, a coach with
  any client who has (or had) a booking with them.
- REST for history and sending; Socket.IO for realtime: connect with `auth: { token: <accessToken> }`; server joins
  the socket to room `user:<id>`.
- Events: server -> client `message:new { conversationId, message }`, `message:read { conversationId, readerId, readAt }`,
  `conversation:updated { conversation }`; client -> server `typing { conversationId }` (relayed as `typing`).
- Sending a message (REST or socket `message:send`) persists it, updates `lastMessage` and the other side's
  `unread`, and emits to both users' rooms.

### Calendar event for the device calendar

`GET /bookings/:id/calendar-event` -> `{ title, startAt, endAt, timezone, location: { name, address, lat, lng },
notes, url? }` (title like "Strength 1:1 with Alex Carter"; notes include short instructions and the booking id).

### Rate limits

`/auth/login`, `/auth/register`, `/auth/password/*`: 10 requests / 15 min per IP + email; `/auth/login` and
`/auth/register` also 20 / hour per email from any IP. `/auth/verify` and `/auth/verify/resend`: 20 / 15 min per
IP + verification id and 60 / 15 min per IP. Everything else 300 / 15 min.

---

## 6. Endpoints (`/api/v1`)

Legend: 🔓 public, 👤 any authenticated, 🏋️ coach, 🙋 client.

### Auth

| Method | Path                       | Who | Body / query                                               | Response                                                         |
| ------ | -------------------------- | --- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| POST   | /auth/register             | 🔓  | `{ email, password, firstName, lastName, role, homeArea }` | 201 `{ verification: Verification }`                             |
| POST   | /auth/login                | 🔓  | `{ email, password }`                                      | 200 `{ verification: Verification }`                             |
| POST   | /auth/verify               | 🔓  | `{ verificationId, code }`                                 | 200 `AuthResult`                                                 |
| POST   | /auth/verify/resend        | 🔓  | `{ verificationId }`                                       | 200 `{ verification: Verification }` (same id, new dates)        |
| POST   | /auth/google               | 🔓  | `{ idToken }`                                              | 200 `AuthResult` (`user.onboardingCompleted` may be false)       |
| POST   | /auth/apple                | 🔓  | `{ identityToken, firstName?, lastName? }`                 | 200 `AuthResult`                                                 |
| POST   | /auth/refresh              | 🔓  | `{ refreshToken }`                                         | 200 `Tokens` (rotates; reuse of an old token revokes the family) |
| POST   | /auth/logout               | 👤  | `{ refreshToken }`                                         | 204                                                              |
| POST   | /auth/password/forgot      | 🔓  | `{ email }`                                                | 204                                                              |
| POST   | /auth/password/verify-code | 🔓  | `{ email, code }`                                          | 200 `{ resetToken }`                                             |
| POST   | /auth/password/reset       | 🔓  | `{ resetToken, newPassword }`                              | 200 `AuthResult`                                                 |

`AuthResult = { user: User, tokens: Tokens }`, `Tokens = { accessToken, refreshToken, accessTokenExpiresAt }`,
`Verification = { id, purpose: 'signup' | 'login', email, codeLength: 6, expiresAt, resendAvailableAt }`.

### Me

| Method | Path           | Who | Body                                                                        | Response                                               |
| ------ | -------------- | --- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| GET    | /me            | 👤  |                                                                             | `User` (+ `coachProfile` summary for coaches)          |
| PATCH  | /me            | 👤  | `{ firstName?, lastName?, avatarUrl?, homeArea?, settings?: { theme } }`    | `User`                                                 |
| POST   | /me/onboarding | 👤  | `{ role, homeArea, firstName?, lastName? }`                                 | `User`                                                 |
| PATCH  | /me/password   | 👤  | `{ currentPassword?, newPassword }` (current required if a password exists) | 200 `Tokens` (other sessions signed out)               |
| GET    | /me/trial      | 🙋  |                                                                             | `{ eligible: boolean, reason?: 'TRIAL_ALREADY_USED' }` |

`User = { id, email, role, firstName, lastName, avatarUrl, homeArea, onboardingCompleted, trialUsed, settings,
authProviders: ('password'|'google'|'apple')[], createdAt }`

### Coach catalog (for clients)

| Method | Path                        | Who | Query                                                                                                     | Response                                       |
| ------ | --------------------------- | --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| GET    | /coaches                    | 👤  | `search?, specialization?, city?, state?, kind?, page, pageSize` (default: client's homeArea state first) | list of `CoachCard`                            |
| GET    | /coaches/:id                | 👤  |                                                                                                           | `CoachDetails`                                 |
| GET    | /coaches/:id/slots          | 🙋  | `sessionTypeId, from, to`                                                                                 | `{ items: Slot[] }`                            |
| GET    | /coaches/:id/group-sessions | 🙋  | `from, to`                                                                                                | `{ items: GroupSession[] }` (with `spotsLeft`) |

`CoachCard = { id, firstName, lastName, avatarUrl, headline, specializations, experienceYears, rating,
homeArea, priceFrom: Money, kinds: ('individual'|'group')[] }`
`CoachDetails = CoachCard + { bio, certifications, highlights, languages, defaultLocation,
cancellationPolicy, sessionTypes: SessionType[] }`

### Coach self-management

| Method | Path                                 | Who | Body / query                                                              | Response                                                                               |
| ------ | ------------------------------------ | --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | /coach/profile                       | 🏋️  |                                                                           | `CoachProfile` (+ `completeness: { missing: string[] }`)                               |
| PUT    | /coach/profile                       | 🏋️  | profile fields                                                            | `CoachProfile`                                                                         |
| POST   | /coach/profile/publish               | 🏋️  | `{ isPublished }`                                                         | `CoachProfile` (`PROFILE_INCOMPLETE` if missing fields)                                |
| PUT    | /coach/settings/cancellation         | 🏋️  | `{ freeCancelHours }`                                                     | `CoachProfile`                                                                         |
| GET    | /coach/session-types                 | 🏋️  |                                                                           | `{ items: SessionType[] }`                                                             |
| POST   | /coach/session-types                 | 🏋️  | `{ title, kind, durationMin, price, capacity?, location?, description? }` | 201 `SessionType`                                                                      |
| PATCH  | /coach/session-types/:id             | 🏋️  | partial (price, title, isActive, ...)                                     | `SessionType`                                                                          |
| DELETE | /coach/session-types/:id             | 🏋️  |                                                                           | 204 (soft: `isActive = false` if used)                                                 |
| GET    | /coach/availability                  | 🏋️  |                                                                           | `Availability`                                                                         |
| PUT    | /coach/availability                  | 🏋️  | `{ weekly }` (non-overlapping, start < end)                               | `Availability`                                                                         |
| POST   | /coach/availability/exceptions       | 🏋️  | `{ date, start?, end?, reason? }`                                         | `Availability`                                                                         |
| DELETE | /coach/availability/exceptions/:date | 🏋️  |                                                                           | `Availability`                                                                         |
| POST   | /coach/group-sessions                | 🏋️  | `{ sessionTypeId, startAt, repeat? }`                                     | 201 `{ created: GroupSession[], skipped }`                                             |
| POST   | /coach/group-sessions/:id/cancel     | 🏋️  | `{ reason }`                                                              | `GroupSession`                                                                         |
| GET    | /coach/schedule                      | 🏋️  | `from, to`                                                                | `{ items: ScheduleItem[] }` (session + participants with booking status + notes count) |
| GET    | /coach/sessions/:id                  | 🏋️  |                                                                           | `ScheduleItem` with participants and their bookings                                    |
| GET    | /coach/clients                       | 🏋️  | `search?`                                                                 | clients who have bookings with this coach                                              |
| POST   | /coach/bookings/:id/cancel           | 🏋️  | `{ reason }`                                                              | `Booking`                                                                              |

### Bookings (client)

| Method | Path                         | Who            | Body / query                                                                          | Response                                             |
| ------ | ---------------------------- | -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| POST   | /bookings                    | 🙋             | individual `{ sessionTypeId, startAt, isTrial?, location? }` or group `{ sessionId }` | 201 `Booking`                                        |
| POST   | /bookings/series/preview     | 🙋             | `{ sessionTypeId, weekdays, time, weeks, startDate }`                                 | `{ items: SeriesPreviewItem[] }`                     |
| POST   | /bookings/series             | 🙋             | preview body + `{ dates }`                                                            | 201 `{ seriesId, bookings, skipped }`                |
| POST   | /bookings/series/:id/pay     | 🙋             |                                                                                       | `{ bookings }`                                       |
| GET    | /bookings                    | 🙋             | `scope=upcoming\|past, from?, to?, page`                                              | list of `Booking`                                    |
| GET    | /bookings/:id                | 👤 participant |                                                                                       | `Booking` (with coach, client, session, notes count) |
| POST   | /bookings/:id/pay            | 🙋             |                                                                                       | `Booking`                                            |
| POST   | /bookings/:id/cancel         | 🙋             | `{ reason? }`                                                                         | `Booking`                                            |
| GET    | /bookings/:id/calendar-event | 👤 participant |                                                                                       | `CalendarEvent`                                      |

`Booking = { id, status, isTrial, price, payment, expiresAt, startAt, endAt, seriesId, cancellable: boolean,
cancelDeadline, session: { id, title, kind, location, capacity, participantsCount }, coach: { id, firstName,
lastName, avatarUrl }, client: { id, firstName, lastName, avatarUrl }, notesCount, createdAt }`

### Notes

| Method | Path                | Who            | Body              | Response                            |
| ------ | ------------------- | -------------- | ----------------- | ----------------------------------- |
| GET    | /bookings/:id/notes | 👤 participant |                   | `{ before: Note[], after: Note[] }` |
| POST   | /bookings/:id/notes | 👤 participant | `{ phase, text }` | 201 `Note`                          |
| PATCH  | /notes/:id          | 👤 participant | `{ text }`        | `Note`                              |
| DELETE | /notes/:id          | 👤 participant |                   | 204                                 |

`Note = { id, bookingId, phase, text, author: { id, role, firstName, lastName }, lastEditedBy: { id, role },
createdAt, updatedAt }`

### Chat

| Method | Path                        | Who       | Body / query                                     | Response                                                                       |
| ------ | --------------------------- | --------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| GET    | /conversations              | 👤        |                                                  | `{ items: Conversation[] }` sorted by last activity, with `unreadCount` for me |
| POST   | /conversations              | 👤        | `{ coachId }` (client) or `{ clientId }` (coach) | `Conversation` (get or create)                                                 |
| GET    | /conversations/:id/messages | 👤 member | `before?, limit (<= 50)`                         | `{ items: Message[], nextCursor }`                                             |
| POST   | /conversations/:id/messages | 👤 member | `{ text }`                                       | 201 `Message`                                                                  |
| POST   | /conversations/:id/read     | 👤 member |                                                  | 204                                                                            |

### Service

`GET /health` -> `{ status: 'ok', db: 'up' }`, `GET /docs`, `GET /openapi.json`.

---

## 7. Errors

All errors: `{ "error": { "code": "SLOT_UNAVAILABLE", "message": "This time is no longer available.", "details": {} } }`.
Validation errors list fields: `details: { fields: { email: "Invalid email" } }`.

| HTTP | Code                                    | When                                                                                                                |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 400  | VALIDATION_ERROR                        | zod validation failed                                                                                               |
| 400  | RESET_CODE_INVALID / RESET_CODE_EXPIRED | password reset                                                                                                      |
| 400  | VERIFICATION_CODE_INVALID               | wrong email code in `/auth/verify` (`details.attemptsLeft`)                                                         |
| 400  | VERIFICATION_CODE_EXPIRED               | email code or verification no longer valid (used, expired, replaced, resend limit)                                  |
| 401  | UNAUTHORIZED                            | no / invalid token                                                                                                  |
| 401  | TOKEN_EXPIRED                           | access token expired (client should refresh)                                                                        |
| 401  | INVALID_CREDENTIALS                     | wrong email or password                                                                                             |
| 401  | SOCIAL_TOKEN_INVALID                    | Google / Apple token rejected                                                                                       |
| 403  | FORBIDDEN                               | wrong role or not a participant                                                                                     |
| 403  | ONBOARDING_REQUIRED                     | social account without role / homeArea                                                                              |
| 404  | NOT_FOUND                               | resource missing or not visible                                                                                     |
| 409  | EMAIL_TAKEN                             | register                                                                                                            |
| 409  | SLOT_UNAVAILABLE                        | time already taken / not in availability                                                                            |
| 409  | SESSION_FULL                            | group capacity reached                                                                                              |
| 409  | ALREADY_BOOKED                          | client already in this session                                                                                      |
| 409  | TRIAL_ALREADY_USED                      | second trial (account or email)                                                                                     |
| 409  | CANCELLATION_WINDOW_PASSED              | too late to cancel (`details.freeCancelHours`, `details.deadline`)                                                  |
| 409  | BOOKING_NOT_PAYABLE                     | not pending or expired                                                                                              |
| 422  | TRIAL_NOT_ALLOWED                       | trial requested for a group session                                                                                 |
| 422  | PROFILE_INCOMPLETE                      | publishing an incomplete coach profile (`details.missing`)                                                          |
| 422  | SESSION_TYPE_INACTIVE                   | booking an inactive type                                                                                            |
| 429  | RATE_LIMITED / TOO_MANY_ATTEMPTS        | limits (`RATE_LIMITED` on resend has `details.retryAfterSeconds`; 5 wrong codes -> `TOO_MANY_ATTEMPTS`)             |
| 503  | EMAIL_DELIVERY_FAILED                   | register / login / verify/resend: the email with the code could not be sent (the verification is not usable; retry) |
| 500  | INTERNAL                                | unexpected (no stack traces in responses)                                                                           |

`message` is a human-readable English text; the mobile app maps `code` to its own localized strings.

---

## 8. Seed data (`npm run seed`, `npm run seed:reset`)

Language: English. Currency: USD. Main city: **Chicago, IL** (`America/Chicago`); a few coaches and clients in
other US cities to demonstrate location filtering: New York NY, Austin TX, Los Angeles CA, Miami FL.

- **Demo accounts** (password `Password123!`):
  - `coach@fitbook.dev` - Alex Carter, strength & conditioning, Chicago, full schedule, group + individual types
  - `client@fitbook.dev` - Jamie Lee, Chicago, trial already used, past and upcoming bookings, a series, notes, chats
  - `newclient@fitbook.dev` - fresh client, trial still available, no bookings
  - `newcoach@fitbook.dev` - coach with an incomplete, unpublished profile (to show onboarding)
- **10 coaches** (7 in Chicago, 3 elsewhere): strength, yoga, running, boxing, pilates, crossfit, swimming,
  tennis, hiit, mobility. Realistic names, headlines, 2-3 paragraph bios, 3-12 years experience, 2-4
  certifications (NASM-CPT, ACE, RYT-200, USA Boxing, ...), highlights, languages, ratings 4.5-5.0 (12-180 reviews),
  `freeCancelHours` among 12 / 24 / 48. Avatars: stable placeholder portrait URLs (e.g. `https://i.pravatar.cc/300?img=<n>`).
- **Session types:** 2-4 per coach; individual $45-$120 (45-90 min); group $15-$35 (60 min, capacity 6-15).
- **Locations (Chicago):** a downtown gym, Lincoln Park, Lakefront Trail at North Avenue Beach, Montrose Beach,
  a boxing club in West Loop, a tennis center, an indoor pool (approximate real coordinates).
- **Availability:** realistic weekly hours for each coach + 1-2 exceptions (vacation day).
- **Group sessions:** next 14 days, partly filled; at least one full session.
- **Bookings:** past 6 weeks (completed, with before/after notes from both sides) and next 3 weeks (confirmed,
  one pending_payment, one cancelled); Jamie has a 6-week Tue/Thu series with Alex.
- **Chats:** 6-8 conversations with 5-25 realistic messages each, some unread.
- Seed is idempotent: `seed:reset` drops the `fitbook` database and recreates everything; dates are generated
  relative to "now" so the demo always looks current.

---

## 9. Tests (must pass)

Integration tests with supertest on `fitbook_test` (dropped before the run):

- auth: register (both roles, homeArea required), login, refresh rotation + reuse detection, logout, forgot /
  verify / reset flow, rate limit smoke test;
- onboarding guard for social accounts (`ONBOARDING_REQUIRED`) - social token verification mocked;
- slots: weekly hours + exceptions + existing locks + time zone (Chicago, including a DST-change week);
- booking: individual success, `SLOT_UNAVAILABLE` on a concurrent second booking (fire both requests in parallel),
  group join, `SESSION_FULL`, `ALREADY_BOOKED`;
- trial: success, second trial on same account, second trial with the same gmail address variant
  (`j.ohn+x@gmail.com` vs `john@gmail.com`), `TRIAL_NOT_ALLOWED` for group;
- series: preview flags, booking skips taken dates, pay series;
- payment: pay, pay expired, expiry job frees the slot;
- cancellation: inside / outside `freeCancelHours`, coach cancel, group cancel cascades;
- notes: both participants edit, outsider gets `FORBIDDEN`;
- chat: create conversation, send, unread counters, read; socket smoke test (connect with token, receive `message:new`);
- role guards: client calling coach endpoints and vice versa -> `FORBIDDEN`.

---

## 10. Deliverables for the mobile app

At the end generate:

1. `docs/openapi.json` (from the zod registry).
2. `docs/API_CONTRACT.md` for the React Native app: base URLs for local development
   (iOS simulator `http://localhost:3000/api/v1`, Android emulator `http://10.0.2.2:3000/api/v1`,
   device `http://<mac-lan-ip>:3000/api/v1`), auth flow (tokens, refresh on `TOKEN_EXPIRED`), every endpoint with
   request and response JSON examples taken from real seed data, all error codes with when they happen, Socket.IO
   connection and events, enums (statuses, roles, specializations, themes), money and date conventions, and the
   demo accounts.
3. `README.md`: prerequisites, setup (`npm i`, `.env`, optional Mailpit via Docker), `seed`, `dev`, tests, links to
   `/docs`.

---

## 11. Acceptance checklist

- [ ] `npm run validate` passes (typecheck, lint, all tests)
- [ ] `npm run seed:reset && npm run dev` starts on :3000, `/health` reports db up, `/docs` shows every endpoint
- [ ] Demo accounts log in; client sees coaches (Chicago first), slots, bookings, notes, chats; coach sees schedule
- [ ] Double booking impossible (parallel test), trial rules enforced, cancellation policy enforced
- [ ] Socket.IO chat works between the two demo accounts (two terminals with a small script or the test)
- [ ] `docs/API_CONTRACT.md` and `docs/openapi.json` exist and match the implementation

---

## 12. Implementation notes (added during implementation)

- Group capacity is enforced with per-seat lock documents (`seatlocks`, unique `sessionId + seat` and
  `sessionId + clientId`) instead of a conditional counter update; `participantsCount` mirrors the seat count.
- Social accounts are looked up by `providerKeys` (`"google:<sub>"`, `"apple:<sub>"`).
- Tests use Vitest + supertest. Password hashing uses `bcryptjs` (cost 12).
- `pending_payment` bookings can be cancelled by the client any time before the start.
- Seed: 10 published coaches (8 Chicago, 1 New York, 1 Miami) + one incomplete coach, 20 clients.
