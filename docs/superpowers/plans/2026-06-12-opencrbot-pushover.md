# crpush Implementation Plan

> **STATUS: COMPLETED** — Project is fully implemented and deployed. This plan is archived for reference.  
> The project was renamed from `opencrbot` / `opencrpushover` to `crpush`.

## Deviations from Original Plan

| Area | Plan | Actual |
|------|------|--------|
| ORM | Raw `D1Database` SQL | Drizzle ORM (`drizzle-orm/d1`) added as a refactor step |
| Module structure | Monolithic `index.ts` | Split into `auth.ts`, `db.ts`, `templates.ts`, `drizzle.ts`, `schema.ts` |
| Password storage | Plain-text in settings | PBKDF2-SHA256 with salt (100k iterations) |
| Manual poll | Synchronous | `executionCtx.waitUntil()` — async, response returns immediately |
| Tests | `chess.test.ts`, `pushover.test.ts` | Also `auth.test.ts`, `db.test.ts` |

See `docs/system-architecture.md` and `docs/system-design.md` for the current state.

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Workers app that monitors chess-results.com tournaments and sends Pushover notifications, with a server-rendered HTML dashboard for session management.

**Architecture:** A single Cloudflare Worker (Hono) serves both a server-rendered HTML dashboard (Tailwind CDN, no build step) and a cron handler that polls chess-results.com every minute and sends Pushover notifications on changes. Cookie-based auth. TypeScript compiled directly by Wrangler.

**Tech Stack:** TypeScript, Hono v4, Cloudflare Workers, Cloudflare D1, Pushover API, Tailwind CSS CDN, Vitest

---

## File Map

| File | Responsibility |
|------|---------------|
| `package.json` | Project metadata, scripts, deps |
| `tsconfig.json` | Single TypeScript config for the Worker |
| `wrangler.json` | Cloudflare Worker, D1 binding, cron config |
| `worker-configuration.d.ts` | `Env` interface (D1 binding type) |
| `vitest.config.ts` | Vitest config for unit tests |
| `schema.sql` | D1 database tables + indexes |
| `src/worker/chess.ts` | chess-results.com HTML scraper + polling logic (adapted from old project) |
| `src/worker/pushover.ts` | Pushover API client (`sendPushover`) |
| `src/worker/index.ts` | Hono app: all routes, HTML templates, auth helpers, cron handler |
| `src/worker/chess.test.ts` | Unit tests for pure chess parsing functions |
| `src/worker/pushover.test.ts` | Unit tests for `sendPushover` (fetch mock) |

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.json`
- Create: `worker-configuration.d.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "opencrbot",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241224.0",
    "typescript": "^5.7.0",
    "wrangler": "^3.99.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true
  },
  "include": ["src/worker/**/*.ts", "worker-configuration.d.ts"]
}
```

- [ ] **Step 3: Create wrangler.json**

```json
{
  "name": "opencrbot",
  "main": "src/worker/index.ts",
  "compatibility_date": "2025-01-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "opencrbot",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ],
  "triggers": {
    "crons": ["* * * * *"]
  }
}
```

- [ ] **Step 4: Create worker-configuration.d.ts**

```typescript
interface Env {
  DB: D1Database;
}
```

- [ ] **Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/worker/**/*.test.ts'],
  },
});
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
.wrangler/
*.env
.dev.vars
```

- [ ] **Step 7: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 8: Commit**

```bash
git init
git add package.json tsconfig.json wrangler.json worker-configuration.d.ts vitest.config.ts .gitignore
git commit -m "chore: project scaffold"
```

---

### Task 2: Database Schema

**Files:**
- Create: `schema.sql`

- [ ] **Step 1: Create schema.sql**

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

- [ ] **Step 2: Commit**

```bash
git add schema.sql
git commit -m "chore: add D1 schema"
```

---

### Task 3: Pushover Client

**Files:**
- Create: `src/worker/pushover.ts`
- Create: `src/worker/pushover.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/worker/pushover.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendPushover } from './pushover';

describe('sendPushover', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when Pushover responds with status 1', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ status: 1 }),
    });
    const result = await sendPushover('apptoken', 'userkey', 'Test Title', 'Test message', 'https://example.com');
    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends correct JSON body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ status: 1 }),
    });
    await sendPushover('mytoken', 'myuser', 'Round 3: WON!', 'vs Smith', 'https://chess-results.com/tnr123.aspx');
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.token).toBe('mytoken');
    expect(body.user).toBe('myuser');
    expect(body.title).toBe('Round 3: WON!');
    expect(body.message).toBe('vs Smith');
    expect(body.url).toBe('https://chess-results.com/tnr123.aspx');
    expect(body.url_title).toBe('View on chess-results.com');
  });

  it('returns false when Pushover responds with status 0', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ status: 0, errors: ['user key is invalid'] }),
    });
    const result = await sendPushover('apptoken', 'badkey', 'Title', 'Message', 'https://example.com');
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    const result = await sendPushover('apptoken', 'userkey', 'Title', 'Message', 'https://example.com');
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npm test
```

Expected: FAIL — `sendPushover` not found.

- [ ] **Step 3: Create src/worker/pushover.ts**

```typescript
const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

export async function sendPushover(
  appToken: string,
  userKey: string,
  title: string,
  message: string,
  url: string,
): Promise<boolean> {
  try {
    const res = await fetch(PUSHOVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: appToken,
        user: userKey,
        title,
        message,
        url,
        url_title: 'View on chess-results.com',
      }),
    });
    const data = await res.json() as { status: number };
    return data.status === 1;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
npm test
```

Expected: PASS — 4 tests in pushover.test.ts pass.

- [ ] **Step 5: Commit**

```bash
git add src/worker/pushover.ts src/worker/pushover.test.ts
git commit -m "feat: add Pushover client"
```

---

### Task 4: Chess Module

Copy the scraper from the old project. Three changes: (1) remove Telegram code, (2) change the `checkForUpdates` callback from Telegram-style to Pushover-style, (3) strip the inline URL from `formatNotification` messages (Pushover receives the URL separately via its `url` field).

**Files:**
- Create: `src/worker/chess.ts`

- [ ] **Step 1: Copy chess.ts from the old project**

```bash
cp /Users/rathnakara/project/old/OpenCRBot/src/worker/chess.ts src/worker/chess.ts
```

- [ ] **Step 2: Delete the `getActiveTelegramChatIds` function**

Remove this entire function from `src/worker/chess.ts`:

```typescript
async function getActiveTelegramChatIds(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT chat_id FROM telegram_users WHERE active = 1").all<{ chat_id: string }>();
  return results.map(r => r.chat_id);
}
```

- [ ] **Step 3: Delete the `formatTelegramNotification` function**

Remove the entire exported `formatTelegramNotification` function (the one starting with `export function formatTelegramNotification`). It spans ~50 lines and handles pairing/result/completion with HTML escape sequences.

- [ ] **Step 4: Strip inline URL from `formatNotification` messages**

In the `formatNotification` function, remove the `\n\nVerify: ${session.url}` suffix from all three case branches. The URL is passed to Pushover separately.

Change the `pairing` case message from:
```typescript
message: `${newData.player.name} vs ${match.opponent_name}\nPlaying: ${match.color || 'TBD'}\nBoard: ${match.board || 'TBD'}\nRank: #${newData.player.current_rank} | Points: ${points}/${newData.completed_rounds}\n\nVerify: ${session.url}`,
```
To:
```typescript
message: `${newData.player.name} vs ${match.opponent_name}\nPlaying: ${match.color || 'TBD'}\nBoard: ${match.board || 'TBD'}\nRank: #${newData.player.current_rank} | Points: ${points}/${newData.completed_rounds}`,
```

Change the `result` case return from:
```typescript
message: `${newData.player.name} vs ${match.opponent_name}\nNew Rank: #${newData.player.current_rank}${rankChange}\nPoints: ${points}/${newData.completed_rounds}${ratingInfo}\n\nVerify: ${session.url}`,
```
To:
```typescript
message: `${newData.player.name} vs ${match.opponent_name}\nNew Rank: #${newData.player.current_rank}${rankChange}\nPoints: ${points}/${newData.completed_rounds}${ratingInfo}`,
```

Change the `completion` case return from:
```typescript
message: `${newData.player.name}\n${newData.tournament_name || 'Tournament'}\nFinal Rank: #${newData.player.current_rank}\nFinal Score: ${points}/${newData.total_rounds}${ratingInfo}\n\nVerify: ${session.url}`,
```
To:
```typescript
message: `${newData.player.name}\n${newData.tournament_name || 'Tournament'}\nFinal Rank: #${newData.player.current_rank}\nFinal Score: ${points}/${newData.total_rounds}${ratingInfo}`,
```

- [ ] **Step 5: Update `checkForUpdates` signature**

Change from:
```typescript
export async function checkForUpdates(
  db: D1Database,
  sendMessage: (chatId: string, text: string) => Promise<boolean>,
  writeLog: (msg: string, level?: 'info' | 'warn' | 'error', source?: string) => Promise<void>,
): Promise<PollResult>
```
To:
```typescript
export async function checkForUpdates(
  db: D1Database,
  sendNotification: (title: string, message: string, url: string) => Promise<boolean>,
  writeLog: (msg: string, level?: 'info' | 'warn' | 'error', source?: string) => Promise<void>,
): Promise<PollResult>
```

- [ ] **Step 6: Replace the notification dispatch block inside `checkForUpdates`**

Remove the line that declares `activeChatIds`:
```typescript
const activeChatIds = await getActiveTelegramChatIds(db);
```

Replace the Telegram multi-user send block:
```typescript
if (notification.session.notify === 1 && activeChatIds.length > 0) {
  const tgMsg = formatTelegramNotification(notification);
  if (tgMsg) {
    let anySent = false;
    for (const chatId of activeChatIds) {
      const sent = await sendMessage(chatId, tgMsg);
      if (sent) anySent = true;
    }
    if (anySent) await markNotificationSent(db, notifId);
  }
}
```

With:
```typescript
if (notification.session.notify === 1) {
  const { title, message } = formatNotification(notification);
  if (message) {
    const sent = await sendNotification(title, message, notification.session.url);
    if (sent) await markNotificationSent(db, notifId);
  }
}
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/worker/chess.ts
git commit -m "feat: add chess module (adapted from old project, Pushover callback)"
```

---

### Task 5: Chess Module Unit Tests

**Files:**
- Create: `src/worker/chess.test.ts`

- [ ] **Step 1: Write tests for pure functions**

Create `src/worker/chess.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { calculatePoints, calculateTotalRatingChange, parseSessionData } from './chess';
import type { ChessSession } from './chess';

const makeSession = (overrides: Partial<ChessSession> = {}): ChessSession => ({
  id: 1, url: '', server: '', tournament_id: '', player_snr: '',
  federation: 'IND', status: 'running', notify: 1,
  data: '{}', created_at: '', updated_at: '', ...overrides,
});

describe('calculatePoints', () => {
  it('sums completed match results', () => {
    const matches = [
      { round_number: 1, result: '1', opponent_name: 'A', opponent_rank: '1', opponent_rating: 1500, color: 'White', board: '1' },
      { round_number: 2, result: '0', opponent_name: 'B', opponent_rank: '2', opponent_rating: 1600, color: 'Black', board: '2' },
      { round_number: 3, result: '½', opponent_name: 'C', opponent_rank: '3', opponent_rating: 1400, color: 'White', board: '3' },
    ];
    expect(calculatePoints(matches)).toBe(1.5);
  });

  it('ignores matches without a result', () => {
    const matches = [
      { round_number: 1, result: '', opponent_name: 'A', opponent_rank: '1', opponent_rating: 1500, color: 'White', board: '1' },
      { round_number: 2, result: '1', opponent_name: 'B', opponent_rank: '2', opponent_rating: 1600, color: 'Black', board: '2' },
    ];
    expect(calculatePoints(matches)).toBe(1);
  });

  it('returns 0 for empty match array', () => {
    expect(calculatePoints([])).toBe(0);
  });
});

describe('calculateTotalRatingChange', () => {
  it('gains ~10 Elo for winning against an equal opponent', () => {
    const matches = [
      { round_number: 1, result: '1', opponent_name: 'A', opponent_rank: '1', opponent_rating: 1500, color: 'White', board: '1' },
    ];
    const { total } = calculateTotalRatingChange(1500, matches, 20);
    expect(total).toBeGreaterThan(9);
    expect(total).toBeLessThan(11);
  });

  it('returns 0 for no completed matches', () => {
    const { total } = calculateTotalRatingChange(1500, [], 20);
    expect(total).toBe(0);
  });

  it('loses Elo for losing to a lower-rated opponent', () => {
    const matches = [
      { round_number: 1, result: '0', opponent_name: 'A', opponent_rank: '5', opponent_rating: 1300, color: 'White', board: '1' },
    ];
    const { total } = calculateTotalRatingChange(1500, matches, 20);
    expect(total).toBeLessThan(-10);
  });
});

describe('parseSessionData', () => {
  it('returns defaults for empty JSON', () => {
    const data = parseSessionData(makeSession({ data: '{}' }));
    expect(data.total_rounds).toBe(0);
    expect(data.matches).toEqual([]);
    expect(data.player.name).toBe('Unknown');
  });

  it('returns defaults for invalid JSON', () => {
    const data = parseSessionData(makeSession({ data: 'not-json' }));
    expect(data.total_rounds).toBe(0);
    expect(data.player.name).toBe('Unknown');
  });

  it('parses stored session data correctly', () => {
    const session = makeSession({
      data: JSON.stringify({
        total_rounds: 7, completed_rounds: 3,
        player: { name: 'Smith, John', current_rank: '5', starting_rank: '8', rating: 1650, kFactor: 20 },
        ratingChange: 12, performanceRating: 1700, matches: [],
      }),
    });
    const data = parseSessionData(session);
    expect(data.total_rounds).toBe(7);
    expect(data.player.name).toBe('Smith, John');
    expect(data.ratingChange).toBe(12);
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: PASS — all tests in both `chess.test.ts` and `pushover.test.ts` pass.

- [ ] **Step 3: Commit**

```bash
git add src/worker/chess.test.ts
git commit -m "test: add chess module unit tests"
```

---

### Task 6: index.ts — Skeleton, Auth, and DB Helpers

**Files:**
- Create: `src/worker/index.ts`

- [ ] **Step 1: Create src/worker/index.ts**

```typescript
import { Hono } from "hono";
import {
  checkForUpdates, fetchPlayerData, calculatePoints,
  calculateTotalRatingChange, parseSessionData, type ChessSession,
} from "./chess";
import { sendPushover } from "./pushover";

const app = new Hono<{ Bindings: Env }>();

// ── Cookie auth ───────────────────────────────────────────────────────────────

async function getCookieSecret(db: D1Database): Promise<CryptoKey> {
  let secret = (await db.prepare("SELECT value FROM settings WHERE key = 'session_cookie_secret'")
    .first<{ value: string }>())?.value;
  if (!secret) {
    secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, "0")).join("");
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("session_cookie_secret", secret).run();
  }
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function createSessionCookie(key: CryptoKey, username: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 7;
  const payload = btoa(`${username}:${exp}`);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${sig}`;
}

async function verifySessionCookie(key: CryptoKey, cookie: string): Promise<string | null> {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  try {
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
    if (!valid) return null;
    const [username, expStr] = atob(payload).split(":");
    if (parseInt(expStr) < Math.floor(Date.now() / 1000)) return null;
    return username;
  } catch {
    return null;
  }
}

async function getAuthUser(req: Request, db: D1Database): Promise<string | null> {
  const cookieHeader = req.headers.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  const key = await getCookieSecret(db);
  return verifySessionCookie(key, decodeURIComponent(match[1]));
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function writeLog(db: D1Database, message: string, level: "info" | "warn" | "error" = "info", source = "worker"): Promise<void> {
  try {
    await db.batch([
      db.prepare("INSERT INTO worker_logs (level, source, message) VALUES (?, ?, ?)").bind(level, source, message),
      db.prepare("DELETE FROM worker_logs WHERE id NOT IN (SELECT id FROM worker_logs ORDER BY created_at DESC LIMIT 1000)"),
    ]);
  } catch {
    console.error("[writeLog] failed:", message);
  }
}

async function getCredentials(db: D1Database): Promise<{ user: string; pass: string }> {
  const userRow = await db.prepare("SELECT value FROM settings WHERE key = 'dashboard_user'").first<{ value: string }>();
  const passRow = await db.prepare("SELECT value FROM settings WHERE key = 'dashboard_password'").first<{ value: string }>();
  return { user: userRow?.value || "admin", pass: passRow?.value || "admin" };
}

function parseChessUrl(url: string): { server: string; tournament_id: string; player_snr: string; federation: string } | null {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (!u.hostname.includes("chess-results.com")) return null;
    const parts = u.hostname.split(".");
    const server = parts.length > 2 ? parts[0] : "";
    const pathMatch = u.pathname.match(/\/(tnr\d+)\.aspx/i);
    const tournament_id = pathMatch?.[1];
    const player_snr = u.searchParams.get("snr");
    const federation = u.searchParams.get("fed") || "IND";
    if (!tournament_id || !player_snr) return null;
    return { server, tournament_id, player_snr, federation };
  } catch {
    return null;
  }
}

// ── Export (scheduled handler completed in Task 13) ───────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await writeLog(env.DB, "Cron stub — implement in Task 13", "info", "cron");
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: index.ts skeleton with cookie auth and DB helpers"
```

---

### Task 7: HTML Layout, Auth Middleware, Login/Logout

**Files:**
- Modify: `src/worker/index.ts`

Insert the following sections after the `parseChessUrl` function and before the `export default` block.

- [ ] **Step 1: Add layout helper, auth middleware, and login/logout routes to index.ts**

```typescript
// ── HTML helpers ──────────────────────────────────────────────────────────────

function statusBadge(status: string): string {
  const styles: Record<string, string> = {
    running: "bg-green-100 text-green-800",
    stopped: "bg-gray-100 text-gray-700",
    completed: "bg-blue-100 text-blue-800",
    error: "bg-red-100 text-red-800",
  };
  return `<span class="px-2 py-0.5 rounded text-xs font-medium ${styles[status] ?? "bg-gray-100 text-gray-700"}">${status}</span>`;
}

function levelBadge(level: string): string {
  const styles: Record<string, string> = {
    info: "bg-gray-100 text-gray-700",
    warn: "bg-yellow-100 text-yellow-800",
    error: "bg-red-100 text-red-800",
  };
  return `<span class="px-2 py-0.5 rounded text-xs font-medium ${styles[level] ?? "bg-gray-100 text-gray-700"}">${level}</span>`;
}

function layout(title: string, content: string, activePage = ""): string {
  const link = (href: string, label: string, page: string) =>
    `<a href="${href}" class="text-sm ${activePage === page ? "text-blue-600 font-medium" : "text-gray-600 hover:text-gray-900"}">${label}</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — OpenCRBot</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <nav class="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6 sticky top-0 z-10">
    <a href="/" class="font-bold text-gray-900 text-lg">♟ OpenCRBot</a>
    ${link("/", "Sessions", "sessions")}
    ${link("/notifications", "Notifications", "notifications")}
    ${link("/logs", "Logs", "logs")}
    ${link("/settings", "Settings", "settings")}
    <div class="ml-auto">
      <form method="POST" action="/logout">
        <button type="submit" class="text-sm text-gray-500 hover:text-gray-900">Logout</button>
      </form>
    </div>
  </nav>
  <main class="max-w-5xl mx-auto px-6 py-8">${content}</main>
</body>
</html>`;
}

// ── Auth middleware ───────────────────────────────────────────────────────────

app.use("/*", async (c, next) => {
  if (c.req.path === "/login") return next();
  const user = await getAuthUser(c.req.raw, c.env.DB);
  if (!user) return c.redirect("/login");
  return next();
});

// ── Login / Logout ────────────────────────────────────────────────────────────

app.get("/login", async (c) => {
  const error = c.req.query("error");
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — OpenCRBot</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-sm">
    <h1 class="text-2xl font-bold text-gray-900 mb-1">♟ OpenCRBot</h1>
    <p class="text-gray-500 text-sm mb-6">Sign in to your dashboard</p>
    ${error ? `<div class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">Invalid username or password.</div>` : ""}
    <form method="POST" action="/login" class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Username</label>
        <input name="username" type="text" required autofocus
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Password</label>
        <input name="password" type="password" required
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <button type="submit"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors">
        Sign In
      </button>
    </form>
  </div>
</body>
</html>`);
});

app.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username || "");
  const password = String(body.password || "");
  const creds = await getCredentials(c.env.DB);
  if (username !== creds.user || password !== creds.pass) return c.redirect("/login?error=1");
  const key = await getCookieSecret(c.env.DB);
  const cookie = await createSessionCookie(key, username);
  c.header("Set-Cookie", `session=${encodeURIComponent(cookie)}; HttpOnly; Secure; SameSite=Lax; Max-Age=604800; Path=/`);
  return c.redirect("/");
});

app.post("/logout", (c) => {
  c.header("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/");
  return c.redirect("/login");
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: add layout helper, auth middleware, login/logout"
```

---

### Task 8: Sessions Page

**Files:**
- Modify: `src/worker/index.ts`

Insert after the logout route and before `export default`.

- [ ] **Step 1: Add sessions routes to index.ts**

```typescript
// ── Sessions ──────────────────────────────────────────────────────────────────

function formatSession(s: Record<string, unknown>) {
  const data = parseSessionData(s as unknown as ChessSession);
  return {
    id: s.id as number,
    url: s.url as string,
    status: s.status as string,
    notify: Boolean(s.notify ?? 1),
    tournament: data.tournament_name || "",
    player: data.player?.name || "Unknown",
    rank: data.player?.current_rank || "?",
    points: calculatePoints(data.matches || []),
    completedRounds: data.completed_rounds || 0,
    totalRounds: data.total_rounds || 0,
  };
}

app.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM chess_sessions ORDER BY created_at DESC"
  ).all<Record<string, unknown>>();

  const [statsRes, notifRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) as running FROM chess_sessions WHERE status='running'"),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM notifications WHERE sent=1"),
  ]);
  const running = ((statsRes.results[0] ?? {}) as { running: number }).running ?? 0;
  const notifCount = ((notifRes.results[0] ?? {}) as { count: number }).count ?? 0;

  const creds = await getCredentials(c.env.DB);
  const isDefault = creds.user === "admin" && creds.pass === "admin";

  const rows = results.map(s => {
    const fmt = formatSession(s);
    const rounds = fmt.totalRounds ? `${fmt.completedRounds}/${fmt.totalRounds}` : "—";
    const notifyToggle = `<form method="POST" action="/sessions/${fmt.id}/toggle-notify" class="inline">
      <button type="submit" title="${fmt.notify ? "Mute" : "Unmute"}" class="text-lg">${fmt.notify ? "🔔" : "🔕"}</button>
    </form>`;
    const stopBtn = fmt.status === "running"
      ? `<form method="POST" action="/sessions/${fmt.id}/stop" class="inline" onsubmit="return confirm('Stop monitoring this player?')">
           <button type="submit" class="text-xs text-red-600 hover:text-red-800 font-medium">Stop</button>
         </form>`
      : `<span class="text-xs text-gray-400">—</span>`;
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-4 py-3 text-sm"><a href="/session/${fmt.id}" class="text-blue-600 hover:underline font-medium">${fmt.player}</a></td>
      <td class="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title="${fmt.tournament}">${fmt.tournament || "—"}</td>
      <td class="px-4 py-3 text-sm text-center">#${fmt.rank}</td>
      <td class="px-4 py-3 text-sm text-center">${fmt.points} · ${rounds}</td>
      <td class="px-4 py-3 text-center">${statusBadge(fmt.status)}</td>
      <td class="px-4 py-3 text-center">${notifyToggle}</td>
      <td class="px-4 py-3 text-center">${stopBtn}</td>
    </tr>`;
  }).join("");

  const content = `
    ${isDefault ? `<div class="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
      Default credentials in use. <a href="/settings" class="font-medium underline">Change your password in Settings.</a>
    </div>` : ""}
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Sessions</h1>
        <p class="text-sm text-gray-500 mt-0.5">${running} running · ${notifCount} notifications sent</p>
      </div>
      <form method="POST" action="/poll">
        <button type="submit" class="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-lg px-4 py-2 transition-colors">Check Now</button>
      </form>
    </div>
    <div class="bg-white rounded-xl border border-gray-200 shadow-sm mb-6">
      <div class="px-4 py-3 border-b border-gray-100">
        <h2 class="text-sm font-semibold text-gray-700">Add New Session</h2>
      </div>
      <form method="POST" action="/sessions" class="px-4 py-3 flex gap-3">
        <input name="url" type="url" required
          placeholder="https://chess-results.com/tnr123.aspx?lan=1&art=9&fed=IND&snr=42"
          class="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors whitespace-nowrap">
          Add Monitor
        </button>
      </form>
    </div>
    ${results.length === 0
      ? `<div class="text-center py-12 text-gray-400">No sessions yet. Paste a chess-results.com player URL above to start monitoring.</div>`
      : `<div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table class="w-full">
            <thead>
              <tr class="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                <th class="px-4 py-3">Player</th>
                <th class="px-4 py-3">Tournament</th>
                <th class="px-4 py-3 text-center">Rank</th>
                <th class="px-4 py-3 text-center">Pts · Rounds</th>
                <th class="px-4 py-3 text-center">Status</th>
                <th class="px-4 py-3 text-center">Notify</th>
                <th class="px-4 py-3 text-center">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}
  `;
  return c.html(layout("Sessions", content, "sessions"));
});

app.post("/sessions", async (c) => {
  const body = await c.req.parseBody();
  const url = String(body.url || "").trim();
  if (!url) return c.redirect("/");
  const parsed = parseChessUrl(url);
  if (!parsed) return c.redirect("/");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM chess_sessions WHERE url = ? AND status = 'running'"
  ).bind(url).first();
  if (existing) return c.redirect("/");
  const initialData = await fetchPlayerData(parsed.server, parsed.tournament_id, parsed.player_snr, parsed.federation, url);
  await c.env.DB.prepare(
    "INSERT INTO chess_sessions (url, tournament_id, player_snr, server, federation, data) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(url, parsed.tournament_id, parsed.player_snr, parsed.server, parsed.federation, JSON.stringify(initialData ?? {})).run();
  return c.redirect("/");
});

app.post("/sessions/:id/stop", async (c) => {
  await c.env.DB.prepare(
    "UPDATE chess_sessions SET status = 'stopped', updated_at = datetime('now') WHERE id = ?"
  ).bind(c.req.param("id")).run();
  return c.redirect("/");
});

app.post("/sessions/:id/toggle-notify", async (c) => {
  const session = await c.env.DB.prepare("SELECT notify FROM chess_sessions WHERE id = ?")
    .bind(c.req.param("id")).first<{ notify: number }>();
  if (!session) return c.redirect("/");
  await c.env.DB.prepare("UPDATE chess_sessions SET notify = ? WHERE id = ?")
    .bind(session.notify ? 0 : 1, c.req.param("id")).run();
  return c.redirect("/");
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: add sessions page and form handlers"
```

---

### Task 9: Session Detail Page

**Files:**
- Modify: `src/worker/index.ts`

Insert after the sessions routes.

- [ ] **Step 1: Add GET /session/:id to index.ts**

```typescript
// ── Session detail ────────────────────────────────────────────────────────────

app.get("/session/:id", async (c) => {
  const s = await c.env.DB.prepare("SELECT * FROM chess_sessions WHERE id = ?")
    .bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!s) return c.redirect("/");

  const data = parseSessionData(s as unknown as ChessSession);
  const ratingEst = calculateTotalRatingChange(
    data.player?.rating || 0, data.matches || [], data.player?.kFactor || 20
  ).total;
  const points = calculatePoints(data.matches || []);

  const matchRows = (data.matches || []).map(m => {
    const outcome = m.result === "1" ? "Win" : m.result === "0" ? "Loss" : m.result ? "Draw" : "—";
    const cls = m.result === "1" ? "text-green-700 font-medium" : m.result === "0" ? "text-red-700 font-medium" : "text-gray-700";
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-4 py-2 text-sm text-center">${m.round_number}</td>
      <td class="px-4 py-2 text-sm">${m.opponent_name}</td>
      <td class="px-4 py-2 text-sm text-center">${m.opponent_rating || "—"}</td>
      <td class="px-4 py-2 text-sm text-center">${m.color || "—"}</td>
      <td class="px-4 py-2 text-sm text-center">${m.board || "—"}</td>
      <td class="px-4 py-2 text-sm text-center ${cls}">${outcome}</td>
    </tr>`;
  }).join("");

  const ratingDisplay = data.ratingChange !== 0
    ? `${data.ratingChange > 0 ? "+" : ""}${data.ratingChange}`
    : ratingEst !== 0 ? `~${ratingEst > 0 ? "+" : ""}${ratingEst}` : "—";
  const ratingColor = (data.ratingChange || ratingEst) > 0 ? "text-green-700" : (data.ratingChange || ratingEst) < 0 ? "text-red-700" : "text-gray-900";

  const content = `
    <div class="mb-6">
      <a href="/" class="text-sm text-blue-600 hover:underline">← Back to Sessions</a>
    </div>
    <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-6">
      <div class="flex items-start justify-between">
        <div>
          <h1 class="text-2xl font-bold text-gray-900">${data.player?.name || "Unknown"}</h1>
          <p class="text-gray-500 mt-0.5">${data.tournament_name || "Tournament"}</p>
        </div>
        <div class="flex items-center gap-2">
          ${statusBadge(s.status as string)}
          <a href="${s.url as string}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">chess-results.com ↗</a>
        </div>
      </div>
      <div class="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="bg-gray-50 rounded-lg p-3">
          <div class="text-xs text-gray-500 mb-1">Current Rank</div>
          <div class="text-xl font-bold text-gray-900">#${data.player?.current_rank || "?"}</div>
        </div>
        <div class="bg-gray-50 rounded-lg p-3">
          <div class="text-xs text-gray-500 mb-1">Points</div>
          <div class="text-xl font-bold text-gray-900">${points} / ${data.total_rounds || "?"}</div>
        </div>
        <div class="bg-gray-50 rounded-lg p-3">
          <div class="text-xs text-gray-500 mb-1">Rating</div>
          <div class="text-xl font-bold text-gray-900">${data.player?.rating || "—"}</div>
        </div>
        <div class="bg-gray-50 rounded-lg p-3">
          <div class="text-xs text-gray-500 mb-1">Rating ±</div>
          <div class="text-xl font-bold ${ratingColor}">${ratingDisplay}</div>
        </div>
      </div>
    </div>
    ${(data.matches || []).length > 0
      ? `<div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-100">
            <h2 class="text-sm font-semibold text-gray-700">Match History</h2>
          </div>
          <table class="w-full">
            <thead>
              <tr class="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                <th class="px-4 py-3 text-center">Rd</th>
                <th class="px-4 py-3">Opponent</th>
                <th class="px-4 py-3 text-center">Rating</th>
                <th class="px-4 py-3 text-center">Color</th>
                <th class="px-4 py-3 text-center">Board</th>
                <th class="px-4 py-3 text-center">Result</th>
              </tr>
            </thead>
            <tbody>${matchRows}</tbody>
          </table>
        </div>`
      : `<div class="text-center py-8 text-gray-400">No matches yet.</div>`}
  `;
  return c.html(layout(data.player?.name || "Session", content, "sessions"));
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: add session detail page"
```

---

### Task 10: Notifications and Logs Pages

**Files:**
- Modify: `src/worker/index.ts`

Insert after the session detail route.

- [ ] **Step 1: Add notifications and logs routes to index.ts**

```typescript
// ── Notifications ─────────────────────────────────────────────────────────────

app.get("/notifications", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT n.*, s.data as session_data FROM notifications n
     LEFT JOIN chess_sessions s ON n.session_id = s.id
     ORDER BY n.created_at DESC LIMIT 50`
  ).all<Record<string, unknown>>();

  const typeBadge = (t: string) => {
    const styles: Record<string, string> = {
      pairing: "bg-purple-100 text-purple-800",
      result: "bg-blue-100 text-blue-800",
      completion: "bg-green-100 text-green-800",
    };
    return `<span class="px-2 py-0.5 rounded text-xs font-medium ${styles[t] ?? "bg-gray-100 text-gray-700"}">${t}</span>`;
  };

  const rows = results.map(n => {
    const sessionData = parseSessionData({ data: n.session_data as string } as ChessSession);
    const sentBadge = n.sent
      ? `<span class="text-green-600 text-xs">✓ sent</span>`
      : `<span class="text-gray-400 text-xs">unsent</span>`;
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">${String(n.created_at).slice(0, 16).replace("T", " ")}</td>
      <td class="px-4 py-3">${typeBadge(String(n.type))}</td>
      <td class="px-4 py-3 text-sm font-medium text-gray-900">${n.title}</td>
      <td class="px-4 py-3 text-xs text-gray-500">
        <div class="font-medium mb-0.5">${sessionData.player?.name || "Unknown"}</div>
        <pre class="whitespace-pre-wrap text-gray-600">${String(n.message)}</pre>
      </td>
      <td class="px-4 py-3 text-center">${sentBadge}</td>
    </tr>`;
  }).join("");

  const content = `
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">Notifications</h1>
      <span class="text-sm text-gray-500">Last 50</span>
    </div>
    ${results.length === 0
      ? `<div class="text-center py-12 text-gray-400">No notifications yet.</div>`
      : `<div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table class="w-full">
            <thead>
              <tr class="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                <th class="px-4 py-3">Time</th>
                <th class="px-4 py-3">Type</th>
                <th class="px-4 py-3">Title</th>
                <th class="px-4 py-3">Message</th>
                <th class="px-4 py-3 text-center">Sent</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}
  `;
  return c.html(layout("Notifications", content, "notifications"));
});

// ── Logs ──────────────────────────────────────────────────────────────────────

app.get("/logs", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM worker_logs ORDER BY created_at DESC LIMIT 100"
  ).all<Record<string, unknown>>();

  const rows = results.map(l => `<tr class="border-t border-gray-100 hover:bg-gray-50">
    <td class="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">${String(l.created_at).slice(0, 19).replace("T", " ")}</td>
    <td class="px-4 py-2">${levelBadge(String(l.level))}</td>
    <td class="px-4 py-2 text-xs text-gray-500">${l.source}</td>
    <td class="px-4 py-2 text-sm text-gray-700">${l.message}</td>
  </tr>`).join("");

  const content = `
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">Worker Logs</h1>
      <form method="POST" action="/logs/clear" onsubmit="return confirm('Clear all logs?')">
        <button type="submit" class="text-sm text-red-600 hover:text-red-800 font-medium">Clear All</button>
      </form>
    </div>
    ${results.length === 0
      ? `<div class="text-center py-12 text-gray-400">No logs yet.</div>`
      : `<div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table class="w-full">
            <thead>
              <tr class="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                <th class="px-4 py-3">Time</th>
                <th class="px-4 py-3">Level</th>
                <th class="px-4 py-3">Source</th>
                <th class="px-4 py-3">Message</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}
  `;
  return c.html(layout("Logs", content, "logs"));
});

app.post("/logs/clear", async (c) => {
  await c.env.DB.prepare("DELETE FROM worker_logs").run();
  return c.redirect("/logs");
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: add notifications and logs pages"
```

---

### Task 11: Settings Page

**Files:**
- Modify: `src/worker/index.ts`

Insert after the logs routes.

- [ ] **Step 1: Add settings routes to index.ts**

```typescript
// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Record<string, string> = {
  timezone: "Asia/Kolkata",
  night_start_hour: "23",
  night_end_hour: "6",
};

app.get("/settings", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = Object.fromEntries(results.map(r => [r.key, r.value]));
  const s = { ...DEFAULT_SETTINGS, ...map };

  const saved = c.req.query("saved");
  const testOk = c.req.query("testok");
  const testErr = c.req.query("testerror");

  const content = `
    ${saved ? `<div class="mb-4 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700">Settings saved.</div>` : ""}
    ${testOk ? `<div class="mb-4 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700">Test notification sent successfully!</div>` : ""}
    ${testErr ? `<div class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">Test notification failed. Check your app token and user key.</div>` : ""}

    <h1 class="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

    <form method="POST" action="/settings" class="space-y-6">
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <h2 class="text-base font-semibold text-gray-900 mb-1">Pushover Notifications</h2>
        <p class="text-sm text-gray-500 mb-4">Get your tokens from <a href="https://pushover.net" target="_blank" class="text-blue-600 hover:underline">pushover.net</a>.</p>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">App Token</label>
            <input name="pushover_app_token" type="text" value="${map.pushover_app_token || ""}"
              placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500">
            <p class="text-xs text-gray-400 mt-1">From pushover.net/apps — create an application for OpenCRBot</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">User Key</label>
            <input name="pushover_user_key" type="text" value="${map.pushover_user_key || ""}"
              placeholder="uQiRzpo4DXghDmr9QzzfQu"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500">
            <p class="text-xs text-gray-400 mt-1">From your Pushover account dashboard</p>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <h2 class="text-base font-semibold text-gray-900 mb-1">Quiet Hours</h2>
        <p class="text-sm text-gray-500 mb-4">Polling is paused during these hours so you don't get woken up.</p>
        <div class="grid grid-cols-3 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
            <input name="timezone" type="text" value="${s.timezone}"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Start Hour (24h)</label>
            <input name="night_start_hour" type="number" min="0" max="23" value="${s.night_start_hour}"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">End Hour (24h)</label>
            <input name="night_end_hour" type="number" min="0" max="23" value="${s.night_end_hour}"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
        </div>
      </div>

      <div class="flex items-center gap-4">
        <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-6 py-2 text-sm transition-colors">
          Save Settings
        </button>
      </div>
    </form>

    <form method="POST" action="/settings/test" class="mt-3">
      <button type="submit" class="text-sm text-gray-600 hover:text-gray-900 underline">Send Test Notification</button>
    </form>

    <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mt-6">
      <h2 class="text-base font-semibold text-gray-900 mb-4">Change Credentials</h2>
      <form method="POST" action="/settings/password" class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">New Username</label>
          <input name="username" type="text" required
            class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">New Password</label>
          <input name="password" type="password" required
            class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div class="col-span-2">
          <button type="submit" class="bg-gray-800 hover:bg-gray-900 text-white font-medium rounded-lg px-6 py-2 text-sm transition-colors">
            Update Credentials
          </button>
        </div>
      </form>
    </div>
  `;
  return c.html(layout("Settings", content, "settings"));
});

app.post("/settings", async (c) => {
  const body = await c.req.parseBody();
  const allowed = ["pushover_app_token", "pushover_user_key", "timezone", "night_start_hour", "night_end_hour"];
  const stmts = allowed
    .filter(k => body[k] !== undefined)
    .map(k => c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(k, String(body[k])));
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return c.redirect("/settings?saved=1");
});

app.post("/settings/test", async (c) => {
  const appToken = await getSetting(c.env.DB, "pushover_app_token");
  const userKey = await getSetting(c.env.DB, "pushover_user_key");
  if (!appToken || !userKey) return c.redirect("/settings?testerror=1");
  const ok = await sendPushover(appToken, userKey, "OpenCRBot Test", "Pushover is configured correctly!", "https://pushover.net");
  return c.redirect(ok ? "/settings?testok=1" : "/settings?testerror=1");
});

app.post("/settings/password", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username || "").trim();
  const password = String(body.password || "").trim();
  if (!username || !password) return c.redirect("/settings");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind("dashboard_user", username),
    c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind("dashboard_password", password),
  ]);
  c.header("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/");
  return c.redirect("/login");
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: add settings page with Pushover config, quiet hours, credentials"
```

---

### Task 12: Poll Endpoint

**Files:**
- Modify: `src/worker/index.ts`

Insert after the settings routes.

- [ ] **Step 1: Add POST /poll to index.ts**

```typescript
// ── Poll ──────────────────────────────────────────────────────────────────────

app.post("/poll", async (c) => {
  const appToken = await getSetting(c.env.DB, "pushover_app_token");
  const userKey = await getSetting(c.env.DB, "pushover_user_key");

  const sendFn = async (title: string, message: string, url: string) => {
    if (!appToken || !userKey) return false;
    return sendPushover(appToken, userKey, title, message, url);
  };

  const logFn = (msg: string, level: "info" | "warn" | "error" = "info", source = "poll") =>
    writeLog(c.env.DB, msg, level, source);

  await writeLog(c.env.DB, "Manual check triggered", "info", "poll");
  const result = await checkForUpdates(c.env.DB, sendFn, logFn);
  await writeLog(c.env.DB, `Manual check done — ${result.sessions} session(s), ${result.notifications} notification(s)`, "info", "poll");
  return c.redirect("/");
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: add manual poll endpoint"
```

---

### Task 13: Cron Handler

**Files:**
- Modify: `src/worker/index.ts`

Replace the stub `scheduled` handler in the `export default` block with the full quiet-hours cron logic.

- [ ] **Step 1: Replace the scheduled stub in export default**

Replace:
```typescript
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await writeLog(env.DB, "Cron stub — implement in Task 13", "info", "cron");
  },
};
```

With:
```typescript
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const timezone = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'")
      .first<{ value: string }>())?.value || "Asia/Kolkata";
    const nightStart = parseInt(
      (await env.DB.prepare("SELECT value FROM settings WHERE key = 'night_start_hour'")
        .first<{ value: string }>())?.value || "23", 10
    );
    const nightEnd = parseInt(
      (await env.DB.prepare("SELECT value FROM settings WHERE key = 'night_end_hour'")
        .first<{ value: string }>())?.value || "6", 10
    );

    const hour = parseInt(
      new Date().toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false }),
      10
    );
    const isNight = nightStart > nightEnd
      ? hour >= nightStart || hour < nightEnd
      : hour >= nightStart && hour < nightEnd;

    if (isNight) {
      await writeLog(env.DB, `Cron skipped — quiet hours (hour=${hour}, quiet=${nightStart}h–${nightEnd}h)`, "info", "cron");
      return;
    }

    const appToken = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'pushover_app_token'")
      .first<{ value: string }>())?.value || "";
    const userKey = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'pushover_user_key'")
      .first<{ value: string }>())?.value || "";

    const sendFn = async (title: string, message: string, url: string) => {
      if (!appToken || !userKey) return false;
      return sendPushover(appToken, userKey, title, message, url);
    };

    const logFn = (msg: string, level: "info" | "warn" | "error" = "info", source = "cron") =>
      writeLog(env.DB, msg, level, source);

    const result = await checkForUpdates(env.DB, sendFn, logFn);
    await writeLog(env.DB, `Cron done — ${result.sessions} session(s), ${result.notifications} notification(s)`, "info", "cron");
  },
};
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: implement cron handler with quiet hours and Pushover integration"
```

---

### Task 14: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

```markdown
# OpenCRBot

A self-hosted Cloudflare Workers app that monitors [chess-results.com](https://chess-results.com) tournaments and sends real-time [Pushover](https://pushover.net) notifications for pairings, results, and tournament completion.

Built with **Hono** + **Cloudflare D1** + **server-rendered HTML** (Tailwind CDN). No frontend build step.

## Features

- Monitor multiple players across multiple tournaments simultaneously
- Pushover notifications for: new pairings, match results, tournament completion
- Per-player rating tracking and local Elo estimate
- Clean HTML dashboard — no React, no Vite, no build step
- Quiet hours: skip polling during configured night hours
- Runs on Cloudflare's free tier (Workers + D1)

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account (free)
- A [Pushover](https://pushover.net) account and application

## Setup

### 1. Clone and install

```bash
git clone <your-fork-url>
cd opencrbot
npm install
```

### 2. Create the D1 database

```bash
wrangler d1 create opencrbot
```

Copy the `database_id` from the output and replace `YOUR_D1_DATABASE_ID` in `wrangler.json`.

### 3. Run migrations

```bash
wrangler d1 execute opencrbot --remote --file=schema.sql
```

### 4. Deploy

```bash
npm run deploy
```

Your app is live at `https://opencrbot.<your-subdomain>.workers.dev`.

Log in with `admin` / `admin`. You will be prompted to change these on first login.

### 5. Configure Pushover

1. Create an account at [pushover.net](https://pushover.net)
2. Note your **User Key** from the account dashboard
3. Create a new **Application** — note the **App Token**
4. Go to **Settings** in the OpenCRBot dashboard
5. Enter your App Token and User Key, then click **Save Settings**
6. Click **Send Test Notification** to verify everything works

## Local Development

```bash
npm run dev
```

## Running Tests

```bash
npm test
```

## License

MIT
```

- [ ] **Step 2: Run final test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Final commit**

```bash
git add README.md
git commit -m "docs: add README with setup and Pushover instructions"
```
