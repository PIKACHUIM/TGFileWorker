-- tgfileui-work D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('file','video','audio','image','book')),
  api_id TEXT,
  api_hash TEXT,
  session_string TEXT,
  bot_token TEXT,
  last_scan_message_id INTEGER NOT NULL DEFAULT 0,
  last_scan_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  media_type TEXT NOT NULL,
  title TEXT,
  description TEXT,
  cover TEXT,
  release_date TEXT,
  rating REAL,
  genre TEXT,
  external_id TEXT,
  scraped_at INTEGER,
  file_hash TEXT NOT NULL,
  message_date INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_media_source ON media_items(source_id);
CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(media_type);
CREATE INDEX IF NOT EXISTS idx_media_scraped ON media_items(scraped_at);
