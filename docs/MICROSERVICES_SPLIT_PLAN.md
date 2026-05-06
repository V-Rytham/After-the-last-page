# Microservices split plan for Render free tier (512MB RAM)

## Goal
Keep the **main API** lightweight and move memory-heavy AI workloads into separate services.

## Suggested service boundaries

1. **Core API service** (`backend/`)
   - Auth/AuthZ
   - User profile
   - sessions/meet/thread coordination
   - acts as gateway/orchestrator

2. **BookFriend RAG service** (`bookfriend-server/`) (already separate)
   - `/agent/start`, `/agent/message`, `/agent/end` logic
   - retrieval + LLM prompting

3. **Recommendations service** (new repo from subset of `backend/` files)
   - Legacy recommender endpoint currently at `POST /api/recommendations`
   - Can be scaled independently from core API

## Code changes made

Core API now supports delegating `POST /api/recommendations` to a remote service via:
- `RECOMMENDATIONS_SERVICE_ENABLED=true`
- `RECOMMENDATIONS_SERVICE_URL=https://<your-recommendations-service>.onrender.com`

If remote service fails, it gracefully falls back to in-process logic.

## Files to place in each repository

### A) Core API repo
- Entire `backend/` folder
- Keep these env vars configured:
  - `BOOKFRIEND_SERVER_URL`
  - `RECOMMENDATIONS_SERVICE_ENABLED`
  - `RECOMMENDATIONS_SERVICE_URL`

### B) BookFriend repo
- Entire `bookfriend-server/` folder
- Deploy as independent web service (Node)

### C) Recommendations repo (new)
Use these files/folders from `backend/`:
- `controllers/recommendationsController.js` (or a slimmed version exposing only `postRecommendations`)
- `services/recommendationsService.js`
- `models/Book.js`
- `seed/gutenbergCatalog.js`
- `config/db.js`
- minimal Express bootstrap and route for `POST /api/recommendations`

> Tip: start by copying `backend/` as a baseline, then delete unrelated routes/controllers until only recommendations remains.

## Render deployment steps (beginner-friendly)

1. Create 3 GitHub repos:
   - `atlp-core-api`
   - `atlp-bookfriend`
   - `atlp-recommendations`

2. Create 3 Render Web Services (Node):
   - Core API
   - BookFriend
   - Recommendations

3. Set environment variables:

### Core API
- `BOOKFRIEND_SERVER_URL=https://<bookfriend-service>.onrender.com`
- `RECOMMENDATIONS_SERVICE_ENABLED=true`
- `RECOMMENDATIONS_SERVICE_URL=https://<recommendations-service>.onrender.com`
- existing DB/JWT/CORS vars

### BookFriend
- Its existing `.env.example` vars
- `MONGODB_URI` if it reads book metadata from DB

### Recommendations
- `MONGODB_URI`
- `GROQ_API_KEY`
- `GROQ_MODEL`
- `GOOGLE_BOOKS_API_KEY` (optional)

4. Health checks:
- Core API: `GET /api/health`
- Add a simple `GET /health` in recommendations service and BookFriend for Render health check path.

5. Validate end-to-end:
- open app
- check `POST /api/recommendations` in logs (should hit recommendations service when enabled)
- kill recommendations service once to verify fallback still works in core API

## Next split candidates

After this first split stabilizes, split these next for lower memory in core API:
- quiz engine paths (`/api/quiz`) as service
- search enrichment (`/api/search`) as service

Do this incrementally (one service at a time) so debugging stays easy.
