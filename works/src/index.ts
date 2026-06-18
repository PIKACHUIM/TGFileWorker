import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './types'
import authRoutes from './routes/auth'
import sourcesRoutes from './routes/sources'
import scanRoutes from './routes/scan'
import mediaRoutes from './routes/media'
import publicRoutes from './routes/public'
import streamRoutes from './routes/stream'
import settingsRoutes from './routes/settings'
import usersRoutes from './routes/users'
import sessionGenRoutes from './routes/session-gen'
import { WebSocketProxy } from './ws-proxy'
import { SessionGenDO } from './tg/session-gen-do'
import { ensureMigrations } from './db'

const app = new Hono<{ Bindings: Env }>()

// 应用启动中间件：首次请求时自动执行数据库迁移
app.use('*', async (c, next) => {
  try {
    await ensureMigrations(c.env.DB)
  } catch (e) {
    console.warn('[Startup] Migration error:', String(e))
  }
  return next()
})

app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }))

app.route('/api/auth', authRoutes)
app.route('/api/sources', sourcesRoutes)
app.route('/api/sources', scanRoutes)
app.route('/api/admin/media', mediaRoutes)
app.route('/api/admin/settings', settingsRoutes)
app.route('/api/admin/users', usersRoutes)
app.route('/api/media', publicRoutes)
app.route('/api/session-gen', sessionGenRoutes)
app.route('/api', streamRoutes)

app.get('/', (c) => c.text('tgfileui-work API'))

export { WebSocketProxy, SessionGenDO }
export default app
