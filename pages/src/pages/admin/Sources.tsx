import { useEffect, useState, useRef } from 'react'
import { Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Typography, Tag, Steps } from 'antd'
import { PlusOutlined, ScanOutlined, EditOutlined, DeleteOutlined, LoginOutlined } from '@ant-design/icons'
import { getSources, getSource, createSource, updateSource, deleteSource, scanSource, sessionGenStart, sessionGenCode, sessionGenPassword, sessionGenResult, type Source } from '../../api'

const { Text } = Typography

const TYPE_OPTIONS = [
  { label: '视频', value: 'video' },
  { label: '音频', value: 'audio' },
  { label: '图片', value: 'image' },
  { label: '电子书', value: 'book' },
  { label: '文件', value: 'file' },
]

const SCAN_MODE_OPTIONS = [
  { label: 'Bot API (getUpdates)', value: 'simple_bot_api' },
  { label: 'Bot API (forwardMessage)', value: 'bot_api' },
  { label: 'MTProto (DO Proxy)', value: 'mtproto' },
]

interface ScanState { processed: number; currentFile: string; done: boolean; error?: string }
type LoginStep = 'phone' | 'code' | 'password' | 'done'
interface LoginState { open: boolean; step: LoginStep; genId: string; loading: boolean; phone: string; code: string; password: string; error: string }

// 扫描模式对应的凭证字段配置
const SCAN_MODE_CREDENTIAL_FIELDS: Record<string, { key: string; label: string; type: 'input' | 'textarea'; placeholder: string; required: boolean }[]> = {
  mtproto: [
    { key: 'api_id', label: 'MTProto API ID', type: 'input', placeholder: '如 12345678', required: true },
    { key: 'api_hash', label: 'MTProto API Hash', type: 'input', placeholder: '如 0123456789abcdef0123456789abcdef', required: true },
    { key: 'session_string', label: 'Session String', type: 'textarea', placeholder: '通过 gen-session.mjs 工具生成', required: true },
  ],
  bot_api: [
    { key: 'bot_token', label: 'Bot Token', type: 'input', placeholder: '如 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', required: true },
  ],
  simple_bot_api: [
    { key: 'bot_token', label: 'Bot Token', type: 'input', placeholder: '如 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', required: true },
  ],
}

export default function Sources() {
  const [sources, setSources] = useState<Source[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Source | null>(null)
  const [loading, setLoading] = useState(false)
  const [scanState, setScanState] = useState<Record<number, ScanState>>({})
  const [form] = Form.useForm()
  const esRefs = useRef<Record<number, { close: () => void } | null>>({})
  const [currentScanMode, setCurrentScanMode] = useState<string>('simple_bot_api')
  const savedCredentialsRef = useRef<Record<string, Record<string, string>>>({})
  const [login, setLogin] = useState<LoginState>({ open: false, step: 'phone', genId: '', loading: false, phone: '', code: '', password: '', error: '' })

  function openLoginModal() {
    const { api_id, api_hash } = form.getFieldsValue(['api_id', 'api_hash'])
    if (!api_id || !api_hash) { message.warning('请先填写 API ID 和 API Hash'); return }
    setLogin({ open: true, step: 'phone', genId: '', loading: false, phone: '', code: '', password: '', error: '' })
  }

  async function loginSendCode() {
    const { api_id, api_hash } = form.getFieldsValue(['api_id', 'api_hash'])
    setLogin(l => ({ ...l, loading: true, error: '' }))
    try {
      const r = await sessionGenStart(login.phone, api_id, api_hash)
      setLogin(l => ({ ...l, genId: r.data.id, step: 'code', loading: false }))
    } catch (e: any) {
      setLogin(l => ({ ...l, loading: false, error: e.response?.data?.error || '发送失败' }))
    }
  }

  async function loginSubmitCode() {
    setLogin(l => ({ ...l, loading: true, error: '' }))
    try {
      await sessionGenCode(login.genId, login.code)
      // 轮询结果
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const r = await sessionGenResult(login.genId)
        if (r.data.state === 'done') {
          form.setFieldValue('session_string', r.data.session)
          setLogin(l => ({ ...l, step: 'done', loading: false }))
          return
        }
        if (r.data.state === 'waiting_password') {
          setLogin(l => ({ ...l, step: 'password', loading: false })); return
        }
        if (r.data.state === 'error') {
          setLogin(l => ({ ...l, loading: false, error: r.data.error || '登录失败' })); return
        }
      }
      setLogin(l => ({ ...l, loading: false, error: '超时，请重试' }))
    } catch (e: any) {
      setLogin(l => ({ ...l, loading: false, error: e.response?.data?.error || '验证失败' }))
    }
  }

  async function loginSubmitPassword() {
    setLogin(l => ({ ...l, loading: true, error: '' }))
    try {
      await sessionGenPassword(login.genId, login.password)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const r = await sessionGenResult(login.genId)
        if (r.data.state === 'done') {
          form.setFieldValue('session_string', r.data.session)
          setLogin(l => ({ ...l, step: 'done', loading: false })); return
        }
        if (r.data.state === 'error') {
          setLogin(l => ({ ...l, loading: false, error: r.data.error || '密码错误' })); return
        }
      }
      setLogin(l => ({ ...l, loading: false, error: '超时，请重试' }))
    } catch (e: any) {
      setLogin(l => ({ ...l, loading: false, error: e.response?.data?.error || '验证失败' }))
    }
  }

  // 切换扫描模式时：保存当前模式的凭证值，恢复目标模式的凭证值
  function handleScanModeChange(newMode: string) {
    const oldMode = currentScanMode
    if (oldMode === newMode) return

    // 保存当前模式的凭证值到 ref
    const oldFields = SCAN_MODE_CREDENTIAL_FIELDS[oldMode]?.map(f => f.key) || []
    const currentFormValues = form.getFieldsValue(oldFields)
    savedCredentialsRef.current[oldMode] = {
      ...savedCredentialsRef.current[oldMode],
      ...Object.fromEntries(oldFields.filter(k => currentFormValues[k]).map(k => [k, currentFormValues[k]])),
    }

    // 从 ref 恢复目标模式的凭证值
    const newFields = SCAN_MODE_CREDENTIAL_FIELDS[newMode]?.map(f => f.key) || []
    const saved = savedCredentialsRef.current[newMode] || {}
    const valuesToRestore: Record<string, string> = {}
    newFields.forEach(k => {
      if (saved[k]) valuesToRestore[k] = saved[k]
    })
    form.setFieldsValue(valuesToRestore)
    setCurrentScanMode(newMode)
  }

  const load = () => getSources().then(r => setSources(r.data)).catch(() => {})
  useEffect(() => { load() }, [])

  function openAdd() {
    setEditing(null)
    savedCredentialsRef.current = {}
    form.resetFields()
    form.setFieldsValue({ scan_mode: 'simple_bot_api' })
    setCurrentScanMode('simple_bot_api')
    setOpen(true)
  }

  async function openEdit(s: Source) {
    setEditing(s)
    // 通过详情接口获取完整数据（含凭证字段）
    let detail: Source
    try {
      detail = (await getSource(s.id)).data
    } catch {
      detail = s
    }
    const mode = detail.scan_mode || 'simple_bot_api'
    form.setFieldsValue(detail)
    setCurrentScanMode(mode)

    // 将数据库中各模式的凭证数据存入 ref，用于后续切换模式时恢复
    const creds: Record<string, Record<string, string>> = {}
    for (const [scanMode, fields] of Object.entries(SCAN_MODE_CREDENTIAL_FIELDS)) {
      const modeCreds: Record<string, string> = {}
      fields.forEach(f => {
        const val = (detail as unknown as Record<string, unknown>)[f.key]
        if (val && typeof val === 'string') modeCreds[f.key] = val
      })
      if (Object.keys(modeCreds).length > 0) creds[scanMode] = modeCreds
    }
    savedCredentialsRef.current = creds
    setOpen(true)
  }

  async function onSave() {
    const vals = await form.validateFields()
    setLoading(true)
    try {
      if (editing) await updateSource(editing.id, vals)
      else await createSource(vals)
      message.success('保存成功')
      setOpen(false); load()
    } catch (e: any) {
      message.error(e.response?.data?.error || '保存失败')
    } finally { setLoading(false) }
  }

  function startScan(id: number) {
    if (esRefs.current[id]) return
    setScanState(prev => ({ ...prev, [id]: { processed: 0, currentFile: '连接中...', done: false } }))
    const token = localStorage.getItem('token')
    const url = scanSource(id)
    const abortController = new AbortController()
    esRefs.current[id] = { close: () => abortController.abort() }

    fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abortController.signal,
    }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      function processChunk(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (done) {
            setScanState(prev => {
              const s = prev[id]
              if (s && !s.done) return { ...prev, [id]: { ...s, done: true, error: s.error || '连接关闭' } }
              return prev
            })
            delete esRefs.current[id]
            return
          }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop()!
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const d = JSON.parse(line.slice(6))
              setScanState(prev => ({ ...prev, [id]: { processed: d.processed || 0, currentFile: d.current_file || '', done: !!d.done, error: d.error } }))
              if (d.done) {
                if (!d.error) message.success(`扫描完成，共处理 ${d.processed} 条`)
                delete esRefs.current[id]
                reader.cancel()
                return
              }
            }
          }
          return processChunk()
        })
      }
      processChunk()
    }).catch(() => {
      setScanState(prev => ({ ...prev, [id]: { ...prev[id], done: true, error: '连接错误' } }))
      delete esRefs.current[id]
    })
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '频道', dataIndex: 'channel_id', key: 'channel_id', render: (v: string) => <Text code>{v}</Text> },
    { title: '类型', dataIndex: 'type', key: 'type', render: (v: string) => <Tag>{v}</Tag> },
    { title: '扫描模式', dataIndex: 'scan_mode', key: 'scan_mode', render: (v: string) => {
      if (!v || v === 'auto') return <Tag color="warning">未设置</Tag>
      const mode = SCAN_MODE_OPTIONS.find(o => o.value === v)
      return <Tag>{mode?.label || v}</Tag>
    }},
    { title: '名称正则', dataIndex: 'name_regex', key: 'name_regex', render: (v: string) => {
      if (!v) return <Text type="secondary">默认规则</Text>
      return <Text code style={{ fontSize: 12 }}>{v}</Text>
    }},
    {
      title: '扫描状态', key: 'scan',
      render: (_: unknown, r: Source) => {
        const s = scanState[r.id]
        if (!s) return <Text type="secondary">{r.last_scan_at ? `上次：${new Date(r.last_scan_at * 1000).toLocaleString()}` : '未扫描'}</Text>
        if (s.done && s.error) return <Text type="danger">{s.error}</Text>
        if (s.done) return <Text type="success">已完成，{s.processed} 条</Text>
        return <Space direction="vertical" size={2} style={{ width: 200 }}>
          <Text style={{ fontSize: 12 }} ellipsis>{s.currentFile}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>已处理 {s.processed} 条</Text>
        </Space>
      }
    },
    {
      title: '操作', key: 'action',
      render: (_: unknown, r: Source) => (
        <Space>
          <Button size="small" icon={<ScanOutlined />} onClick={() => startScan(r.id)} loading={!!scanState[r.id] && !scanState[r.id]?.done}>扫描</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
          <Popconfirm title="确认删除该来源及其所有媒体？" onConfirm={async () => { await deleteSource(r.id); load() }}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>来源管理</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加来源</Button>
      </div>
      <Table rowKey="id" dataSource={sources} columns={columns} pagination={false} />

      <Modal
        title={editing ? '编辑来源' : '添加来源'}
        open={open} onOk={onSave} onCancel={() => setOpen(false)} confirmLoading={loading}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="频道 ID / @username" name="channel_id" rules={[{ required: true }]}>
            <Input placeholder="如 -1001234567890 或 @channelname" />
          </Form.Item>
          <Form.Item label="内容类型" name="type" rules={[{ required: true }]}>
            <Select options={TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item label="扫描模式" name="scan_mode" rules={[{ required: true, message: '请选择扫描模式' }]} initialValue="simple_bot_api">
            <Select options={SCAN_MODE_OPTIONS} onChange={handleScanModeChange} />
          </Form.Item>

          {/* 根据扫描模式动态显示凭证字段 */}
          {SCAN_MODE_CREDENTIAL_FIELDS[currentScanMode]?.map(field => (
            <Form.Item
              key={field.key}
              label={field.key === 'session_string'
                ? <Space>{field.label}<Button size="small" icon={<LoginOutlined />} onClick={openLoginModal}>一键登录</Button></Space>
                : field.label}
              name={field.key}
              rules={field.required ? [{ required: true, message: `${field.label} 不能为空` }] : []}
            >
              {field.type === 'textarea' ? (
                <Input.TextArea rows={3} placeholder={field.placeholder} />
              ) : (
                <Input placeholder={field.placeholder} />
              )}
            </Form.Item>
          ))}

          {/* MTProto 模式额外提示 */}
          {currentScanMode === 'mtproto' && (
            <div style={{ padding: '8px 0', color: '#888', fontSize: 12 }}>
              使用 MTProto 协议通过 DO Proxy 连接 Telegram，可获取频道完整历史消息。
              需要提供 api_id、api_hash 和 session_string。
              可使用 <Text code>gen-session.mjs</Text> 脚本生成 session_string。
            </div>
          )}
          {/* Bot API 模式额外提示 */}
          {currentScanMode === 'bot_api' && (
            <div style={{ padding: '8px 0', color: '#888', fontSize: 12 }}>
              使用 Bot API 的 forwardMessage 方式逐条转发消息进行扫描。
              会在频道中创建转发消息然后删除（有副作用）。
              Bot 必须是频道管理员。
            </div>
          )}
          {/* Simple Bot API 模式额外提示 */}
          {currentScanMode === 'simple_bot_api' && (
            <div style={{ padding: '8px 0', color: '#888', fontSize: 12 }}>
              使用 Bot API 的 getUpdates 直接获取频道帖子，无需转发消息（无副作用）。
              Bot 必须是频道管理员。仅能获取最近 24 小时内的更新。
            </div>
          )}

          <Form.Item
            label="名称提取正则"
            name="name_regex"
            tooltip="用于从文件名中提取媒体名称的正则表达式。留空则使用默认规则：自动匹配第一个 #标签、《》或 【】中的内容作为名称，后续 #内容作为标签"
          >
            <Input placeholder="如：^#(.+?)\s 留空则使用默认规则" />
          </Form.Item>
          <div style={{ padding: '0 0 12px', color: '#888', fontSize: 12 }}>
            默认规则：自动匹配第一个 #标签、《》或【】中的内容作为名称，后续 #内容作为标签。
            例如「#飞驰人生3 4K高清 #2026年国产 #喜剧电影」会提取名称「飞驰人生3」，标签「2026年国产,喜剧电影」
          </div>
        </Form>
      </Modal>

      {/* 一键登录弹窗 */}
      <Modal
        title="Telegram 一键登录"
        open={login.open}
        onCancel={() => setLogin(l => ({ ...l, open: false }))}
        footer={null}
        width={420}
      >
        <Steps
          size="small"
          current={{ phone: 0, code: 1, password: 2, done: 2 }[login.step]}
          items={[{ title: '手机号' }, { title: '验证码' }, { title: '完成' }]}
          style={{ marginBottom: 24 }}
        />
        {login.step === 'phone' && (
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="+8613800138000"
              value={login.phone}
              onChange={e => setLogin(l => ({ ...l, phone: e.target.value }))}
              onPressEnter={loginSendCode}
            />
            <Button type="primary" loading={login.loading} onClick={loginSendCode}>发送验证码</Button>
          </Space.Compact>
        )}
        {login.step === 'code' && (
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="输入 Telegram 验证码"
              value={login.code}
              onChange={e => setLogin(l => ({ ...l, code: e.target.value }))}
              onPressEnter={loginSubmitCode}
            />
            <Button type="primary" loading={login.loading} onClick={loginSubmitCode}>确认</Button>
          </Space.Compact>
        )}
        {login.step === 'password' && (
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              placeholder="两步验证密码"
              value={login.password}
              onChange={e => setLogin(l => ({ ...l, password: e.target.value }))}
              onPressEnter={loginSubmitPassword}
            />
            <Button type="primary" loading={login.loading} onClick={loginSubmitPassword}>确认</Button>
          </Space.Compact>
        )}
        {login.step === 'done' && (
          <div style={{ textAlign: 'center', color: '#52c41a' }}>
            登录成功！Session String 已自动填入表单。
            <br />
            <Button type="primary" style={{ marginTop: 12 }} onClick={() => setLogin(l => ({ ...l, open: false }))}>关闭</Button>
          </div>
        )}
        {login.error && <div style={{ color: '#ff4d4f', marginTop: 8 }}>{login.error}</div>}
      </Modal>
    </div>
  )
}