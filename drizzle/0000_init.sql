CREATE TABLE IF NOT EXISTS `chess_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`tournament_id` text NOT NULL,
	`player_snr` text NOT NULL,
	`server` text DEFAULT '',
	`federation` text DEFAULT 'IND',
	`status` text DEFAULT 'running',
	`notify` integer DEFAULT 1,
	`fail_count` integer DEFAULT 0,
	`data` text DEFAULT '{}',
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	CONSTRAINT "chess_sessions_status_check" CHECK("chess_sessions"."status" IN ('running', 'stopped', 'completed', 'error'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_status` ON `chess_sessions` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`sent` integer DEFAULT 0,
	`round_number` integer DEFAULT -1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`session_id`) REFERENCES `chess_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_type_check" CHECK("notifications"."type" IN ('pairing', 'result', 'completion'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_notifications_session` ON `notifications` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_notifications_dedup` ON `notifications` (`session_id`,`type`,`round_number`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `worker_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`source` text DEFAULT 'worker' NOT NULL,
	`message` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	CONSTRAINT "worker_logs_level_check" CHECK("worker_logs"."level" IN ('info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_worker_logs_created` ON `worker_logs` (`created_at`);