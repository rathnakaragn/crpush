import { Hono } from "hono";
// TODO: restore chess/pushover imports when routes are implemented (Tasks 7+)
// import {
//   checkForUpdates, fetchPlayerData, calculatePoints,
//   calculateTotalRatingChange, parseSessionData, type ChessSession,
// } from "./chess";
// import { sendPushover } from "./pushover";

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

// ── Export (scheduled handler completed in Task 13) ───────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await writeLog(env.DB, "Cron stub — implement in Task 13", "info", "cron");
  },
};
