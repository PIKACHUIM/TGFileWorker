import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Card, Typography, message } from 'antd'
import { authStatus, authInit } from '../api'

const { Title, Paragraph } = Typography

export default function Init() {
  const nav = useNavigate()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    authStatus().then(r => {
      if (r.data.initialized) nav('/login', { replace: true })
    }).catch(() => {})
  }, [nav])

  async function onFinish({ username, password }: { username: string; password: string }) {
    setLoading(true)
    try {
      await authInit(username, password)
      message.success('初始化成功，请登录')
      nav('/login', { replace: true })
    } catch (e: any) {
      message.error(e.response?.data?.error || '初始化失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Card style={{ width: 400 }}>
        <Title level={3} style={{ textAlign: 'center' }}>Telegram媒体库 初始化</Title>
        <Paragraph type="secondary" style={{ textAlign: 'center' }}>
          首次使用，请创建管理员账号
        </Paragraph>
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item label="用户名" name="username" rules={[{ required: true }]}>
            <Input placeholder="admin" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, min: 6 }]}>
            <Input.Password placeholder="至少6位" />
          </Form.Item>
          <Form.Item
            label="确认密码" name="confirm"
            dependencies={['password']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator(_, v) {
                  return !v || getFieldValue('password') === v
                    ? Promise.resolve()
                    : Promise.reject('两次密码不一致')
                }
              })
            ]}
          >
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            初始化并创建账号
          </Button>
        </Form>
      </Card>
    </div>
  )
}
