import type { TelegramClient } from '@mtcute/web'
import type { D1Database } from '@cloudflare/workers-types'
import { upsertMediaItem } from '../db'
import { computeFileHash } from '../utils/hash'

function detectMediaType(mimeType: string | undefined, sourceType: string): string {
  if (!mimeType) return sourceType
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('image/')) return 'image'
  if (['application/pdf', 'application/epub+zip', 'application/x-mobipocket-ebook'].includes(mimeType)) return 'book'
  return sourceType
}

export interface ScanProgress {
  processed: number
  current_file: string
  message_id: number
  done: boolean
  error?: string
}

export type ProgressCallback = (p: ScanProgress) => Promise<void>

export async function scanChannel(
  client: TelegramClient,
  db: D1Database,
  sourceId: number,
  channelId: string,
  sourceType: string,
  lastMessageId: number,
  jwtSecret: string,
  onProgress: ProgressCallback
): Promise<number> {
  let maxNewMessageId = lastMessageId
  let processed = 0
  // getHistory returns from newest to oldest; we stop when we hit lastMessageId
  let offsetId: number | undefined
  let offsetDate: number | undefined

  while (true) {
    const messages = await client.getHistory(Number(channelId), {
      limit: 100,
      ...(offsetId !== undefined && offsetDate !== undefined
        ? { offset: { id: offsetId, date: offsetDate } }
        : {}),
    })

    if (!messages || messages.length === 0) break

    let reachedOld = false
    for (const msg of messages) {
      if (msg.id <= lastMessageId) { reachedOld = true; break }
      if (msg.id > maxNewMessageId) maxNewMessageId = msg.id

      const media = msg.media
      if (!media) continue

      let fileName = ''
      let fileSize = 0
      let mimeType = ''
      let fileUniqueId = ''

      if (media.type === 'document' || media.type === 'video' || media.type === 'audio' || media.type === 'voice') {
        const doc = media as any
        fileSize = doc.fileSize ?? doc.raw?.size ?? 0
        mimeType = doc.mimeType ?? ''
        fileUniqueId = String(doc.raw?.id ?? doc.raw?.accessHash ?? msg.id)
        fileName = doc.fileName ?? `${media.type}_${msg.id}`
      } else if (media.type === 'photo') {
        const photo = media as any
        mimeType = 'image/jpeg'
        fileUniqueId = String(photo.raw?.id ?? msg.id)
        fileName = `photo_${msg.id}.jpg`
      } else {
        continue
      }

      const mediaType = detectMediaType(mimeType, sourceType)
      const fileHash = await computeFileHash(fileName, fileSize, mimeType, fileUniqueId)

      await upsertMediaItem(db, {
        source_id: sourceId,
        message_id: msg.id,
        file_name: fileName,
        file_size: fileSize,
        mime_type: mimeType || null,
        media_type: mediaType,
        file_hash: fileHash,
        message_date: Math.floor(msg.date.getTime() / 1000),
        title: null, description: null, cover: null,
        release_date: null, rating: null, genre: null,
        external_id: null, scraped_at: null,
        tags: null,
      })

      processed++
      await onProgress({ processed, current_file: fileName, message_id: msg.id, done: false })
    }

    if (reachedOld || messages.length < 100) break
    const last = messages[messages.length - 1]
    offsetId = last.id
    offsetDate = Math.floor(last.date.getTime() / 1000)
  }

  return maxNewMessageId
}
