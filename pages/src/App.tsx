import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme as antdTheme, App as AntdApp } from 'antd'
import { ThemeProvider, useTheme } from './theme'
import Init from './pages/Init'
import Login from './pages/Login'
import Register from './pages/Register'
import Home from './pages/Home'
import Channel from './pages/Channel'
import Detail from './pages/Detail'
import AdminLayout from './pages/admin/Layout'
import Sources from './pages/admin/Sources'
import Media from './pages/admin/Media'
import Settings from './pages/admin/Settings'
import Users from './pages/admin/Users'

function ThemedApp() {
  const { isDark } = useTheme()
  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: '#1677ff', borderRadius: 8 },
      }}
    >
      <AntdApp>
        <BrowserRouter>
          <Routes>
            <Route path="/init" element={<Init />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/" element={<Home />} />
            <Route path="/channel/:id" element={<Channel />} />
            <Route path="/media/:id" element={<Detail />} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="/admin/sources" replace />} />
              <Route path="sources" element={<Sources />} />
              <Route path="media" element={<Media />} />
              <Route path="users" element={<Users />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  )
}
