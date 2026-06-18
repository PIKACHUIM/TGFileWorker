import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()
app.use('*', authMiddleware)

app.get('/', async (c) => {
  const rows = await c.env.DB.prepare('SELECT key, value FROM settings WHERE key != ?').bind('initialized').all<{ key: string; value: string }>()
  return c.json(Object.fromEntries(rows.results.map(r => [r.key, r.value])))
})

app.put('/', async (c) => {
  const body = await c.req.json<Record<string, string>>()
  const stmts = Object.entries(body).map(([k, v]) =>
    c.env.DB.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').bind(k, v)
  )
  if (stmts.length) await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

export default app
