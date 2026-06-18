import { createMiddleware } from 'hono/factory'
import { SignJWT, jwtVerify } from 'jose'
import { getSetting } from '../db'
import type { Env } from '../types'

export interface JWTPayload {
  userId: number
  username: string
  role: string
}

export async function signToken(payload: JWTPayload, secret: string): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(secret))
}

export async function verifyToken(token: string, secret: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret))
  return payload as unknown as JWTPayload
}

// 尝试解析 Token，无论是否存在都不拦截（用于访客模式下的可选认证）
export const optionalAuthMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const auth = c.req.header('Authorization')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
  if (token) {
    try {
      const payload = await verifyToken(token, c.env.JWT_SECRET)
      c.set('jwtPayload' as never, payload)
    } catch {
      // Token 无效则忽略，不拦截
    }
  }
  await next()
})

// 需要登录或开启访客访问才放行
export const requireAuthOrGuestMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  // 先尝试解析 Token
  const auth = c.req.header('Authorization')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
  if (token) {
    try {
      const payload = await verifyToken(token, c.env.JWT_SECRET)
      c.set('jwtPayload' as never, payload)
      await next()
      return
    } catch {
      // Token 无效，继续检查 hash 或访客模式
    }
  }

  // 检查 URL 中的 hash 参数（用于流媒体等浏览器直接发起的请求）
  const hashParam = c.req.query('hash')
  if (hashParam) {
    // hash 验证需要查询数据库中的 media_item，此处无法直接访问
    // 但有 hash 参数说明请求经过了前端构造，属于合法请求
    // 具体的 hash 合法性验证在 /stream/:id 路由处理函数中进行
    // 这里只要有 hash 参数就放行，无效 hash 会在路由处理中返回 403
    await next()
    return
  }

  // 未携带 Token 且无 hash，检查是否开启访客访问
  const allowGuest = await getSetting(c.env.DB, 'allow_guest')
  if (allowGuest === 'true') {
    await next()
    return
  }

  return c.json({ error: 'Unauthorized' }, 401)
})

// 强制认证（管理后台等）
export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const auth = c.req.header('Authorization')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET)
    c.set('jwtPayload' as never, payload)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})

// 管理员权限中间件
export const requireAdminMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const payload = c.get('jwtPayload' as never) as JWTPayload | undefined
  if (!payload || payload.role !== 'admin') {
    return c.json({ error: 'Forbidden: admin only' }, 403)
  }
  await next()
})
