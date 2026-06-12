import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chessSessions = sqliteTable("chess_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  tournamentId: text("tournament_id").notNull(),
  playerSnr: text("player_snr").notNull(),
  server: text("server").default(""),
  federation: text("federation").default("IND"),
  status: text("status", { enum: ["running", "stopped", "completed", "error"] }).default("running"),
  notify: integer("notify").default(1),
  data: text("data").default("{}"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  type: text("type", { enum: ["pairing", "result", "completion"] }).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  sent: integer("sent").default(0),
  roundNumber: integer("round_number").notNull().default(-1),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

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
});
