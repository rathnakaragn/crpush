import { env } from "cloudflare:test";
import { beforeEach } from "vitest";

// The drizzle/ migration files are the single source of truth — tests apply
// the same chain that `wrangler d1 migrations apply` runs against production.
const migrationFiles = import.meta.glob("../../drizzle/*.sql", { query: "?raw", eager: true }) as Record<string, { default: string }>;

const STATEMENTS = Object.keys(migrationFiles).sort().flatMap(path =>
  migrationFiles[path].default
    .split(";")
    .map(s => s.replace(/--> statement-breakpoint/g, "").trim())
    .filter(Boolean)
);

const DROP_ORDER = ["worker_logs", "settings", "notifications", "chess_sessions"];

beforeEach(async () => {
  for (const table of DROP_ORDER) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const stmt of STATEMENTS) {
    await env.DB.prepare(stmt).run();
  }
});
