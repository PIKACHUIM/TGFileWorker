import { TelegramClient, WebCryptoProvider, WebSocketTransport } from '@mtcute/web'
import { patchEarlyTimer } from './do-proxy-transport'
import { KVStorage } from './kv-storage'
import type { Env } from '../types'
import type { Source } from '../db'

import mtcuteWasmSimd from '../wasm/mtcute-simd.wasm'
import mtcuteWasm from '../wasm/mtcute.wasm'

const SIMD_AVAILABLE = /* @__PURE__ */ WebAssembly.validate(new Uint8Array(
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]
))

function getMtcuteWasmModule(): WebAssembly.Module {
  if (SIMD_AVAILABLE) {
    console.log('[WASM] Using SIMD WASM module')
    return mtcuteWasmSimd
  }
  console.log('[WASM] SIMD not available, using standard WASM module')
  return mtcuteWasm
}

/**
 * 创建并连接 MTcute TelegramClient。
 * CF Workers 不支持 new WebSocket() 出站连接，
 * 因此通过 Durable Object WebSocket 代理建立到 Telegram 的 MTProto 连接。
 *
 * 流程：client → DO WebSocket Proxy → Telegram MTProto Server
 */
export async function getTGClient(env: Env, source: Source): Promise<TelegramClient> {
  if (!source.api_id || !source.api_hash) {
    throw new Error('该来源未配置 api_id / api_hash')
  }
  return _connect(env, source)
}

async function _connect(env: Env, source: Source): Promise<TelegramClient> {
  const sessionKey = `session:${source.id}`
  const sessionStr = source.session_string || (await env.KV.get(sessionKey)) || undefined

  try { await patchEarlyTimer() } catch {}

  const storage = new KVStorage(env.KV, source.id)
  // No preload: stale DC keys from a previous session cause AUTH_BYTES_INVALID
  // when the new client tries to export auth to a different DC. Fresh auth per request.

  const client = new TelegramClient({
    apiId: Number(source.api_id),
    apiHash: source.api_hash!,
    storage,
    crypto: new WebCryptoProvider({ wasmInput: getMtcuteWasmModule() }),
    transport: new WebSocketTransport(),
    disableUpdates: true,
  })

  try {
    await client.start({ session: sessionStr })
    const exported = await client.exportSession()
    if (exported) await env.KV.put(sessionKey, exported as string)
    return client
  } catch (e: any) {
    await client.destroy().catch(() => {})
    if (String(e?.message).includes('AUTH_BYTES_INVALID')) {
      await storage.deleteAllAuthKeys()
      console.warn('[TGClient] AUTH_BYTES_INVALID — cleared stale auth keys')
    }
    throw e
  }
}
