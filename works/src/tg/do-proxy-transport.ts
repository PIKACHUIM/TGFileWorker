/**
 * DO Proxy Transport — 自定义 TelegramTransport 实现
 *
 * Cloudflare Workers 不支持直接创建出站 WebSocket 连接（new WebSocket()），
 * 因此通过 Durable Object WebSocket 代理建立到 Telegram 的 MTProto 连接。
 *
 * 此 transport 实现了 TelegramTransport 接口，
 * 关键是提供了 packetCodec() 方法（返回 ObfuscatedPacketCodec），
 * 以及 connect() 方法（返回实现了 IConnection 的包装器）。
 *
 * 流程：client → DO WebSocket Proxy → Telegram MTProto Server
 *
 * DOProxyConnection 参照 @fuman/net 的 WebSocketConnection 实现，
 * 使用 ConditionVariable 进行异步等待，而非简单的 Promise 阻塞，
 * 以避免 @mtcute/core 内部事件循环中的无限递归问题。
 */

import {
  ObfuscatedPacketCodec,
  IntermediatePacketCodec,
} from '@mtcute/web'
import type {
  ITelegramConnection,
  TelegramTransport,
  IPacketCodec,
} from '@mtcute/core'
import type {
  BasicDcOption,
  ICryptoProvider,
  Logger,
} from '@mtcute/core/utils.js'
import type { WebSocket as CFWebSocket } from '@cloudflare/workers-types'
import type { Env } from '../types'
import { createWSProxyConnection } from '../ws-proxy'

// ===== ConditionVariable（与 @fuman/utils 一致） =====
// 使用 ConditionVariable 而非简单的 Promise 阻塞，
// 确保 read() 在等待数据时正确让出控制权，避免忙轮询。
class ConditionVariable {
  #notify: (() => void) | undefined
  #promise: Promise<void> | undefined

  wait(): Promise<void> {
    if (this.#promise) {
      return this.#promise
    }
    return this.#promise = new Promise<void>((resolve) => {
      this.#notify = resolve
    })
  }

  notify(): void {
    this.#notify?.()
    this.#notify = undefined
    this.#promise = undefined
  }
}

// ===== ConnectionClosedError =====
class ConnectionClosedError extends Error {
  constructor(message = 'Connection closed') {
    super(message)
    this.name = 'ConnectionClosedError'
  }
}

/**
 * 将已有的 CF Workers WebSocket 包装为 ITelegramConnection 接口。
 *
 * 参照 @fuman/net 的 WebSocketConnection 实现：
 * - 使用 ConditionVariable 进行异步等待
 * - 使用 Uint8Array 缓冲区管理接收的数据
 * - 正确处理 close/error 事件
 */
class DOProxyConnection implements ITelegramConnection {
  private _ws: CFWebSocket
  private _buffer = new Uint8Array(0)
  private _bufferOffset = 0
  private _error: Error | null = null
  private _cv = new ConditionVariable()

  constructor(ws: CFWebSocket) {
    this._ws = ws

    // 监听 WebSocket 消息事件，将数据推入缓冲区
    this._ws.addEventListener('message', (event: MessageEvent) => {
      const data =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data instanceof Uint8Array
            ? event.data
            : new Uint8Array(event.data as ArrayBuffer)

      this.appendBuffer(data)
      // 通知等待中的 read() 有新数据到达
      this._cv.notify()
    })

    this._ws.addEventListener('close', (event: CloseEvent) => {
      if (this._error) return
      this._error = new ConnectionClosedError(`code ${event.code} (${event.reason})`)
      this._cv.notify()
    })

    this._ws.addEventListener('error', () => {
      if (this._error) return
      this._error = new ConnectionClosedError('WebSocket error')
      this._cv.notify()
    })
  }

  private appendBuffer(data: Uint8Array): void {
    const remaining = this._buffer.length - this._bufferOffset
    const newBuffer = new Uint8Array(remaining + data.length)
    newBuffer.set(this._buffer.subarray(this._bufferOffset), 0)
    newBuffer.set(data, remaining)
    this._buffer = newBuffer
    this._bufferOffset = 0
  }

  get remoteAddress(): string | null {
    return null
  }

  get localAddress(): never {
    throw new Error('Not available')
  }

  async read(into: Uint8Array): Promise<number> {
    // 循环等待，直到缓冲区有数据或连接已关闭
    while (true) {
      // 先从缓冲区读取
      const available = this._buffer.length - this._bufferOffset
      if (available > 0) {
        const toCopy = Math.min(available, into.length)
        into.set(this._buffer.subarray(this._bufferOffset, this._bufferOffset + toCopy), 0)
        this._bufferOffset += toCopy
        // 如果缓冲区已全部读取，释放内存
        if (this._bufferOffset >= this._buffer.length) {
          this._buffer = new Uint8Array(0)
          this._bufferOffset = 0
        }
        return toCopy
      }

      // 检查是否关闭
      if (this._error !== null) {
        throw this._error
      }

      // 等待新数据到达（使用 ConditionVariable 正确让出控制权）
      await this._cv.wait()

      // 被唤醒后再次检查缓冲区（循环回到顶部）
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this._error) throw this._error
    if (!bytes.length) return
    this._ws.send(bytes)
  }

  close(): void {
    if (!this._error) {
      this._error = new ConnectionClosedError('closed')
    }
    this._cv.notify()
    try {
      this._ws.close()
    } catch {
      // ignore
    }
  }
}

/**
 * 通过 DO WebSocket 代理连接 Telegram 的 Transport
 *
 * 与原版不同，此 Transport 会在每次 connect() 调用时，
 * 根据 DC 参数动态创建新的 WebSocket 代理连接到对应的数据中心。
 *
 * 这是必要的，因为 mtcute 在连接/重连时会指定目标 DC（如 DC5=flora），
 * 如果忽略 DC 参数始终复用同一条 WebSocket 连接（可能连到错误的 DC），
 * 会导致 MTProto transport error 404。
 *
 * DC → 子域名映射（与 @mtcute/web 的 WebSocketTransport 一致）：
 *   1 → pluto, 2 → venus, 3 → aurora, 4 → vesta, 5 → flora
 *
 * 用法：
 *   const transport = new DOProxyTransport(env)
 *   const client = new TelegramClient({ transport, ... })
 *   // transport.connect(dc) 会自动建立到对应 DC 的 WS 代理连接
 */
const DC_SUBDOMAINS: Record<number, string> = {
  1: 'pluto',
  2: 'venus',
  3: 'aurora',
  4: 'vesta',
  5: 'flora',
}

export class DOProxyTransport implements TelegramTransport {
  private _env: Env
  private _crypto?: ICryptoProvider
  private _log?: Logger

  constructor(env: Env) {
    this._env = env
  }

  setup(crypto: ICryptoProvider, log: Logger): void {
    this._crypto = crypto
    this._log = log
  }

  async connect(dc: BasicDcOption): Promise<ITelegramConnection> {
    const subdomain = DC_SUBDOMAINS[dc.id]
    if (!subdomain) {
      throw new Error(`Unknown DC id: ${dc.id}, cannot determine WebSocket host`)
    }
    const targetHost = `${subdomain}.web.telegram.org`
    const targetPath = dc.testMode ? 'apiws_test' : 'apiws'

    this._log?.debug('connecting to %s/%s (DC %d)', targetHost, targetPath, dc.id)

    const { clientWs } = await createWSProxyConnection(this._env, targetHost, targetPath)
    return new DOProxyConnection(clientWs)
  }

  packetCodec(_dc: BasicDcOption): IPacketCodec {
    // 与 @mtcute/web 的 WebSocketTransport 保持一致：
    // 使用 ObfuscatedPacketCodec 包装 IntermediatePacketCodec
    return new ObfuscatedPacketCodec(new IntermediatePacketCodec())
  }
}

// ===== EarlyTimer 无限递归修复 =====
// @mtcute/core 的 EarlyTimer.emitBefore() 在时间已过期时同步调用 _handler()，
// 而 SessionConnection._flush() 结尾又调用 emitBefore()，形成无限递归导致栈溢出。
// 修复：monkey-patch emitBefore，使其在时间过期时使用 setTimeout 异步调用，打破递归链。
let _earlyTimerPatched = false

export async function patchEarlyTimer(): Promise<void> {
  if (_earlyTimerPatched) return
  _earlyTimerPatched = true

  try {
    // @mtcute/core 的 package.json exports 包含 "./utils.js" 子路径，
    // 该文件导出了 EarlyTimer 类。
    // 注意：不能使用 "@mtcute/core/utils/early-timer.js"（不在 exports 中）。
    const mod = await import('@mtcute/core/utils.js')
    const EarlyTimer = mod.EarlyTimer
    if (!EarlyTimer) {
      console.warn('[PatchEarlyTimer] EarlyTimer not found in @mtcute/core/utils.js, skipping patch')
      return
    }

    const originalEmitBefore = EarlyTimer.prototype.emitBefore
    EarlyTimer.prototype.emitBefore = function (ts: number) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any
      if (!self._timeoutTs || ts < self._timeoutTs) {
        this.reset()
        const diff = ts - performance.now()
        if (diff > 0) {
          self._timeout = setTimeout(this.emitNow, diff)
          self._timeoutTs = ts
        } else {
          // 原始实现同步调用 this._handler()，导致 _flush → emitBefore → _handler → _flush 无限递归
          // 改为 setTimeout(0) 异步调度，让调用栈先展开，打破递归链
          self._timeout = setTimeout(this.emitNow, 0)
          self._timeoutTs = ts
        }
      }
    }

    console.log('[PatchEarlyTimer] EarlyTimer.emitBefore patched successfully')
  } catch (e) {
    console.warn('[PatchEarlyTimer] Failed to patch EarlyTimer (non-fatal):', e)
    // 即使补丁失败，客户端仍可工作——只是可能在某些边界情况下遇到栈溢出。
    // 这是非致命错误，不影响基本功能。
  }
}
