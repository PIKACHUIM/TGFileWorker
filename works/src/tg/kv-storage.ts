/**
 * KV-backed MTProto Auth Key Storage
 *
 * MemoryStorage 在每次请求中都是全新的，导致 auth key 丢失，
 * 每次都要重新与 Telegram 握手协商密钥，并发时被 Telegram 拒绝（1011 upstream error）。
 *
 * 此实现将永久 auth key（每 DC 一个）持久化到 CF Workers KV，
 * 下次请求直接复用，避免重复握手。
 */

import { MemoryStorage } from '@mtcute/core'
import type { KVNamespace } from '@cloudflare/workers-types'

function encodeKey(key: Uint8Array): string {
  return btoa(String.fromCharCode(...key))
}

function decodeKey(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

class KVAuthKeysRepository {
  private _mem = new Map<number, Uint8Array>()
  // temp keys are short-lived; losing them on restart just re-negotiates them (cheap)
  private _tempMem = new Map<string, { key: Uint8Array; expires: number }>()

  constructor(private _kv: KVNamespace, private _prefix: string) {}

  async loadFromKV(): Promise<void> {
    const list = await this._kv.list({ prefix: `${this._prefix}:ak:` })
    await Promise.all(list.keys.map(async ({ name }) => {
      const val = await this._kv.get(name)
      if (!val) return
      const dc = Number(name.slice(`${this._prefix}:ak:`.length))
      if (Number.isFinite(dc)) {
        this._mem.set(dc, decodeKey(val))
        console.log(`[KVStorage] Loaded auth key for DC${dc}`)
      }
    }))
  }

  async set(dc: number, key: Uint8Array | null): Promise<void> {
    const existing = this._mem.get(dc)

    // 值未变化，不写入 KV
    if (key && existing && key.length === existing.length) {
      let same = true
      for (let i = 0; i < key.length; i++) {
        if (key[i] !== existing[i]) {
          same = false
          break
        }
      }
      if (same) return
    }

    if (key) {
      this._mem.set(dc, key)
      await this._kv.put(`${this._prefix}:ak:${dc}`, encodeKey(key))
      console.log(`[KVStorage] Saved auth key for DC${dc}`)
    } else {
      this._mem.delete(dc)
      await this._kv.delete(`${this._prefix}:ak:${dc}`)
    }
  }

  get(dc: number): Uint8Array | null {
    return this._mem.get(dc) ?? null
  }

  setTemp(dc: number, idx: number, key: Uint8Array | null, expires: number): void {
    const k = `${dc}:${idx}`
    if (key) this._tempMem.set(k, { key, expires })
    else this._tempMem.delete(k)
  }

  getTemp(dc: number, idx: number, now: number): Uint8Array | null {
    const entry = this._tempMem.get(`${dc}:${idx}`)
    if (!entry || now > entry.expires) return null
    return entry.key
  }

  async deleteByDc(dc: number): Promise<void> {
    this._mem.delete(dc)
    await this._kv.delete(`${this._prefix}:ak:${dc}`)
    for (const k of this._tempMem.keys()) {
      if (k.startsWith(`${dc}:`)) this._tempMem.delete(k)
    }
  }

  async deleteAll(): Promise<void> {
    this._mem.clear()
    this._tempMem.clear()
    const list = await this._kv.list({ prefix: `${this._prefix}:ak:` })
    await Promise.all(list.keys.map(k => this._kv.delete(k.name)))
  }
}

export class KVStorage extends MemoryStorage {
  private _authKeysKV: KVAuthKeysRepository

  constructor(kv: KVNamespace, sourceId: number) {
    super()
    this._authKeysKV = new KVAuthKeysRepository(kv, `mtcute:${sourceId}`)
    // Replace in-memory authKeys with KV-backed implementation
    ;(this as any).authKeys = this._authKeysKV
  }

  /** Call before client.start() to pre-load persisted auth keys */
  async preload(): Promise<void> {
    await this._authKeysKV.loadFromKV()
  }

  /**
   * 清除所有已持久化的 auth keys（包括 KV 和内存）
   * 用于 AUTH_BYTES_INVALID 等认证错误时，强制重新协商密钥
   */
  async deleteAllAuthKeys(): Promise<void> {
    await this._authKeysKV.deleteAll()
    console.log('[KVStorage] All auth keys deleted')
  }
}
