# CLAUDE.md — OpenCRBot (Pushover Edition)

A self-hosted Cloudflare Workers app that monitors chess-results.com tournaments and sends real-time Pushover notifications. Server-rendered HTML dashboard, no frontend build step.

## Solo Workflow

Commit directly to `main`. No branches, no PRs.

**Commit message prefixes:**
- `feat:` — new features
- `fix:` — everything else (bugs, deps, config, refactor, docs, cleanup)

### Three rules

1. **Always on `main`** — never create a branch, commit directly to `main`
2. **Push often** — `git push` after every commit or two
3. **Deploy when a feature is complete**
   - `npm run deploy` when a feature is done and working

## Commands

```bash
npm run dev        # wrangler dev (local Worker)
npm run deploy     # wrangler deploy (to Cloudflare)
npm test           # vitest run
npm run test:watch # vitest watch
npx tsc --noEmit   # type-check (ignore errors in node_modules)
```

## Stack

- **Runtime:** Cloudflare Workers (TypeScript compiled by Wrangler directly — no build step)
- **Framework:** Hono v4
- **Database:** Cloudflare D1 (SQLite at edge), binding name `DB`
- **Notifications:** Pushover API (`src/worker/pushover.ts`)
- **Chess scraping:** chess-results.com HTML scraper (`src/worker/chess.ts`)
- **Dashboard:** Server-rendered HTML, Tailwind CSS from CDN (no postcss, no config file)
- **Auth:** HMAC-SHA256 signed cookies, 7-day expiry
- **Tests:** Vitest, node environment, pure function tests only

## Project Structure

```
src/worker/
  index.ts      — Hono app: all routes, HTML templates, cookie auth, cron handler
  chess.ts      — chess-results.com scraper + polling logic
  pushover.ts   — Pushover API client
  *.test.ts     — unit tests (pure functions only)
schema.sql      — D1 schema (run via wrangler d1 execute)
wrangler.json   — Worker config: D1 binding + cron trigger (* * * * *)
```

## TypeScript Rules

- `noUnusedLocals: true` and `noUnusedParameters: true` are enforced
- Use `export` on helpers when routes haven't been wired up yet (avoids false TS errors during incremental development)
- Prefix unused parameters with `_` (e.g., `_event`, `_ctx`)
- Errors in `node_modules` from `npx tsc --noEmit` can be ignored (vitest/vite type conflicts with @cloudflare/workers-types)

## D1 Database

Tables: `chess_sessions`, `notifications`, `settings`, `worker_logs`

Key settings keys: `pushover_app_token`, `pushover_user_key`, `dashboard_user`, `dashboard_password`, `timezone`, `night_start_hour`, `night_end_hour`, `session_cookie_secret`

Default credentials: `admin` / `admin` (change on first login via Settings page)

## Deployment

```bash
# First-time setup
wrangler d1 create opencrbot
# Update database_id in wrangler.json
wrangler d1 execute opencrbot --remote --file=schema.sql
npm run deploy
```
