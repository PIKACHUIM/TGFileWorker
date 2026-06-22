import { useRef, useState, useEffect, useCallback } from 'react'
import { TelegramClient, WebCryptoProvider, WebSocketTransport } from '@mtcute/web'
import mtcuteWasmUrl from '@mtcute/wasm/mtcute-simd.wasm?url'

interface FileInfo { fileLocation: object; dcId: number }

const CHUNK = 512 * 1024

async function resolveFileInfo(client: TelegramClient, messageId: number, channelId: string): Promise<FileInfo> {
  const str = String(channelId)
  const bareId = str.startsWith('-100') ? Number(str.slice(4))
    : str.startsWith('-') ? Number(str.slice(1)) : Number(str)

  const ch = await client.call({ _: 'channels.getChannels', id: [{ _: 'inputChannel', channelId: bareId, accessHash: 0n }] } as any)
  const accessHash = (ch as any).chats?.[0]?.accessHash
  if (!accessHash) throw new Error('Cannot get accessHash')

  const msgs = await client.call({ _: 'channels.getMessages', channel: { _: 'inputChannel', channelId: bareId, accessHash }, id: [{ _: 'inputMessageID', id: messageId }] } as any)
  const doc = (msgs as any).messages?.[0]?.media?.document ?? (msgs as any).messages?.[0]?.media?.photo
  if (!doc) throw new Error('No document in media')

  const fileLocation = doc._ === 'document'
    ? { _: 'inputDocumentFileLocation', id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' }
    : { _: 'inputPhotoFileLocation', id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: 'y' }
  return { fileLocation, dcId: doc.dcId }
}

export interface BrowserTGState {
  loading: boolean
  error: string | null
  ready: boolean
}

export function useBrowserTGClient(sourceId: number | null): BrowserTGState & {
  makeFetcher: (messageId: number) => (start: number, end: number) => Promise<ArrayBuffer>
} {
  const clientRef = useRef<TelegramClient | null>(null)
  const channelIdRef = useRef<string>('')
  const fileCacheRef = useRef(new Map<number, FileInfo>())
  const [state, setState] = useState<BrowserTGState>({ loading: false, error: null, ready: false })

  useEffect(() => {
    if (sourceId === null) return
    let active = true
    clientRef.current?.destroy()
    clientRef.current = null
    fileCacheRef.current.clear()
    setState({ loading: true, error: null, ready: false })

    const token = localStorage.getItem('token')
    fetch(`/api/tg-session/${sourceId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(new Error(e.error))))
      .then(async (creds: { apiId: number; apiHash: string; session: string | null; channelId: string }) => {
        channelIdRef.current = creds.channelId
        const client = new TelegramClient({
          apiId: creds.apiId,
          apiHash: creds.apiHash,
          crypto: new WebCryptoProvider({ wasmInput: new URL(mtcuteWasmUrl, location.href) }),
          transport: new WebSocketTransport(),
          disableUpdates: true,
        })
        await client.start({ session: creds.session ?? undefined })
        if (!active) { client.destroy(); return }
        clientRef.current = client
        setState({ loading: false, error: null, ready: true })
      })
      .catch(e => { if (active) setState({ loading: false, error: e.message, ready: false }) })

    return () => {
      active = false
      clientRef.current?.destroy()
      clientRef.current = null
    }
  }, [sourceId])

  const makeFetcher = useCallback(
    (messageId: number) =>
      async (start: number, end: number): Promise<ArrayBuffer> => {
        const client = clientRef.current
        if (!client) throw new Error('Browser TG client not ready')

        if (!fileCacheRef.current.has(messageId)) {
          fileCacheRef.current.set(messageId, await resolveFileInfo(client, messageId, channelIdRef.current))
        }
        const { fileLocation, dcId } = fileCacheRef.current.get(messageId)!

        const contentLength = end - start + 1
        const alignedStart = Math.floor(start / CHUNK) * CHUNK
        const skipBytes = start - alignedStart
        const bufs: Uint8Array[] = []
        let offset = alignedStart, collected = 0

        while (collected < skipBytes + contentLength) {
          const res = await client.call({ _: 'upload.getFile', location: fileLocation, offset, limit: CHUNK, precise: true } as any, { kind: 'main', dcId } as any)
          if ((res as any)._ !== 'upload.file') break
          const bytes: Uint8Array = (res as any).bytes
          bufs.push(bytes); offset += bytes.length; collected += bytes.length
          if (bytes.length < CHUNK) break
        }

        const merged = new Uint8Array(bufs.reduce((s, b) => s + b.length, 0))
        let pos = 0; for (const b of bufs) { merged.set(b, pos); pos += b.length }
        return merged.slice(skipBytes, skipBytes + contentLength).buffer
      },
    [],
  )

  return { ...state, makeFetcher }
}
