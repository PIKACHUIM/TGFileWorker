import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Form, Input, Button, Card, Typography, message, Space, Alert } from 'antd'
import { MailOutlined, SendOutlined } from '@ant-design/icons'
import { authStatus, authRegister, sendVerifyCode, getPublicSettings } from '../api'

const { Title, Text } = Typography

export default function Register() {
  const nav = useNavigate()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [allowRegister, setAllowRegister] = useState(true)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    authStatus().then(r => {
      if (!r.data.initialized) nav('/init', { replace: true })
    }).catch(() => {})
    if (localStorage.getItem('token')) nav('/', { replace: true })

    getPublicSettings().then(r => {
      setAllowRegister(r.data.allow_register)
      setChecking(false)
    }).catch(() => {
      setChecking(false)
    })
  }, [nav])

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  async function onSendCode() {
    const email = form.getFieldValue('email')
    if (!email) {
      message.warning('请先输入邮箱')
      return
    }
    setSendingCode(true)
    try {
      await sendVerifyCode(email)
      message.success('验证码已发送')
      setCountdown(60)
    } catch (err: any) {
      const err_msg = err.response?.data?.error || '发送失败'
      message.error(err_msg)
    } finally {
      setSendingCode(false)
    }
  }

  async function onFinish(values: { username: string; password: string; email: string; code: string }) {
    setLoading(true)
    try {
      const r = await authRegister(values.username, values.password, values.email, values.code)
      localStorage.setItem('token', r.data.token)
      message.success('注册成功')
      nav('/', { replace: true })
    } catch (err: any) {
      const err_msg = err.response?.data?.error || '注册失败'
      message.error(err_msg)
    } finally {
      setLoading(false)
    }
  }

  if (checking) return null

  if (!allowRegister) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Card style={{ width: 400, textAlign: 'center' }}>
          <Alert
            message="注册功能已关闭"
            description="管理员已关闭注册功能，请联系管理员或稍后再试。"
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Link to="/login">返回登录</Link>
        </Card>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card style={{ width: 420 }}>
        <Title level={3} style={{ textAlign: 'center' }}>注册账号</Title>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item label="邮箱" name="email" rules={[
            { required: true, message: '请输入邮箱' },
            { type: 'email', message: '邮箱格式不正确' },
          ]}>
            <Input prefix={<MailOutlined />} placeholder="请输入邮箱" />
          </Form.Item>
          <Form.Item label="验证码" name="code" rules={[{ required: true, message: '请输入验证码' }]}>
            <Space.Compact style={{ width: '100%' }}>
              <Input placeholder="6位验证码" maxLength={6} />
              <Button
                icon={<SendOutlined />}
                loading={sendingCode}
                disabled={countdown > 0}
                onClick={onSendCode}
              >
                {countdown > 0 ? `${countdown}s` : '发送验证码'}
              </Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item label="用户名" name="username" rules={[
            { required: true, message: '请输入用户名' },
            { min: 2, message: '用户名长度不能少于2位' },
          ]}>
            <Input placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[
            { required: true, message: '请输入密码' },
            { min: 6, message: '密码长度不能少于6位' },
          ]}>
            <Input.Password placeholder="请输入密码" />
          </Form.Item>
          <Form.Item label="确认密码" name="confirm" dependencies={['password']} rules={[
            { required: true, message: '请确认密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('password') === value) return Promise.resolve()
                return Promise.reject(new Error('两次密码不一致'))
              },
            }),
          ]}>
            <Input.Password placeholder="请再次输入密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>注册</Button>
          </Form.Item>
          <div style={{ textAlign: 'center' }}>
            <Text>已有账号？</Text> <Link to="/login">立即登录</Link>
          </div>
        </Form>
      </Card>
    </div>
  )
}
