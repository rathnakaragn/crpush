CREATE TABLE IF NOT EXISTS chess_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  tournament_id TEXT NOT NULL,
  player_snr TEXT NOT NULL,
  server TEXT DEFAULT '',
  federation TEXT DEFAULT 'IND',
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'stopped', 'completed', 'error')),
  notify INTEGER DEFAULT 1,
  data TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pairing', 'result', 'completion')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  sent INTEGER DEFAULT 0,
  round_number INTEGER NOT NULL DEFAULT -1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES chess_sessions(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  source TEXT NOT NULL DEFAULT 'worker',
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON chess_sessions(status);
CREATE INDEX IF NOT EXISTS idx_notifications_session ON notifications(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(session_id, type, round_number);
CREATE INDEX IF NOT EXISTS idx_worker_logs_created ON worker_logs(created_at DESC);
