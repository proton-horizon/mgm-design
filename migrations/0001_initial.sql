PRAGMA foreign_keys = ON;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','viewer')), password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL, active_publication TEXT, latest_attempt TEXT, created_at TEXT NOT NULL
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  sequence INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  source_commit TEXT, source_ref TEXT, run_url TEXT, message TEXT, manifest TEXT, cleaned_at TEXT,
  UNIQUE(project_id,sequence)
);
CREATE INDEX attempts_project ON attempts(project_id);
CREATE TABLE grants (
  hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
  project_id TEXT NOT NULL, publication_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX grants_session ON grants(session_hash);
CREATE TABLE login_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
