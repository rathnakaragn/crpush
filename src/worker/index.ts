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

// ── Export (scheduled handler completed in Task 13) ───────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await writeLog(env.DB, "Cron stub — implement in Task 13", "info", "cron");
  },
};
