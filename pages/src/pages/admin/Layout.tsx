import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Button, Typography, Switch, message } from 'antd'
import { ApiOutlined, DatabaseOutlined, SettingOutlined, LogoutOutlined, MoonOutlined, SunOutlined, UserOutlined } from '@ant-design/icons'
import { useTheme } from '../../theme'
import { useEffect, useState } from 'react'
import { authStatus } from '../../api'

const { Sider, Content, Header } = Layout

export default function AdminLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const { isDark, setMode } = useTheme()
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    authStatus().then(r => {
      if (!r.data.initialized) nav('/init', { replace: true })
      else if (!r.data.allow_guest && !localStorage.getItem('token')) nav('/login', { replace: true })
    }).catch(() => {})
  }, [nav])

  useEffect(() => {
    // 检查当前用户角色
    try {
      const token = localStorage.getItem('token')
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]))
        if (payload.role === 'admin') {
          setIsAdmin(true)
        } else {
          // 非管理员重定向到首页
          message.warning('无权访问管理后台')
          nav('/', { replace: true })
        }
      } else {
        nav('/login', { replace: true })
      }
    } catch {
      nav('/login', { replace: true })
    }
  }, [nav])

  function logout() {
    localStorage.removeItem('token')
    nav('/login')
  }

  const selectedKey = loc.pathname.split('/')[2] || 'sources'

  if (!isAdmin) return null

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth={0}>
        <div style={{ padding: '16px', color: '#fff', fontWeight: 'bold', fontSize: 16 }}>Telegram媒体库</div>
        <Menu
          theme="dark" mode="inline"
          selectedKeys={[selectedKey]}
          onSelect={({ key }) => nav(`/admin/${key}`)}
          items={[
            { key: 'sources', icon: <ApiOutlined />, label: '来源管理' },
            { key: 'media', icon: <DatabaseOutlined />, label: '媒体管理' },
            { key: 'users', icon: <UserOutlined />, label: '用户管理' },
            { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
          ]}
        />
      </Sider>
      <Layout>
        <Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, padding: '0 24px' }}>
          <Button type="text" onClick={() => nav('/')}>前台</Button>
          <Switch
            checked={isDark}
            checkedChildren={<MoonOutlined />}
            unCheckedChildren={<SunOutlined />}
            onChange={v => setMode(v ? 'dark' : 'light')}
          />
          <Button icon={<LogoutOutlined />} type="text" onClick={logout}>退出</Button>
        </Header>
        <Content style={{ padding: 24, overflowY: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
