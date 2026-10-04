CREATE TABLE account_links (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('invite','reset')),
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
  user_id TEXT REFERENCES users(id),
  issued_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  claim TEXT,
  CHECK((kind='invite' AND user_id IS NULL) OR (kind='reset' AND user_id IS NOT NULL))
);
CREATE INDEX account_links_email ON account_links(email);
CREATE INDEX account_links_user ON account_links(user_id);
