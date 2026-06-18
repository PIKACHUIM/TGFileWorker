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

/**
 * 获取 mtcute WASM 模块（WebAssembly.Module）
 * CF Workers 运行在 V8 引擎上，支持 WASM SIMD，优先使用 SIMD 版本
 */
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
  // 优先用来源里手填的 session，否则从 KV 取上次保存的
  const sessionStr = source.session_string || (await env.KV.get(sessionKey)) || undefined

  // 修复 @mtcute/core EarlyTimer 无限递归导致栈溢出的问题
  try {
    await patchEarlyTimer()
  } catch (e) {
    console.warn('[getTGClient] patchEarlyTimer failed (non-fatal):', e)
  }

  let client: TelegramClient | null = null
  let storage: KVStorage | null = null

  // 最多重试一次：如果 AUTH_BYTES_INVALID，清除旧 auth keys 后重建客户端
  for (let attempt = 0; attempt < 2; attempt++) {
    storage = new KVStorage(env.KV, source.id)
    if (attempt === 0) {
      // 第一次尝试：加载 KV 中的 auth keys
      await storage.preload()
    }
    // 第二次尝试：不 preload，让 mtcute 从 session string 重新协商 auth keys

    const wasmModule = getMtcuteWasmModule()
    const doProxyTransport = new DOProxyTransport(env)

    client = new TelegramClient({
      apiId: Number(source.api_id),
      apiHash: source.api_hash,
      storage,
      crypto: new WebCryptoProvider({ wasmInput: wasmModule }),
      transport: doProxyTransport,
      disableUpdates: true,
      // 只保留 main pool（1条连接），禁用 upload/download/downloadSmall pool
      // 这些 pool 会并发打开额外 WebSocket，导致 Telegram 以 1011 拒绝
      connectionCount: (kind) => kind === 'main' ? 1 : 0,
    })

    try {
      await client.start({ session: sessionStr })

      // 保存最新 session 到 KV（供下次复用）
      const exported = await client.exportSession()
      if (exported) await env.KV.put(sessionKey, exported as string)

      return client
    } catch (e: any) {
      if (attempt === 0 && e?.message?.includes('AUTH_BYTES_INVALID')) {
        console.warn('[getTGClient] AUTH_BYTES_INVALID: auth key 与 session 不匹配，清除旧 auth keys 后重试')
        await storage.deleteAllAuthKeys()
        await client.destroy().catch(() => {})
        client = null
        continue
      }
      throw e
    }
  }

  // 不应该到这里，但 TypeScript 需要
  throw new Error('getTGClient: 不可达代码')
}
