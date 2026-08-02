import { env } from "cloudflare:test";
import { beforeEach } from "vitest";
import schemaSql from "../../schema.sql?raw";

// schema.sql is the single source of truth — tests always run against the
// exact schema that gets applied to production via wrangler d1 execute.
const DROP_ORDER = ["worker_logs", "settings", "notifications", "chess_sessions"];
const STATEMENTS = schemaSql.split(";").map(s => s.trim()).filter(Boolean);

beforeEach(async () => {
  for (const table of DROP_ORDER) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const stmt of STATEMENTS) {
    await env.DB.prepare(stmt).run();
  }
});
