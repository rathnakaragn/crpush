import type { ChessSession } from "./chess";

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

export function toChessSession(row: Record<string, unknown>): ChessSession {
  return row as unknown as ChessSession;
}
