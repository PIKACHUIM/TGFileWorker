import { useEffect, useState } from 'react'
import { Form, Input, Button, Card, message, Typography, Switch, Divider } from 'antd'
import { getSettings, updateSettings } from '../../api'

export default function Settings() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getSettings().then(r => {
      const vals = r.data
      // Switch 组件需要 boolean 值
      form.setFieldsValue({
        ...vals,
        allow_guest: vals.allow_guest === 'true',
        allow_login: vals.allow_login !== 'false', // 默认 true
        allow_register: vals.allow_register !== 'false', // 默认 true
      })
    }).catch(() => {})
  }, [])

  async function onSave() {
    setLoading(true)
    try {
      const vals = await form.validateFields()
      // Switch 值转为字符串存储
      const data: Record<string, string> = {}
      for (const [k, v] of Object.entries(vals)) {
        if (typeof v === 'boolean') {
          data[k] = v ? 'true' : 'false'
        } else {
          data[k] = String(v ?? '')
        }
      }
      await updateSettings(data)
      message.success('设置已保存')
    } catch { message.error('保存失败') }
    finally { setLoading(false) }
  }

  return (
    <div style={{ maxWidth: 600 }}>
      <Typography.Title level={4}>系统设置</Typography.Title>
      <Card>
        <Form form={form} layout="vertical">
          <Typography.Text strong>访问控制</Typography.Text>
          <Form.Item label="允许访客访问" name="allow_guest" extra="开启后，未登录用户可浏览公开媒体库，但不能访问管理后台" valuePropName="checked" style={{ marginTop: 12 }}>
            <Switch />
          </Form.Item>
          <Form.Item label="允许登录" name="allow_login" extra="关闭后，普通用户无法登录（管理员不受影响）" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="允许注册" name="allow_register" extra="关闭后，新用户无法注册账号" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Divider />

          <Typography.Text strong>邮件服务（Resend）</Typography.Text>
          <Form.Item label="Resend API Key" name="resend_api_key" extra="在 https://resend.com 获取 API Key，也可通过 wrangler secret put RESEND_API_KEY 设置" style={{ marginTop: 12 }}>
            <Input.Password placeholder="re_xxxxxxxxxxxx" />
          </Form.Item>
          <Form.Item label="发信域名" name="resend_domain" extra="在 Resend 中验证的域名，用于生成邮件中的应用名称">
            <Input placeholder="example.com" />
          </Form.Item>
          <Form.Item label="发送邮箱" name="resend_from_email" extra="发件人地址，需为 Resend 中已验证的域名邮箱，如 noreply@example.com">
            <Input placeholder="noreply@example.com" />
          </Form.Item>

          <Divider />

          <Typography.Text strong>刮削服务</Typography.Text>
          <Form.Item label="TMDB API Key" name="tmdb_api_key" extra="在 https://www.themoviedb.org/settings/api 申请" style={{ marginTop: 12 }}>
            <Input.Password />
          </Form.Item>
          <Form.Item label="TMDB API 地址" name="tmdb_base_url" extra="可选，留空使用默认 https://api.themoviedb.org，支持反代地址如 example.edgeone.run/api/tmdb">
            <Input placeholder="https://api.themoviedb.org" />
          </Form.Item>
          <Form.Item label="豆瓣 Cookie" name="douban_cookie" extra="用于豆瓣刮削，不稳定，可选">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="Discogs Token" name="discogs_token" extra="在 https://www.discogs.com/settings/tokens 申请，用于音乐刮削">
            <Input.Password />
          </Form.Item>
          <Form.Item label="Discogs API 地址" name="discogs_base_url" extra="可选，留空使用默认 https://api.discogs.com，支持反代地址如 example.edgeone.run/api/discogs">
            <Input placeholder="https://api.discogs.com" />
          </Form.Item>

          <Divider />

          <Typography.Text strong>其他</Typography.Text>
          <Form.Item label="Worker 公开 URL" name="worker_url" extra="用于生成 STRM 文件内容，例如 https://xxx.workers.dev" style={{ marginTop: 12 }}>
            <Input />
          </Form.Item>

          <Button type="primary" onClick={onSave} loading={loading}>保存设置</Button>
        </Form>
      </Card>
    </div>
  )
}
