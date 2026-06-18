/**
 * SessionGenDO — 在 Durable Object 中管理 Telegram 登录状态机
 *
 * 流程：
 *   POST /start      {phone, api_id, api_hash}  → 发送验证码，后台异步挂起等待
 *   POST /code       {code}                      → 注入验证码
 *   POST /password   {password}                  → 注入两步验证密码（如有）
 *   GET  /result                                 → 查询状态 / 获取 session string
 */

import { TelegramClient, WebCryptoProvider } from '@mtcute/web'
import { DOProxyTransport, patchEarlyTimer } from './do-proxy-transport'
import { KVStorage } from './kv-storage'
import type { Env } from '../types'
import mtcuteWasmSimd from '../wasm/mtcute-simd.wasm'
import mtcuteWasm from '../wasm/mtcute.wasm'

const SIMD_AVAILABLE = WebAssembly.validate(new Uint8Array(
  [0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]
))

type AuthState = 'idle' | 'waiting_code' | 'waiting_password' | 'done' | 'error'

export class SessionGenDO {
  private _doState: DurableObjectState
  private _env: Env
  private _authState: AuthState = 'idle'
  private _session?: string
  private _error?: string
  private _userInfo?: { id: string; username?: string; displayName?: string }
  private _resolveCode?: (code: string) => void
  private _resolvePassword?: (password: string) => void

  constructor(state: DurableObjectState, env: Env) {
    this._doState = state
    this._env = env
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/^\/+/, '')

    if (req.method === 'POST' && path === 'start') return this._handleStart(req)
    if (req.method === 'POST' && path === 'code') return this._handleCode(req)
    if (req.method === 'POST' && path === 'password') return this._handlePassword(req)
    if (req.method === 'GET' && path === 'result') return this._handleResult()
    return new Response('Not found', { status: 404 })
  }

  private async _handleStart(req: Request): Promise<Response> {
    if (this._authState !== 'idle') {
      return Response.json({ error: `Already started, state: ${this._authState}` }, { status: 400 })
    }
    const body = await req.json<{ phone?: string; api_id?: string; api_hash?: string }>()
    if (!body.phone || !body.api_id || !body.api_hash) {
      return Response.json({ error: 'Missing phone, api_id or api_hash' }, { status: 400 })
    }
    this._authState = 'waiting_code'
    const p = this._runAuth(body.phone, body.api_id, body.api_hash).catch(e => {
      this._authState = 'error'
      this._error = e?.message ?? String(e)
    })
    this._doState.waitUntil(p)
    return Response.json({ ok: true })
  }

  private async _handleCode(req: Request): Promise<Response> {
    if (this._authState !== 'waiting_code') {
      return Response.json({ error: `Not waiting for code, state: ${this._authState}` }, { status: 400 })
    }
    const { code } = await req.json<{ code?: string }>()
    if (!code) return Response.json({ error: 'Missing code' }, { status: 400 })
    this._resolveCode?.(code)
    return Response.json({ ok: true })
  }

  private async _handlePassword(req: Request): Promise<Response> {
    if (this._authState !== 'waiting_password') {
      return Response.json({ error: `Not waiting for password, state: ${this._authState}` }, { status: 400 })
    }
    const { password } = await req.json<{ password?: string }>()
    if (!password) return Response.json({ error: 'Missing password' }, { status: 400 })
    this._resolvePassword?.(password)
    return Response.json({ ok: true })
  }

  private _handleResult(): Response {
    return Response.json({
      state: this._authState,
      session: this._session,
      user: this._userInfo,
      error: this._error,
    })
  }

  private async _runAuth(phone: string, api_id: string, api_hash: string): Promise<void> {
    await patchEarlyTimer().catch(() => {})

    const storage = new KVStorage(this._env.KV, -1) // -1 = 临时 session gen 专用
    await storage.preload()

    const client = new TelegramClient({
      apiId: Number(api_id),
      apiHash: api_hash,
      storage,
      crypto: new WebCryptoProvider({ wasmInput: SIMD_AVAILABLE ? mtcuteWasmSimd : mtcuteWasm }),
      transport: new DOProxyTransport(this._env),
      disableUpdates: true,
    })

    try {
      const user = await client.start({
        phone: async () => phone,
        code: () => new Promise<string>(resolve => { this._resolveCode = resolve }),
        password: () => {
          this._authState = 'waiting_password'
          return new Promise<string>(resolve => { this._resolvePassword = resolve })
        },
      })
      this._session = (await client.exportSession()) ?? undefined
      this._userInfo = {
        id: String(user.id),
        username: user.username ?? undefined,
        displayName: user.displayName,
      }
      this._authState = 'done'
    } finally {
      await client.destroy().catch(() => {})
    }
  }
}
