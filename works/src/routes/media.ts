import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import { updateMediaScraped, getAllSettings } from '../db'
import { scrape } from '../scraper'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()
app.use('*', authMiddleware)

type MediaRow = {
  id: number; source_id: number; media_type: string; file_name: string
  title: string | null; cover: string | null; scraped_at: number | null
}

// 列表（支持按 source/type/scraped 过滤）
app.get('/', async (c) => {
  const { source, type, unscraped, page = '1', pageSize = '50' } = c.req.query()
  const conditions: string[] = []
  const binds: unknown[] = []
  if (source) { conditions.push('source_id = ?'); binds.push(Number(source)) }
  if (type) { conditions.push('media_type = ?'); binds.push(type) }
  if (unscraped === '1') conditions.push('scraped_at IS NULL')

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const offset = (Number(page) - 1) * Number(pageSize)

  const [rows, total] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM media_items ${where} ORDER BY message_date DESC LIMIT ? OFFSET ?`)
      .bind(...binds, Number(pageSize), offset).all<MediaRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM media_items ${where}`)
      .bind(...binds).first<{ cnt: number }>()
  ])
  return c.json({ items: rows.results, total: total?.cnt ?? 0 })
})

// 编辑（封面/标题/简介等）
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const b = await c.req.json<{
    title?: string; description?: string; cover?: string
    release_date?: string; rating?: number; genre?: string
  }>()
  await c.env.DB.prepare(
    `UPDATE media_items SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      cover = COALESCE(?, cover),
      release_date = COALESCE(?, release_date),
      rating = COALESCE(?, rating),
      genre = COALESCE(?, genre)
    WHERE id = ?`
  ).bind(b.title ?? null, b.description ?? null, b.cover ?? null,
    b.release_date ?? null, b.rating ?? null, b.genre ?? null, id).run()
  return c.json({ ok: true })
})

// 单条刮削
app.post('/:id/scrape', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const item = await c.env.DB.prepare('SELECT * FROM media_items WHERE id = ?').bind(id).first<MediaRow & { file_name: string }>()
  if (!item) {
    console.log(`[Scrape:Single] Item not found, id=${id}`)
    return c.json({ error: 'Not found' }, 404)
  }

  console.log(`[Scrape:Single] Starting scrape, id=${id}, media_type=${item.media_type}, file_name=${item.file_name}`)
  const settings = await getAllSettings(c.env.DB)
  const result = await scrape(item.media_type, item.file_name, settings)
  if (result) {
    console.log(`[Scrape:Single] Scrape success, id=${id}, title=${result.title}, cover=${result.cover}`)
    await updateMediaScraped(c.env.DB, id, result)
    return c.json({ ok: true, data: result })
  }
  console.log(`[Scrape:Single] Scrape failed, id=${id}, media_type=${item.media_type}, file_name=${item.file_name}`)
  return c.json({ ok: false, message: '未找到刮削结果' })
})

// 批量刮削（仅处理未刮削的）
app.post('/scrape-all', async (c) => {
  const { source } = c.req.query()
  const where = source ? 'WHERE scraped_at IS NULL AND source_id = ?' : 'WHERE scraped_at IS NULL'
  const binds = source ? [Number(source)] : []
  const items = await c.env.DB.prepare(`SELECT * FROM media_items ${where} ORDER BY id`)
    .bind(...binds).all<MediaRow & { file_name: string }>()

  console.log(`[Scrape:Batch] Starting batch scrape, source=${source ?? 'all'}, total_items=${items.results.length}`)
  const settings = await getAllSettings(c.env.DB)
  let done = 0
  let failed = 0
  for (const item of items.results) {
    console.log(`[Scrape:Batch] Processing item id=${item.id}, media_type=${item.media_type}, file_name=${item.file_name}`)
    const result = await scrape(item.media_type, item.file_name, settings)
    if (result) {
      console.log(`[Scrape:Batch] Scrape success, id=${item.id}, title=${result.title}`)
      await updateMediaScraped(c.env.DB, item.id, result)
      done++
    } else {
      console.log(`[Scrape:Batch] Scrape failed, id=${item.id}, media_type=${item.media_type}, file_name=${item.file_name}`)
      failed++
    }
  }
  console.log(`[Scrape:Batch] Batch scrape complete, done=${done}, failed=${failed}, total=${items.results.length}`)
  return c.json({ ok: true, done, failed, total: items.results.length })
})

// 清空某来源的媒体
app.delete('/source/:sourceId', async (c) => {
  const sourceId = Number(c.req.param('sourceId'))
  if (!Number.isFinite(sourceId)) return c.json({ error: 'Invalid sourceId' }, 400)
  await c.env.DB.prepare('DELETE FROM media_items WHERE source_id = ?').bind(sourceId).run()
  // 重置扫描游标
  await c.env.DB.prepare('UPDATE sources SET last_scan_message_id = 0, last_scan_at = NULL WHERE id = ?').bind(sourceId).run()
  return c.json({ ok: true })
})

export default app
