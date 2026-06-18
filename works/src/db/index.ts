import type { Env } from '../types'
import { MIGRATIONS } from './schema'

export interface Source {
  id: number
  name: string
  channel_id: string
  type: string
  scan_mode: string | null
  api_id: string | null
  api_hash: string | null
  session_string: string | null
  bot_token: string | null
  last_scan_message_id: number
  last_scan_at: number | null
  name_regex: string | null
  created_at: number
}

export interface MediaItem {
  id: number
  source_id: number
  message_id: number
  file_name: string
  file_size: number
  mime_type: string | null
  media_type: string
  title: string | null
  description: string | null
  cover: string | null
  release_date: string | null
  rating: number | null
  genre: string | null
  tags: string | null
  external_id: string | null
  scraped_at: number | null
  file_hash: string
  message_date: number | null
  created_at: number
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').bind(key, value).run()
}

export async function getAllSettings(db: D1Database): Promise<Record<string, string>> {
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  return Object.fromEntries(rows.results.map(r => [r.key, r.value]))
}

export async function isInitialized(db: D1Database): Promise<boolean> {
  try {
    const val = await getSetting(db, 'initialized')
    return val === 'true'
  } catch {
    return false
  }
}

// 自动执行增量迁移（确保数据库结构是最新的）
export async function ensureMigrations(db: D1Database): Promise<void> {
  const stmts = MIGRATIONS.split(';').map(s => s.trim()).filter(Boolean)
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run()
    } catch (e: any) {
      // 列/索引已存在时忽略错误
      if (!String(e).includes('duplicate column name') && !String(e).includes('already exists')) {
        console.warn('[Migration] Warning:', String(e))
      }
    }
  }
}

export async function getSourceById(db: D1Database, id: number): Promise<Source | null> {
  return db.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first<Source>()
}

export async function upsertMediaItem(db: D1Database, item: Omit<MediaItem, 'id' | 'created_at'>): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO media_items
      (source_id, message_id, file_name, file_size, mime_type, media_type, file_hash, message_date, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    item.source_id, item.message_id, item.file_name, item.file_size,
    item.mime_type, item.media_type, item.file_hash, item.message_date,
    item.tags ?? null
  ).run()
}

export async function updateSourceSession(db: D1Database, sourceId: number, sessionString: string): Promise<void> {
  await db.prepare('UPDATE sources SET session_string = ? WHERE id = ?').bind(sessionString, sourceId).run()
}

export async function updateMediaScraped(
  db: D1Database, id: number,
  data: { title?: string; description?: string; cover?: string; release_date?: string; rating?: number; genre?: string; external_id?: string; tags?: string }
): Promise<void> {
  await db.prepare(`
    UPDATE media_items SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      cover = COALESCE(?, cover),
      release_date = COALESCE(?, release_date),
      rating = COALESCE(?, rating),
      genre = COALESCE(?, genre),
      external_id = COALESCE(?, external_id),
      tags = COALESCE(?, tags),
      scraped_at = ?
    WHERE id = ?
  `).bind(
    data.title ?? null, data.description ?? null, data.cover ?? null,
    data.release_date ?? null, data.rating ?? null, data.genre ?? null,
    data.external_id ?? null, data.tags ?? null,
    Math.floor(Date.now() / 1000), id
  ).run()
}
