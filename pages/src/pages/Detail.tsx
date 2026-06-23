import { useEffect, useRef, useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button, Descriptions, Rate, Space, Tag, Typography, Breadcrumb, Spin, message, Switch, Layout, Progress, Tooltip, Modal, Segmented, Alert } from 'antd'
import { DownloadOutlined, PlayCircleOutlined, FileOutlined, LinkOutlined, MoonOutlined, SunOutlined, UnorderedListOutlined, CloudOutlined, LoadingOutlined, WifiOutlined, PauseCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { getMediaDetail, getEpisodes, type MediaItem, type EpisodeItem } from '../api'
import { formatSize } from '../utils'
import { useTheme } from '../theme'
import Artplayer from 'artplayer'
import { useBufferedPlayer, type BufferState } from '../hooks/useBufferedPlayer'
import type { FloodWaitInfo, SegmentFetcher } from '../hooks/SegmentCache'
import { useBrowserTGClient } from '../hooks/useBrowserTGClient'
import { useFrontendDownload } from '../hooks/useFrontendDownload'

const { Title, Paragraph, Text } = Typography

// ===== 缓冲状态指示器 =====
function BufferIndicator({ bufferState, isDark, downloadProgress, fallback }: {
  bufferState: BufferState | null
  isDark: boolean
  downloadProgress?: number
  fallback?: boolean
}) {
  if (!bufferState) return null

  const { isBuffering, bufferProgress, cachedSegments, totalSegments, prefetching, cachedBytes, totalBytes } = bufferState
  const percent = fallback && totalBytes > 0
    ? Math.round(cachedBytes / totalBytes * 100)
    : Math.round(bufferProgress * 100)
  const dlPercent = downloadProgress !== undefined ? Math.round(downloadProgress * 100) : null

  return (
    <div style={{
      padding: '8px 12px',
      background: isDark ? '#1f1f1f' : '#fafafa',
      borderRadius: 6,
      marginBottom: 8,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      fontSize: 12,
      color: isDark ? '#999' : '#666',
    }}>
      <CloudOutlined style={{ fontSize: 16, color: isBuffering ? '#faad14' : '#52c41a' }} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
          <span>
            {fallback ? '直接播放（大文件）' : isBuffering ? '缓冲中...' : '缓冲充足'}
            {prefetching > 0 && ` (预加载 ${prefetching} 片段)`}
            {dlPercent !== null && dlPercent < 100 && !fallback && ` · 下载 ${dlPercent}%`}
          </span>
          <span>{percent}%</span>
        </div>
        <Progress
          percent={percent}
          size="small"
          strokeColor={isBuffering ? '#faad14' : '#52c41a'}
          showInfo={false}
          style={{ marginBottom: 0 }}
        />
      </div>
      <Tooltip title={`已缓存 ${cachedSegments}/${totalSegments} 片段 (${formatSize(cachedBytes)}/${formatSize(totalBytes)})`}>
        <Text style={{ fontSize: 12, color: isDark ? '#666' : '#999', cursor: 'help' }}>
          {cachedSegments}/{totalSegments}
        </Text>
      </Tooltip>
    </div>
  )
}

// ===== 带缓存队列的视频播放器 =====
function VideoPlayer({ src, mimeType, onFloodWait, fetcher, fileSize }: { src: string; mimeType?: string; onFloodWait?: (info: FloodWaitInfo) => void; fetcher?: SegmentFetcher; fileSize?: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const artRef = useRef<Artplayer | null>(null)
  const hlsRef = useRef<any>(null)
  const { isDark } = useTheme()
  const isHls = mimeType === 'application/x-mpegURL' || src.endsWith('.m3u8')

  // 使用缓存播放器 hook
  const { state: playerState, updatePlaybackPosition, cacheManager } = useBufferedPlayer({
    src,
    mimeType,
    isAudio: false,
    fetcher,
    fileSize,
  })

  useEffect(() => {
    if (!playerState.useMediaSource || !containerRef.current || !cacheManager.current) return
    // Bare MIME types (e.g. 'video/mp4') fail isTypeSupported — qualify with codecs
    const mseCodec = (mimeType && /codecs/.test(mimeType)) ? mimeType : `${mimeType || 'video/mp4'}; codecs="avc1.42E01E, mp4a.40.2"`
    if (!MediaSource.isTypeSupported(mseCodec)) return

    const video = document.createElement('video')
    video.controls = true
    video.autoplay = true
    video.style.width = '100%'
    video.style.height = '100%'
    video.style.background = '#000'
    containerRef.current.replaceChildren(video)

    const mediaSource = new MediaSource()
    const objectUrl = URL.createObjectURL(mediaSource)
    video.src = objectUrl

    let cancelled = false
    let nextIndex = 0
    let sourceBuffer: SourceBuffer | null = null

    const appendNext = async () => {
      if (cancelled || !sourceBuffer || sourceBuffer.updating) return
      const chunk = await cacheManager.current?.getSegment(nextIndex)
      if (cancelled || !sourceBuffer) return
      if (!chunk) {
        // 所有片段已追加完毕，关闭 MediaSource
        if (mediaSource.readyState === 'open') mediaSource.endOfStream()
        return
      }
      sourceBuffer.appendBuffer(chunk)
      updatePlaybackPosition(nextIndex * 1024 * 1024)
      nextIndex += 1
    }

    const onSourceOpen = () => {
      if (cancelled) return
      sourceBuffer = mediaSource.addSourceBuffer(mseCodec)
      sourceBuffer.mode = 'sequence'
      sourceBuffer.addEventListener('updateend', appendNext)
      appendNext()
    }

    mediaSource.addEventListener('sourceopen', onSourceOpen)

    return () => {
      cancelled = true
      sourceBuffer?.removeEventListener('updateend', appendNext)
      mediaSource.removeEventListener('sourceopen', onSourceOpen)
      video.pause()
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(objectUrl)
    }
  }, [playerState.useMediaSource, mimeType, cacheManager.current, updatePlaybackPosition])

  // 注册 FLOOD_WAIT 回调
  useEffect(() => {
    if (!cacheManager.current) return
    const unsub = cacheManager.current.onFloodWait((info) => {
      onFloodWait?.(info)
    })
    return unsub
  }, [cacheManager.current, onFloodWait])

  useEffect(() => {
    if (!containerRef.current) return
    if (playerState.initializing || playerState.useMediaSource) return

    // 确定播放 URL
    let playUrl: string
    if (isHls) {
      playUrl = src
    } else if (playerState.blobUrl) {
      playUrl = playerState.blobUrl
    } else {
      // 回退模式：直接使用原始 URL
      playUrl = src
    }

    const artOptions: any = {
      container: containerRef.current,
      url: playUrl,
      volume: 0.7,
      autoplay: true,
      pip: true,
      fullscreen: true,
      setting: true,
      settings: [
        {
          html: '速度',
          tooltip: '1x',
          selector: [
            { html: '0.5x', value: 0.5 },
            { html: '0.75x', value: 0.75 },
            { html: '1x', value: 1, default: true },
            { html: '1.25x', value: 1.25 },
            { html: '1.5x', value: 1.5 },
            { html: '2x', value: 2 },
          ],
          onSelect(item: any) {
            artRef.current!.playbackRate = item.value
            return item.html
          },
        },
      ],
    }

    // HLS 流需要使用 HLS.js
    if (isHls) {
      artOptions.customType = {
        m3u8: (video: HTMLVideoElement, url: string) => {
          import('hls.js').then(({ default: HlsLib }) => {
            if (hlsRef.current) {
              hlsRef.current.destroy()
            }

            const hlsConfig = playerState.hlsConfig || {}
            const hls = new HlsLib(hlsConfig)
            hlsRef.current = hls

            // 监听播放进度，通知缓存管理器
            hls.on(HlsLib.Events.FRAG_LOADED, (_event: any, data: any) => {
              if (data.frag) {
                updatePlaybackPosition((data.frag.startPTS || 0) * 1000000)
              }
            })

            hls.loadSource(url)
            hls.attachMedia(video)
          })
        }
      }
    }

    artRef.current = new Artplayer(artOptions)
    return () => {
      artRef.current?.destroy()
      artRef.current = null
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [src, playerState.initializing, playerState.ready, playerState.blobUrl])

  // 初始化中显示加载状态
  if (playerState.initializing) {
    return (
      <div style={{
        width: '100%',
        paddingBottom: '56.25%',
        position: 'relative',
        background: '#000',
        borderRadius: 8,
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          gap: 16,
        }}>
          <LoadingOutlined style={{ fontSize: 40 }} />
          <div>正在预加载缓冲...</div>
          {playerState.bufferState && (
            <div style={{ width: 200 }}>
              <Progress
                percent={playerState.bufferState.totalBytes > 0
                  ? Math.round(playerState.bufferState.cachedBytes / playerState.bufferState.totalBytes * 100)
                  : Math.round(playerState.bufferState.bufferProgress * 100)}
                strokeColor="#1890ff"
                size="small"
              />
              <Text style={{ fontSize: 12, color: '#999' }}>
                已缓存 {playerState.bufferState.cachedSegments}/{playerState.bufferState.totalSegments} 片段
              </Text>
            </div>
          )}
        </div>
      </div>
    )
  }

  // 初始化错误时回退到直接播放
  if (playerState.error) {
    return (
      <div>
        <div style={{ color: '#faad14', fontSize: 12, marginBottom: 8 }}>
          缓冲预加载失败，已回退到直接播放模式
        </div>
        <DirectVideoPlayer src={src} />
      </div>
    )
  }

  return (
    <div>
      <BufferIndicator
        bufferState={playerState.bufferState}
        isDark={isDark}
        downloadProgress={playerState.downloadProgress}
        fallback={playerState.fallback}
      />
      <div style={{ width: '100%', height: 0, paddingBottom: '56.25%', position: 'relative' }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
    </div>
  )
}

// ===== 直接播放器（回退方案） =====
function DirectVideoPlayer({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const artRef = useRef<Artplayer | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const artOptions: any = {
      container: containerRef.current,
      url: src,
      volume: 0.7,
      autoplay: true,
      pip: true,
      fullscreen: true,
      setting: true,
      settings: [
        {
          html: '速度',
          tooltip: '1x',
          selector: [
            { html: '0.5x', value: 0.5 },
            { html: '0.75x', value: 0.75 },
            { html: '1x', value: 1, default: true },
            { html: '1.25x', value: 1.25 },
            { html: '1.5x', value: 1.5 },
            { html: '2x', value: 2 },
          ],
          onSelect(item: any) {
            artRef.current!.playbackRate = item.value
            return item.html
          },
        },
      ],
    }
    artRef.current = new Artplayer(artOptions)
    return () => {
      artRef.current?.destroy()
      artRef.current = null
    }
  }, [src])

  return <div style={{ width: '100%', height: 0, paddingBottom: '56.25%', position: 'relative' }}>
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
  </div>
}

// ===== 带缓存队列的音频播放器 =====
function AudioPlayer({ src, mimeType, onFloodWait, fetcher, fileSize }: { src: string; mimeType?: string; onFloodWait?: (info: FloodWaitInfo) => void; fetcher?: SegmentFetcher; fileSize?: number }) {
  const { isDark } = useTheme()
  const audioRef = useRef<HTMLAudioElement>(null)

  // 使用缓存播放器 hook
  const { state: playerState, cacheManager } = useBufferedPlayer({
    src,
    mimeType,
    isAudio: true,
    fetcher,
    fileSize,
  })

  // 注册 FLOOD_WAIT 回调
  useEffect(() => {
    if (!cacheManager.current) return
    const unsub = cacheManager.current.onFloodWait((info) => {
      onFloodWait?.(info)
    })
    return unsub
  }, [cacheManager.current, onFloodWait])

  // 确定音频播放 URL
  const audioSrc = playerState.blobUrl || src

  return (
    <div>
      <BufferIndicator
        bufferState={playerState.bufferState}
        isDark={isDark}
        downloadProgress={playerState.downloadProgress}
        fallback={playerState.fallback}
      />
      {playerState.initializing && (
        <div style={{ textAlign: 'center', padding: '12px 0', color: isDark ? '#999' : '#666', fontSize: 13 }}>
          <LoadingOutlined /> 正在预加载音频缓冲...
        </div>
      )}
      <audio ref={audioRef} controls autoPlay style={{ width: '100%' }}>
        <source src={audioSrc} type={mimeType || 'audio/mpeg'} />
      </audio>
    </div>
  )
}

export default function Detail() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const { isDark, setMode } = useTheme()
  const [item, setItem] = useState<MediaItem | null>(null)
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [floodWait, setFloodWait] = useState<FloodWaitInfo | null>(null)
  const [playMode, setPlayMode] = useState<'proxy' | 'browser'>('proxy')

  const [dlRequested, setDlRequested] = useState(false)
  const { status: dlStatus, download, pause: pauseDl, resume: resumeDl, cancel: cancelDl, reset: dlReset } = useFrontendDownload()

  const browserClient = useBrowserTGClient(
    ((playMode === 'browser' && playing) || dlRequested) && item ? item.source_id : null
  )

  useEffect(() => {
    if (!dlRequested || !browserClient.ready || !item) return
    if (dlStatus.state === 'idle') {
      download(browserClient.makeFetcher(item.message_id), item.file_size, item.file_name)
    }
  }, [dlRequested, browserClient.ready])
  const fetcher = useMemo(
    () => playMode === 'browser' && browserClient.ready && item ? browserClient.makeFetcher(item.message_id) : undefined,
    [playMode, browserClient.ready, browserClient.makeFetcher, item?.id],
  )

  const loadDetail = (mediaId: number) => {
    setLoading(true)
    Promise.all([
      getMediaDetail(mediaId),
      getEpisodes(mediaId),
    ]).then(([detailRes, epRes]) => {
      setItem(detailRes.data)
      setEpisodes(epRes.data.items)
      setPlaying(false)
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    loadDetail(Number(id))
  }, [id])

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
  if (!item) return <div style={{ padding: 48, textAlign: 'center' }}>媒体不存在</div>

  const isVideo = item.media_type === 'video'
  const isAudio = item.media_type === 'audio'
  const canPlay = isVideo || isAudio

  const textColor = isDark ? '#e0e0e0' : undefined
  const secondaryColor = isDark ? '#999' : undefined
  const borderColor = isDark ? '#303030' : '#f0f0f0'

  const handleEpisodeSwitch = (epId: number) => {
    nav(`/media/${epId}`)
  }

  const handleFloodWait = (info: FloodWaitInfo) => {
    setFloodWait(info)
  }

  return (
    <Layout style={{ minHeight: '100vh', background: isDark ? '#141414' : '#f5f5f5' }}>
      <Layout.Header style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 24px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        background: isDark ? '#1f1f1f' : '#fff',
        borderBottom: `1px solid ${borderColor}`,
        transition: 'background 0.3s ease, border-color 0.3s ease',
      }}>
        <Breadcrumb style={{ flex: 1 }} items={[
          { title: <a onClick={() => nav('/')} style={{ color: isDark ? '#ddd' : undefined }}>首页</a> },
          { title: <a onClick={() => nav(`/channel/${item.source_id}`)} style={{ color: isDark ? '#ddd' : undefined }}>{item.source_name}</a> },
          { title: <span style={{ color: isDark ? '#ddd' : undefined }}>{item.title || item.file_name}</span> },
        ]} />
        <Switch
          checked={isDark}
          checkedChildren={<MoonOutlined />}
          unCheckedChildren={<SunOutlined />}
          onChange={v => setMode(v ? 'dark' : 'light')}
        />
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>

          {/* 播放器 - 单独区域，下方留出间距 */}
          {playing && isVideo && (
            <div style={{ marginBottom: 32 }}>
              {playMode === 'browser' && browserClient.loading && (
                <div style={{ textAlign: 'center', padding: 16, color: '#1890ff' }}><LoadingOutlined /> 正在连接 Telegram...</div>
              )}
              {playMode === 'browser' && browserClient.error && (
                <Alert type="error" message={`浏览器直连失败: ${browserClient.error}`} style={{ marginBottom: 8 }} />
              )}
              {(playMode === 'proxy' || browserClient.ready) && (
                <VideoPlayer src={item.stream_url || `/api/stream/${item.id}`} mimeType={item.mime_type} onFloodWait={handleFloodWait} fetcher={fetcher} fileSize={item.file_size || undefined} />
              )}
            </div>
          )}
          {playing && isAudio && (
            <div style={{ marginBottom: 32 }}>
              {playMode === 'browser' && browserClient.loading && (
                <div style={{ textAlign: 'center', padding: 16, color: '#1890ff' }}><LoadingOutlined /> 正在连接 Telegram...</div>
              )}
              {playMode === 'browser' && browserClient.error && (
                <Alert type="error" message={`浏览器直连失败: ${browserClient.error}`} style={{ marginBottom: 8 }} />
              )}
              {(playMode === 'proxy' || browserClient.ready) && (
                <AudioPlayer src={item.stream_url || `/api/stream/${item.id}`} mimeType={item.mime_type} onFloodWait={handleFloodWait} fetcher={fetcher} fileSize={item.file_size || undefined} />
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {/* 封面 */}
            <div style={{ width: 200, flexShrink: 0 }}>
              {item.cover
                ? <img src={item.cover} alt="" style={{ width: '100%', borderRadius: 8, boxShadow: `0 4px 12px ${isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)'}` }} />
                : <div style={{
                    width: '100%',
                    paddingBottom: '150%',
                    background: isDark ? '#262626' : '#f0f0f0',
                    borderRadius: 8,
                    position: 'relative',
                  }}>
                    <FileOutlined style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48, color: isDark ? '#555' : '#bbb' }} />
                  </div>}
            </div>

            {/* 信息 */}
            <div style={{ flex: 1, minWidth: 240 }}>
              <Title level={4} style={{ color: textColor }}>{item.title || item.file_name}</Title>
              {item.rating && <Rate disabled defaultValue={item.rating / 2} allowHalf style={{ fontSize: 14 }} />}
              {item.genre && <div style={{ margin: '8px 0' }}><Tag color="blue">{item.genre}</Tag></div>}
              {/* 显示从文件名提取的标签 */}
              {item.tags && item.tags.split(',').map((tag: string) => (
                <Tag key={tag} color="orange">{tag}</Tag>
              ))}
              {item.release_date && <Text type="secondary" style={{ color: secondaryColor }}>发行：{item.release_date}</Text>}
              {item.description && <Paragraph style={{ marginTop: 12, color: textColor }} ellipsis={{ rows: 4, expandable: true }}>{item.description}</Paragraph>}

              <Descriptions size="small" column={1} bordered style={{ marginTop: 12, background: isDark ? '#1f1f1f' : '#fff' }}>
                <Descriptions.Item label="文件名" style={{ color: textColor }}>{item.file_name}</Descriptions.Item>
                <Descriptions.Item label="大小" style={{ color: textColor }}>{formatSize(item.file_size)}</Descriptions.Item>
                <Descriptions.Item label="来源" style={{ color: textColor }}>{item.source_name}</Descriptions.Item>
              </Descriptions>

              {/* 播放按钮组 - 与信息区域保持间距 */}
              <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${borderColor}` }}>
                {canPlay && (
                  <div style={{ marginBottom: 12 }}>
                    <Segmented
                      size="small"
                      value={playMode}
                      onChange={v => { setPlayMode(v as 'proxy' | 'browser'); setPlaying(false) }}
                      options={[
                        { label: '代理播放', value: 'proxy' },
                        { label: <><WifiOutlined /> 浏览器直连</>, value: 'browser' },
                      ]}
                    />
                  </div>
                )}
                <Space wrap size="middle">
                  {canPlay && !playing && (
                    <Button type="primary" size="large" icon={<PlayCircleOutlined />} onClick={() => setPlaying(true)}>
                      在线播放
                    </Button>
                  )}
                  {canPlay && playing && (
                    <Button size="large" icon={<PlayCircleOutlined />} onClick={() => setPlaying(false)}>收起播放器</Button>
                  )}
                  <Button
                    size="large"
                    icon={<DownloadOutlined />}
                    onClick={() => { window.open((item.stream_url || `/api/stream/${item.id}`) + '&download=1', '_blank') }}
                  >
                    代理下载
                  </Button>
                  <Button
                    size="large"
                    icon={dlRequested && browserClient.loading ? <LoadingOutlined /> : <DownloadOutlined />}
                    disabled={dlStatus.state === 'downloading' || dlStatus.state === 'paused'}
                    onClick={() => setDlRequested(true)}
                  >
                    前端下载
                  </Button>
                  {!!(item.has_direct && item.direct_url && item.file_size <= 20 * 1024 * 1024) && (
                    <Button
                      size="large"
                      icon={<LinkOutlined />}
                      onClick={() => { window.open(item.direct_url!, '_blank') }}
                    >
                      直链下载
                    </Button>
                  )}
                  <Button
                    size="large"
                    icon={<DownloadOutlined />}
                    onClick={() => { window.open(item.strm_url || `/api/strm/${item.id}`, '_blank') }}
                  >
                    下载 STRM
                  </Button>
                  <Button
                    size="large"
                    onClick={() => {
                      navigator.clipboard.writeText(item.stream_url || `/api/stream/${item.id}`)
                      message.success('已复制流媒体链接')
                    }}
                  >
                    复制链接
                  </Button>
                </Space>
                {dlRequested && (
                  <div style={{ marginTop: 12 }}>
                    {browserClient.loading && <div style={{ color: '#1890ff', fontSize: 13 }}><LoadingOutlined /> 正在连接 Telegram...</div>}
                    {browserClient.error && <div style={{ color: '#ff4d4f', fontSize: 13 }}>连接失败: {browserClient.error}</div>}
                    {(dlStatus.state === 'downloading' || dlStatus.state === 'paused') && (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: isDark ? '#999' : '#666', marginBottom: 4 }}>
                          <span>{dlStatus.state === 'paused' ? '已暂停' : '下载中...'}</span>
                          <span>{Math.round(dlStatus.progress * 100)}%</span>
                        </div>
                        <Progress percent={Math.round(dlStatus.progress * 100)} size="small" showInfo={false} style={{ marginBottom: 8 }} />
                        <Space size="small">
                          {dlStatus.state === 'downloading'
                            ? <Button size="small" icon={<PauseCircleOutlined />} onClick={pauseDl}>暂停</Button>
                            : <Button size="small" type="primary" onClick={resumeDl}>继续</Button>}
                          <Button size="small" danger icon={<CloseCircleOutlined />} onClick={() => { cancelDl(); setDlRequested(false) }}>取消</Button>
                        </Space>
                      </div>
                    )}
                    {dlStatus.state === 'done' && (
                      <Space size="small">
                        <span style={{ color: '#52c41a', fontSize: 13 }}>✓ 下载完成</span>
                        <Button size="small" type="link" onClick={() => { setDlRequested(false); dlReset() }}>关闭</Button>
                      </Space>
                    )}
                    {dlStatus.state === 'error' && (
                      <Space size="small">
                        <span style={{ color: '#ff4d4f', fontSize: 13 }}>下载失败: {dlStatus.error}</span>
                        <Button size="small" type="link" onClick={() => { setDlRequested(false); dlReset() }}>关闭</Button>
                      </Space>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 选集列表 */}
          {episodes.length > 1 && (
            <div style={{ marginTop: 32, paddingTop: 24, borderTop: `1px solid ${borderColor}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <UnorderedListOutlined style={{ color: isDark ? '#e0e0e0' : undefined }} />
                <Text strong style={{ fontSize: 16, color: textColor }}>选集列表</Text>
                <Text type="secondary" style={{ color: secondaryColor }}>({episodes.length} 集)</Text>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 8,
              }}>
                {episodes.map((ep, index) => {
                  const isCurrent = ep.id === Number(id)
                  return (
                    <Button
                      key={ep.id}
                      type={isCurrent ? 'primary' : 'default'}
                      onClick={() => !isCurrent && handleEpisodeSwitch(ep.id)}
                      style={{
                        textAlign: 'center',
                        background: isCurrent ? undefined : (isDark ? '#2a2a2a' : '#f5f5f5'),
                        borderColor: isCurrent ? undefined : (isDark ? '#404040' : '#d9d9d9'),
                        color: isCurrent ? undefined : (isDark ? '#e0e0e0' : undefined),
                      }}
                    >
                      第{index + 1}集
                    </Button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </Layout.Content>

      {/* FLOOD_WAIT 错误提示 */}
      {floodWait && (
        <FloodWaitModal
          info={floodWait}
          isDark={isDark}
          onClose={() => setFloodWait(null)}
          onRetry={() => {
            setFloodWait(null)
            // 重新播放（会重新初始化缓存管理器）
            setPlaying(false)
            setTimeout(() => setPlaying(true), 500)
          }}
        />
      )}
    </Layout>
  )
}

// ===== FLOOD_WAIT 提示模态框 =====
function FloodWaitModal({ info, isDark, onClose, onRetry }: {
  info: FloodWaitInfo
  isDark: boolean
  onClose: () => void
  onRetry: () => void
}) {
  const [countdown, setCountdown] = useState(info.waitSeconds)
  const [canRetry, setCanRetry] = useState(info.waitSeconds <= 30)

  useEffect(() => {
    if (info.waitSeconds > 30) {
      // 等待时间超过30秒，不自动重试，只显示提示
      return
    }

    // 开始倒计时
    setCountdown(info.waitSeconds)
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          setCanRetry(true)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [info.waitSeconds])

  const handleRetry = () => {
    onRetry()
  }

  return (
    <Modal
      title={
        <span style={{ color: '#faad14' }}>
          <LoadingOutlined style={{ marginRight: 8 }} />
          Telegram API 限流
        </span>
      }
      open={true}
      closable={canRetry}
      maskClosable={false}
      footer={[
        <Button key="close" onClick={onClose} disabled={!canRetry}>
          关闭
        </Button>,
        <Button key="retry" type="primary" onClick={handleRetry} disabled={!canRetry}>
          {canRetry ? '重试播放' : `请等待 ${countdown} 秒`}
        </Button>,
      ]}
      onCancel={onClose}
      style={{ top: 100 }}
    >
      <div style={{ padding: '16px 0' }}>
        <div style={{ 
          padding: 16, 
          background: isDark ? '#2a2a2a' : '#fff7e6', 
          borderRadius: 8,
          border: `1px solid ${isDark ? '#594214' : '#ffd591'}`,
          marginBottom: 16,
        }}>
          <Text strong style={{ color: '#faad14', fontSize: 16 }}>
            ⚠️ 请求频率过高
          </Text>
          <div style={{ marginTop: 12, color: isDark ? '#e0e0e0' : undefined }}>
            <p>{info.message || `Telegram API 限流，请等待 ${info.waitSeconds} 秒后重试`}</p>
            {info.waitSeconds > 30 && (
              <p style={{ color: '#ff4d4f', marginTop: 8 }}>
                等待时间较长（{info.waitSeconds}秒），建议：
                <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                  <li>使用 Bot Token 模式（如果已配置）</li>
                  <li>下载后本地播放</li>
                  <li>稍后再试</li>
                </ul>
              </p>
            )}
          </div>
        </div>

        {!canRetry && (
          <div style={{ textAlign: 'center' }}>
            <Progress
              type="circle"
              percent={Math.round(((info.waitSeconds - countdown) / info.waitSeconds) * 100)}
              format={() => `${countdown}s`}
              width={80}
              strokeColor="#faad14"
            />
            <div style={{ marginTop: 8, color: '#999' }}>
              自动重试倒计时
            </div>
          </div>
        )}

        {canRetry && (
          <div style={{ 
            padding: 12, 
            background: isDark ? '#1f2a1f' : '#f6ffed',
            borderRadius: 8,
            border: `1px solid ${isDark ? '#237804' : '#b7eb8f'}`,
          }}>
            <Text style={{ color: '#52c41a' }}>
              ✅ 可以重试了！点击"重试播放"按钮继续。
            </Text>
          </div>
        )}
      </div>
    </Modal>
  )
}