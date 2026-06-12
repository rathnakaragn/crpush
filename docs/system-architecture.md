# System Architecture — crpush

**Version:** 1.0  
**Date:** 2026-06-12

---

## 1. Architecture Overview

crpush follows a **monolithic edge architecture**. A single Cloudflare Worker handles all concerns: HTTP routing, authentication, HTML rendering, scraping orchestration, and push delivery. There is no microservice boundary, no separate API layer, and no frontend build pipeline.

```
┌──────────────────────────────────────────────────────────────────────┐
│                         crpush Worker                                │
│                                                                      │
│  ┌──────────────┐  ┌─────────────────────────────────────────────┐  │
│  │ Hono Router  │  │              Route Handlers                 │  │
│  │              │  │  GET /          POST /sessions              │  │
│  │  Auth        │  │  GET /session/:id  POST /sessions/:id/stop  │  │
│  │  Middleware  │  │  GET /notifications  POST /poll             │  │
│  │              │  │  GET /logs       POST /logs/clear           │  │
│  │  /* except   │  │  GET /settings   POST /settings             │  │
│  │  /login      │  │  GET /login      POST /settings/test        │  │
│  └──────────────┘  │  POST /login     POST /settings/password    │  │
│                    │  POST /logout    POST /sessions/:id/toggle-notify│
│                    └─────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │  chess.ts    │  │ pushover.ts  │  │       auth.ts            │   │
│  │              │  │              │  │                          │   │
│  │ scraper      │  │ sendPushover │  │ getCookieSecret          │   │
│  │ checkForUpdates  │              │  │ createSessionCookie      │   │
│  │ parseHtml    │  └──────────────┘  │ verifySessionCookie      │   │
│  │ calcPoints   │                    │ hashPassword             │   │
│  │ calcRating   │  ┌──────────────┐  │ verifyPassword           │   │
│  └──────────────┘  │  templates.ts│  └──────────────────────────┘   │
│                    │              │                                  │
│  ┌──────────────┐  │ layout()     │  ┌──────────────────────────┐   │
│  │    db.ts     │  │ formatSession│  │       drizzle.ts         │   │
│  │              │  │ escapeHtml   │  │                          │   │
│  │ getSetting   │  │ statusBadge  │  │ getDb() → AppDB          │   │
│  │ writeLog     │  │ levelBadge   │  │ Drizzle ORM wrapper      │   │
│  │ getCredentials  └──────────────┘  └──────────────────────────┘   │
│  │ parseChessUrl│                                                    │
│  └──────────────┘  ┌──────────────────────────────────────────────┐ │
│                    │              schema.ts                        │ │
│                    │  chessSessions  notifications                 │ │
│                    │  settings       workerLogs                    │ │
│                    └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
  Cloudflare D1       chess-results.com     api.pushover.net
  (SQLite at edge)    (HTML scraping)       (push delivery)
```

---

## 2. Module Responsibilities

| File | Responsibility |
|------|---------------|
| `index.ts` | Hono app bootstrap, all route handlers, scheduled handler, HTML templates for each page |
| `chess.ts` | chess-results.com HTTP fetching, HTML parsing, change detection, notification formatting, poll orchestration |
| `pushover.ts` | Single function: POST to Pushover REST API |
| `auth.ts` | Cookie creation/verification (HMAC-SHA256), password hashing/verification (PBKDF2) |
| `db.ts` | D1 helper functions: `getSetting`, `writeLog`, `getCredentials`, `parseChessUrl` |
| `drizzle.ts` | Drizzle ORM instance factory (`getDb`) |
| `schema.ts` | Drizzle table definitions (single source of truth for schema) |
| `templates.ts` | Shared HTML helpers: `layout`, `escapeHtml`, `statusBadge`, `levelBadge`, `formatSession` |

---

## 3. Layer Diagram

```
┌─────────────────────────────────────────┐
│             Presentation Layer          │
│   index.ts — HTML rendering, routing   │
│   templates.ts — shared HTML helpers   │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│            Application Layer           │
│   index.ts — route handlers            │
│   chess.ts — poll orchestration        │
│   auth.ts  — session management        │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│             Domain Layer               │
│   chess.ts — scraping, parsing,        │
│              change detection,         │
│              notification logic,       │
│              Elo estimation            │
│   pushover.ts — delivery               │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│           Infrastructure Layer         │
│   db.ts       — D1 helper functions    │
│   drizzle.ts  — ORM factory            │
│   schema.ts   — table definitions      │
│   auth.ts     — crypto primitives      │
└─────────────────────────────────────────┘
```

---

## 4. Dependency Graph

```
index.ts
  ├── hono
  ├── drizzle-orm          (eq, and, desc, sql, inArray)
  ├── ./drizzle            (getDb, AppDB)
  ├── ./schema             (chessSessions, notifications, settings, workerLogs)
  ├── ./chess              (checkForUpdates, fetchPlayerData, calculatePoints,
  │                         calculateTotalRatingChange, parseSessionData, ChessSession)
  ├── ./pushover           (sendPushover)
  ├── ./auth               (getCookieSecret, createSessionCookie, getAuthUser,
  │                         hashPassword, verifyPassword)
  ├── ./db                 (getSetting, writeLog, getCredentials, parseChessUrl)
  └── ./templates          (escapeHtml, statusBadge, levelBadge, layout, formatSession)

chess.ts
  ├── drizzle-orm          (eq, sql)
  ├── ./drizzle            (AppDB)
  └── ./schema             (chessSessions, notifications)

templates.ts
  └── ./chess              (parseSessionData, calculatePoints, ChessSession)

db.ts
  ├── drizzle-orm          (eq, sql)
  ├── ./drizzle            (AppDB)
  └── ./schema             (settings, workerLogs)

drizzle.ts
  ├── drizzle-orm/d1
  └── ./schema             (*)

schema.ts
  └── drizzle-orm          (sql)
  └── drizzle-orm/sqlite-core  (integer, sqliteTable, text)

auth.ts
  └── (Web Crypto API — no imports)

pushover.ts
  └── (fetch — no imports)
```

---

## 5. Cloudflare Worker Entry Points

The Worker exports a default object with two handlers:

```typescript
export default {
  fetch: app.fetch,          // handles all HTTP (dashboard)
  scheduled(event, env, ctx) // handles cron triggers
}
```

Both share the same D1 binding (`env.DB`) but run in separate isolate invocations. The `scheduled` handler is purely async — it does not return a response.

**`executionCtx.waitUntil`** is used in `POST /poll` to allow the HTTP response to return immediately while the poll continues processing in the background. This is necessary because the poll can take several seconds (multiple HTTP fetches with delays).

---

## 6. Database Access Pattern

All D1 access goes through Drizzle ORM. The ORM instance is created per-request:

```typescript
// drizzle.ts
export function getDb(d1: D1Database): AppDB {
  return drizzle(d1, { schema });
}
```

There is no connection pool — Cloudflare D1 manages connections internally. Each route handler calls `getDb(c.env.DB)` at the start.

Drizzle is used for all CRUD. Raw SQL is used only for the log-cap delete (not expressible as a simple Drizzle query):
```sql
DELETE FROM worker_logs
WHERE id NOT IN (SELECT id FROM worker_logs ORDER BY created_at DESC LIMIT 1000)
```

---

## 7. Environment & Bindings

Declared in `wrangler.json`:

| Binding | Type | Name in code | Purpose |
|---------|------|--------------|---------|
| D1 database | D1Database | `env.DB` | All persistent state |
| Cron trigger | — | — | `* * * * *` schedule |

All secrets (Pushover tokens, cookie secret, dashboard password) are stored in D1 `settings`, not in Worker environment variables. This allows runtime configuration via the Settings UI without redeployment.

---

## 8. Type System

The codebase uses TypeScript strict mode. Key types:

```
SessionData          — parsed player/match data (in-memory, stored as JSON)
MatchData            — one row from the match history table
ChessSession         — snake_case mirror of D1 chess_sessions row
                       (Drizzle returns camelCase; mapped in checkForUpdates)
TournamentInfo       — full tournament page parse result
TournamentStanding   — one row from the standings table
Notification         — in-memory event (type + old/new data + match)
PollResult           — { sessions, notifications } return from checkForUpdates
AppDB                — Drizzle return type (inferred, not hand-written)
Env                  — Cloudflare binding types (D1Database)
```

`ChessSession` uses `snake_case` field names (matching the original SQL schema) while Drizzle schema uses `camelCase`. The mapping is done once in `checkForUpdates` via an explicit `.map(r => ({ ... }))`.

---

## 9. Security Architecture

| Concern | Approach |
|---------|---------|
| Authentication | HMAC-SHA256 signed session cookie; 7-day expiry |
| Password storage | PBKDF2-SHA256, random 16-byte salt, 100k iterations |
| XSS prevention | All user-controlled data passed through `escapeHtml()` before HTML insertion |
| CSRF | All state-mutating routes are POST; session cookie is `SameSite=Lax` |
| Cookie theft | `HttpOnly; Secure` flags; no JS access to cookie |
| Secret storage | Cookie secret lives in D1, never in Worker env vars or logs |
| Plaintext fallback | Only for bootstrap `admin/admin`; replaced with PBKDF2 hash on first credential change |

---

## 10. Deployment Architecture

```
Developer machine
  │
  │  npm run deploy
  │  (wrangler CLI)
  ▼
Cloudflare Edge Network
  ├── Worker bundle (TypeScript → V8 bytecode, compiled by Wrangler)
  ├── D1 database (crpush) — replicated SQLite
  └── Cron trigger (* * * * *)

No staging environment. Deploy directly to production on main.
```

**Deploy checklist:**
1. `wrangler d1 create crpush` (first time only)
2. Set `database_id` in `wrangler.json`
3. `wrangler d1 execute crpush --remote --file=schema.sql` (first time only)
4. `npm run deploy`

---

## 11. Testing Architecture

Tests live alongside source files as `*.test.ts`. Only pure functions are tested — no Worker runtime, no D1, no fetch mocking.

| Test file | What is tested |
|-----------|---------------|
| `auth.test.ts` | `b64url`, cookie create/verify, password hash/verify |
| `chess.test.ts` | `parseSessionData`, `calculatePoints`, `calculateTotalRatingChange`, HTML parsers |
| `db.test.ts` | `parseChessUrl` |
| `pushover.test.ts` | `sendPushover` (with fetch mock) |

**Test runner:** Vitest, `node` environment (not Workers environment).

```bash
npm test          # run once
npm run test:watch  # watch mode
```

Integration testing (end-to-end cron/scraping) is done manually via `npm run dev` (local wrangler dev server) and the "Check Now" button in the dashboard.

---

## 12. Technology Choices

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Cloudflare Workers | Zero infrastructure cost, global edge, built-in cron |
| Database | Cloudflare D1 | Native Workers binding, SQLite semantics, free tier |
| ORM | Drizzle | Type-safe, D1 support, minimal overhead |
| HTTP framework | Hono | Lightweight, first-class Workers support, familiar Express-style API |
| Frontend | Server-rendered HTML + Tailwind CDN | No build step, no JS bundle, fast iteration |
| Push delivery | Pushover | Reliable, cheap, excellent mobile UX, simple REST API |
| Auth | Custom HMAC cookie | No external dependency, runs on Web Crypto API |
| Scraping | Raw regex HTML parsing | chess-results.com has no API; DOM parser unavailable in Workers |
