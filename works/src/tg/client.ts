import { TelegramClient, WebCryptoProvider } from '@mtcute/web'
import { DOProxyTransport, patchEarlyTimer } from './do-proxy-transport'
import { KVStorage } from './kv-storage'
import type { Env } from '../types'
import type { Source } from '../db'

// CF Workers 原生支持 WASM 模块导入（import xxx from '*.wasm'），
// esbuild/wrangler 在构建时自动处理 WASM 文件。
// 参考：https://developers.cloudflare.com/workers/runtime-apis/webassembly/
import mtcuteWasmSimd from '../wasm/mtcute-simd.wasm'
import mtcuteWasm from '../wasm/mtcute.wasm'

// 运行时检测 SIMD 支持（与 @mtcute/wasm 的检测逻辑一致）
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

  const sessionKey = `session:${source.id}`
  const sessionStr = source.session_string || (await env.KV.get(sessionKey)) || undefined

  try {
    await patchEarlyTimer()
  } catch (e) {
    console.warn('[getTGClient] patchEarlyTimer failed (non-fatal):', e)
  }

  let client: TelegramClient | null = null
  let storage: KVStorage | null = null

  for (let attempt = 0; attempt < 2; attempt++) {
    storage = new KVStorage(env.KV, source.id)
    if (attempt === 0) {
      await storage.preload()
    }

    const wasmModule = getMtcuteWasmModule()
    const doProxyTransport = new DOProxyTransport(env)

    client = new TelegramClient({
      apiId: Number(source.api_id),
      apiHash: source.api_hash,
      storage,
      crypto: new WebCryptoProvider({ wasmInput: wasmModule }),
      transport: doProxyTransport,
      disableUpdates: true,
      connectionCount: (kind) => kind === 'main' ? 1 : 0,
    })

    try {
      await client.start({ session: sessionStr })
      const exported = await client.exportSession()
      if (exported) await env.KV.put(sessionKey, exported as string)
      return client
    } catch (e: any) {
      if (attempt === 0 && e?.message?.includes('AUTH_BYTES_INVALID')) {
        console.warn('[getTGClient] AUTH_BYTES_INVALID: clearing and retrying')
        await storage.deleteAllAuthKeys()
        await client.destroy().catch(() => {})
        client = null
        continue
      }
      throw e
    }
  }

  throw new Error('getTGClient: unreachable')
}
