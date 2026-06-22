/**
 * HLS.js 自定义 Loader 和虚拟播放列表生成器
 *
 * 将后端 Range 请求接口伪装为 HLS 流：
 * 1. 拦截 m3u8 请求，返回虚拟播放列表
 * 2. 拦截 ts 片段请求，通过 Range 请求获取数据
 * 3. 利用 SegmentCacheManager 实现预加载缓存
 */
import { SegmentCacheManager } from './SegmentCache'

// ===== 片段大小（与 SegmentCacheManager 保持一致） =====
const SEGMENT_SIZE = 1024 * 1024     // 每个片段 1MB
// ===== 每个虚拟 HLS 片段包含的分片数 =====
const CHUNKS_PER_SEGMENT = 2          // 每个虚拟片段 2MB (1MB * 2)
// ===== 虚拟片段大小 =====
const VIRTUAL_SEGMENT_SIZE = SEGMENT_SIZE * CHUNKS_PER_SEGMENT // 2MB

// ===== 虚拟 m3u8 播放列表生成 =====
export function generateVirtualM3U8(
  fileSize: number,
  mimeType: string,
  segmentDuration: number = 4,
): string {
  const totalSegments = Math.ceil(fileSize / VIRTUAL_SEGMENT_SIZE)
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:' + Math.ceil(segmentDuration),
    '#EXT-X-MEDIA-SEQUENCE:0',
  ]

  // 根据 mimeType 判断编码信息
  const isVideo = mimeType.startsWith('video/')
  const codecs = isVideo ? 'avc1.64001f,mp4a.40.2' : 'mp4a.40.2'
  const bandwidth = isVideo ? 2000000 : 128000

  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecs}"`)
  lines.push('main.m3u8')

  return lines.join('\n')
}

export function generateVirtualPlaylist(
  fileSize: number,
  mimeType: string,
  segmentDuration: number = 4,
  segmentBaseUrl?: string,
): string {
  const totalSegments = Math.ceil(fileSize / VIRTUAL_SEGMENT_SIZE)
  const base = segmentBaseUrl ? segmentBaseUrl.replace(/\/$/, '') + '/' : ''
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:' + Math.ceil(segmentDuration),
    '#EXT-X-MEDIA-SEQUENCE:0',
  ]

  for (let i = 0; i < totalSegments; i++) {
    lines.push(`#EXTINF:${segmentDuration},`)
    lines.push(`${base}segment_${i}.ts`)
  }

  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

// ===== 自定义 HLS.js Loader =====
export interface CustomLoaderContext {
  url: string
  responseType: string
  onSuccess: (response: { url: string; data: string | ArrayBuffer }, stats: any) => void
  onError: (error: { code: number; text: string }, stats: any) => void
  onTimeout: (stats: any) => void
  onProgress: (stats: any, data: any, key: any) => void
  config: any
  loader: any
}

export interface CustomLoaderStats {
  aborted: boolean
  loaded: number
  retry: number
  total: number
  chunkCount: number
  bwEstimate: number
  loading: { start: number; first: number; end: number }
}

export class HlsRangeLoader {
  private context!: CustomLoaderContext
  private config: any
  private stats: CustomLoaderStats
  private callbacks: any
  private cacheManager: SegmentCacheManager
  private fileSize: number
  private mimeType: string
  private baseUrl: string
  private aborted = false

  constructor(config: any) {
    this.config = config
    this.cacheManager = config.cacheManager
    this.fileSize = config.fileSize
    this.mimeType = config.mimeType
    this.baseUrl = config.baseUrl

    this.stats = {
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
    }
  }

  destroy(): void {
    this.abort()
  }

  abort(): void {
    this.aborted = true
    this.stats.aborted = true
  }

  load(context: CustomLoaderContext, config: any, callbacks: any): void {
    this.context = context
    this.callbacks = callbacks
    this.stats.loading.start = performance.now()
    this.aborted = false

    const url = context.url

    // 判断请求类型
    if (url.endsWith('.m3u8') || url.includes('main.m3u8')) {
      this.handleM3U8Request(url)
    } else if (url.includes('segment_')) {
      this.handleSegmentRequest(url)
    } else {
      // 其他请求回退到标准 fetch
      this.handleFallbackRequest(url)
    }
  }

  // ===== 处理 m3u8 播放列表请求 =====
  private handleM3U8Request(url: string): void {
    const isMasterPlaylist = url.endsWith('.m3u8') && !url.includes('main.m3u8')

    let content: string
    if (isMasterPlaylist) {
      content = generateVirtualM3U8(this.fileSize, this.mimeType)
    } else {
      content = generateVirtualPlaylist(this.fileSize, this.mimeType)
    }

    this.stats.loading.first = performance.now()
    this.stats.loading.end = performance.now()
    this.stats.loaded = content.length
    this.stats.total = content.length

    this.callbacks.onSuccess(
      {
        url,
        data: content,
      },
      this.stats,
      this.context,
    )
  }

  // ===== 处理虚拟片段请求 =====
  private async handleSegmentRequest(url: string): Promise<void> {
    // 解析片段索引：segment_0.ts -> 0
    const match = url.match(/segment_(\d+)\.ts/)
    if (!match) {
      this.callbacks.onError(
        { code: 0, text: 'Invalid segment URL' },
        this.stats,
        this.context,
      )
      return
    }

    const segmentIndex = parseInt(match[1])
    const startByte = segmentIndex * VIRTUAL_SEGMENT_SIZE
    const endByte = Math.min(startByte + VIRTUAL_SEGMENT_SIZE - 1, this.fileSize - 1)

    if (startByte >= this.fileSize) {
      this.callbacks.onError(
        { code: 0, text: 'Segment out of range' },
        this.stats,
        this.context,
      )
      return
    }

    this.stats.total = endByte - startByte + 1

    try {
      // 通过缓存管理器获取数据
      // 每个虚拟片段由 CHUNKS_PER_SEGMENT 个分片组成
      const chunks: ArrayBuffer[] = []
      const startChunkIdx = Math.floor(startByte / SEGMENT_SIZE)
      const endChunkIdx = Math.floor(endByte / SEGMENT_SIZE)

      for (let i = startChunkIdx; i <= endChunkIdx; i++) {
        if (this.aborted) return

        const chunkData = await this.cacheManager.getSegment(i)
        if (!chunkData) {
          throw new Error(`Failed to load chunk ${i}`)
        }

        // 计算当前分片在虚拟片段中的偏移
        const chunkStart = i * SEGMENT_SIZE
        const chunkEnd = Math.min(chunkStart + SEGMENT_SIZE - 1, this.fileSize - 1)

        // 裁剪分片数据到请求范围
        const trimStart = Math.max(0, startByte - chunkStart)
        const trimEnd = Math.min(chunkEnd - chunkStart, endByte - chunkStart)

        chunks.push(chunkData.slice(trimStart, trimEnd + 1))

        this.stats.loaded += (trimEnd - trimStart + 1)
        this.stats.chunkCount++

        // 首次数据到达
        if (this.stats.loading.first === 0) {
          this.stats.loading.first = performance.now()
        }
      }

      if (this.aborted) return

      // 合并所有分片
      const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0)
      const merged = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(new Uint8Array(chunk), offset)
        offset += chunk.byteLength
      }

      this.stats.loading.end = performance.now()
      this.stats.loaded = merged.byteLength

      this.callbacks.onSuccess(
        {
          url,
          data: merged.buffer,
        },
        this.stats,
        this.context,
      )
    } catch (e: any) {
      if (!this.aborted) {
        this.callbacks.onError(
          { code: 0, text: e.message || 'Segment load failed' },
          this.stats,
          this.context,
        )
      }
    }
  }

  // ===== 标准请求回退 =====
  private async handleFallbackRequest(url: string): Promise<void> {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const isText = this.context.responseType === 'text' || url.startsWith('blob:')
      const data = isText ? await response.text() : await response.arrayBuffer()

      this.stats.loading.first = performance.now()
      this.stats.loading.end = performance.now()
      this.stats.loaded = typeof data === 'string' ? data.length : data.byteLength
      this.stats.total = this.stats.loaded

      this.callbacks.onSuccess(
        { url, data },
        this.stats,
        this.context,
      )
    } catch (e: any) {
      this.callbacks.onError(
        { code: 0, text: e.message },
        this.stats,
        this.context,
      )
    }
  }
}

// ===== 创建自定义 Loader 的工厂函数 =====
export function createHlsRangeLoader(
  cacheManager: SegmentCacheManager,
  fileSize: number,
  mimeType: string,
  baseUrl: string,
) {
  return class CustomHlsLoader {
    private loader: HlsRangeLoader

    constructor(config: any) {
      const customConfig = {
        ...config,
        cacheManager,
        fileSize,
        mimeType,
        baseUrl,
      }
      this.loader = new HlsRangeLoader(customConfig)
    }

    destroy() { this.loader.destroy() }
    abort() { this.loader.abort() }

    load(context: any, config: any, callbacks: any) {
      this.loader.load(context, config, callbacks)
    }
  }
}
