/**
 * WebSocket Proxy Durable Object
 * 
 * 基于 TG-WS-API (https://github.com/CloudflareHackers/TG-WS-API) 的设计模式，
 * 使用 Durable Objects 在 Cloudflare Workers 中建立持久的 WebSocket 连接。
 * 
 * Cloudflare Workers 不支持直接创建出站 WebSocket 连接（new WebSocket()），
 * 因此使用 Durable Object 的 fetch + Upgrade 机制来代理 WebSocket 连接。
 * 
 * 用法：
 *   wss://<worker-domain>/ws/<telegram-host>/<path>
 *   wss://<worker-domain>/ws/pluto.web.telegram.org/apiws
 *   wss://<worker-domain>/ws/pluto.web.telegram.org/apiws?locationHint=enam
 */

import type { Env } from './types'

// ===== Telegram DC → CF Location Hint Mapping =====
const DC_LOCATION_MAP: Record<string, string> = {
  'zws1': 'enam',      // DC1 → Eastern North America (Miami)
  'zws1-1': 'enam',
  'zws2': 'weur',      // DC2 → Western Europe (Amsterdam)
  'zws2-1': 'weur',
  'zws3': 'enam',      // DC3 → Eastern North America (Miami)
  'zws3-1': 'enam',
  'zws4': 'weur',      // DC4 → Western Europe (Amsterdam)
  'zws4-1': 'weur',
  'zws5': 'apac',      // DC5 → Asia Pacific (Singapore)
  'zws5-1': 'apac',
  'pluto': 'enam',     // DC1 aliases
  'venus': 'weur',     // DC2 aliases
  'aurora': 'enam',    // DC3 aliases
  'vesta': 'weur',     // DC4 aliases
  'flora': 'apac',     // DC5 aliases
}

// Valid CF location hints
const VALID_HINTS = new Set([
  'wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me',
])

/**
 * 根据 Telegram 主机名确定最佳 CF 位置提示
 */
function getLocationHint(targetHost: string, manualHint?: string): string | undefined {
  if (manualHint && VALID_HINTS.has(manualHint.toLowerCase())) {
    return manualHint.toLowerCase()
  }

  const dcPrefix = targetHost.split('.')[0].toLowerCase()
  if (DC_LOCATION_MAP[dcPrefix]) return DC_LOCATION_MAP[dcPrefix]

  const basePrefix = dcPrefix.replace(/-\d+$/, '')
  if (DC_LOCATION_MAP[basePrefix]) return DC_LOCATION_MAP[basePrefix]

  return undefined
}

// 允许的 Telegram 域名
const ALLOWED_TELEGRAM_DOMAIN = /^[a-z0-9\-]+\.(?:web\.)?telegram\.org$/i

export class WebSocketProxy {
  private state: DurableObjectState
  private env: Env
  private clientWs: WebSocket | null = null
  private upstreamWs: WebSocket | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    console.log('[WS-Proxy] DO fetch received, request.url:', request.url)
    const targetHost = url.searchParams.get('targetHost')
    const targetPath = url.searchParams.get('targetPath') || 'apiws'
    console.log('[WS-Proxy] targetHost:', targetHost, 'targetPath:', targetPath)

    if (!targetHost) {
      console.error('[WS-Proxy] Missing targetHost')
      return new Response('Missing targetHost', { status: 400 })
    }

    // 验证 Telegram 域名
    if (!ALLOWED_TELEGRAM_DOMAIN.test(targetHost)) {
      console.error('[WS-Proxy] Forbidden domain:', targetHost)
      return new Response('Forbidden: not a Telegram domain', { status: 403 })
    }

    // WebSocket 升级
    const upgradeHeader = request.headers.get('Upgrade')
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      console.error('[WS-Proxy] Expected WebSocket, got Upgrade:', upgradeHeader)
      return new Response('Expected WebSocket', { status: 426 })
    }

    // 创建 WebSocket 对
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // 接受客户端连接
    server.accept()
    this.clientWs = server

    // 连接到 Telegram 上游
    // CF Workers 的 fetch() 不支持 wss:// URL，必须使用 https:// + Upgrade: websocket 头
    const upstreamUrl = `https://${targetHost}/${targetPath}`
    const manualHint = url.searchParams.get('_locationHint')
    const locationHint = getLocationHint(targetHost, manualHint ?? undefined)
    console.log('[WS-Proxy] Connecting to upstream:', upstreamUrl, 'locationHint:', locationHint, 'manualHint:', manualHint)

    try {
      // 使用 fetch + Upgrade 方式发起出站 WebSocket（CF Workers 支持）
      console.log('[WS-Proxy] Fetching upstream URL:', upstreamUrl)
      const upstreamResp = await fetch(upstreamUrl, {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Protocol': 'binary',
          'Origin': `https://${targetHost}`,
          'Host': targetHost,
        },
      })
      console.log('[WS-Proxy] Upstream response status:', upstreamResp.status, 'hasWebSocket:', !!upstreamResp.webSocket)

      if (!upstreamResp.webSocket) {
        server.send(JSON.stringify({
          error: 'upstream_failed',
          status: upstreamResp.status,
        }))
        server.close(1011, `Upstream returned ${upstreamResp.status}`)
        return new Response(null, { status: 101, webSocket: client })
      }

      const upstream = upstreamResp.webSocket
      upstream.accept()
      this.upstreamWs = upstream

      // 上游 → 客户端
      upstream.addEventListener('message', (event) => {
        try {
          server.send(event.data)
        } catch {
          try { upstream.close(1000, 'client gone') } catch {}
        }
      })

      upstream.addEventListener('close', (event) => {
        try {
          server.close(event.code || 1000, event.reason || 'upstream closed')
        } catch {}
      })

      upstream.addEventListener('error', () => {
        try { server.close(1011, 'upstream error') } catch {}
      })

      // 客户端 → 上游
      server.addEventListener('message', (event) => {
        try {
          upstream.send(event.data)
        } catch {
          try { server.close(1011, 'upstream gone') } catch {}
        }
      })

      server.addEventListener('close', (event) => {
        try {
          upstream.close(event.code || 1000, event.reason || 'client closed')
        } catch {}
      })

      server.addEventListener('error', () => {
        try { upstream.close(1011, 'client error') } catch {}
      })

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[WS-Proxy] Upstream connection failed:', msg, err instanceof Error ? err.stack : '')
      server.send(JSON.stringify({ error: 'connection_failed', message: msg }))
      server.close(1011, msg)
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }
}

// 帮助函数：通过 DO 建立 WebSocket 代理连接到 Telegram
export async function createWSProxyConnection(
  env: Env,
  targetHost: string,
  targetPath: string = 'apiws',
  locationHint?: string,
): Promise<{ clientWs: WebSocket; close: () => void }> {
  console.log('[WS-Proxy] createWSProxyConnection called, targetHost:', targetHost, 'targetPath:', targetPath, 'locationHint:', locationHint)

  // 创建 DO 实例（可选管辖区域）
  const id = locationHint && VALID_HINTS.has(locationHint.toLowerCase())
    ? env.WS_PROXY.newUniqueId({ jurisdiction: locationHint.toLowerCase() as DurableObjectJurisdiction })
    : env.WS_PROXY.newUniqueId()
  const stub = env.WS_PROXY.get(id)

  // 构建 DO 请求 URL
  const doUrl = new URL('https://dummy/ws')
  doUrl.searchParams.set('targetHost', targetHost)
  doUrl.searchParams.set('targetPath', targetPath)
  if (locationHint) {
    doUrl.searchParams.set('_locationHint', locationHint)
  }
  console.log('[WS-Proxy] DO request URL:', doUrl.toString())

  // 发起 WebSocket 升级请求到 DO
  const requestUrl = doUrl.toString()
  console.log('[WS-Proxy] Fetching DO stub with URL:', requestUrl)
  const resp = await stub.fetch(new Request(requestUrl, {
    headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
  }))
  console.log('[WS-Proxy] DO stub response status:', resp.status, 'hasWebSocket:', !!resp.webSocket)

  if (resp.status !== 101 || !resp.webSocket) {
    throw new Error(`WebSocket proxy connection failed: ${resp.status}`)
  }

  const clientWs = resp.webSocket
  clientWs.accept()

  return {
    clientWs,
    close: () => {
      try { clientWs.close(1000, 'done') } catch {}
    },
  }
}
