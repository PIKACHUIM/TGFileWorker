/**
 * 缓存队列管理器
 *
 * 通过 HTTP Range 请求实现视频分片预加载和缓存：
 * - 播放前至少缓存 3 个片段
 * - 队列至多缓存 10 个片段
 * - 边播放边预加载后续片段
 * - 使用主动预加载机制，而非被动触发
 */

// ===== 缓存队列配置 =====
const SEGMENT_SIZE = 1024 * 1024       // 每个片段 512KB
const MIN_BUFFER_SEGMENTS = 3          // 播放前最少缓存片段数
const MAX_BUFFER_SEGMENTS = 10         // 队列最大缓存片段数
const PREFETCH_TRIGGER_THRESHOLD = 5   // 当前方缓存少于此值时触发预加载

// ===== 缓存片段 =====
export interface CacheSegment {
  index: number
  start: number
  end: number
  data: ArrayBuffer
  timestamp: number
}

// ===== FLOOD_WAIT 错误回调 =====
export interface FloodWaitInfo {
  waitSeconds: number
  message: string
  retryAfter: number
}

type FloodWaitCallback = (info: FloodWaitInfo) => void

// ===== 缓存队列状态 =====
export interface BufferState {
  /** 已缓存的片段数 */
  cachedSegments: number
  /** 正在预加载的片段数 */
  prefetching: number
  /** 缓存进度 (0~1) */
  bufferProgress: number
  /** 是否正在缓冲（尚未达到最低缓存要求） */
  isBuffering: boolean
  /** 当前播放位置对应的片段索引 */
  currentSegmentIndex: number
  /** 总片段数 */
  totalSegments: number
  /** 缓存的字节数 */
  cachedBytes: number
  /** 文件总大小 */
  totalBytes: number
  /** 前方连续缓存片段数 */
  consecutiveAhead: number
  /** 是否有 FLOOD_WAIT 错误 */
  hasFloodWait: boolean
  /** FLOOD_WAIT 等待秒数 */
  floodWaitSeconds: number
}

type BufferStateListener = (state: BufferState) => void

export type SegmentFetcher = (start: number, end: number) => Promise<ArrayBuffer>

export class SegmentCacheManager {
  private segments: Map<number, CacheSegment> = new Map()
  private fileSize = 0
  private totalSegments = 0
  private currentSegmentIndex = 0
  private prefetchingCount = 0
  private abortController: AbortController | null = null
  private url = ''
  private listeners: Set<BufferStateListener> = new Set()
  private destroyed = false
  private initPromise: Promise<void> | null = null
  private initResolved = false
  private prefetchQueue: Set<number> = new Set()
  private floodWaitCallback: FloodWaitCallback | null = null
  private hasFloodWait = false
  private floodWaitSeconds = 0
  private customFetcher?: SegmentFetcher

  private prefetchTaskRunning = false

  constructor(url: string, fetcher?: SegmentFetcher, knownFileSize?: number) {
    this.url = url
    this.customFetcher = fetcher
    if (knownFileSize) {
      this.fileSize = knownFileSize
      this.totalSegments = Math.ceil(knownFileSize / SEGMENT_SIZE)
      // 不设 initResolved，让 init() 仍然执行预加载初始片段
    }
  }

  // ===== 初始化：发 HEAD 请求获取文件大小（已知大小时跳过）=====
  async init(): Promise<void> {
    if (this.initResolved) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      try {
        if (!this.fileSize) {
          // 未知文件大小：发 HEAD 请求
          const resp = await fetch(this.url, { method: 'HEAD' })
          const contentLength = resp.headers.get('Content-Length')
          if (!contentLength) {
            const rangeResp = await fetch(this.url, { headers: { Range: 'bytes=0-0' } })
            const rangeHeader = rangeResp.headers.get('Content-Range')
            if (rangeHeader) {
              const match = rangeHeader.match(/\/(\d+)/)
              if (match) this.fileSize = parseInt(match[1])
            }
          } else {
            this.fileSize = parseInt(contentLength)
          }
          this.totalSegments = Math.ceil(this.fileSize / SEGMENT_SIZE)
        }

        this.initResolved = true
        this.emitState()

        // 预加载前 MIN_BUFFER_SEGMENTS 个片段（主动等待完成）
        await this.prefetchSegments(0, MIN_BUFFER_SEGMENTS)
      } catch (e) {
        console.error('[SegmentCache] 初始化失败:', e)
        throw e
      }
    })()

    return this.initPromise
  }

  // ===== 对外暴露：启动后台预加载 =====
  startPrefetch(): void {
    this.startPrefetchTask()
  }

  // ===== 主动预加载任务（3并发）=====
  private async startPrefetchTask(): Promise<void> {
    if (this.prefetchTaskRunning || this.destroyed) return
    this.prefetchTaskRunning = true

    await Promise.allSettled(Array.from({ length: 3 }, () => this._prefetchWorker()))

    this.prefetchTaskRunning = false
    this.emitState()
  }

  private async _prefetchWorker(): Promise<void> {
    while (!this.destroyed) {
      if (this.countConsecutiveAhead() >= MAX_BUFFER_SEGMENTS) break
      const nextIndex = this.findNextPrefetchIndex()
      if (nextIndex === -1) break
      this.prefetchQueue.add(nextIndex)
      this.prefetchingCount++
      this.emitState()
      try { await this.fetchSegment(nextIndex) } catch {}
    }
  }

  // ===== 找到下一个需要预加载的片段索引 =====
  private findNextPrefetchIndex(): number {
    // 从当前位置开始，找到第一个未缓存的片段
    for (let i = this.currentSegmentIndex; i < this.totalSegments; i++) {
      if (!this.segments.has(i) && !this.prefetchQueue.has(i)) {
        return i
      }
    }
    return -1
  }

  // ===== 计算当前位置前方连续缓存的片段数 =====
  private countConsecutiveAhead(): number {
    let count = 0
    for (let i = this.currentSegmentIndex; i < this.totalSegments; i++) {
      if (this.segments.has(i)) {
        count++
      } else {
        break
      }
    }
    return count
  }

  // ===== 预加载片段 =====
  private async prefetchSegments(fromIndex: number, count: number): Promise<void> {
    if (this.destroyed) return

    const endIndex = Math.min(fromIndex + count, this.totalSegments)
    const promises: Promise<void>[] = []

    for (let i = fromIndex; i < endIndex; i++) {
      if (this.segments.has(i) || this.prefetchQueue.has(i)) continue
      this.prefetchQueue.add(i)
      this.prefetchingCount++
      promises.push(this.fetchSegment(i))
    }

    this.emitState()
    await Promise.allSettled(promises)
  }

  private async fetchSegment(index: number): Promise<void> {
    if (this.destroyed) {
      this.prefetchQueue.delete(index)
      return
    }

    const start = index * SEGMENT_SIZE
    const end = Math.min(start + SEGMENT_SIZE - 1, this.fileSize - 1)

    if (start >= this.fileSize) {
      this.prefetchQueue.delete(index)
      this.prefetchingCount = Math.max(0, this.prefetchingCount - 1)
      return
    }

    const controller = new AbortController()
    this.abortController = controller

    try {
      // 浏览器直连模式：使用自定义 fetcher（TG client）代替 HTTP Range 请求
      if (this.customFetcher) {
        const data = await this.customFetcher(start, end)
        if (!this.destroyed) {
          this.segments.set(index, { index, start, end, data, timestamp: Date.now() })
        }
        return
      }

      const headers: Record<string, string> = { Range: `bytes=${start}-${end}` }
      // 如果 URL 已带 hash 参数则不需要额外认证头
      if (!this.url.includes('hash=')) {
        const token = localStorage.getItem('token')
        if (token) headers['Authorization'] = `Bearer ${token}`
      }

      const resp = await fetch(this.url, { headers, signal: controller.signal })

      // 检查是否是 429 FLOOD_WAIT 错误
      if (resp.status === 429) {
        const errorData = await resp.json().catch(() => ({}))
        if (errorData.error === 'FLOOD_WAIT' && errorData.waitSeconds) {
          this.hasFloodWait = true
          this.floodWaitSeconds = errorData.waitSeconds
          this.emitState()
          this.floodWaitCallback?.({
            waitSeconds: errorData.waitSeconds,
            message: errorData.message || `Telegram API 限流，请等待 ${errorData.waitSeconds} 秒后重试`,
            retryAfter: errorData.retryAfter || errorData.waitSeconds,
          })
          throw new Error(`FLOOD_WAIT:${errorData.waitSeconds}`)
        }
        throw new Error(`HTTP ${resp.status}`)
      }

      if (!resp.ok && resp.status !== 206) {
        throw new Error(`HTTP ${resp.status}`)
      }

      const data = await resp.arrayBuffer()
      if (!this.destroyed) {
        this.segments.set(index, {
          index,
          start,
          end,
          data,
          timestamp: Date.now(),
        })
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.warn(`[SegmentCache] 片段 ${index} 加载失败:`, e)
      }
    } finally {
      this.prefetchQueue.delete(index)
      this.prefetchingCount = Math.max(0, this.prefetchingCount - 1)
      this.emitState()
    }
  }

  // ===== 获取片段数据 =====
  async getSegment(index: number): Promise<ArrayBuffer | null> {
    if (index < 0 || index >= this.totalSegments) return null

    const cached = this.segments.get(index)
    if (cached) {
      this.onSegmentAccess(index)
      return cached.data
    }

    // 不在缓存中，优先加载这个片段
    this.prefetchQueue.add(index)
    this.prefetchingCount++
    this.emitState()

    await this.fetchSegment(index)
    const result = this.segments.get(index)
    return result?.data ?? null
  }

  // ===== 同步获取（不触发预加载） =====
  getSegmentSync(index: number): ArrayBuffer | null {
    const cached = this.segments.get(index)
    return cached?.data ?? null
  }

  // ===== 播放器访问某片段时触发预加载 =====
  private onSegmentAccess(index: number): void {
    // 更新当前位置
    const prevIndex = this.currentSegmentIndex
    this.currentSegmentIndex = index

    // 清理距离过远的旧片段（释放内存）
    for (const key of this.segments.keys()) {
      if (key < index - MAX_BUFFER_SEGMENTS * 2) {
        this.segments.delete(key)
      }
    }

    // 触发主动预加载
    this.triggerPrefetch()

    this.emitState()
  }

  // ===== 触发主动预加载 =====
  private triggerPrefetch(): void {
    if (this.destroyed) return

    const consecutiveAhead = this.countConsecutiveAhead()
    
    // 如果前方缓存不足阈值，启动预加载任务
    if (consecutiveAhead < PREFETCH_TRIGGER_THRESHOLD && !this.prefetchTaskRunning) {
      this.startPrefetchTask()
    }
  }

  // ===== 通知播放位置更新 =====
  updatePlaybackPosition(byteOffset: number): void {
    const segIndex = Math.floor(byteOffset / SEGMENT_SIZE)
    if (segIndex !== this.currentSegmentIndex) {
      this.onSegmentAccess(segIndex)
    }
  }

  // ===== 获取当前缓冲状态 =====
  getState(): BufferState {
    const cachedSegments = this.segments.size
    const cachedBytes = Array.from(this.segments.values())
      .reduce((sum, s) => sum + s.data.byteLength, 0)

    // 从当前位置向前连续缓存数
    let consecutiveAhead = 0
    for (let i = this.currentSegmentIndex; i < this.totalSegments; i++) {
      if (this.segments.has(i)) consecutiveAhead++
      else break
    }

    return {
      cachedSegments,
      prefetching: this.prefetchingCount,
      bufferProgress: this.totalSegments > 0
        ? Math.min(1, consecutiveAhead / Math.min(this.totalSegments, MAX_BUFFER_SEGMENTS)) : 0,
      isBuffering: consecutiveAhead < MIN_BUFFER_SEGMENTS && this.totalSegments > 0,
      currentSegmentIndex: this.currentSegmentIndex,
      totalSegments: this.totalSegments,
      cachedBytes,
      totalBytes: this.fileSize,
      consecutiveAhead,
      hasFloodWait: this.hasFloodWait,
      floodWaitSeconds: this.floodWaitSeconds,
    }
  }

  // ===== 监听状态变化 =====
  onStateChange(listener: BufferStateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ===== 注册 FLOOD_WAIT 错误回调 =====
  onFloodWait(callback: FloodWaitCallback): () => void {
    this.floodWaitCallback = callback
    return () => { this.floodWaitCallback = null }
  }

  // ===== 清除 FLOOD_WAIT 状态（用户等待后重试）=====
  clearFloodWait(): void {
    this.hasFloodWait = false
    this.floodWaitSeconds = 0
    this.emitState()
  }

  private emitState(): void {
    const state = this.getState()
    for (const listener of this.listeners) {
      try { listener(state) } catch { /* ignore */ }
    }
  }

  // ===== 等待最低缓冲 =====
  async waitForMinBuffer(): Promise<void> {
    const check = () => {
      let consecutive = 0
      for (let i = this.currentSegmentIndex; i < this.totalSegments; i++) {
        if (this.segments.has(i)) consecutive++
        else break
      }
      return consecutive >= Math.min(MIN_BUFFER_SEGMENTS, this.totalSegments)
    }

    if (check()) return

    return new Promise<void>((resolve) => {
      const unsub = this.onStateChange(() => {
        if (check()) {
          unsub()
          resolve()
        }
      })
      if (check()) {
        unsub()
        resolve()
      }
    })
  }

  // ===== 获取片段大小常量 =====
  static getSegmentSize(): number {
    return SEGMENT_SIZE
  }

  // ===== 并行下载所有片段 =====
  // 同时发起多个 Range 请求，提高下载速度
  async downloadAll(
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    if (this.destroyed || this.totalSegments === 0) return

    const CONCURRENT = 6  // 并行下载数
    let nextIndex = 0

    const downloadNext = async (): Promise<void> => {
      while (nextIndex < this.totalSegments && !this.destroyed) {
        const index = nextIndex++
        if (this.segments.has(index)) continue

        const start = index * SEGMENT_SIZE
        const end = Math.min(start + SEGMENT_SIZE - 1, this.fileSize - 1)
        if (start >= this.fileSize) continue

        try {
          let data: ArrayBuffer
          if (this.customFetcher) {
            data = await this.customFetcher(start, end)
          } else {
            const headers: Record<string, string> = { Range: `bytes=${start}-${end}` }
            if (!this.url.includes('hash=')) {
              const token = localStorage.getItem('token')
              if (token) headers['Authorization'] = `Bearer ${token}`
            }
            const resp = await fetch(this.url, { headers })
            if (!resp.ok && resp.status !== 206) continue
            data = await resp.arrayBuffer()
          }
          if (!this.destroyed) {
            this.segments.set(index, {
              index, start, end, data, timestamp: Date.now(),
            })
            onProgress?.(this.segments.size, this.totalSegments)
          }
        } catch {
          // 单个片段失败不中断整体下载
        }
      }
    }

    // 启动 CONCURRENT 个并行下载任务
    await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () => downloadNext())
    )
  }

  // ===== 销毁 =====
  destroy(): void {
    this.destroyed = true
    this.abortController?.abort()
    this.segments.clear()
    this.prefetchQueue.clear()
    this.listeners.clear()
    this.floodWaitCallback = null
  }
}
