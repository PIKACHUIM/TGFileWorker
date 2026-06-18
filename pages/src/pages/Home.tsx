import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Row, Col, Card, Typography, Tag, Space, Button, Select, Input, Layout, Switch } from 'antd'
import { PlayCircleOutlined, UserOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons'
import { getPublicSources, getPublicMedia, authStatus, type Source, type MediaItem } from '../api'
import { useTheme } from '../theme'
import { formatSize, TYPE_COLORS, TYPE_LABELS } from '../utils'

const { Header, Content } = Layout
const { Title, Text } = Typography
const { Search } = Input

export default function Home() {
  const nav = useNavigate()
  const { isDark, mode, setMode } = useTheme()
  const [sources, setSources] = useState<Source[]>([])
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [sourceId, setSourceId] = useState<number | undefined>()
  const [mediaType, setMediaType] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const pageSize = 24

  useEffect(() => {
    authStatus().then(r => {
      if (!r.data.initialized) nav('/init', { replace: true })
      else if (!r.data.allow_guest && !localStorage.getItem('token')) nav('/login', { replace: true })
    }).catch(() => {})
  }, [nav])

  useEffect(() => {
    getPublicSources().then(r => setSources(r.data)).catch(() => {})
  }, [])

  useEffect(() => {
    const params: Record<string, string | number> = { page, pageSize }
    if (sourceId) params.source = sourceId
    if (mediaType) params.type = mediaType
    if (query) params.q = query
    getPublicMedia(params).then(r => {
      setItems(r.data.items)
      setTotal(r.data.total)
    }).catch(() => {})
  }, [page, sourceId, mediaType, query])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 24px', position: 'sticky', top: 0, zIndex: 100 }}>
        <Title level={4} style={{ color: '#fff', margin: 0, flex: 1 }}>Telegram媒体库</Title>
        <Button type="text" icon={<UserOutlined />} style={{ color: '#fff' }} onClick={() => nav('/admin')}>后台</Button>
        <Switch
          checked={isDark}
          checkedChildren={<MoonOutlined />}
          unCheckedChildren={<SunOutlined />}
          onChange={v => setMode(v ? 'dark' : 'light')}
        />
      </Header>
      <Content style={{ padding: '24px' }}>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            allowClear placeholder="全部频道" style={{ width: 180 }}
            onChange={v => { setSourceId(v); setPage(1) }}
            options={sources.map(s => ({ label: s.name, value: s.id }))}
          />
          <Select
            allowClear placeholder="全部类型" style={{ width: 120 }}
            onChange={v => { setMediaType(v); setPage(1) }}
            options={Object.entries(TYPE_LABELS).map(([k, v]) => ({ label: v, value: k }))}
          />
          <Search placeholder="搜索标题/文件名" onSearch={v => { setQuery(v); setPage(1) }} style={{ width: 240 }} allowClear />
        </Space>
        <Row gutter={[16, 16]}>
          {items.map(item => (
            <Col key={item.id} xs={12} sm={8} md={6} lg={4}>
              <Card
                hoverable
                cover={
                  <div style={{ height: 180, overflow: 'hidden', background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                    onClick={() => nav(`/media/${item.id}`)}>
                    {item.cover
                      ? <img src={item.cover} alt={item.title || item.file_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <PlayCircleOutlined style={{ fontSize: 48, color: '#bbb' }} />}
                  </div>
                }
                styles={{ body: { padding: '8px 12px' } }}
                onClick={() => nav(`/media/${item.id}`)}
              >
                <Text strong ellipsis title={item.title || item.file_name} style={{ display: 'block' }}>
                  {item.title || item.file_name}
                </Text>
                <Space style={{ marginTop: 4, flexWrap: 'wrap', gap: 4 }}>
                  <Tag color={TYPE_COLORS[item.media_type]}>{TYPE_LABELS[item.media_type]}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>{formatSize(item.file_size)}</Text>
                  {/* 显示从文件名提取的标签 */}
                  {item.tags && item.tags.split(',').map((tag: string) => (
                    <Tag key={tag} color="orange" style={{ fontSize: 11 }}>{tag}</Tag>
                  ))}
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
        {total > pageSize && (
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Space>
              <Button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button>
              <Text>{page} / {Math.ceil(total / pageSize)}</Text>
              <Button disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(p => p + 1)}>下一页</Button>
            </Space>
          </div>
        )}
      </Content>
    </Layout>
  )
}
