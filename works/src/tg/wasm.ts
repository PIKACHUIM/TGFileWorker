// src/tg/wasm.ts
// Cloudflare Workers 原生支持 WASM 模块导入
// 使用静态 import 语法，esbuild/wrangler 会在构建时处理 WASM 文件
// 参考：https://developers.cloudflare.com/workers/runtime-apis/webassembly/
//
// 问题背景：@mtcute/wasm 的 getWasmUrl() 使用 new URL("./mtcute-simd.wasm", import.meta.url)
// 构建 WASM 文件 URL，但 CF Workers 中 import.meta.url 的值不适合构建文件 URL，
// 导致 TypeError: Invalid URL string。
//
// 注意：WASM 文件必须使用项目内的相对路径导入，不能使用 @mtcute/wasm/xxx.wasm，
// 因为 pnpm 的 symlink 结构会导致 wrangler 的 esbuild 插件将包路径解析到
// src/tg/@mtcute/wasm/ 而非 node_modules/，从而报 ENOENT 错误。
// 因此将 WASM 文件复制到 src/wasm/ 目录下使用相对路径导入。

// 从项目本地路径导入 WASM 文件（esbuild/wrangler 会在构建时处理）
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
export function getMtcuteWasmModule(): WebAssembly.Module {
  if (SIMD_AVAILABLE) {
    console.log('[WASM] Using SIMD WASM module')
    return mtcuteWasmSimd
  }
  console.log('[WASM] SIMD not available, using standard WASM module')
  return mtcuteWasm
}
