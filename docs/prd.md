# Product Requirements Document — crpush

**Version:** 1.2.3  
**Date:** 2026-06-12  
**Owner:** rathnakaragn

---

## 1. Overview

**crpush** (Chess Results Pushover) is a self-hosted Cloudflare Workers application that monitors live chess tournaments on [chess-results.com](https://chess-results.com) and delivers real-time push notifications to the user's mobile device via [Pushover](https://pushover.net).

The app runs entirely at the edge with no external backend — all state is persisted in Cloudflare D1 (SQLite) and all logic runs inside a single Worker.

---

## 2. Problem Statement

Chess players and their supporters have no reliable way to receive instant notifications when:
- A player is paired for the next round
- A game result is posted
- A tournament concludes

Checking chess-results.com manually is tedious and often missed. No existing push notification service targets chess-results.com specifically.

---

## 3. Goals

| # | Goal |
|---|------|
| G1 | Notify within one minute of a pairing or result appearing on chess-results.com |
| G2 | Support monitoring multiple players across multiple concurrent tournaments |
| G3 | Avoid notification spam during night/quiet hours |
| G4 | Run with zero ongoing infrastructure cost (Cloudflare free tier) |
| G5 | Be self-hosted — no third-party data sharing beyond Pushover delivery |

---

## 4. Non-Goals

- Multi-user / multi-account support (single admin user)
- Support for chess platforms other than chess-results.com (lichess, Chess.com, etc.)
- Email or SMS delivery (Pushover only)
- Historical analytics or reporting beyond the last 50 notifications and 100 log lines
- Mobile or native app

---

## 5. Target Users

**Primary:** A chess player or coach who wants instant updates for one or more players in over-the-board tournaments that are streamed to chess-results.com.

**Technical profile:** Comfortable setting up a Cloudflare account, creating a D1 database, and deploying a Worker via Wrangler CLI. Not necessarily a developer.

---

## 6. Features

### 6.1 Session Management

- **Add session** — paste a chess-results.com player URL; the app parses it, fetches initial data, and begins monitoring
- **Stop session** — manually stop monitoring a player mid-tournament
- **Auto-complete** — session transitions to `completed` status automatically when `completed_rounds >= total_rounds`
- **Mute/unmute** — toggle Pushover delivery per session without stopping polling
- **Duplicate prevention** — adding the same URL while a session is `running` is a no-op

### 6.2 Polling & Change Detection

- **Cron trigger** — Worker runs every minute via Cloudflare cron (`* * * * *`)
- **Tournament-level pre-check** — fetches the tournament standings page first; skips per-player fetch if standings show no change (reduces requests)
- **Per-player fetch** — fetches the individual player page when standings indicate a change or a new round has started
- **Request throttling** — 2-second delay between tournament fetches and between player fetches to avoid rate-limiting by chess-results.com

### 6.3 Notification Types

| Type | Trigger | Content |
|------|---------|---------|
| `pairing` | New round with no result yet | Opponent name, color, board number, current rank/score |
| `result` | A game result is posted | Win/Loss/Draw, new rank, rank change delta, rating change if available |
| `completion` | Final round result posted | Final rank, final score, rating change, performance rating |

- Deduplication: notifications are stored with `(session_id, type, round_number)` uniqueness; re-delivery of the same notification is skipped silently
- Notify flag respected: notifications are always stored in DB; Pushover delivery is skipped if the session is muted

### 6.4 Quiet Hours

- Configurable start/end hour (24h) and timezone
- During quiet hours the cron handler logs a skip and returns immediately — no HTTP requests to chess-results.com, no notifications
- Default: 23:00–06:00 Asia/Kolkata

### 6.5 Dashboard

Server-rendered HTML dashboard (no JS framework, Tailwind CSS via CDN):

| Page | Purpose |
|------|---------|
| `/` | Sessions list — player, tournament, rank, score, status, mute toggle, stop action |
| `/session/:id` | Session detail — player stats, time control, match history table, rating estimate |
| `/notifications` | Last 50 notifications with type badge, title, message, sent status |
| `/logs` | Last 100 worker log lines with level badge, source, message; clear button |
| `/settings` | Pushover credentials, quiet hours config, change credentials |

- **Manual poll** — "Check Now" button on the sessions page triggers an immediate poll outside cron
- **Test notification** — sends a test Pushover message to verify credentials

### 6.6 Authentication

- Single-user password auth via `AUTH_PASSWORD` Cloudflare Workers secret
- Password set once with `wrangler secret put AUTH_PASSWORD` — no UI credential management
- Session cookie: HMAC-SHA256 signed (using `AUTH_PASSWORD` as key), 7-day expiry, `HttpOnly; Secure; SameSite=Lax`
- Rotating `AUTH_PASSWORD` automatically invalidates all existing sessions

### 6.7 URL Parsing

Supported URL format:
```
https://[server.]chess-results.com/tnrNNNNNN.aspx?lan=1&art=9&fed=XXX&snr=NN[&SNode=N...]
```
- Extracts: `server` (subdomain), `tournament_id`, `player_snr`, `federation`
- Extra query params (e.g. `SNode` for multi-section tournaments) are preserved in the stored URL and passed verbatim to subsequent fetches

---

## 7. Data Model

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `chess_sessions` | `url`, `tournament_id`, `player_snr`, `server`, `federation`, `status`, `notify`, `data` | One row per monitored player; `data` is JSON blob of last-fetched `SessionData` |
| `notifications` | `session_id`, `type`, `title`, `message`, `sent`, `round_number` | Audit log of every notification; unique on `(session_id, type, round_number)` |
| `settings` | `key`, `value` | Key-value store for all configuration |
| `worker_logs` | `level`, `source`, `message`, `created_at` | Rolling log capped at 1,000 rows |

---

## 8. Technical Constraints

| Constraint | Detail |
|------------|--------|
| Runtime | Cloudflare Workers (V8 isolate, no Node.js APIs) |
| Language | TypeScript, compiled by Wrangler (no build step) |
| Database | Cloudflare D1 via Drizzle ORM |
| HTTP framework | Hono v4 |
| Cron | Cloudflare scheduled triggers (`* * * * *`) |
| Crypto | Web Crypto API (HMAC, PBKDF2) |
| No outbound auth | chess-results.com is scraped as a public site; no API key |
| CPU limits | Cloudflare free tier: 10ms CPU per invocation (I/O awaits don't count) |

---

## 9. Scraping Approach

chess-results.com returns server-rendered HTML. The scraper:
- Parses `<tr class="CRg1/CRg2">` rows for standings and match tables
- Decodes HTML entities (`&#NNN;`, `&amp;`, `&frac12;`, etc.)
- Extracts player info from labeled `<td>` pairs (`>Name</td>`, `>Rank</td>`, etc.)
- Handles multi-section tournaments via preserved URL params
- Handles rate-limit responses (`exceeded daily limit`) gracefully by returning `null`

---

## 10. Notification Delivery

Pushover REST API (`https://api.pushover.net/1/messages.json`):
- Fields sent: `token`, `user`, `title`, `message`, `url`, `url_title`
- `url` links to the player's chess-results.com page
- Delivery is fire-and-forget; failure is logged but does not retry

---

## 11. Rating Estimate

When FIDE official rating change is not yet published, the dashboard computes an Elo estimate:
- Expected score: `1 / (1 + 10^((oppRating - playerRating) / 400))`
- Change per game: `K × (actual − expected)` where K is parsed from the player page (defaults to 20)
- Displayed as `~+N` to distinguish from confirmed FIDE change

---

## 12. Deployment

```bash
# One-time setup
wrangler d1 create crpush
# Update database_id in wrangler.json
wrangler d1 execute crpush --remote --file=schema.sql
npm run deploy

# Subsequent deploys
npm run deploy
```

Default credentials: `admin / admin` — change immediately via Settings after first deploy.

---

## 13. Out-of-Scope for v1

- Bracket / pairing prediction
- Player comparison across sessions
- Webhook delivery (only Pushover)
- Tournament-level (not player-level) monitoring
- Notification delivery retry on failure
- Multiple admin users or role-based access
