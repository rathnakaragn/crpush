# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver
(`feat:` → minor, `fix:`-only → patch).

## [Unreleased]

## [1.6.0] - 2026-08-02

### Changed

- Poll cadence is now phase- and time-control aware: sessions awaiting a
  pairing (incl. before round 1) poll every minute so the board number arrives
  before the round; while a round is in progress the cadence relaxes to the
  base time control (e.g. 15+5 → every 15 min, clamped 5–15) since nothing can
  change mid-game. The time-control category and string are captured from the
  tournament details page onto each session. Idle/quiet-hours cadence unchanged.
- Later-round pairing detection fixed: a pairing published without any
  standings change (the standings header only advances on results) is now
  caught — the player page stays watched whenever no future pairing is known.
- Rate-limit handling: chess-results.com's daily-limit page now aborts the
  cycle, pauses all polling for 30 minutes, and sends one alert — instead of
  counting as per-session fetch failures (which, at 1-minute cadence, flipped
  every running session to `error` within 3 minutes).
- Overlap guard: a poll cycle started less than 50s ago blocks the next one,
  preventing concurrent retry passes from double-sending notifications; a
  crashed cycle's stale guard expires on its own.
- Outbound chess-results.com fetches time out after 10s instead of hanging
  the cycle.

## [1.5.0] - 2026-08-02

### Changed

- Schema management moved to drizzle-kit migrations: `src/worker/schema.ts` is
  now the single source of truth (indexes, FK, and CHECK constraints included);
  `schema.sql` is retired in favor of generated migrations in `drizzle/`
  (`just db-generate` / `just db-migrate`). Production was baselined with an
  idempotent init migration; integration tests apply the same chain.
- Adaptive poll cadence: the cron now fires every minute, but the handler
  polls at full speed only while a session is running outside quiet hours —
  idle or quiet-hours cycles keep the old 5-minute cadence (`shouldRunCron`).

## [1.4.0] - 2026-08-02

### Added

- Stop/Start/Delete actions on the session detail page (previously dashboard
  only).
- App version in the dashboard footer (from `package.json`).

### Changed

- Tailwind is now compiled ahead of time and served inline (`just css` →
  `src/worker/styles.ts`) instead of loaded from the CDN — the dashboard no
  longer depends on any external host.
- Failed logins are delayed by 1 second as a brute-force damper.

## [1.3.2] - 2026-08-02

### Fixed

- Standings parser now reads points and tiebreaks for unrated players: the
  rating cell holds `0` for them, which previously failed the rating match
  and skipped the points search entirely (row parsed as 0 points).

## [1.3.1] - 2026-08-02

### Fixed

- Integration tests now build their schema from `schema.sql` directly (raw
  import) instead of a hand-maintained copy — no more schema drift risk.
- Scraper regression tests against real chess-results.com pages captured as
  fixtures (`src/worker/__fixtures__/`): player card, matches incl. upcoming
  pairing, tournament details, and full standings.

## [1.3.0] - 2026-08-02

### Changed

- Quiet hours now defer notifications instead of skipping polling: the cron
  keeps polling overnight, saves notifications unsent, and the retry pass
  delivers them on the first cycle after quiet hours end — no more morning
  catch-up gap. Cron error alerts still send during quiet hours, but at low
  (silent) priority.
- Sessions are marked `error` after 3 consecutive fetch failures (new
  `fail_count` column; migration: `ALTER TABLE chess_sessions ADD COLUMN
  fail_count INTEGER DEFAULT 0`). A successful fetch or the Start button
  resets the streak.
- Old rows are pruned on each poll: worker logs after 30 days, sent
  notifications after 90 days.

### Added

- Start button to resume stopped/errored sessions. Resume is silent: the data
  snapshot is refreshed first so no catch-up notifications fire for rounds
  played while stopped; if the refresh fails the session stays stopped (logged).
- Per-type Pushover notification priorities, configurable on the Settings page:
  pairing defaults to high (bypasses Pushover quiet hours), result to normal,
  completion to low. Clamped to -2..1 — emergency priority is unsupported.
- Delete button for non-running sessions (with confirm): removes the session
  and its notifications. The route refuses to delete running sessions
  server-side.

## [1.2.8] - 2026-08-02

### Fixed

- CLAUDE.md described auth that no longer exists (admin/admin defaults,
  `dashboard_user`/`dashboard_password`/`session_cookie_secret` settings keys);
  corrected to the `AUTH_PASSWORD` secret and the five real settings keys.
- README updated to the `just` workflow (deploy step and Commands section);
  `.DS_Store` gitignored.

## [1.2.7] - 2026-08-02

### Fixed

- Synced dashboard-only Worker settings into `wrangler.json` (smart placement,
  observability logs) so deploys no longer revert them.
- Documented toolchain notes in CLAUDE.md: Node v22+ requirement (Homebrew
  node v26 is canonical; stale `/usr/local/bin/node` symlink and `node@20`
  removed), wrangler OAuth re-auth, and dashboard config-drift rule.

## [1.2.6] - 2026-08-02

### Fixed

- Notifications page and worker log timestamps now render in the configured
  timezone (were showing UTC).
- Cron errors and crashes now alert via Pushover (`url` made optional in
  `sendPushover`).
- Unsent notifications are retried on each cron/poll cycle (24-hour window).
- `src` typecheck errors resolved (unused imports, `cloudflare:test` types for
  integration tests).

### Changed

- Adopted `just ci` pre-push gate and milestone tagging workflow (justfile
  replaces Makefile; changelog added).

## [1.2.5] - 2026-06-12

### Changed

- Docs bumped to reflect v1.2.4.

## [1.2.4] - 2026-06-12

### Changed

- Docs bumped to reflect v1.2.3.

## [1.2.3] - 2026-06-12

### Fixed

- README deploy command updated; integration test command documented.

## [1.2.2] - 2026-06-12

### Changed

- All docs updated to reflect v1.2.1 (auth, time control, integration tests).

## [1.2.1] - 2026-06-12

### Fixed

- README Node.js prerequisite updated to v22+.

## [1.2.0] - 2026-06-12

### Added

- Time control shown on the session detail page.
- 22 integration tests using `@cloudflare/vitest-pool-workers`.
- 12 auth unit tests (`b64url`, `makeSessionCookie`, `verifySessionCookie`).

## [1.1.0] - 2026-06-12

### Added

- Single-user password auth via `AUTH_PASSWORD` secret (later removed — single
  user app, no login required).

### Fixed

- Base64 padding restored before `atob` in `verifySessionCookie`.
- DB binding pointed at the new `crpush` D1 database; README updated for the
  rename.

## [1.0.0] - 2026-06-12

Initial release.

### Added

- chess-results.com scraper and polling logic with round diffing.
- Pushover API client and cron handler with quiet hours.
- Server-rendered dashboard: sessions, session detail, notifications, logs,
  settings pages.
- Cookie auth, D1 schema, manual poll endpoint, unit tests.

### Fixed

- HTML escaped in all template interpolations (XSS prevention).
- Dashboard password hashed with PBKDF2.

[Unreleased]: https://github.com/rathnakaragn/crpush/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/rathnakaragn/crpush/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/rathnakaragn/crpush/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/rathnakaragn/crpush/compare/v1.3.2...v1.4.0
[1.3.2]: https://github.com/rathnakaragn/crpush/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/rathnakaragn/crpush/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/rathnakaragn/crpush/compare/v1.2.8...v1.3.0
[1.2.8]: https://github.com/rathnakaragn/crpush/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/rathnakaragn/crpush/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/rathnakaragn/crpush/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/rathnakaragn/crpush/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/rathnakaragn/crpush/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/rathnakaragn/crpush/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/rathnakaragn/crpush/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/rathnakaragn/crpush/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/rathnakaragn/crpush/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/rathnakaragn/crpush/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rathnakaragn/crpush/releases/tag/v1.0.0
