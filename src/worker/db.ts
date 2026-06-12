import { eq, sql } from "drizzle-orm";
import type { ChessSession } from "./chess";
import type { AppDB } from "./drizzle";
import { settings, workerLogs } from "./schema";

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function getSetting(db: AppDB, key: string): Promise<string | null> {
  const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return rows[0]?.value ?? null;
}

export async function writeLog(db: AppDB, message: string, level: "info" | "warn" | "error" = "info", source = "worker"): Promise<void> {
  try {
    await db.insert(workerLogs).values({ level, source, message });
    // Cap at 1000 rows — delete oldest beyond limit
    await db.run(
      sql`DELETE FROM worker_logs WHERE id NOT IN (SELECT id FROM worker_logs ORDER BY created_at DESC LIMIT 1000)`
    );
  } catch {
    console.error("[writeLog] failed:", message);
  }
}

export async function getCredentials(db: AppDB): Promise<{ user: string; pass: string }> {
  const userRow = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "dashboard_user"));
  const passRow = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "dashboard_password"));
  return { user: userRow[0]?.value || "admin", pass: passRow[0]?.value || "admin" };
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
