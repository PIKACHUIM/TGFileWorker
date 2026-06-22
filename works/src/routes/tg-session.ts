import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import { getSetting, getSourceById } from '../db'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()
app.use('*', authMiddleware)

app.get('/:sourceId', async (c) => {
  const allowed = await getSetting(c.env.DB, 'allow_direct_mtproto')
  if (allowed !== 'true') {
    return c.json({ error: '管理员未开启浏览器直连模式' }, 403)
  }

  const sourceId = Number(c.req.param('sourceId'))
  const source = await getSourceById(c.env.DB, sourceId)
  if (!source) return c.json({ error: 'Source not found' }, 404)
  if (!source.api_id || !source.api_hash) {
    return c.json({ error: '该来源未配置 api_id / api_hash' }, 400)
  }

  // KV session is fresher than db session_string
  const session = (await c.env.KV.get(`session:${sourceId}`)) || source.session_string || null
  return c.json({ apiId: Number(source.api_id), apiHash: source.api_hash, session, channelId: source.channel_id })
})

export default app
