# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver
(`feat:` → minor, `fix:`-only → patch).

## [Unreleased]

### Fixed

- Notifications page and worker log timestamps now render in the configured
  timezone (were showing UTC).
- Cron errors and crashes now alert via Pushover (`url` made optional in
  `sendPushover`).
- Unsent notifications are retried on each cron/poll cycle (24-hour window).

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

[Unreleased]: https://github.com/rathnakaragn/crpush/compare/v1.2.5...HEAD
[1.2.5]: https://github.com/rathnakaragn/crpush/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/rathnakaragn/crpush/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/rathnakaragn/crpush/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/rathnakaragn/crpush/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/rathnakaragn/crpush/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/rathnakaragn/crpush/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/rathnakaragn/crpush/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rathnakaragn/crpush/releases/tag/v1.0.0
