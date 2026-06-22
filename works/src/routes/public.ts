import { Hono } from 'hono'
import { requireAuthOrGuestMiddleware } from '../middleware/auth'
import { getSetting } from '../db'
import { computeFileHash, getShortHash } from '../utils/hash'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()
app.use('*', requireAuthOrGuestMiddleware)

// 公开媒体列表（分页 + 筛选）
app.get('/', async (c) => {
  const { source, type, q, page = '1', pageSize = '24' } = c.req.query()
  const conditions: string[] = []
  const binds: unknown[] = []
  if (source) { conditions.push('m.source_id = ?'); binds.push(Number(source)) }
  if (type) { conditions.push('m.media_type = ?'); binds.push(type) }
  if (q) { conditions.push('(m.title LIKE ? OR m.file_name LIKE ?)'); binds.push(`%${q}%`, `%${q}%`) }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const offset = (Number(page) - 1) * Number(pageSize)

  const [rows, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT m.id, m.source_id, m.media_type, m.file_name, m.file_size,
              m.title, m.cover, m.release_date, m.rating, m.genre, m.message_date, m.tags,
              s.name as source_name, s.channel_id
       FROM media_items m JOIN sources s ON s.id = m.source_id
       ${where} ORDER BY m.message_date DESC LIMIT ? OFFSET ?`
    ).bind(...binds, Number(pageSize), offset).all(),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM media_items m ${where}`)
      .bind(...binds).first<{ cnt: number }>()
  ])

  return c.json({ items: rows.results, total: total?.cnt ?? 0 })
})

// 公开来源列表（用于前端切换频道）
app.get('/sources', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, channel_id, type FROM sources ORDER BY id'
  ).all()
  return c.json(rows.results)
})

// 媒体详情
app.get('/:id', async (c) => {
  const item = await c.env.DB.prepare(
    `SELECT m.*, s.name as source_name, s.channel_id, s.bot_token IS NOT NULL as has_direct
     FROM media_items m JOIN sources s ON s.id = m.source_id
     WHERE m.id = ?`
  ).bind(Number(c.req.param('id'))).first()
  if (!item) return c.json({ error: 'Not found' }, 404)

  // 计算文件 hash 并返回带 hash 的流 URL（参考 Go 项目 TG-FileStreamBot）
  const hashLength = Number(c.env.HASH_LENGTH) || 6
  const fullHash = await computeFileHash(
    item.file_name as string,
    item.file_size as number,
    (item.mime_type as string) || '',
    String(item.id)
  )
  const shortHash = getShortHash(fullHash, hashLength)

  // 获取 worker_url
  const workerUrl = ((await getSetting(c.env.DB, 'worker_url')) || c.env.WORKER_URL || '').replace(/\/$/, '')

  return c.json({
    ...item,
    stream_url: `${workerUrl}/api/stream/${item.id}?hash=${shortHash}`,
    direct_url: item.has_direct ? `${workerUrl}/api/direct/${item.id}?hash=${shortHash}` : null,
    strm_url: `${workerUrl}/api/strm/${item.id}?hash=${shortHash}`,
  })
})

// 选集列表：获取与指定媒体同名称（title）的其他集
app.get('/:id/episodes', async (c) => {
  const id = Number(c.req.param('id'))
  // 先获取当前媒体
  const current = await c.env.DB.prepare(
    'SELECT id, source_id, title, file_name FROM media_items WHERE id = ?'
  ).bind(id).first<{ id: number; source_id: number; title: string | null; file_name: string }>()
  if (!current) return c.json({ error: 'Not found' }, 404)

  // 用 title 或 file_name 的模糊匹配查找同系列
  const name = current.title || current.file_name
  if (!name) return c.json({ items: [], current_id: id })

  // 清理名称：去掉 # 前缀、集数标识、分辨率等，提取系列名
  const cleanName = name
    .replace(/^#+\s?/, '')
    .replace(/[\s._-]*(S\d{1,2}E\d{1,3}|EP?\d{1,3}|第\d+[集话期])/gi, '')
    .replace(/[\s._-]*(4K|2160p|1080p|720p|480p|高清|超清|HDR|BluRay|WEB-DL|x264|x265|HEVC).*$/i, '')
    .trim()
  if (!cleanName || cleanName.length < 2) return c.json({ items: [], current_id: id })

  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.source_id, m.message_id, m.file_name, m.file_size,
            m.mime_type, m.media_type, m.title, m.cover, m.message_date, m.tags
     FROM media_items m
     WHERE m.source_id = ? AND (m.title LIKE ? OR m.file_name LIKE ? OR m.title LIKE ? OR m.file_name LIKE ?)
     ORDER BY m.message_date ASC`
  ).bind(
    current.source_id,
    `%${cleanName}%`, `%${cleanName}%`,
    `%${name}%`, `%${name}%`
  ).all()

  return c.json({ items: rows.results, current_id: id })
})

export default app
