import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Form, Input, Button, Card, Typography, message, Alert } from 'antd'
import { authStatus, authLogin, getPublicSettings } from '../api'

const { Title } = Typography

export default function Login() {
  const nav = useNavigate()
  const [loading, setLoading] = useState(false)
  const [allowLogin, setAllowLogin] = useState(true)
  const [allowRegister, setAllowRegister] = useState(true)
  const [guestAvailable, setGuestAvailable] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    authStatus().then(r => {
      if (!r.data.initialized) nav('/init', { replace: true })
      else if (r.data.allow_guest) setGuestAvailable(true)
    }).catch(() => {})
    if (localStorage.getItem('token')) nav('/', { replace: true })

    getPublicSettings().then(r => {
      setAllowLogin(r.data.allow_login)
      setAllowRegister(r.data.allow_register)
      setChecking(false)
    }).catch(() => {
      setChecking(false)
    })
  }, [nav])

  async function onFinish({ username, password }: { username: string; password: string }) {
    setLoading(true)
    try {
      const r = await authLogin(username, password)
      localStorage.setItem('token', r.data.token)
      nav('/', { replace: true })
    } catch (err: any) {
      const err_msg = err.response?.data?.error || '用户名或密码错误'
      message.error(err_msg)
    } finally {
      setLoading(false)
    }
  }

  if (checking) return null

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card style={{ width: 360 }}>
        <Title level={3} style={{ textAlign: 'center' }}>Telegram媒体库</Title>
        {!allowLogin && (
          <Alert
            message="登录功能已关闭"
            description="管理员已关闭登录功能，请稍后再试。"
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item label="用户名" name="username" rules={[{ required: true }]}>
            <Input disabled={!allowLogin} />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true }]}>
            <Input.Password disabled={!allowLogin} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading} disabled={!allowLogin}>
            登录
          </Button>
        </Form>
        {allowRegister && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            没有账号？ <Link to="/register">立即注册</Link>
          </div>
        )}
        {guestAvailable && (
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <Button type="link" onClick={() => nav('/', { replace: true })}>访客浏览</Button>
          </div>
        )}
      </Card>
    </div>
  )
}
