import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()
app.use('*', authMiddleware)

// 列表（排除敏感凭据字段）
app.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, channel_id, type, scan_mode, name_regex, last_scan_message_id, last_scan_at, created_at FROM sources ORDER BY id DESC'
  ).all()
  return c.json(rows.results)
})

// 详情（含敏感凭据字段，用于编辑表单填充）
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const row = await c.env.DB.prepare(
    'SELECT * FROM sources WHERE id = ?'
  ).bind(id).first()
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// 新增
app.post('/', async (c) => {
  const b = await c.req.json<{
    name: string; channel_id: string; type: string; scan_mode?: string
    api_id?: string; api_hash?: string; session_string?: string; bot_token?: string; name_regex?: string
  }>()
  if (!b.name || !b.channel_id || !b.type || !b.scan_mode) return c.json({ error: '缺少必填字段 (name, channel_id, type, scan_mode)' }, 400)
  if (b.scan_mode === 'auto') return c.json({ error: 'scan_mode 不能为 auto，必须选择具体的扫描模式' }, 400)
  const r = await c.env.DB.prepare(
    'INSERT INTO sources(name,channel_id,type,scan_mode,api_id,api_hash,session_string,bot_token,name_regex) VALUES(?,?,?,?,?,?,?,?,?)'
  ).bind(b.name, b.channel_id, b.type, b.scan_mode ?? null, b.api_id ?? null, b.api_hash ?? null, b.session_string ?? null, b.bot_token ?? null, b.name_regex ?? null).run()
  return c.json({ id: r.meta.last_row_id }, 201)
})

// 编辑
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const b = await c.req.json<{
    name?: string; channel_id?: string; type?: string; scan_mode?: string
    api_id?: string; api_hash?: string; session_string?: string; bot_token?: string; name_regex?: string
  }>()
  await c.env.DB.prepare(
    `UPDATE sources SET
      name = COALESCE(?, name),
      channel_id = COALESCE(?, channel_id),
      type = COALESCE(?, type),
      scan_mode = COALESCE(?, scan_mode),
      api_id = COALESCE(?, api_id),
      api_hash = COALESCE(?, api_hash),
      session_string = COALESCE(?, session_string),
      bot_token = COALESCE(?, bot_token),
      name_regex = COALESCE(?, name_regex)
    WHERE id = ?`
  ).bind(b.name ?? null, b.channel_id ?? null, b.type ?? null, b.scan_mode ?? null, b.api_id ?? null, b.api_hash ?? null, b.session_string ?? null, b.bot_token ?? null, b.name_regex ?? null, id).run()
  return c.json({ ok: true })
})

// 删除
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  await c.env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

export default app
