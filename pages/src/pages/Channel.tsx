import { useEffect, useState, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Row, Col, Card, Typography, Tag, Space, Button, Breadcrumb, Switch, Layout, Badge } from 'antd'
import { PlayCircleOutlined, MoonOutlined, SunOutlined, TeamOutlined } from '@ant-design/icons'
import { getPublicMedia, type MediaItem } from '../api'
import { useTheme } from '../theme'
import { formatSize, TYPE_COLORS, TYPE_LABELS } from '../utils'

const { Header, Content } = Layout
const { Title, Text } = Typography

interface GroupedItem {
  name: string
  firstItem: MediaItem
  count: number
  tags: string[]
}

export default function Channel() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const { isDark, setMode } = useTheme()
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [sourceName, setSourceName] = useState('')
  const [groupByTitle, setGroupByTitle] = useState(true)
  const pageSize = 24

  useEffect(() => {
    getPublicMedia({ source: Number(id), page, pageSize }).then(r => {
      setItems(r.data.items)
      setTotal(r.data.total)
      if (r.data.items[0]?.source_name) setSourceName(r.data.items[0].source_name)
    })
  }, [id, page])

  // 按标题分组
  const groupedItems = useMemo(() => {
    if (!groupByTitle) return null
    const groupMap = new Map<string, GroupedItem>()
    for (const item of items) {
      // 用 title 或 file_name 作为分组 key（去掉 # 前缀和分辨率后缀）
      const rawName = item.title || item.file_name
      const cleanName = rawName
        .replace(/^#+\s?/, '#')
        .replace(/\s*(4K|1080p|720p|高清|超清|HDR).*$/i, '')
        .trim()
      const key = cleanName || rawName
      if (groupMap.has(key)) {
        const group = groupMap.get(key)!
        group.count++
        // 合并标签
        if (item.tags) {
          for (const t of item.tags.split(',')) {
            if (!group.tags.includes(t)) group.tags.push(t)
          }
        }
      } else {
        groupMap.set(key, {
          name: cleanName,
          firstItem: item,
          count: 1,
          tags: item.tags ? item.tags.split(',') : [],
        })
      }
    }
    return Array.from(groupMap.values())
  }, [items, groupByTitle])

  return (
    <Layout style={{ minHeight: '100vh', background: isDark ? '#141414' : '#f5f5f5' }}>
      <Header style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 24px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        background: isDark ? '#1f1f1f' : '#fff',
        borderBottom: `1px solid ${isDark ? '#303030' : '#f0f0f0'}`,
        transition: 'background 0.3s ease, border-color 0.3s ease',
      }}>
        <Breadcrumb items={[
          { title: <a onClick={() => nav('/')} style={{ color: isDark ? '#ddd' : undefined }}>首页</a> },
          { title: <span style={{ color: isDark ? '#ddd' : undefined }}>{sourceName || '频道'}</span> },
        ]} style={{ flex: 1 }} />
        <Space>
          <Text style={{ fontSize: 12, color: isDark ? '#999' : undefined }}>合并选集</Text>
          <Switch
            size="small"
            checked={groupByTitle}
            onChange={setGroupByTitle}
          />
          <Switch
            checked={isDark}
            checkedChildren={<MoonOutlined />}
            unCheckedChildren={<SunOutlined />}
            onChange={v => setMode(v ? 'dark' : 'light')}
          />
        </Space>
      </Header>
      <Content style={{ padding: 24 }}>
        <Title level={4} style={{ marginBottom: 20, color: isDark ? '#e0e0e0' : undefined }}>
          {sourceName}
        </Title>

        {/* 合并模式 */}
        {groupByTitle && groupedItems && (
          <Row gutter={[16, 16]}>
            {groupedItems.map((group, index) => (
              <Col key={group.firstItem.id} xs={12} sm={8} md={6} lg={4}>
                <Card
                  hoverable
                  style={{
                    animation: index < 12 ? `fadeInUp 0.5s ease-out ${index * 0.05}s forwards` : undefined,
                    opacity: index < 12 ? 0 : 1,
                    border: `1px solid ${isDark ? '#303030' : '#f0f0f0'}`,
                    transition: 'transform 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease',
                  }}
                  cover={
                    <div style={{
                      height: 160,
                      background: isDark ? '#262626' : '#f0f0f0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      position: 'relative',
                    }}
                      onClick={() => nav(`/media/${group.firstItem.id}`)}>
                      {group.firstItem.cover
                        ? <img src={group.firstItem.cover} alt={group.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <PlayCircleOutlined style={{ fontSize: 40, color: isDark ? '#555' : '#bbb' }} />}
                      {group.count > 1 && (
                        <Badge count={`${group.count}集`}
                          style={{
                            position: 'absolute', top: 8, right: 8,
                            background: 'rgba(0,0,0,0.7)',
                            fontSize: 11,
                          }}
                        />
                      )}
                    </div>
                  }
                  styles={{ body: { padding: '8px 12px', background: isDark ? '#1f1f1f' : '#fff' } }}
                  onClick={() => nav(`/media/${group.firstItem.id}`)}
                >
                  <Text strong ellipsis style={{ display: 'block', color: isDark ? '#e0e0e0' : undefined }}>
                    {group.name}
                  </Text>
                  <Space style={{ marginTop: 4, flexWrap: 'wrap', gap: 4 }}>
                    <Tag color={TYPE_COLORS[group.firstItem.media_type]}>{TYPE_LABELS[group.firstItem.media_type]}</Tag>
                    {group.count > 1 && (
                      <Tag icon={<TeamOutlined />} color="purple">{group.count}集</Tag>
                    )}
                    {group.tags.slice(0, 2).map(tag => (
                      <Tag key={tag} color="orange" style={{ fontSize: 11 }}>{tag}</Tag>
                    ))}
                    {group.tags.length > 2 && (
                      <Tag style={{ fontSize: 11 }}>+{group.tags.length - 2}</Tag>
                    )}
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        )}

        {/* 非合并模式 - 逐条显示 */}
        {!groupByTitle && (
          <Row gutter={[16, 16]}>
            {items.map((item, index) => (
              <Col key={item.id} xs={12} sm={8} md={6} lg={4}>
                <Card
                  hoverable
                  style={{
                    animation: index < 12 ? `fadeInUp 0.5s ease-out ${index * 0.05}s forwards` : undefined,
                    opacity: index < 12 ? 0 : 1,
                    border: `1px solid ${isDark ? '#303030' : '#f0f0f0'}`,
                    transition: 'transform 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease',
                  }}
                  cover={
                    <div style={{
                      height: 160,
                      background: isDark ? '#262626' : '#f0f0f0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    }}
                      onClick={() => nav(`/media/${item.id}`)}>
                      {item.cover
                        ? <img src={item.cover} alt={item.title || item.file_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <PlayCircleOutlined style={{ fontSize: 40, color: isDark ? '#555' : '#bbb' }} />}
                    </div>
                  }
                  styles={{ body: { padding: '8px 12px', background: isDark ? '#1f1f1f' : '#fff' } }}
                  onClick={() => nav(`/media/${item.id}`)}
                >
                  <Text strong ellipsis style={{ display: 'block', color: isDark ? '#e0e0e0' : undefined }}>
                    {item.title || item.file_name}
                  </Text>
                  <Space style={{ marginTop: 4, flexWrap: 'wrap', gap: 4 }}>
                    <Tag color={TYPE_COLORS[item.media_type]}>{TYPE_LABELS[item.media_type]}</Tag>
                    <Text type="secondary" style={{ fontSize: 12, color: isDark ? '#999' : undefined }}>
                      {formatSize(item.file_size)}
                    </Text>
                    {/* 显示从文件名提取的标签 */}
                    {item.tags && item.tags.split(',').map((tag: string) => (
                      <Tag key={tag} color="orange" style={{ fontSize: 11 }}>{tag}</Tag>
                    ))}
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        )}

        {total > pageSize && (
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Space>
              <Button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button>
              <Text style={{ color: isDark ? '#ccc' : undefined }}>{page} / {Math.ceil(total / pageSize)}</Text>
              <Button disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(p => p + 1)}>下一页</Button>
            </Space>
          </div>
        )}
      </Content>
      <style>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .ant-card-hoverable:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 24px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.1)'};
        }
      `}</style>
    </Layout>
  )
}