import { Hono } from 'hono'
import { requireAuthOrGuestMiddleware } from '../middleware/auth'
import { getSetting, getSourceById } from '../db'
import type { MediaItem } from '../db'
import { computeFileHash, getShortHash, checkHash } from '../utils/hash'
// getSetting used in /strm route below
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()
// 使用访客认证中间件：有token放行，无token检查allow_guest设置
app.use('*', requireAuthOrGuestMiddleware)

// Worker 代理流（支持 Range），用于在线播放
// 验证方式：hash 参数 或 JWT token
app.get('/stream/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const item = await c.env.DB.prepare('SELECT * FROM media_items WHERE id = ?')
    .bind(id).first<MediaItem>()
  if (!item) return c.json({ error: 'Not found' }, 404)

  const source = await getSourceById(c.env.DB, item.source_id)
  if (!source) return c.json({ error: 'Source not found' }, 404)

  // hash 验证（与 Go 项目一致）
  const hashParam = c.req.query('hash')
  if (hashParam) {
    const expectedHash = await computeFileHash(item.file_name, item.file_size, item.mime_type || '', String(item.id))
    const hashLength = Number(c.env.HASH_LENGTH) || 6
    if (!checkHash(hashParam, expectedHash, hashLength)) {
      return c.json({ error: 'Invalid hash' }, 403)
    }
  }
  // 无 hash 时，由 requireAuthOrGuestMiddleware 保证已认证或为允许的访客

  const rangeHeader = c.req.header('Range')
  const fileSize = item.file_size

  // HEAD 请求只返回头信息，不需要建立 client 连接
  if (c.req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': item.mime_type || 'application/octet-stream',
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${encodeURIComponent(item.file_name)}"`,
      },
    })
  }

  // ===== 小文件（≤ 20MB）且有 bot_token：通过 Bot API 获取 =====
  if (source.bot_token && fileSize > 0 && fileSize <= 20 * 1024 * 1024) {
    const fileId = await getBotFileId(source.bot_token, item.message_id, source.channel_id)
    if (fileId) {
      const url = `https://api.telegram.org/file/bot${source.bot_token}/${fileId}`
      const upstream = await fetch(url, { headers: rangeHeader ? { Range: rangeHeader } : {} })
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': item.mime_type || 'application/octet-stream',
          'Content-Length': upstream.headers.get('Content-Length') || String(fileSize),
          'Accept-Ranges': 'bytes',
          ...(upstream.headers.get('Content-Range') ? { 'Content-Range': upstream.headers.get('Content-Range')! } : {}),
          'Content-Disposition': `inline; filename="${encodeURIComponent(item.file_name)}"`,
        },
      })
    }
  }

  let start = 0
  let end = fileSize - 1
  let status = 200

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    if (match) {
      start = parseInt(match[1])
      end = match[2] ? parseInt(match[2]) : fileSize - 1
      status = 206
    }
  }

  // 委托给持久化 DO，复用已有 TelegramClient 连接，避免每次握手
  const doId = c.env.TG_CLIENT.idFromName(`src:${source.id}`)
  const doStub = c.env.TG_CLIENT.get(doId)
  const contentLength = end - start + 1
  const doResp = await doStub.fetch(new Request('http://do/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, messageId: item.message_id, channelId: source.channel_id, start, end }),
  }))
  if (!doResp.ok) {
    const err = await doResp.json() as any
    return c.json(err, doResp.status as any)
  }
  return new Response(doResp.body, {
    status,
    headers: {
      'Content-Type': item.mime_type || 'application/octet-stream',
      'Content-Length': String(contentLength),
      'Content-Range': status === 206 ? `bytes ${start}-${end}/${fileSize}` : '',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${encodeURIComponent(item.file_name)}"`,
    },
  })
})

// 302 直链（TG CDN）
// 验证方式：hash 参数 或 JWT token
app.get('/direct/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const item = await c.env.DB.prepare('SELECT * FROM media_items WHERE id = ?')
    .bind(id).first<MediaItem>()
  if (!item) return c.json({ error: 'Not found' }, 404)

  const source = await getSourceById(c.env.DB, item.source_id)
  if (!source?.bot_token) return c.json({ error: '该来源未配置 bot_token，无法获取直链' }, 400)

  // hash 验证
  const hashParam = c.req.query('hash')
  if (hashParam) {
    const expectedHash = await computeFileHash(item.file_name, item.file_size, item.mime_type || '', String(item.id))
    const hashLength = Number(c.env.HASH_LENGTH) || 6
    if (!checkHash(hashParam, expectedHash, hashLength)) {
      return c.json({ error: 'Invalid hash' }, 403)
    }
  }
  // 无 hash 时，由 requireAuthOrGuestMiddleware 保证已认证或为允许的访客

  const fileId = await getBotFileId(source.bot_token, item.message_id, source.channel_id)
  if (!fileId) return c.json({ error: '获取直链失败' }, 500)

  return c.redirect(`https://api.telegram.org/file/bot${source.bot_token}/${fileId}`)
})

// 下载 .strm 文件
// 验证方式：hash 参数 或 JWT token
app.get('/strm/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const item = await c.env.DB.prepare('SELECT id, file_name, file_size, mime_type FROM media_items WHERE id = ?')
    .bind(id).first<{ id: number; file_name: string; file_size: number; mime_type: string | null }>()
  if (!item) return c.json({ error: 'Not found' }, 404)

  // hash 验证
  const hashParam = c.req.query('hash')
  if (hashParam) {
    const expectedHash = await computeFileHash(item.file_name, item.file_size, item.mime_type || '', String(item.id))
    const hashLength = Number(c.env.HASH_LENGTH) || 6
    if (!checkHash(hashParam, expectedHash, hashLength)) {
      return c.json({ error: 'Invalid hash' }, 403)
    }
  }
  // 无 hash 时，由 requireAuthOrGuestMiddleware 保证已认证或为允许的访客

  // 优先从设置读取 worker_url，回退到环境变量
  const workerUrl = (await getSetting(c.env.DB, 'worker_url')) || c.env.WORKER_URL || ''
  const baseUrl = workerUrl.replace(/\/$/, '')

  // 计算短 hash 用于 strm 内容中的 stream URL
  const fullHash = await computeFileHash(item.file_name, item.file_size, item.mime_type || '', String(item.id))
  const hashLength = Number(c.env.HASH_LENGTH) || 6
  const shortHash = getShortHash(fullHash, hashLength)

  const strmContent = `${baseUrl}/api/stream/${item.id}?hash=${shortHash}`
  const strmName = item.file_name.replace(/\.[^.]+$/, '') + '.strm'

  return new Response(strmContent, {
    headers: {
      'Content-Type': 'text/plain',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(strmName)}"`,
    },
  })
})

// 通过 Bot API 转发消息到 bot 自身以获取 file_id，再获取文件 path
async function getBotFileId(botToken: string, messageId: number, channelId: string): Promise<string | null> {
  try {
    // 先尝试直接通过 forwardMessage 转发到 bot 自身聊天
    const r = await fetch(`https://api.telegram.org/bot${botToken}/forwardMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, from_chat_id: channelId, message_id: messageId }),
    })
    const data = await r.json() as any
    const msg = data?.result
    const fileId = msg?.document?.file_id || msg?.video?.file_id || msg?.audio?.file_id || msg?.photo?.[msg.photo.length - 1]?.file_id
    if (!fileId) return null

    // 删除转发消息（避免污染频道）
    if (msg?.message_id) {
      await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: channelId, message_id: msg.message_id }),
      })
    }

    const fr = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)
    const fd = await fr.json() as any
    return fd?.result?.file_path ?? null
  } catch {
    return null
  }
}

export default app
