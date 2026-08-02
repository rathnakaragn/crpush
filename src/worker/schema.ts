import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const chessSessions = sqliteTable("chess_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  tournamentId: text("tournament_id").notNull(),
  playerSnr: text("player_snr").notNull(),
  server: text("server").default(""),
  federation: text("federation").default("IND"),
  status: text("status", { enum: ["running", "stopped", "completed", "error"] }).default("running"),
  notify: integer("notify").default(1),
  failCount: integer("fail_count").default(0),
  data: text("data").default("{}"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (t) => [
  index("idx_sessions_status").on(t.status),
  check("chess_sessions_status_check", sql`${t.status} IN ('running', 'stopped', 'completed', 'error')`),
]);

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull().references(() => chessSessions.id),
  type: text("type", { enum: ["pairing", "result", "completion"] }).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  sent: integer("sent").default(0),
  roundNumber: integer("round_number").notNull().default(-1),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (t) => [
  index("idx_notifications_session").on(t.sessionId),
  // saveNotification relies on this unique index for dedup (constraint
  // violation is caught and treated as "already notified")
  uniqueIndex("idx_notifications_dedup").on(t.sessionId, t.type, t.roundNumber),
  check("notifications_type_check", sql`${t.type} IN ('pairing', 'result', 'completion')`),
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const workerLogs = sqliteTable("worker_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  level: text("level", { enum: ["info", "warn", "error"] }).default("info").notNull(),
  source: text("source").default("worker").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (t) => [
  index("idx_worker_logs_created").on(t.createdAt),
  check("worker_logs_level_check", sql`${t.level} IN ('info', 'warn', 'error')`),
]);
