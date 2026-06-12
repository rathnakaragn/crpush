# crpush — Design Spec

**Date:** 2026-06-12  
**Status:** Implemented  
**Note:** Originally named `opencrbot` / `opencrpushover`. Renamed to `crpush`. Several sections below reflect post-plan implementation decisions (Drizzle ORM, module split, PBKDF2 hashing).

---

## Overview

A self-hosted Cloudflare Workers app that monitors chess-results.com tournaments and sends real-time Pushover notifications for pairings, results, and tournament completion. Server-rendered HTML dashboard. No frontend build step.

---

## Goals

- Monitor multiple players across multiple tournaments simultaneously
- Send Pushover notifications for: new pairings, match results, tournament completion
- Provide a simple HTML dashboard for admin tasks (no separate frontend build)
- Deploy on Cloudflare Workers free tier (Workers + D1)
- Quiet hours: skip polling during configured night hours

---

## Non-Goals

- Multi-user notification delivery (Pushover targets one user key)
- Telegram bot, webhook, or bot commands
- React/Vite frontend build pipeline
- Swagger/OpenAPI documentation
- JWT authentication (cookie-based is sufficient for server-rendered HTML)

---

## Project Structure

```
src/worker/
  index.ts       — Hono app: all routes, HTML templates, cron handler
  chess.ts       — chess-results.com scraper + polling logic
  pushover.ts    — Pushover API client
  auth.ts        — Cookie creation/verification (HMAC-SHA256), password hashing (PBKDF2)
  db.ts          — D1 helper functions (getSetting, writeLog, getCredentials, parseChessUrl)
  drizzle.ts     — Drizzle ORM instance factory (getDb)
  schema.ts      — Drizzle table definitions (single source of truth for schema)
  templates.ts   — Shared HTML helpers (layout, escapeHtml, statusBadge, levelBadge, formatSession)
  *.test.ts      — Unit tests (pure functions only, Vitest node environment)
schema.sql       — D1 database schema (run via wrangler d1 execute)
wrangler.json    — Cloudflare Worker + D1 binding + cron trigger config
```

No Vite, no postcss, no tailwind config file, no React. Wrangler compiles TypeScript directly.

---

## Architecture

### Worker Entry Points

**`fetch` handler** — Hono app serving the HTML dashboard and handling form POSTs.

**`scheduled` handler** — Cloudflare Cron Trigger (`* * * * *`). Checks quiet hours, polls all running sessions, fires Pushover notifications for changes.

### Request Flow (Cron)

1. Load settings from D1 (timezone, quiet hours, Pushover tokens) in one batch query
2. Compute current hour in configured timezone — skip if within quiet hours
3. Load all `status = 'running'` sessions from D1 via Drizzle
4. Group sessions by tournament (one standings fetch per tournament)
5. For each tournament group:
   a. Fetch tournament standings page (one HTTP request)
   b. For each player session: check if standings changed via `hasStandingsChanged()`
   c. If changed (or new round): fetch player detail page, diff against stored data
   d. Emit notifications for new pairings, results, completions
6. Send each notification via Pushover API if `session.notify = 1`
7. Persist updated session data to D1 via Drizzle
8. Auto-mark sessions `completed` when all rounds finished
9. Log activity to `worker_logs`

**Rate limiting:** 2-second delay between chess-results.com requests.

### Manual Poll

`POST /poll` triggers the same logic as the cron handler. Uses `c.executionCtx.waitUntil()` so the HTTP response redirects immediately while polling continues in the background.

---

## Database Schema

Four tables. All D1 access goes through Drizzle ORM (`drizzle-orm/d1`).

```sql
CREATE TABLE IF NOT EXISTS chess_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  tournament_id TEXT NOT NULL,
  player_snr TEXT NOT NULL,
  server TEXT DEFAULT '',
  federation TEXT DEFAULT 'IND',
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'stopped', 'completed', 'error')),
  notify INTEGER DEFAULT 1,
  data TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pairing', 'result', 'completion')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  sent INTEGER DEFAULT 0,
  round_number INTEGER NOT NULL DEFAULT -1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES chess_sessions(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  source TEXT NOT NULL DEFAULT 'worker',
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON chess_sessions(status);
CREATE INDEX IF NOT EXISTS idx_notifications_session ON notifications(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(session_id, type, round_number);
CREATE INDEX IF NOT EXISTS idx_worker_logs_created ON worker_logs(created_at DESC);
```

### Settings Keys

| Key | Description | Default |
|---|---|---|
| `pushover_app_token` | Pushover application token | — |
| `pushover_user_key` | Pushover user key | — |
| `dashboard_user` | Dashboard login username | `admin` |
| `dashboard_password` | Dashboard login password (PBKDF2 hash after first change) | `admin` |
| `timezone` | Timezone for quiet hours | `Asia/Kolkata` |
| `night_start_hour` | Quiet hours start (24h) | `23` |
| `night_end_hour` | Quiet hours end (24h) | `6` |
| `session_cookie_secret` | HMAC key for signed session cookies | auto-generated on first boot |

---

## Authentication

Cookie-based session auth. On successful login, the server sets a signed `session` cookie (HMAC-SHA256, 7-day expiry). All dashboard routes (except `/login`) check this cookie via auth middleware.

**Password storage:** Passwords are stored as PBKDF2-SHA256 with a random 16-byte salt and 100,000 iterations. The default `admin/admin` credentials are stored plain-text and replaced with a PBKDF2 hash on the first credential change. The login handler detects which format is in use by checking if the stored value contains `:` and has length > 40.

---

## Pushover Integration

**File:** `src/worker/pushover.ts`

Simple POST to `https://api.pushover.net/1/messages.json`:

```
token     = pushover_app_token (from settings)
user      = pushover_user_key (from settings)
title     = notification title (e.g. "Round 5: WON!")
message   = notification body
url       = chess-results.com player URL
url_title = "View on chess-results.com"
```

`sendPushover(token, userKey, title, message, url): Promise<boolean>` — returns `true` on success.

### Notification Types & Content

**Pairing** (`type = 'pairing'`):
- Title: `Round N Pairing`
- Message: `[Player] vs [Opponent]\nPlaying: [Color]\nBoard: [N]\nRank: #X | Points: Y/Z`

**Result** (`type = 'result'`):
- Title: `Round N: WON! / LOST! / DRAW!`
- Message: `[Player] vs [Opponent]\nNew Rank: #X (↑/↓N)\nPoints: Y/Z\nRating: ±N`

**Completion** (`type = 'completion'`):
- Title: `Tournament Complete!`
- Message: `[Player]\n[Tournament]\nFinal Rank: #X\nFinal Score: Y/Z\nRating: ±N (Perf: NNNN)`

---

## Dashboard

All pages are server-rendered HTML. Tailwind CSS loaded from CDN. All user-controlled data passed through `escapeHtml()` before insertion into HTML.

### Routes

| Route | Method | Description |
|---|---|---|
| `GET /login` | GET | Login form |
| `POST /login` | POST | Authenticate, set cookie, redirect to `/` |
| `POST /logout` | POST | Clear cookie, redirect to `/login` |
| `GET /` | GET | Sessions list with Add form and Check Now button |
| `GET /session/:id` | GET | Session detail: matches, rating estimate, stats |
| `GET /notifications` | GET | Last 50 notifications |
| `GET /logs` | GET | Last 100 worker logs, clear button |
| `GET /settings` | GET | Pushover config, quiet hours, credentials change |
| `POST /sessions` | POST | Add new monitoring session |
| `POST /sessions/:id/stop` | POST | Stop a session |
| `POST /sessions/:id/toggle-notify` | POST | Toggle Pushover delivery for session |
| `POST /settings` | POST | Save settings |
| `POST /settings/test` | POST | Send a test Pushover notification |
| `POST /settings/password` | POST | Update username + password (hashes with PBKDF2, clears session cookie) |
| `POST /poll` | POST | Trigger manual poll via waitUntil, redirect back to `/` |
| `POST /logs/clear` | POST | Delete all worker_logs rows |

---

## Deployment

```bash
# First-time setup
wrangler d1 create crpush
# Update database_id in wrangler.json
wrangler d1 execute crpush --remote --file=schema.sql
npm run deploy

# Subsequent deploys
npm run deploy
```

Default login: `admin` / `admin` — change immediately via Settings.

---

## What Changed vs Original Plan

| Area | Original plan | Actual implementation |
|------|--------------|----------------------|
| ORM | Raw `D1Database` SQL | Drizzle ORM (`drizzle-orm/d1`) |
| Module structure | Monolithic `index.ts` | Split: `auth.ts`, `db.ts`, `templates.ts`, `drizzle.ts`, `schema.ts` |
| Password storage | Plain-text in settings | PBKDF2-SHA256 (100k iterations, random salt) — added during implementation |
| Manual poll | Synchronous, blocks response | `executionCtx.waitUntil()` — async, response redirects immediately |
| Project name | `opencrbot` / `opencrpushover` | `crpush` |
| Test coverage | `chess.test.ts`, `pushover.test.ts` | + `auth.test.ts`, `db.test.ts` |
