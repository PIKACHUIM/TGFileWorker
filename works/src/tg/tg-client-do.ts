import type { Env } from '../types'
import type { Source } from '../db'
import { getTGClient } from './client'
import type { TelegramClient } from '@mtcute/web'

interface StreamRequest {
  source: Source
  messageId: number
  channelId: string
  start: number
  end: number
}

interface FileInfo {
  fileLocation: object
  dcId: number
}

export class TGClientDO {
  private _client: TelegramClient | null = null
  private _initPromise: Promise<TelegramClient> | null = null
  private _fileCache = new Map<number, FileInfo>()

  // Flood wait tracking: return 429 on next request if still waiting
  private _floodWaitUntil = 0

  private _remainingFloodWait(): number {
    return Math.max(0, Math.ceil((this._floodWaitUntil - Date.now()) / 1000))
  }

  private _recordFloodWait(e: any): void {
    if (e?.code !== 420) return
    const seconds: number = e.seconds || parseInt(String(e?.text || '').match(/_(\d+)$/)?.[1] ?? '0') || 0
    if (seconds > 0) this._floodWaitUntil = Date.now() + seconds * 1000
  }

  // Semaphore: max 2 concurrent upload.getFile loops to avoid flood wait
  private _slots = 2
  private _waitQueue: Array<() => void> = []

  constructor(private state: DurableObjectState, private env: Env) {}

  private _ensureClient(source: Source): Promise<TelegramClient> {
    if (this._client) return Promise.resolve(this._client)
    if (this._initPromise) return this._initPromise
    this._initPromise = getTGClient(this.env, source)
      .then(c => {
        this._client = c
        // 监听 mtcute 内部连接错误，防止死连接残留
        ;(c as any).onError.add((err: Error) => {
          console.error('[TGClientDO] client error, resetting:', err.message)
          this._resetClient(c)
        })
        return c
      })
      .catch(e => { this._initPromise = null; throw e })
    return this._initPromise
  }

  private _resetClient(c: TelegramClient) {
    if (this._client === c) { this._client = null; this._initPromise = null }
    c.destroy().catch(() => {})
  }

  private _acquire(): Promise<void> {
    if (this._slots > 0) { this._slots--; return Promise.resolve() }
    return new Promise(r => this._waitQueue.push(r))
  }

  private _release() {
    const next = this._waitQueue.shift()
    if (next) next()
    else this._slots++
  }

  private async _getFileInfo(client: TelegramClient, messageId: number, channelId: string): Promise<FileInfo> {
    if (this._fileCache.has(messageId)) return this._fileCache.get(messageId)!

    const channelIdStr = String(channelId)
    const bareId = channelIdStr.startsWith('-100')
      ? Number(channelIdStr.slice(4))
      : channelIdStr.startsWith('-') ? Number(channelIdStr.slice(1)) : Number(channelIdStr)

    const chResult = await client.call({
      _: 'channels.getChannels',
      id: [{ _: 'inputChannel', channelId: bareId, accessHash: 0n }],
    } as any)
    const accessHash = (chResult as any).chats?.[0]?.accessHash
    if (!accessHash) throw new Error('Cannot get accessHash')

    const rawMsgs = await client.call({
      _: 'channels.getMessages',
      channel: { _: 'inputChannel', channelId: bareId, accessHash },
      id: [{ _: 'inputMessageID', id: messageId }],
    } as any)
    const msg = (rawMsgs as any).messages?.[0]
    if (!msg || msg._ === 'messageEmpty') throw new Error('Message not found')

    const doc = (msg as any).media?.document ?? (msg as any).media?.photo
    if (!doc) throw new Error('No document in media')

    const fileLocation = doc._ === 'document'
      ? { _: 'inputDocumentFileLocation', id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' }
      : { _: 'inputPhotoFileLocation', id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: 'y' }
    const dcId: number = doc.dcId ?? await client.getPrimaryDcId()

    const info: FileInfo = { fileLocation, dcId }
    this._fileCache.set(messageId, info)
    return info
  }

  async fetch(req: Request): Promise<Response> {
    const { source, messageId, channelId, start, end }: StreamRequest = await req.json()

    // Return 429 immediately if still in flood wait period
    const fw = this._remainingFloodWait()
    if (fw > 0) {
      return Response.json(
        { error: 'FLOOD_WAIT', waitSeconds: fw, message: `Telegram API 限流，请等待 ${fw} 秒后重试` },
        { status: 429, headers: { 'Retry-After': String(fw) } },
      )
    }

    let client: TelegramClient
    try {
      client = await this._ensureClient(source)
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500 })
    }

    let fileInfo: FileInfo
    try {
      fileInfo = await this._getFileInfo(client, messageId, channelId)
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: e.message === 'Message not found' ? 404 : 500 })
    }

    const { fileLocation, dcId } = fileInfo
    const CHUNK = 512 * 1024
    const contentLength = end - start + 1
    const alignedStart = Math.floor(start / CHUNK) * CHUNK
    const skipBytes = start - alignedStart

    const { readable, writable } = new TransformStream<Uint8Array>()
    const writer = writable.getWriter()

    ;(async () => {
      await this._acquire()
      try {
        let offset = alignedStart, downloaded = 0, skipped = 0
        while (downloaded < contentLength) {
          const result = await client.call({
            _: 'upload.getFile', location: fileLocation, offset, limit: CHUNK, precise: true,
          } as any, { kind: 'main', dcId } as any)
          if ((result as any)._ !== 'upload.file') break
          let data: Uint8Array = (result as any).bytes
          offset += data.length
          if (skipped < skipBytes) {
            const n = Math.min(skipBytes - skipped, data.length)
            data = data.subarray(n); skipped += n
          }
          if (data.length > 0) {
            const rem = contentLength - downloaded
            const chunk = data.length > rem ? data.subarray(0, rem) : data
            await writer.write(chunk); downloaded += chunk.length
          }
          if ((result as any).bytes.length < CHUNK) break
        }
      } catch (e) {
        this._recordFloodWait(e)
        this._resetClient(client)
        console.error('[TGClientDO] stream error:', e)
      } finally {
        this._release()
        writer.close()
      }
    })()

    return new Response(readable, {
      headers: { 'Content-Length': String(contentLength), 'Content-Type': 'application/octet-stream' },
    })
  }
}
