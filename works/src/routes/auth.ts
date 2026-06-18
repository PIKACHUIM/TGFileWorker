import { Hono } from 'hono'
import { isInitialized, setSetting, getSetting } from '../db'
import { signToken } from '../middleware/auth'
import type { Env } from '../types'
import { SCHEMA, MIGRATIONS } from '../db/schema'
import bcrypt from 'bcryptjs'
import { sendVerificationCode } from '../services/email'

const app = new Hono<{ Bindings: Env }>()

// 生成6位数字验证码
function generateCode(): string {
  return Math.random().toString().slice(2, 8)
}

// 检查是否已初始化 + 是否允许访客访问
app.get('/status', async (c) => {
  try {
    const initialized = await isInitialized(c.env.DB)
    const allowGuest = (await getSetting(c.env.DB, 'allow_guest')) === 'true'
    return c.json({ initialized, allow_guest: allowGuest })
  } catch {
    return c.json({ initialized: false, allow_guest: false })
  }
})

// 公开设置（无需认证），返回 allow_login、allow_register 和 allow_guest
app.get('/public-settings', async (c) => {
  try {
    const allowLogin = await getSetting(c.env.DB, 'allow_login')
    const allowRegister = await getSetting(c.env.DB, 'allow_register')
    const allowGuest = await getSetting(c.env.DB, 'allow_guest')
    return c.json({
      allow_login: allowLogin !== 'false', // 默认 true
      allow_register: allowRegister !== 'false', // 默认 true
      allow_guest: allowGuest === 'true', // 默认 false
    })
  } catch {
    return c.json({ allow_login: true, allow_register: true, allow_guest: false })
  }
})

// 首次初始化：建表 + 创建管理员
app.post('/init', async (c) => {
  try {
    const initialized = await isInitialized(c.env.DB)
    if (initialized) return c.json({ error: '已经初始化过了' }, 400)

    const { username, password } = await c.req.json<{ username: string; password: string }>()
    if (!username || !password) return c.json({ error: '用户名和密码不能为空' }, 400)
    if (password.length < 6) return c.json({ error: '密码长度不能少于6位' }, 400)
    if (username.length < 2) return c.json({ error: '用户名长度不能少于2位' }, 400)

    // 执行建表 SQL（分号分隔多条语句）
    const stmts = SCHEMA.split(';').map(s => s.trim()).filter(Boolean)
    for (const sql of stmts) {
      await c.env.DB.prepare(sql).run()
    }

    // 执行增量迁移（添加新列等，忽略已存在的列错误）
    const migrationStmts = MIGRATIONS.split(';').map(s => s.trim()).filter(Boolean)
    for (const sql of migrationStmts) {
      try {
        await c.env.DB.prepare(sql).run()
      } catch (e: any) {
        // 列已存在时忽略错误
        if (!String(e).includes('duplicate column name')) {
          console.warn('[Init] Migration warning:', String(e))
        }
      }
    }

    // 创建管理员用户（role = 'admin'）
    const hash = await hashPassword(password)
    await c.env.DB.prepare('INSERT INTO users(username, password_hash, role) VALUES(?, ?, ?)').bind(username, hash, 'admin').run()
    await setSetting(c.env.DB, 'initialized', 'true')

    return c.json({ ok: true })
  } catch (e: unknown) {
    return c.json({ error: String(e) }, 500)
  }
})

// 登录
app.post('/login', async (c) => {
  try {
    const { username, password } = await c.req.json<{ username: string; password: string }>()

    // 检查是否允许登录
    const allowLogin = await getSetting(c.env.DB, 'allow_login')
    if (allowLogin === 'false') {
      // 管理员不受限制，先查询用户角色
      const preCheck = await c.env.DB.prepare('SELECT id, username, role FROM users WHERE username = ?')
        .bind(username)
        .first<{ id: number; username: string; role: string }>()

      if (!preCheck || preCheck.role !== 'admin') {
        return c.json({ error: '登录功能已关闭' }, 403)
      }
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?')
      .bind(username)
      .first<{ id: number; username: string; password_hash: string; role: string }>()

    if (!user) {
      return c.json({ error: '用户名或密码错误' }, 401)
    }

    let valid = false
    try {
      valid = await verifyPassword(password, user.password_hash)
    } catch (e) {
      return c.json({ error: '密码验证失败: ' + String(e) }, 500)
    }

    if (!valid) {
      return c.json({ error: '用户名或密码错误' }, 401)
    }

    const token = await signToken({ userId: user.id, username: user.username, role: user.role }, c.env.JWT_SECRET)
    return c.json({ token, role: user.role })
  } catch (e) {
    return c.json({ error: '登录异常: ' + String(e) }, 500)
  }
})

// 发送验证码
app.post('/send-code', async (c) => {
  try {
    const { email } = await c.req.json<{ email: string }>()
    if (!email) return c.json({ error: '邮箱不能为空' }, 400)

    // 检查是否允许注册
    const allowRegister = await getSetting(c.env.DB, 'allow_register')
    if (allowRegister === 'false') {
      return c.json({ error: '注册功能已关闭' }, 403)
    }

    // 检查邮箱是否已注册
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (existing) {
      return c.json({ error: '该邮箱已注册' }, 400)
    }

    // 频率限制：同一邮箱 60 秒内只能发一次
    const now = Math.floor(Date.now() / 1000)
    const recent = await c.env.DB.prepare(
      'SELECT id FROM verification_codes WHERE email = ? AND created_at > ? LIMIT 1'
    ).bind(email, now - 60).first()
    if (recent) {
      return c.json({ error: '发送过于频繁，请60秒后重试' }, 429)
    }

    // 生成验证码
    const code = generateCode()
    const expiresAt = now + 600 // 10分钟有效期

    await c.env.DB.prepare(
      'INSERT INTO verification_codes(email, code, type, expires_at) VALUES(?, ?, ?, ?)'
    ).bind(email, code, 'register', expiresAt).run()

    // 发送邮件
    const result = await sendVerificationCode(c.env, email, code)
    if (!result.success) {
      return c.json({ error: `邮件发送失败: ${result.error}` }, 500)
    }

    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: '发送验证码异常: ' + String(e) }, 500)
  }
})

// 注册（需验证邮箱验证码）
app.post('/register', async (c) => {
  try {
    const { username, password, email, code } = await c.req.json<{
      username: string; password: string; email: string; code: string
    }>()

    // 检查是否允许注册
    const allowRegister = await getSetting(c.env.DB, 'allow_register')
    if (allowRegister === 'false') {
      return c.json({ error: '注册功能已关闭' }, 403)
    }

    // 参数校验
    if (!username || !password || !email || !code) {
      return c.json({ error: '所有字段不能为空' }, 400)
    }
    if (password.length < 6) return c.json({ error: '密码长度不能少于6位' }, 400)
    if (username.length < 2) return c.json({ error: '用户名长度不能少于2位' }, 400)

    // 校验邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return c.json({ error: '邮箱格式不正确' }, 400)
    }

    // 验证验证码
    const now = Math.floor(Date.now() / 1000)
    const record = await c.env.DB.prepare(
      'SELECT * FROM verification_codes WHERE email = ? AND code = ? AND type = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
    ).bind(email, code, 'register', now).first<{ id: number }>()

    if (!record) {
      return c.json({ error: '验证码无效或已过期' }, 400)
    }

    // 标记验证码已使用
    await c.env.DB.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').bind(record.id).run()

    // 检查用户名唯一性
    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
    if (existingUser) return c.json({ error: '用户名已存在' }, 400)

    // 检查邮箱唯一性
    const existingEmail = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (existingEmail) return c.json({ error: '该邮箱已注册' }, 400)

    // 创建普通用户
    const hash = await hashPassword(password)
    await c.env.DB.prepare('INSERT INTO users(username, password_hash, role, email) VALUES(?, ?, ?, ?)')
      .bind(username, hash, 'user', email).run()

    // 获取新创建的用户
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username)
      .first<{ id: number; username: string; role: string }>()

    if (!user) return c.json({ error: '注册失败' }, 500)

    // 自动登录
    const token = await signToken({ userId: user.id, username: user.username, role: user.role }, c.env.JWT_SECRET)
    return c.json({ token, role: user.role })
  } catch (e) {
    return c.json({ error: '注册异常: ' + String(e) }, 500)
  }
})

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return bcrypt.compare(password, stored)
}

export default app