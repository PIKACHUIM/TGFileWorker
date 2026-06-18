import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button, Descriptions, Rate, Space, Tag, Typography, Breadcrumb, Spin, message, Switch, Layout, List } from 'antd'
import { DownloadOutlined, PlayCircleOutlined, FileOutlined, LinkOutlined, MoonOutlined, SunOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { getMediaDetail, getEpisodes, type MediaItem, type EpisodeItem } from '../api'
import { formatSize } from '../utils'
import { useTheme } from '../theme'
import Artplayer from 'artplayer'

const { Title, Paragraph, Text } = Typography

function VideoPlayer({ src, mimeType }: { src: string; mimeType?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const artRef = useRef<Artplayer | null>(null)
  const hlsRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const isHls = mimeType === 'application/x-mpegURL' || src.endsWith('.m3u8')
    const artOptions: any = {
      container: containerRef.current,
      url: src,
      volume: 0.7,
      autoplay: false,
      pip: true,
      fullscreen: true,
      setting: true,
      customType: isHls ? {
        m3u8: (video: HTMLVideoElement, url: string) => {
          import('hls.js').then(({ default: HlsLib }) => {
            if (hlsRef.current) {
              hlsRef.current.destroy()
            }
            const hls = new HlsLib()
            hlsRef.current = hls
            hls.loadSource(url)
            hls.attachMedia(video)
          })
        }
      } : {},
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
  }, [src])

  return <div style={{ width: '100%', height: 0, paddingBottom: '56.25%', position: 'relative' }}>
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
  </div>
}

export default function Detail() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const { isDark, setMode } = useTheme()
  const [item, setItem] = useState<MediaItem | null>(null)
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [showEpisodes, setShowEpisodes] = useState(false)

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
              <VideoPlayer src={item.stream_url || `/api/stream/${item.id}`} mimeType={item.mime_type} />
            </div>
          )}
          {playing && isAudio && (
            <div style={{ marginBottom: 32 }}>
              <audio controls autoPlay style={{ width: '100%' }}>
                <source src={item.stream_url || `/api/stream/${item.id}`} type={item.mime_type || 'audio/mpeg'} />
              </audio>
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
                  {item.has_direct && item.direct_url && (
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
    </Layout>
  )
}
