import { Hono } from 'hono'
import { authMiddleware, requireAdminMiddleware } from '../middleware/auth'
import type { Env } from '../types'
import bcrypt from 'bcryptjs'

const app = new Hono<{ Bindings: Env }>()
app.use('*', authMiddleware)
app.use('*', requireAdminMiddleware)

// 获取用户列表
app.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, username, role, email, created_at FROM users ORDER BY created_at DESC'
  ).all<{ id: number; username: string; role: string; email: string | null; created_at: number }>()
  return c.json(rows.results)
})

// 删除用户
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const payload = c.get('jwtPayload' as never) as { userId: number }

  if (id === payload.userId) {
    return c.json({ error: '不能删除自己' }, 400)
  }

  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

// 修改用户密码
app.put('/:id/password', async (c) => {
  const id = Number(c.req.param('id'))
  const { password } = await c.req.json<{ password: string }>()

  if (!password || password.length < 6) {
    return c.json({ error: '密码长度不能少于6位' }, 400)
  }

  const hash = await bcrypt.hash(password, 10)
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, id).run()
  return c.json({ ok: true })
})

export default app
