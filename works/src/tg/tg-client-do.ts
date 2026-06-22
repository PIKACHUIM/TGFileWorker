/**
 * TGClientDO — 持久化 TelegramClient 的 Durable Object
 *
 * 按 source 隔离（idFromName(`src:${source.id}`)），每个 source 持有一个长连接。
 * Worker 层不再直接创建 client，改为调用此 DO，消除每次请求的握手开销。
 */
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

export class TGClientDO {
  private _client: TelegramClient | null = null
  private _initPromise: Promise<TelegramClient> | null = null

  constructor(private state: DurableObjectState, private env: Env) {}

  private _ensureClient(source: Source): Promise<TelegramClient> {
    if (this._client) return Promise.resolve(this._client)
    if (this._initPromise) return this._initPromise
    this._initPromise = getTGClient(this.env, source)
      .then(c => { this._client = c; return c })
      .catch(e => { this._initPromise = null; throw e })
    return this._initPromise
  }

  private _resetClient(c: TelegramClient) {
    if (this._client === c) { this._client = null; this._initPromise = null }
    c.destroy().catch(() => {})
  }

  async fetch(req: Request): Promise<Response> {
    const { source, messageId, channelId, start, end }: StreamRequest = await req.json()

    let client: TelegramClient
    try {
      client = await this._ensureClient(source)
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500 })
    }

    try {
      const channelIdStr = String(channelId)
      const bareId = channelIdStr.startsWith('-100')
        ? Number(channelIdStr.slice(4))
        : channelIdStr.startsWith('-') ? Number(channelIdStr.slice(1)) : Number(channelIdStr)

      const chResult = await client.call({
        _: 'channels.getChannels',
        id: [{ _: 'inputChannel', channelId: bareId, accessHash: 0n }],
      } as any)
      const accessHash = (chResult as any).chats?.[0]?.accessHash
      if (!accessHash) return Response.json({ error: 'Cannot get accessHash' }, { status: 500 })

      const rawMsgs = await client.call({
        _: 'channels.getMessages',
        channel: { _: 'inputChannel', channelId: bareId, accessHash },
        id: [{ _: 'inputMessageID', id: messageId }],
      } as any)
      const msg = (rawMsgs as any).messages?.[0]
      if (!msg || msg._ === 'messageEmpty') return Response.json({ error: 'Message not found' }, { status: 404 })

      const media = (msg as any).media
      if (!media) return Response.json({ error: 'No media' }, { status: 404 })

      // messageMediaDocument wraps the actual document — extract it
      const doc = media.document ?? media.photo
      if (!doc) return Response.json({ error: 'No document in media' }, { status: 404 })

      const fileLocation = doc._ === 'document'
        ? { _: 'inputDocumentFileLocation', id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' }
        : { _: 'inputPhotoFileLocation', id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: 'y' }
      const dcId: number = doc.dcId ?? await client.getPrimaryDcId()

      const CHUNK = 512 * 1024 // 512 KB — CF Workers WS限制1MB，MTProto开销导致1MB块超限(1009错误)
      const contentLength = end - start + 1
      const alignedStart = Math.floor(start / CHUNK) * CHUNK
      const skipBytes = start - alignedStart

      const { readable, writable } = new TransformStream<Uint8Array>()
      const writer = writable.getWriter()

      ;(async () => {
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
          this._resetClient(client)
          console.error('[TGClientDO] stream error:', e)
        } finally {
          writer.close()
        }
      })()

      return new Response(readable, {
        headers: { 'Content-Length': String(contentLength), 'Content-Type': 'application/octet-stream' },
      })
    } catch (e: any) {
      this._resetClient(client)
      return Response.json({ error: e.message }, { status: 500 })
    }
  }
}
