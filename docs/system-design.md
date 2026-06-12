# System Design — crpush

**Version:** 1.2.3  
**Date:** 2026-06-12

---

## 1. High-Level Design

crpush is a single-process edge application. There is no separate backend, no message queue, and no external state store beyond Cloudflare D1. All inbound traffic (dashboard HTTP) and all outbound traffic (scraping + Pushover) flows through one Cloudflare Worker.

```
┌─────────────────────────────────────────────────────────────┐
│                     Cloudflare Network                      │
│                                                             │
│  ┌─────────────┐   HTTP     ┌────────────────────────────┐  │
│  │   Browser   │──────────▶│                            │  │
│  └─────────────┘           │      crpush Worker         │  │
│                            │      (Hono v4 + TS)        │  │
│  ┌─────────────┐   Cron    │                            │  │
│  │ CF Scheduler│──────────▶│                            │  │
│  └─────────────┘           └────────────┬───────────────┘  │
│                                         │                   │
│                            ┌────────────▼───────────────┐  │
│                            │     Cloudflare D1 (SQLite) │  │
│                            └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  chess-results.com            api.pushover.net
  (HTML scraping)              (push delivery)
```

---

## 2. Request Flows

### 2.1 Dashboard Request (Browser → Worker)

```
Browser
  │
  ├─ GET /  ────────────────────────────────────────────────────────────┐
  │                                                                     │
  │         Auth Middleware                                             │
  │           ├─ Read "Cookie: session=..." header                      │
  │           ├─ getCookieSecret() → D1 SELECT settings                │
  │           ├─ verifySessionCookie() → HMAC-SHA256 verify            │
  │           └─ if invalid → redirect /login                          │
  │                                                                     │
  │         Route Handler (GET /)                                       │
  │           ├─ D1: SELECT chess_sessions ORDER BY created_at DESC    │
  │           ├─ D1: COUNT running sessions                            │
  │           ├─ D1: COUNT sent notifications                          │
  │           ├─ D1: SELECT credentials (warn if default)             │
  │           └─ render HTML via layout() + formatSession()           │
  │                                                                     │
  └─ ◀────────────────────── 200 HTML ──────────────────────────────────┘
```

### 2.2 Add Session (POST /sessions)

```
Browser POST /sessions { url: "https://chess-results.com/tnr..." }
  │
  ├─ parseChessUrl() → extract server, tournament_id, player_snr, federation
  ├─ D1: SELECT existing running session for same URL → deduplicate
  ├─ fetchPlayerData() → GET chess-results.com → parsePlayerHtml()
  └─ D1: INSERT chess_sessions with initial data JSON blob
```

### 2.3 Cron Poll (Scheduled → Worker)

```
Cloudflare Scheduler (every minute)
  │
  ├─ D1: SELECT settings (timezone, quiet hours, pushover tokens)
  ├─ Compute local hour → isNight? → return early if yes
  │
  ├─ D1: SELECT chess_sessions WHERE status = 'running'
  ├─ groupByTournament() → Map<"server:tournament_id", sessions[]>
  │
  └─ For each tournament group:
       ├─ fetchTournamentData() → GET standings page + details page
       │    └─ parseStandingsTable() → TournamentStanding[]
       │
       └─ For each session in group:
            ├─ Check oldData.completed_rounds >= total_rounds → auto-stop
            ├─ findPlayerInStandings() → TournamentStanding | undefined
            ├─ hasStandingsChanged()? or hasNewRound?
            │    └─ if no change → writeLog "no change", skip fetch
            │
            ├─ fetchPlayerData() → GET player page → parsePlayerHtml()
            ├─ checkPlayerUpdate() → compare old vs new matches
            │    ├─ new round seen → push pairing or result notification
            │    └─ existing round now has result → push result notification
            │
            ├─ D1: INSERT notifications (dedup on session+type+round)
            ├─ D1: UPDATE chess_sessions SET data = newData
            │
            └─ if session.notify = 1:
                 ├─ sendPushover() → POST api.pushover.net
                 └─ D1: UPDATE notifications SET sent = 1
```

### 2.4 Manual Poll (POST /poll)

Same logic as cron poll but triggered via browser button. Uses `c.executionCtx.waitUntil()` so the response redirects immediately while polling continues in the background.

---

## 3. Change Detection Algorithm

The system uses a two-tier change detection strategy to minimise HTTP requests to chess-results.com.

**Tier 1 — Tournament standings (cheap, one request per tournament):**

```
Fetch /tnrNNN.aspx?lan=1&art=1  (standings page)

For each session in tournament:
  standing = findPlayerInStandings(standings, player.name)
  needsFetch = !standing
             || standing.rank    ≠ oldData.player.current_rank
             || standing.points  ≠ calculatePoints(oldData.matches)
             || tournamentData.currentRound > oldData.matches.length
```

**Tier 2 — Player detail (one request per changed player):**

```
Fetch /tnrNNN.aspx?lan=1&art=9&fed=XXX&snr=NN  (player page)

For each match in newData:
  oldMatch = oldByRound.get(round_number)
  if !oldMatch:
    → emit pairing (if no result) or result notification
  elif !isCompleted(oldMatch.result) && isCompleted(newMatch.result):
    → emit result notification

if completed_rounds >= total_rounds && previously not complete:
  → emit completion notification
  → UPDATE status = 'completed'
```

**Request budget per cron tick:**
- 1 request per unique tournament (standings)
- Up to N requests per tournament (one per changed player)
- 2-second delay between each tournament group fetch
- 2-second delay before each player detail fetch

---

## 4. Notification Deduplication

Notifications are stored with a unique constraint on `(session_id, type, round_number)`. `saveNotification()` catches the constraint violation and returns `0`; the caller skips Pushover delivery for that notification. This prevents duplicate pushes if the cron overlaps or if the same result appears across two ticks.

---

## 5. Authentication Design

```
Login flow:
  POST /login { password }
    │
    ├─ compare password with c.env.AUTH_PASSWORD (Cloudflare Workers secret)
    ├─ on success → makeSessionCookie(AUTH_PASSWORD)
    │    ├─ payload = unix expiry timestamp (string)
    │    └─ cookie  = payload + "." + b64url(HMAC-SHA256(payload, AUTH_PASSWORD))
    └─ Set-Cookie: session=<cookie>; HttpOnly; Secure; SameSite=Lax; Max-Age=604800

Subsequent requests:
  Auth middleware → verifySessionCookie(cookie, AUTH_PASSWORD)
    ├─ split on last "."
    ├─ restore base64 padding, verify HMAC signature
    ├─ check expiry timestamp > now
    └─ false → redirect /login
```

Password is stored as a Workers secret (`AUTH_PASSWORD`), never in D1.
Rotating `AUTH_PASSWORD` via `wrangler secret put` immediately invalidates all sessions.

---

## 6. Data Flow Diagram

```
chess-results.com HTML
        │
        ▼
  fetchPlayerData()          fetchTournamentData()
        │                           │
        ▼                           ▼
  parsePlayerHtml()      parseStandingsTable()
        │                           │
        └──────────┬────────────────┘
                   ▼
          checkPlayerUpdate()
                   │
          ┌────────┴────────┐
          │                 │
     Notification[]    UPDATE chess_sessions.data
          │
     formatNotification()
          │
     ┌────┴────┐
     │         │
  D1 INSERT  sendPushover()
  notifications    │
                   ▼
           api.pushover.net
```

---

## 7. Storage Design

All state lives in Cloudflare D1 (SQLite at edge). There is no in-memory cache — each Worker invocation starts cold.

### chess_sessions

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | auto-increment |
| url | TEXT | original chess-results.com URL (preserved verbatim for SNode etc.) |
| tournament_id | TEXT | e.g. `tnr123456` |
| player_snr | TEXT | start number within tournament |
| server | TEXT | subdomain prefix, empty for root domain |
| federation | TEXT | e.g. `IND` |
| status | TEXT | `running` \| `stopped` \| `completed` \| `error` |
| notify | INTEGER | 1 = deliver via Pushover, 0 = mute |
| data | TEXT | JSON blob of last-fetched `SessionData` |
| created_at | TEXT | SQLite datetime |
| updated_at | TEXT | SQLite datetime |

`data` blob schema (`SessionData`):
```json
{
  "tournament_name": "string",
  "time_control": "90min/40moves+30min+30sec",
  "total_rounds": 9,
  "completed_rounds": 5,
  "player": { "name": "...", "current_rank": "12", "starting_rank": "15", "rating": 1850, "kFactor": 20 },
  "ratingChange": 12,
  "performanceRating": 1920,
  "matches": [
    { "round_number": 1, "opponent_name": "...", "opponent_rank": "8", "opponent_rating": 1900, "color": "White", "result": "1", "board": "3" }
  ]
}
```

### notifications

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| session_id | INTEGER | FK → chess_sessions.id |
| type | TEXT | `pairing` \| `result` \| `completion` |
| title | TEXT | push notification title |
| message | TEXT | push notification body |
| sent | INTEGER | 0 = not sent, 1 = sent via Pushover |
| round_number | INTEGER | -1 for completion |
| created_at | TEXT | |

Unique constraint on `(session_id, type, round_number)` enforces dedup.

### settings

Key-value store. Known keys:

| Key | Default | Purpose |
|-----|---------|---------|
| `pushover_app_token` | — | Pushover application token |
| `pushover_user_key` | — | Pushover user key |
| `dashboard_user` | `admin` | Login username |
| `dashboard_password` | `admin` | Login password (PBKDF2 hash after first change) |
| `timezone` | `Asia/Kolkata` | For quiet hour calculation |
| `night_start_hour` | `23` | Quiet hours start (24h) |
| `night_end_hour` | `6` | Quiet hours end (24h) |
| `session_cookie_secret` | auto-generated | HMAC key for session cookies |

### worker_logs

Capped at 1,000 rows via `DELETE ... WHERE id NOT IN (SELECT id ... LIMIT 1000)` after every insert.

---

## 8. Rating Estimate Algorithm

When FIDE has not yet published an official rating change, the dashboard estimates it using the Elo formula:

```
Expected(player, opponent) = 1 / (1 + 10^((oppRating - playerRating) / 400))

For each completed match:
  actual = 1 (win) | 0.5 (draw) | 0 (loss)
  delta  = K × (actual − expected)

total = Σ delta  (rounded to 2 decimal places)
```

Displayed as `~+12` to distinguish from confirmed FIDE change (`+12`).

---

## 9. Scraping Strategy

chess-results.com has no public API. The scraper targets stable HTML patterns:

| Data point | HTML pattern |
|-----------|-------------|
| Player name | `>Name</td><td>VALUE</td>` |
| Rank | `>Rank</td><td>VALUE</td>` |
| Rating | `>Rating international</td><td>VALUE</td>` |
| Rating change | `>FIDE rtg +/-</td><td>VALUE</td>` |
| K-factor | `<td class="CRr">VALUE</td>` followed by rating change |
| Tournament name | `<h2>VALUE</h2>` |
| Total rounds | `>Number of rounds</td><td>VALUE</td>` |
| Match rows | `<tr class="CRg1/CRg2">` with `<td>` cells |
| Result | `<div class="FarbewT/FarbesT">` (color), last numeric cell |
| Standings | Same `CRg1/CRg2` row pattern on standings page |

HTML entity decoding handles `&#NNN;`, `&#xHH;`, `&amp;`, `&lt;`, `&gt;`, `&nbsp;`, `&frac12;`, `&quot;`, `&apos;`.

---

## 10. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| chess-results.com rate limit | `fetchPlayerData` returns `null`; session skipped this tick |
| Network error on scrape | Caught, logged, session skipped this tick |
| Pushover delivery failure | Logged; notification row stays `sent=0`; no retry |
| Notification dedup constraint | `saveNotification` returns `0`; push skipped silently |
| Malformed session data JSON | `parseSessionData` returns `EMPTY_SESSION_DATA` |
| Invalid chess-results.com URL | `parseChessUrl` returns `null`; POST /sessions redirects to `/` |
| Session already complete (stored) | Auto-stopped at poll time; no fetch performed |

---

## 11. Scalability Limits

| Limit | Value | Constraint |
|-------|-------|-----------|
| Cron frequency | 1/min | Cloudflare minimum cron interval |
| Concurrent sessions | ~20–30 | 2s delay per fetch × sessions ≈ stays within Worker CPU budget |
| Request delay | 2,000 ms | Polite crawling; avoids chess-results.com blocks |
| Notifications stored | Unbounded | D1 free tier: 5 GB |
| Logs stored | 1,000 rows | Hard cap enforced in `writeLog` |
| Notification history shown | 50 rows | Dashboard limit |
| Log history shown | 100 rows | Dashboard limit |
