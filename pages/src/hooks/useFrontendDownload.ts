import { useRef, useState, useCallback } from 'react'

type DlState = 'idle' | 'downloading' | 'paused' | 'done' | 'error'
export interface DlStatus { state: DlState; progress: number; error?: string }

const CHUNK = 512 * 1024

export function useFrontendDownload() {
  const [status, setStatus] = useState<DlStatus>({ state: 'idle', progress: 0 })
  const isPausedRef = useRef(false)
  const cancelRef = useRef(false)
  const resumeRef = useRef<(() => void) | null>(null)

  const download = useCallback(async (
    fetcher: (s: number, e: number) => Promise<ArrayBuffer>,
    fileSize: number,
    fileName: string,
  ) => {
    cancelRef.current = false
    isPausedRef.current = false
    setStatus({ state: 'downloading', progress: 0 })
    const chunks: ArrayBuffer[] = []
    let pos = 0
    try {
      while (pos < fileSize) {
        if (cancelRef.current) { setStatus({ state: 'idle', progress: 0 }); return }
        if (isPausedRef.current) {
          await new Promise<void>(r => { resumeRef.current = r })
        }
        if (cancelRef.current) { setStatus({ state: 'idle', progress: 0 }); return }
        const end = Math.min(pos + CHUNK - 1, fileSize - 1)
        chunks.push(await fetcher(pos, end))
        pos = end + 1
        setStatus({ state: 'downloading', progress: pos / fileSize })
      }
      const blob = new Blob(chunks)
      const url = URL.createObjectURL(blob)
      Object.assign(document.createElement('a'), { href: url, download: fileName }).click()
      URL.revokeObjectURL(url)
      setStatus({ state: 'done', progress: 1 })
    } catch (e: any) {
      if (!cancelRef.current) setStatus({ state: 'error', progress: 0, error: e.message })
    }
  }, [])

  const pause = useCallback(() => {
    isPausedRef.current = true
    setStatus(s => ({ ...s, state: 'paused' }))
  }, [])

  const resume = useCallback(() => {
    isPausedRef.current = false
    resumeRef.current?.()
    resumeRef.current = null
    setStatus(s => ({ ...s, state: 'downloading' }))
  }, [])

  const cancel = useCallback(() => {
    cancelRef.current = true
    isPausedRef.current = false
    resumeRef.current?.()
    resumeRef.current = null
  }, [])

  const reset = useCallback(() => setStatus({ state: 'idle', progress: 0 }), [])

  return { status, download, pause, resume, cancel, reset }
}
