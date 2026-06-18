import { useEffect, useState } from 'react'
import { Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Image, Tag, Typography, InputNumber } from 'antd'
import { EditOutlined, ScissorOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { getSources, getAdminMedia, updateMedia, scrapeMedia, scrapeAll, clearSourceMedia, type Source, type MediaItem } from '../../api'
import { formatSize, TYPE_LABELS, TYPE_OPTIONS } from '../../utils'

const { Text } = Typography

export default function Media() {
  const [sources, setSources] = useState<Source[]>([])
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [sourceFilter, setSourceFilter] = useState<number | undefined>()
  const [typeFilter, setTypeFilter] = useState<string | undefined>()
  const [unscraped, setUnscraped] = useState(false)
  const [editing, setEditing] = useState<MediaItem | null>(null)
  const [scraping, setScraping] = useState(false)
  const [form] = Form.useForm()
  const pageSize = 50

  const load = () => {
    const params: Record<string, string | number> = { page, pageSize }
    if (sourceFilter) params.source = sourceFilter
    if (typeFilter) params.type = typeFilter
    if (unscraped) params.unscraped = 1
    getAdminMedia(params).then(r => { setItems(r.data.items); setTotal(r.data.total) })
  }

  useEffect(() => { getSources().then(r => setSources(r.data)) }, [])
  useEffect(() => { load() }, [page, sourceFilter, typeFilter, unscraped])

  async function onScrapeAll() {
    setScraping(true)
    try {
      const r = await scrapeAll(sourceFilter)
      message.success(`刮削完成：${r.data.done}/${r.data.total} 条成功`)
      load()
    } catch { message.error('批量刮削失败') }
    finally { setScraping(false) }
  }

  async function onScrapeOne(id: number) {
    try {
      await scrapeMedia(id)
      message.success('刮削成功')
      load()
    } catch { message.error('刮削失败') }
  }

  async function onSave() {
    if (!editing) return
    const vals = await form.validateFields()
    await updateMedia(editing.id, vals)
    message.success('保存成功')
    setEditing(null)
    load()
  }

  const columns = [
    {
      title: '封面', key: 'cover', width: 60,
      render: (_: unknown, r: MediaItem) => r.cover
        ? <Image src={r.cover} width={40} height={56} style={{ objectFit: 'cover' }} preview={false} />
        : <div style={{ width: 40, height: 56, background: '#f0f0f0', borderRadius: 4 }} />
    },
    {
      title: '文件名/标题', key: 'title',
      render: (_: unknown, r: MediaItem) => (
        <Space direction="vertical" size={0}>
          <Text strong ellipsis style={{ maxWidth: 200 }}>{r.title || r.file_name}</Text>
          {r.title && <Text type="secondary" style={{ fontSize: 12 }} ellipsis>{r.file_name}</Text>}
        </Space>
      )
    },
    { title: '类型', dataIndex: 'media_type', key: 'type', width: 80, render: (v: string) => <Tag>{TYPE_LABELS[v] || v}</Tag> },
    { title: '大小', dataIndex: 'file_size', key: 'size', width: 90, render: (v: number) => formatSize(v) },
    {
      title: '刮削', key: 'scraped', width: 80,
      render: (_: unknown, r: MediaItem) => r.scraped_at
        ? <Tag color="green">已刮削</Tag>
        : <Tag color="orange">未刮削</Tag>
    },
    {
      title: '操作', key: 'action', width: 180,
      render: (_: unknown, r: MediaItem) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); form.setFieldsValue(r) }}>编辑</Button>
          <Button size="small" icon={<ScissorOutlined />} onClick={() => onScrapeOne(r.id)}>刮削</Button>
        </Space>
      )
    }
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>媒体管理</Typography.Title>
        <Select allowClear placeholder="全部来源" style={{ width: 160 }} onChange={v => { setSourceFilter(v); setPage(1) }}
          options={sources.map(s => ({ label: s.name, value: s.id }))} />
        <Select allowClear placeholder="全部类型" style={{ width: 100 }} onChange={v => { setTypeFilter(v); setPage(1) }}
          options={TYPE_OPTIONS} />
        <Button onClick={() => setUnscraped(v => !v)} type={unscraped ? 'primary' : 'default'}>仅未刮削</Button>
        <Button icon={<ThunderboltOutlined />} loading={scraping} onClick={onScrapeAll}>批量刮削</Button>
        {sourceFilter && (
          <Popconfirm title="确认清空该来源的全部媒体记录？" onConfirm={async () => { await clearSourceMedia(sourceFilter); load() }}>
            <Button danger icon={<DeleteOutlined />}>清空来源媒体</Button>
          </Popconfirm>
        )}
      </div>
      <Table rowKey="id" dataSource={items} columns={columns} size="small"
        pagination={{ current: page, pageSize, total, onChange: setPage, showSizeChanger: false }} />

      <Modal title="编辑媒体信息" open={!!editing} onOk={onSave} onCancel={() => setEditing(null)}>
        <Form form={form} layout="vertical">
          <Form.Item label="标题" name="title"><Input /></Form.Item>
          <Form.Item label="封面图片 URL" name="cover"><Input /></Form.Item>
          <Form.Item label="简介" name="description"><Input.TextArea rows={4} /></Form.Item>
          <Form.Item label="发行日期" name="release_date"><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item label="评分" name="rating"><InputNumber min={0} max={10} step={0.1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="分类/标签" name="genre"><Input /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
