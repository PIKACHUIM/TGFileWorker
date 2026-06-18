// D1 建表语句，由 auth /init 接口执行
// ⚠️ 此文件必须与 migrations/0001_init.sql 保持同步，修改时请同步更新
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  email TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'register',
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_verification_email ON verification_codes(email);
CREATE INDEX IF NOT EXISTS idx_verification_expires ON verification_codes(expires_at);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('file','video','audio','image','book')),
  scan_mode TEXT CHECK(scan_mode IS NULL OR scan_mode IN ('auto','simple_bot_api','bot_api','mtproto')),
  api_id TEXT,
  api_hash TEXT,
  session_string TEXT,
  bot_token TEXT,
  last_scan_message_id INTEGER NOT NULL DEFAULT 0,
  last_scan_at INTEGER,
  name_regex TEXT,
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
  tags TEXT,
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
`

// 增量迁移 SQL（用于已有数据库的列升级）
// D1 的 CREATE TABLE IF NOT EXISTS 不会更新已有表结构，
// 所以需要在 init 时额外执行 ALTER TABLE 来添加新列
export const MIGRATIONS = `
ALTER TABLE sources ADD COLUMN scan_mode TEXT CHECK(scan_mode IS NULL OR scan_mode IN ('auto','simple_bot_api','bot_api','mtproto'));
ALTER TABLE media_items ADD COLUMN tags TEXT;
ALTER TABLE sources ADD COLUMN name_regex TEXT;
`
