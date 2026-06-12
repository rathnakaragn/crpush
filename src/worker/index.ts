import { Hono } from "hono";
import {
  // @ts-ignore – used in Task 13 (cron handler)
  checkForUpdates,
  fetchPlayerData, calculatePoints,
  calculateTotalRatingChange,
  parseSessionData, type ChessSession,
} from "./chess";
import { sendPushover } from "./pushover";

const app = new Hono<{ Bindings: Env }>();

// ── Cookie auth ───────────────────────────────────────────────────────────────

export async function getCookieSecret(db: D1Database): Promise<CryptoKey> {
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

export function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function createSessionCookie(key: CryptoKey, username: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 7;
  const payload = btoa(`${username}:${exp}`);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifySessionCookie(key: CryptoKey, cookie: string): Promise<string | null> {
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

export async function getAuthUser(req: Request, db: D1Database): Promise<string | null> {
  const cookieHeader = req.headers.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  const key = await getCookieSecret(db);
  return verifySessionCookie(key, decodeURIComponent(match[1]));
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function writeLog(db: D1Database, message: string, level: "info" | "warn" | "error" = "info", source = "worker"): Promise<void> {
  try {
    await db.batch([
      db.prepare("INSERT INTO worker_logs (level, source, message) VALUES (?, ?, ?)").bind(level, source, message),
      db.prepare("DELETE FROM worker_logs WHERE id NOT IN (SELECT id FROM worker_logs ORDER BY created_at DESC LIMIT 1000)"),
    ]);
  } catch {
    console.error("[writeLog] failed:", message);
  }
}

export async function getCredentials(db: D1Database): Promise<{ user: string; pass: string }> {
  const userRow = await db.prepare("SELECT value FROM settings WHERE key = 'dashboard_user'").first<{ value: string }>();
  const passRow = await db.prepare("SELECT value FROM settings WHERE key = 'dashboard_password'").first<{ value: string }>();
  return { user: userRow?.value || "admin", pass: passRow?.value || "admin" };
}

export function parseChessUrl(url: string): { server: string; tournament_id: string; player_snr: string; federation: string } | null {
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

// ── HTML helpers ──────────────────────────────────────────────────────────────

export function statusBadge(status: string): string {
  const styles: Record<string, string> = {
    running: "bg-green-100 text-green-800",
    stopped: "bg-gray-100 text-gray-700",
    completed: "bg-blue-100 text-blue-800",
    error: "bg-red-100 text-red-800",
  };
  return `<span class="px-2 py-0.5 rounded text-xs font-medium ${styles[status] ?? "bg-gray-100 text-gray-700"}">${status}</span>`;
}

export function levelBadge(level: string): string {
  const styles: Record<string, string> = {
    info: "bg-gray-100 text-gray-700",
    warn: "bg-yellow-100 text-yellow-800",
    error: "bg-red-100 text-red-800",
  };
  return `<span class="px-2 py-0.5 rounded text-xs font-medium ${styles[level] ?? "bg-gray-100 text-gray-700"}">${level}</span>`;
}

export function layout(title: string, content: string, activePage = ""): string {
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

// ── Export (scheduled handler completed in Task 13) ───────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await writeLog(env.DB, "Cron stub — implement in Task 13", "info", "cron");
  },
};
