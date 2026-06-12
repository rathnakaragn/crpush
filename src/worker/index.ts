import { Hono } from "hono";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { getDb } from "./drizzle";
import { chessSessions, notifications, settings, workerLogs } from "./schema";
import {
  checkForUpdates,
  fetchPlayerData,
  calculatePoints,
  calculateTotalRatingChange,
  parseSessionData, type ChessSession,
} from "./chess";
import { sendPushover } from "./pushover";
import {
  getCookieSecret,
  createSessionCookie,
  getAuthUser,
  hashPassword,
  verifyPassword,
} from "./auth";
import {
  getSetting,
  writeLog,
  getCredentials,
  parseChessUrl,
} from "./db";
import {
  escapeHtml,
  statusBadge,
  levelBadge,
  layout,
  formatSession,
} from "./templates";

const app = new Hono<{ Bindings: Env }>();

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
  const db = getDb(c.env.DB);
  const body = await c.req.parseBody();
  const username = String(body.username || "");
  const password = String(body.password || "");
  const creds = await getCredentials(db);
  const usernameMatch = username === creds.user;
  let passwordMatch: boolean;
  if (creds.pass.includes(":") && creds.pass.length > 40) {
    passwordMatch = await verifyPassword(password, creds.pass);
  } else {
    passwordMatch = password === creds.pass;
  }
  if (!usernameMatch || !passwordMatch) return c.redirect("/login?error=1");
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

app.get("/", async (c) => {
  const db = getDb(c.env.DB);

  const results = await db.select().from(chessSessions).orderBy(desc(chessSessions.createdAt));

  const runningRows = await db.select({ count: sql<number>`count(*)` }).from(chessSessions).where(eq(chessSessions.status, "running"));
  const running = runningRows[0]?.count ?? 0;

  const notifRows = await db.select({ count: sql<number>`count(*)` }).from(notifications).where(eq(notifications.sent, 1));
  const notifCount = notifRows[0]?.count ?? 0;

  const creds = await getCredentials(db);
  const isDefault = creds.user === "admin" && creds.pass === "admin";

  const rows = results.map(s => {
    const fmt = formatSession(s as unknown as Record<string, unknown>);
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
      <td class="px-4 py-3 text-sm"><a href="/session/${escapeHtml(fmt.id)}" class="text-blue-600 hover:underline font-medium">${escapeHtml(fmt.player)}</a></td>
      <td class="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title="${escapeHtml(fmt.tournament)}">${escapeHtml(fmt.tournament) || "—"}</td>
      <td class="px-4 py-3 text-sm text-center">#${escapeHtml(fmt.rank)}</td>
      <td class="px-4 py-3 text-sm text-center">${escapeHtml(fmt.points)} · ${rounds}</td>
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
  const db = getDb(c.env.DB);
  const body = await c.req.parseBody();
  const url = String(body.url || "").trim();
  if (!url) return c.redirect("/");
  const parsed = parseChessUrl(url);
  if (!parsed) return c.redirect("/");
  const existing = await db.select({ id: chessSessions.id }).from(chessSessions)
    .where(and(eq(chessSessions.url, url), eq(chessSessions.status, "running"))).limit(1);
  if (existing.length > 0) return c.redirect("/");
  const initialData = await fetchPlayerData(parsed.server, parsed.tournament_id, parsed.player_snr, parsed.federation, url);
  await db.insert(chessSessions).values({
    url, tournamentId: parsed.tournament_id, playerSnr: parsed.player_snr,
    server: parsed.server, federation: parsed.federation,
    data: JSON.stringify(initialData ?? {})
  });
  return c.redirect("/");
});

app.post("/sessions/:id/stop", async (c) => {
  const db = getDb(c.env.DB);
  await db.update(chessSessions)
    .set({ status: "stopped", updatedAt: sql`(datetime('now'))` })
    .where(eq(chessSessions.id, Number(c.req.param("id"))));
  return c.redirect("/");
});

app.post("/sessions/:id/toggle-notify", async (c) => {
  const db = getDb(c.env.DB);
  const session = await db.select({ notify: chessSessions.notify }).from(chessSessions)
    .where(eq(chessSessions.id, Number(c.req.param("id")))).limit(1);
  if (!session[0]) return c.redirect("/");
  await db.update(chessSessions)
    .set({ notify: session[0].notify ? 0 : 1 })
    .where(eq(chessSessions.id, Number(c.req.param("id"))));
  return c.redirect("/");
});

// ── Session detail ────────────────────────────────────────────────────────────

app.get("/session/:id", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(chessSessions).where(eq(chessSessions.id, Number(c.req.param("id")))).limit(1);
  if (!rows[0]) return c.redirect("/");
  const s = rows[0];

  const data = parseSessionData(s as unknown as ChessSession);
  const ratingEst = calculateTotalRatingChange(
    data.player?.rating || 0, data.matches || [], data.player?.kFactor || 20
  ).total;
  const points = calculatePoints(data.matches || []);

  const matchRows = (data.matches || []).map(m => {
    const outcome = m.result === "1" ? "Win" : m.result === "0" ? "Loss" : m.result ? "Draw" : "—";
    const cls = m.result === "1" ? "text-green-700 font-medium" : m.result === "0" ? "text-red-700 font-medium" : "text-gray-700";
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-4 py-2 text-sm text-center">${escapeHtml(m.round_number)}</td>
      <td class="px-4 py-2 text-sm">${escapeHtml(m.opponent_name)}</td>
      <td class="px-4 py-2 text-sm text-center">${escapeHtml(m.opponent_rating) || "—"}</td>
      <td class="px-4 py-2 text-sm text-center">${escapeHtml(m.color) || "—"}</td>
      <td class="px-4 py-2 text-sm text-center">${escapeHtml(m.board) || "—"}</td>
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
          <h1 class="text-2xl font-bold text-gray-900">${escapeHtml(data.player?.name) || "Unknown"}</h1>
          <p class="text-gray-500 mt-0.5">${escapeHtml(data.tournament_name) || "Tournament"}</p>
        </div>
        <div class="flex items-center gap-2">
          ${statusBadge(s.status as string)}
          <a href="${escapeHtml(s.url as string)}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">chess-results.com ↗</a>
        </div>
      </div>
      <div class="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="bg-gray-50 rounded-lg p-3">
          <div class="text-xs text-gray-500 mb-1">Current Rank</div>
          <div class="text-xl font-bold text-gray-900">#${escapeHtml(data.player?.current_rank) || "?"}</div>
        </div>
        <div class="bg-gray-50 rounded-lg p-3">
          <div class="text-xs text-gray-500 mb-1">Points</div>
          <div class="text-xl font-bold text-gray-900">${points} / ${data.total_rounds || "?"}</div>
        </div>
        <div class="bg-gray-50 rounded-lg p-3">
          <div class="text-xs text-gray-500 mb-1">Rating</div>
          <div class="text-xl font-bold text-gray-900">${escapeHtml(data.player?.rating) || "—"}</div>
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
  return c.html(layout(data.player?.name || "Session", content, "sessions")); // title is escaped inside layout()
});

// ── Notifications ─────────────────────────────────────────────────────────────

app.get("/notifications", async (c) => {
  const db = getDb(c.env.DB);
  const results = await db.select({
    id: notifications.id, type: notifications.type, title: notifications.title,
    message: notifications.message, sent: notifications.sent, createdAt: notifications.createdAt,
    sessionData: chessSessions.data,
  }).from(notifications)
    .leftJoin(chessSessions, eq(notifications.sessionId, chessSessions.id))
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  const typeBadge = (t: string) => {
    const styles: Record<string, string> = {
      pairing: "bg-purple-100 text-purple-800",
      result: "bg-blue-100 text-blue-800",
      completion: "bg-green-100 text-green-800",
    };
    return `<span class="px-2 py-0.5 rounded text-xs font-medium ${styles[t] ?? "bg-gray-100 text-gray-700"}">${t}</span>`;
  };

  const rows = results.map(n => {
    const sessionData = parseSessionData({ data: n.sessionData as string } as ChessSession);
    const sentBadge = n.sent
      ? `<span class="text-green-600 text-xs">✓ sent</span>`
      : `<span class="text-gray-400 text-xs">unsent</span>`;
    return `<tr class="border-t border-gray-100 hover:bg-gray-50">
      <td class="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">${String(n.createdAt).slice(0, 16).replace("T", " ")}</td>
      <td class="px-4 py-3">${typeBadge(String(n.type))}</td>
      <td class="px-4 py-3 text-sm font-medium text-gray-900">${escapeHtml(n.title)}</td>
      <td class="px-4 py-3 text-xs text-gray-500">
        <div class="font-medium mb-0.5">${escapeHtml(sessionData.player?.name) || "Unknown"}</div>
        <pre class="whitespace-pre-wrap text-gray-600">${escapeHtml(String(n.message))}</pre>
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
  const db = getDb(c.env.DB);
  const logs = await db.select().from(workerLogs).orderBy(desc(workerLogs.createdAt)).limit(100);

  const rows = logs.map(l => `<tr class="border-t border-gray-100 hover:bg-gray-50">
    <td class="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">${String(l.createdAt).slice(0, 19).replace("T", " ")}</td>
    <td class="px-4 py-2">${levelBadge(String(l.level))}</td>
    <td class="px-4 py-2 text-xs text-gray-500">${escapeHtml(l.source)}</td>
    <td class="px-4 py-2 text-sm text-gray-700">${escapeHtml(l.message)}</td>
  </tr>`).join("");

  const content = `
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">Worker Logs</h1>
      <form method="POST" action="/logs/clear" onsubmit="return confirm('Clear all logs?')">
        <button type="submit" class="text-sm text-red-600 hover:text-red-800 font-medium">Clear All</button>
      </form>
    </div>
    ${logs.length === 0
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
  const db = getDb(c.env.DB);
  await db.delete(workerLogs);
  return c.redirect("/logs");
});

// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Record<string, string> = {
  timezone: "Asia/Kolkata",
  night_start_hour: "23",
  night_end_hour: "6",
};

app.get("/settings", async (c) => {
  const db = getDb(c.env.DB);
  const allSettings = await db.select().from(settings);
  const map = Object.fromEntries(allSettings.map(r => [r.key, r.value]));
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
            <input name="pushover_app_token" type="text" value="${escapeHtml(map.pushover_app_token || "")}"
              placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500">
            <p class="text-xs text-gray-400 mt-1">From pushover.net/apps — create an application for OpenCRBot</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">User Key</label>
            <input name="pushover_user_key" type="text" value="${escapeHtml(map.pushover_user_key || "")}"
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
            <input name="timezone" type="text" value="${escapeHtml(s.timezone)}"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Start Hour (24h)</label>
            <input name="night_start_hour" type="number" min="0" max="23" value="${escapeHtml(s.night_start_hour)}"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">End Hour (24h)</label>
            <input name="night_end_hour" type="number" min="0" max="23" value="${escapeHtml(s.night_end_hour)}"
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
  const db = getDb(c.env.DB);
  const body = await c.req.parseBody();
  const allowed = ["pushover_app_token", "pushover_user_key", "timezone", "night_start_hour", "night_end_hour"];
  for (const k of allowed) {
    if (body[k] !== undefined) {
      await db.insert(settings).values({ key: k, value: String(body[k]) }).onConflictDoUpdate({
        target: settings.key, set: { value: String(body[k]) }
      });
    }
  }
  return c.redirect("/settings?saved=1");
});

app.post("/settings/test", async (c) => {
  const db = getDb(c.env.DB);
  const appToken = await getSetting(db, "pushover_app_token");
  const userKey = await getSetting(db, "pushover_user_key");
  if (!appToken || !userKey) return c.redirect("/settings?testerror=1");
  const ok = await sendPushover(appToken, userKey, "OpenCRBot Test", "Pushover is configured correctly!", "https://pushover.net");
  return c.redirect(ok ? "/settings?testok=1" : "/settings?testerror=1");
});

app.post("/settings/password", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.parseBody();
  const username = String(body.username || "").trim();
  const password = String(body.password || "").trim();
  if (!username || !password) return c.redirect("/settings");
  const hashedPassword = await hashPassword(password);
  await db.insert(settings).values({ key: "dashboard_user", value: username })
    .onConflictDoUpdate({ target: settings.key, set: { value: username } });
  await db.insert(settings).values({ key: "dashboard_password", value: hashedPassword })
    .onConflictDoUpdate({ target: settings.key, set: { value: hashedPassword } });
  c.header("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/");
  return c.redirect("/login");
});

// ── Poll ──────────────────────────────────────────────────────────────────────

app.post("/poll", async (c) => {
  const db = getDb(c.env.DB);
  const appToken = await getSetting(db, "pushover_app_token");
  const userKey = await getSetting(db, "pushover_user_key");

  const sendFn = async (title: string, message: string, url: string) => {
    if (!appToken || !userKey) return false;
    return sendPushover(appToken, userKey, title, message, url);
  };

  const logFn = (msg: string, level: "info" | "warn" | "error" = "info", source = "poll") =>
    writeLog(db, msg, level, source);

  await writeLog(db, "Manual check triggered", "info", "poll");
  c.executionCtx.waitUntil(
    checkForUpdates(db, sendFn, logFn).then(result =>
      writeLog(db, `Manual check done — ${result.sessions} session(s), ${result.notifications} notification(s)`, "info", "poll")
    )
  );
  return c.redirect("/");
});

// ── Export ────────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const db = getDb(env.DB);
    const cronSettings = await db.select().from(settings)
      .where(inArray(settings.key, ["timezone", "night_start_hour", "night_end_hour", "pushover_app_token", "pushover_user_key"]));
    const settingsMap = Object.fromEntries(cronSettings.map(r => [r.key, r.value]));
    const timezone = settingsMap["timezone"] || "Asia/Kolkata";
    const nightStart = parseInt(settingsMap["night_start_hour"] || "23", 10);
    const nightEnd = parseInt(settingsMap["night_end_hour"] || "6", 10);

    const hour = parseInt(
      new Date().toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false }),
      10
    ) % 24;
    const isNight = nightStart > nightEnd
      ? hour >= nightStart || hour < nightEnd
      : hour >= nightStart && hour < nightEnd;

    if (isNight) {
      await writeLog(db, `Cron skipped — quiet hours (hour=${hour}, quiet=${nightStart}h–${nightEnd}h)`, "info", "cron");
      return;
    }

    const appToken = settingsMap["pushover_app_token"] || "";
    const userKey = settingsMap["pushover_user_key"] || "";

    const sendFn = async (title: string, message: string, url: string) => {
      if (!appToken || !userKey) return false;
      return sendPushover(appToken, userKey, title, message, url);
    };

    const logFn = (msg: string, level: "info" | "warn" | "error" = "info", source = "cron") =>
      writeLog(db, msg, level, source);

    const result = await checkForUpdates(db, sendFn, logFn);
    await writeLog(db, `Cron done — ${result.sessions} session(s), ${result.notifications} notification(s)`, "info", "cron");
  },
};
