# Nexus Core API — SERVICE_TESTING_GUIDE

## A. Service Overview

**Purpose**
- Primary backend API (“gateway”) used by the frontend.
- Owns authentication, user profile, book catalog access, threads, and realtime session orchestration.
- Proxies/coordinates with microservices (BookFriend agent, recommendations, search).

**Main responsibilities**
- Authentication (cookie + bearer token), user registration/login, profile management
- Books module (library feed, Gutenberg read/preview/search)
- Threads + thread messages under `/api/books/:bookId/threads` and `/api/threads/*`
- Realtime session endpoints (`/api/session`, `/api/matchmaking`, `/api/meet`) and Socket.IO
- Microservice proxy endpoints:
  - `/api/recommendations/*` (delegates to recommendations microservice when enabled)
  - `/api/search` (delegates to search microservice when enabled)
  - `/api/agent/*` (BookFriend integration, via `BOOKFRIEND_SERVER_URL`)

**Port**
- Default: `10000` (`PORT` env var)

**Required environment variables**
- `PORT` (optional, default `10000`)
- `MONGODB_URI` (required for full functionality)
- `JWT_SECRET` (required; startup will fail if missing/unsafe in prod)
- `CLIENT_URL` (CORS + auth callback behavior)

**Commonly required for full feature set**
- BookFriend integration:
  - `BOOKFRIEND_SERVER_URL` (default used in logs: `http://127.0.0.1:5050`)
  - `BOOKFRIEND_SERVICE_TIMEOUT_MS`
- Recommendations proxy:
  - `RECOMMENDATIONS_SERVICE_ENABLED`
  - `RECOMMENDATIONS_SERVICE_URL`
  - `RECOMMENDATIONS_SERVICE_TIMEOUT_MS`
- Search proxy:
  - `SEARCH_SERVICE_ENABLED`
  - `SEARCH_SERVICE_URL`
  - `SEARCH_SERVICE_TIMEOUT_MS`

See the complete template: `D:\After The Last Page\atlp-core-api\backend\.env.example`

**Dependencies**
- MongoDB (primary persistence)
- BookFriend agent microservice (recommended for `/api/agent/*`)
- Recommendations microservice (recommended for `/api/recommendations/*`)
- Search microservice (recommended for `/api/search`)

## B. Startup Instructions

### Installation
From `D:\After The Last Page\atlp-core-api\backend`:

1. Install dependencies:
   - `npm install`
2. Create local env:
   - Copy `D:\After The Last Page\atlp-core-api\backend\.env.example` → `.env`
   - Fill in at least `MONGODB_URI` and `JWT_SECRET`

### Run
- Start server: `npm run start`
- Run tests (Node test runner): `npm test`

### Required `.env` structure (minimum)
```env
PORT=10000
MONGODB_URI=mongodb://localhost:27017/after_the_last_page
JWT_SECRET=some_long_random_string
CLIENT_URL=http://localhost:5173
```

### Seed/setup
- This backend has `seed/` and `scripts/` directories. If you need seeded data, inspect `D:\After The Last Page\atlp-core-api\backend\seed` for what’s available.

## C. API Endpoint Documentation

### Conventions

**Base URL (local default)**: `http://localhost:10000`

**Auth**
- Cookie auth: set by `/api/auth/signup` and `/api/auth/login` (HTTP-only cookie)
- Bearer token (also returned by auth endpoints): `Authorization: Bearer <token>`

**Identity headers (non-JWT flexible identity)**
- Some endpoints use “flexible auth” and accept identity from headers/body/query:
  - `X-User-Id: <string>`
  - `X-Display-Name: <string>`

**Error responses (centralized)**
- Most unhandled errors flow into `errorHandler` which returns a “safe error” JSON body including:
  - `message`, `error=true`, `status`, `requestId`, `source`, `service`, plus safe metadata

### Endpoint Index (Routes Mounted)

| Area | Base path |
|---|---|
| Health | `/api/health` |
| Users | `/api/users/*` |
| Auth | `/api/auth/*` |
| Books | `/api/books/*` |
| Threads | `/api/books/:bookId/threads` and `/api/threads/*` |
| Agent | `/api/agent/*` |
| Access | `/api/access/*` |
| Session | `/api/session/*` |
| Matchmaking | `/api/matchmaking/*` |
| Meet | `/api/meet/*` |
| Recommendations | `/api/recommendations/*` |
| Search | `/api/search` |

---

## Health

### `GET /api/health`

| Item | Details |
|---|---|
| Purpose | Service + DB health probe |
| Auth | None |
| Success | `200` when DB connected, else `503` |

Sample request:
```bash
curl -s http://localhost:10000/api/health
```

Sample response:
```json
{ "status":"ok","db":"connected","uptime":123.45 }
```

Validation rules
- None

Common failures
- DB disconnected → `503` and `"db":"disconnected"`

---

## Users (`/api/users`)

### `GET /api/users/username-availability?username=...`

| Item | Details |
|---|---|
| Auth | None |
| Query | `username` (string) |
| Success | `200` with availability payload (see controller) |

Testing (curl)
```bash
curl -s "http://localhost:10000/api/users/username-availability?username=testuser"
```

Validation analysis
- Depends on `controllers/userController.js` logic; ensure username is required and normalized.

Error handling analysis
- Should return `400` for missing/invalid username; otherwise use centralized error handler.

### `POST /api/users/anonymous`

| Item | Details |
|---|---|
| Purpose | Create anonymous user |
| Auth | None |
| Body | (varies; see controller) |
| Success | `200` or `201` with token + user |

Testing
```bash
curl -s -X POST http://localhost:10000/api/users/anonymous -H "Content-Type: application/json" -d "{}"
```

Edge cases
- Repeated calls from same client, missing body, DB down (degraded mode behavior may apply).

### `POST /api/users/signup`
Creates a user (legacy user route; separate from `/api/auth/signup`).

### `POST /api/users/login`
Logs in a user (legacy user route; separate from `/api/auth/login`).

### `GET /api/users/profile` (Auth required)

Headers
- `Authorization: Bearer <token>` OR auth cookie

### `PUT /api/users/profile` (Auth required)

### `PUT /api/users/preferences/genres` (Auth required)

### `PUT /api/users/profile/image` (Auth required)

### `DELETE /api/users/profile/image` (Auth required)

> For the full request/response schema and validation, inspect:
> `D:\After The Last Page\atlp-core-api\backend\controllers\userController.js`

Validation analysis (users group)
- Several endpoints are likely missing strict schema validation (no centralized schema validator).
- Ensure file upload routes validate MIME/type/size (review `middleware/profileUpload.js` and controller usage).

Error handling analysis (users group)
- Most errors should reach centralized `errorHandler`.
- Look for places returning raw Mongo errors or stack traces (should be avoided in prod).

---

## Auth (`/api/auth`)

### `POST /api/auth/signup`

| Item | Details |
|---|---|
| Purpose | Create/upgrade a local user and issue token cookie |
| Body | `{ "email": string, "password": string }` |
| Success | `200` with `{ token, user }` |
| Failures | `400` invalid input, `409` existing verified user |

Sample request
```bash
curl -s -X POST http://localhost:10000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"a@example.com\",\"password\":\"secret123\"}"
```

Validation rules (implemented)
- `email` is trimmed + lowercased and must be non-empty
- `password` length must be ≥ 6

Security notes
- Password strength is minimal (length-only); consider adding stronger requirements.

### `POST /api/auth/login`

| Item | Details |
|---|---|
| Purpose | Login and issue auth cookie |
| Body | `{ "email": string, "password": string }` |
| Success | `200` with `{ token, user }` |
| Failures | `400` missing fields, `401` invalid credentials |

### `POST /api/auth/logout`
- Clears auth cookie.

### `GET /api/auth/me` (Auth required)
- Returns sanitized user.

### Google auth endpoints
- `POST /api/auth/google`
- `GET /api/auth/google/start`
- `GET /api/auth/google/callback`
- `GET /api/auth/google/failure`

Current behavior
- All except `/google/failure` return `410` (“disabled”).

---

## Books (`/api/books`)

> Routes are defined in `modules/books/routes/booksRoutes.js`.

### `GET /api/books`
- List books (source depends on controller implementation).

### `GET /api/books/library` (Auth required)
- Returns personalized/library feed.

### `GET /api/books/search?q=...`
Also available as:
- `GET /api/books/gutenberg/search?q=...`

### `GET /api/books/gutenberg/:gutenbergId/preview`
### `GET /api/books/gutenberg/:gutenbergId/read`
### `GET /api/books/read?source=...&sourceId=...`
### `GET /api/books/:id/read`
### `GET /api/books/:id`

Testing notes
- These endpoints typically depend on DB data and/or upstream sources. Use small queries first.

Validation analysis
- Path params should validate `:id` as ObjectId and `:gutenbergId` as integer.
- Query params should be bounded (max length) to protect from abuse.

Error handling analysis
- Controllers should translate upstream failures to non-500 where possible (e.g. 404 vs 502).

---

## Threads (mounted under `/api`)

> Routes defined in `features/bookThreads/bookThreadsRoutes.js` and are mounted as:
> `app.use('/api', requireDatabase(...), buildBookThreadsRoutes())`

### `POST /api/books/:bookId/threads`

| Item | Details |
|---|---|
| Purpose | Create thread for a book |
| Identity | Requires `userId` + `displayName` (from headers/body/query) |
| Body | `{ title?, content?, chapterReference?, userId?, displayName? }` |
| Success | `201` with `{ success:true, data:<thread> }` |

Sample request
```bash
curl -s -X POST "http://localhost:10000/api/books/<bookId>/threads" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: u123" \
  -H "X-Display-Name: Reader" \
  -d "{\"title\":\"Thoughts\",\"content\":\"...\"}"
```

Validation rules (implemented)
- Identity required; book resolved via `resolveBookOrThrow`
- Book/thread/message ids use ObjectId parsing helpers

Security concerns
- Identity is not JWT-backed here; it trusts `X-User-Id` / `X-Display-Name`.
- Consider requiring JWT auth (or signing identity) if this is user-facing.

### `GET /api/books/:bookId/threads`
- Lists threads for book (query-driven pagination/filtering; see service).

### `GET /api/threads/search`
### `GET /api/threads/:threadId`
### `POST /api/threads/:threadId/like`
### `GET /api/threads/:threadId/messages`
### `POST /api/threads/:threadId/messages`
### `POST /api/threads/:threadId/messages/:messageId/like`

Error handling analysis
- Thread controllers wrap in try/catch and call `sendError()`; confirm `sendError` consistently maps error → status codes.

---

## Agent (BookFriend integration) (`/api/agent`)

Auth model
- Uses `protectFlexible` (requires `X-User-Id` or `userId` in body/query).

### `POST /api/agent/start`

Body schema
```json
{ "book_id": "gutenberg:1342 | 1342 | <mongo_book_id>", "chapter_progress": 0 }
```

Success
- `201` and session metadata (see `controllers/agentController.js`)

Failures
- `400` missing/invalid `book_id` or invalid `chapter_progress`
- `5xx/502` upstream BookFriend failures

### `POST /api/agent/message`

Body schema
```json
{ "session_id": "string", "message": "string", "chapter_progress": 0 }
```

Validation (implemented)
- `message` length ≤ 2000
- requires `session_id` + `message`

Failure scenarios to test
- Send message with a stale/expired session id → may trigger recovery flow or return explicit error category
- Message too long → `400`

### `POST /api/agent/end`
Body: `{ "session_id": "string" }`

### `GET /api/agent/session/:sessionId`
- Inspect session metadata for synchronization/recovery.

Security notes
- Identity is flexible and not cryptographically verified; consider enforcing JWT for agent endpoints.

---

## Access (`/api/access`)

### `GET /api/access/check?bookId=...&context=meet`
Auth: `requireAuth`/`protect` is applied at route level.

### `POST /api/access/check-batch`
Body: `{ bookIds: string[], context?: "meet" }`

Validation (implemented)
- `bookId` required
- Batch caps: `bookIds.length <= 120`
- ObjectId validation enforced when context != `meet`

---

## Quiz (removed)

Quiz endpoints are no longer available in this service.

---

## Session / Matchmaking / Meet

Routes are built by `buildSessionRoutes`, `buildMatchmakingRoutes`, `buildMeetRoutes`.

These are protected with `protectFlexible` and also wrapped by `requireDatabase()` middleware (feature gated when DB is unavailable).

Test strategy
- Call `GET /api/session/status` first (requires `X-User-Id`)
- Join/leave endpoints and verify realtime behavior via Socket.IO

> For route lists, see:
> - `D:\After The Last Page\atlp-core-api\backend\routes\sessionRoutes.js`
> - `D:\After The Last Page\atlp-core-api\backend\routes\matchmakingRoutes.js`
> - `D:\After The Last Page\atlp-core-api\backend\routes\meetRoutes.js`

---

## Recommendations (`/api/recommendations`)

### `POST /api/recommendations`
Delegates to microservice `POST /api/recommendations` when enabled.

Body: `{ "genres": string[] }`

Validation (implemented)
- `genres` must be a non-empty array (values normalized to lower-case and deduped)

Failures
- If disabled/unconfigured → `503` with code `RECOMMENDATIONS_SERVICE_UNAVAILABLE`

### `GET /api/recommendations/for-you` (Auth required)
Delegates to microservice; forwards:
- `Authorization`
- `x-book-action-name` (optional)

### `POST /api/recommendations/for-you/click` (Auth required)
- Delegates click tracking; success returns `204`.

---

## Search (`/api/search`)

### `GET /api/search?q=...`
Delegates to search microservice when enabled.

Validation (implemented)
- Empty `q` returns `{ books: [] }` (success)

Failures
- If disabled/unconfigured → `503` with code `SEARCH_SERVICE_UNAVAILABLE`

---

## D. Testing Instructions (Per Endpoint)

### Minimal smoke test checklist

1. Health:
   - `curl -i http://localhost:10000/api/health`
2. Auth:
   - Signup: `POST /api/auth/signup`
   - Me: `GET /api/auth/me` (send cookie via `-c cookie.txt -b cookie.txt`)
3. Proxy services:
   - Recommendations: `POST /api/recommendations` (requires microservice enabled)
   - Search: `GET /api/search?q=...` (requires microservice enabled)
4. Threads:
   - Create/list thread using `X-User-Id` + `X-Display-Name`

### Postman notes
- Use an environment variable for `CORE_BASE_URL`
- For auth-cookie flows:
  - Postman should automatically store cookies per domain
- For flexible identity:
  - Add headers `X-User-Id` and `X-Display-Name` to requests

## E. Validation Analysis (Summary)

High-confidence validation that exists:
- Auth endpoints validate email/password presence and minimal password length.
- Quiz endpoints validate answer count/range and bookId validity.
- Access batch endpoint caps batch size and validates ObjectIds (context dependent).
- Agent endpoints validate message size and required fields.

Common validation gaps to audit (likely improvements):
- Lack of a shared schema validation layer (e.g. zod/joi/celebrate) means many endpoints rely on ad-hoc checks.
- Threads identity relies on untrusted headers (`X-User-Id`, `X-Display-Name`).
- String length caps are inconsistent across endpoints.
- File upload validation should be audited carefully (type/size/path traversal).

Security concerns to review
- Endpoints using flexible identity should be considered unauthenticated unless behind a trusted gateway.
- Ensure rate limits are appropriate for high-cost endpoints (agent/message, search, recommendations).
- Ensure error payloads never include stack traces in production.

## F. Error Handling Analysis (Summary)

What’s good
- Centralized `notFound` + `errorHandler` in core server.
- Several controllers use try/catch and return safe messages.

What to review
- Ensure controllers don’t return raw upstream payloads without filtering (proxy endpoints include `details`).
- Confirm consistent status codes (e.g. `503` vs `502` vs `500`) for upstream outages.
- Confirm “degraded mode” responses are explicitly tagged (some endpoints include `fallback: true`).

## G. Architecture Notes

### Folder structure (core API backend)
- `index.js` — server bootstrap + middleware + route mounting
- `routes/` — thin route definitions (Express router)
- `controllers/` — request handlers, input checks, orchestration
- `services/` — domain logic + integrations (microservice proxy, sessions)
- `models/` — Mongoose models
- `middleware/` — auth, rate limit, logging, security headers, error handling
- `features/` and `modules/` — feature-focused groupings (e.g. books module, threads feature)

### Request flow (typical)
- `routes/*` → controller → service(s) → model(s) → response

### How services communicate
- Microservice calls are done via internal “client/proxy” utilities (see `services/microserviceProxy.js`).
- BookFriend integration uses `createBookfriendClient` and a session manager stored in `app.locals`.
