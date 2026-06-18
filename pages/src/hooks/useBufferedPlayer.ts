/**
 * useBufferedPlayer - 带缓存队列的播放器 Hook
 *
 * 实现边播边缓存机制：
 * - 播放前至少缓存 3 个片段
 * - 队列至多缓存 10 个片段
 * - 边播放边预加载后续片段
 *
 * 方案说明：
 * 1. HLS 流：配置 HLS.js 的缓冲参数实现更激进的预加载
 * 2. 非 HLS 流（MP4 等）：预加载数据到内存，通过 Blob URL 播放
 *    - 先预加载最小缓冲（3片段 ~1.5MB）后即可开始播放
 *    - 后台继续下载，全部下载完成后切换到完整 Blob URL
 *    - 对于超大文件（>500MB），回退到直接播放模式
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { SegmentCacheManager, type BufferState } from './SegmentCache'

export { type BufferState }

// ===== 播放器配置选项 =====
export interface BufferedPlayerOptions {
  /** 视频流 URL */
  src: string
  /** MIME 类型 */
  mimeType?: string
  /** 是否为音频 */
  isAudio?: boolean
  /** 最大允许预加载到内存的文件大小（默认 500MB） */
  maxPreloadSize?: number
}

// ===== 缓存播放器状态 =====
export interface BufferedPlayerState {
  /** 缓冲状态 */
  bufferState: BufferState | null
  /** 是否正在初始化（获取文件大小和预加载初始片段） */
  initializing: boolean
  /** 初始化错误 */
  error: string | null
  /** 是否已就绪（初始缓冲完成，可以开始播放） */
  ready: boolean
  /** 预加载的 Blob URL（非 HLS 流使用） */
  blobUrl: string | null
  /** HLS.js 优化配置（HLS 流使用） */
  hlsConfig: Record<string, any> | null
  /** 是否使用回退模式（直接播放） */
  fallback: boolean
  /** 下载进度 (0~1)，仅非 HLS 流 */
  downloadProgress: number
}

export function useBufferedPlayer(options: BufferedPlayerOptions) {
  const { src, mimeType, isAudio, maxPreloadSize = 500 * 1024 * 1024 } = options

  const cacheRef = useRef<SegmentCacheManager | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const [state, setState] = useState<BufferedPlayerState>({
    bufferState: null,
    initializing: true,
    error: null,
    ready: false,
    blobUrl: null,
    hlsConfig: null,
    fallback: false,
    downloadProgress: 0,
  })

  const isHls = mimeType === 'application/x-mpegURL' || src.endsWith('.m3u8')

  // ===== 初始化缓存管理器 =====
  useEffect(() => {
    if (!src) return

    const cache = new SegmentCacheManager(src)
    cacheRef.current = cache

    let cancelled = false

    const init = async () => {
      try {
        await cache.init()
        if (cancelled) return

        const bufferState = cache.getState()

        if (isHls) {
          // HLS 流：返回优化配置
          const hlsConfig = {
            enableWorker: true,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1024 * 1024,
            maxBufferHole: 0.5,
            highBufferWatchdogPeriod: 2,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 6,
            progressive: true,
            lowLatencyMode: false,
          }
          if (!cancelled) {
            setState(prev => ({
              ...prev,
              initializing: false,
              ready: true,
              bufferState: cache.getState(),
              hlsConfig,
            }))
          }
          return
        }

        // 非 HLS 流：判断文件大小
        const fileSize = bufferState.totalBytes

        if (fileSize > maxPreloadSize) {
          // 超大文件：回退到直接播放，但仍利用缓存管理器预加载头部
          if (!cancelled) {
            setState(prev => ({
              ...prev,
              initializing: false,
              ready: true,
              bufferState: cache.getState(),
              fallback: true,
            }))
          }
          return
        }

        // 中小文件：并行预加载全部数据到 Blob 后播放
        await cache.downloadAll((loaded, total) => {
          if (!cancelled) {
            const currentState = cache.getState()
            const progress = currentState.cachedBytes / fileSize
            setState(prev => ({
              ...prev,
              bufferState: currentState,
              downloadProgress: progress,
            }))
          }
        })
        if (cancelled) return

        // 全部下载完成，创建 Blob URL
        const finalBlob = createBlobFromCache(cache, mimeType)
        if (finalBlob && !cancelled) {
          const finalUrl = URL.createObjectURL(finalBlob)
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
          blobUrlRef.current = finalUrl

          setState(prev => ({
            ...prev,
            initializing: false,
            ready: true,
            blobUrl: finalUrl,
            downloadProgress: 1,
            bufferState: cache.getState(),
          }))
        }
      } catch (e: any) {
        if (!cancelled) {
          setState(prev => ({
            ...prev,
            initializing: false,
            error: e.message || '初始化失败',
          }))
        }
      }
    }

    // 监听缓冲状态变化
    const unsub = cache.onStateChange((bufferState) => {
      if (!cancelled) {
        setState(prev => ({
          ...prev,
          bufferState,
        }))
      }
    })

    init()

    return () => {
      cancelled = true
      unsub()
      cache.destroy()
      cacheRef.current = null
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [src, mimeType, isAudio, maxPreloadSize])

  // ===== 播放位置更新（通知缓存管理器） =====
  const updatePlaybackPosition = useCallback((byteOffset: number) => {
    cacheRef.current?.updatePlaybackPosition(byteOffset)
  }, [])

  return {
    /** 缓冲播放器状态 */
    state,
    /** 通知缓存管理器播放位置更新 */
    updatePlaybackPosition,
    /** 缓存管理器实例（高级用法） */
    cacheManager: cacheRef,
  }
}

// ===== 从缓存创建 Blob =====
// 收集所有已缓存片段，按序合并为完整文件
function createBlobFromCache(cache: SegmentCacheManager, mimeType?: string): Blob | null {
  const state = cache.getState()
  if (state.totalSegments === 0 || state.cachedSegments < state.totalSegments) return null

  const chunks: ArrayBuffer[] = []
  for (let i = 0; i < state.totalSegments; i++) {
    const seg = cache.getSegmentSync(i)
    if (!seg) return null  // 片段缺失，无法创建完整 Blob
    chunks.push(seg)
  }

  return new Blob(chunks, { type: mimeType || 'video/mp4' })
}