/**
 * Session 生成 API
 *
 * POST /api/session-gen/start      {phone, api_id, api_hash}  → 发送验证码
 * POST /api/session-gen/:id/code   {code}                     → 提交验证码
 * POST /api/session-gen/:id/password {password}               → 提交两步密码（可选）
 * GET  /api/session-gen/:id/result                            → 查询状态/获取 session
 */

import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()
app.use('*', authMiddleware)

function getStub(env: Env, id: string) {
  const doId = env.SESSION_GEN.idFromName(id)
  return env.SESSION_GEN.get(doId)
}

// 开始：创建新会话 ID 并发出验证码
app.post('/start', async (c) => {
  const body = await c.req.json<{ phone?: string; api_id?: string; api_hash?: string }>()
  if (!body.phone || !body.api_id || !body.api_hash) {
    return c.json({ error: 'Missing phone, api_id or api_hash' }, 400)
  }
  const id = crypto.randomUUID()
  const stub = getStub(c.env, id)
  const resp = await stub.fetch(new Request('https://dummy/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const data = await resp.json()
  if (!resp.ok) return c.json(data, resp.status as 400 | 500)
  return c.json({ id })
})

// 提交验证码
app.post('/:id/code', async (c) => {
  const { code } = await c.req.json<{ code?: string }>()
  if (!code) return c.json({ error: 'Missing code' }, 400)
  const stub = getStub(c.env, c.req.param('id'))
  const resp = await stub.fetch(new Request('https://dummy/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }))
  return c.json(await resp.json(), resp.status as 200 | 400)
})

// 提交两步验证密码
app.post('/:id/password', async (c) => {
  const { password } = await c.req.json<{ password?: string }>()
  if (!password) return c.json({ error: 'Missing password' }, 400)
  const stub = getStub(c.env, c.req.param('id'))
  const resp = await stub.fetch(new Request('https://dummy/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }))
  return c.json(await resp.json(), resp.status as 200 | 400)
})

// 查询状态 / 获取 session string
app.get('/:id/result', async (c) => {
  const stub = getStub(c.env, c.req.param('id'))
  const resp = await stub.fetch(new Request('https://dummy/result'))
  return c.json(await resp.json())
})

export default app
