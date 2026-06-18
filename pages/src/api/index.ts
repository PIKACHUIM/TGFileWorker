import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      // 无 token 时说明是访客模式，不清除也不重定向
      // 有 token 时说明 token 已失效，清除并跳转登录页
      if (localStorage.getItem('token')) {
        localStorage.removeItem('token')
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

// Auth
export const authStatus = () => api.get<{ initialized: boolean; allow_guest: boolean }>('/auth/status')
export const authInit = (username: string, password: string) =>
  api.post('/auth/init', { username, password })
export const authLogin = (username: string, password: string) =>
  api.post<{ token: string; role: string }>('/auth/login', { username, password })
export const authRegister = (username: string, password: string, email: string, code: string) =>
  api.post<{ token: string; role: string }>('/auth/register', { username, password, email, code })
export const sendVerifyCode = (email: string) =>
  api.post<{ ok: boolean }>('/auth/send-code', { email })
export const getPublicSettings = () =>
  api.get<{ allow_login: boolean; allow_register: boolean; allow_guest: boolean }>('/auth/public-settings')

// Sources
export const getSources = () => api.get<Source[]>('/sources')
export const getSource = (id: number) => api.get<Source>(`/sources/${id}`)
export const createSource = (data: Partial<Source>) => api.post('/sources', data)
export const updateSource = (id: number, data: Partial<Source>) => api.put(`/sources/${id}`, data)
export const deleteSource = (id: number) => api.delete(`/sources/${id}`)
export const scanSource = (id: number) => `/api/sources/${id}/scan` // SSE URL

// Admin Media
export const getAdminMedia = (params: Record<string, string | number>) =>
  api.get<{ items: MediaItem[]; total: number }>('/admin/media', { params })
export const updateMedia = (id: number, data: Partial<MediaItem>) =>
  api.put(`/admin/media/${id}`, data)
export const scrapeMedia = (id: number) => api.post(`/admin/media/${id}/scrape`)
export const scrapeAll = (source?: number) =>
  api.post('/admin/media/scrape-all', undefined, { params: source ? { source } : {} })
export const clearSourceMedia = (sourceId: number) =>
  api.delete(`/admin/media/source/${sourceId}`)

// Admin Users
export const getUsers = () => api.get<User[]>('/admin/users')
export const deleteUser = (id: number) => api.delete(`/admin/users/${id}`)
export const updateUserPassword = (id: number, password: string) =>
  api.put(`/admin/users/${id}/password`, { password })

// Settings
export const getSettings = () => api.get<Record<string, string>>('/admin/settings')
export const updateSettings = (data: Record<string, string>) => api.put('/admin/settings', data)

// Public
export const getPublicSources = () => api.get<Source[]>('/media/sources')
export const getPublicMedia = (params: Record<string, string | number>) =>
  api.get<{ items: MediaItem[]; total: number }>('/media', { params })
export const getMediaDetail = (id: number) => api.get<MediaItem>(`/media/${id}`)
export const getEpisodes = (id: number) => api.get<EpisodesResponse>(`/media/${id}/episodes`)

// Session Gen
export const sessionGenStart = (phone: string, api_id: string, api_hash: string) =>
  api.post<{ id: string }>('/session-gen/start', { phone, api_id, api_hash })
export const sessionGenCode = (id: string, code: string) =>
  api.post(`/session-gen/${id}/code`, { code })
export const sessionGenPassword = (id: string, password: string) =>
  api.post(`/session-gen/${id}/password`, { password })
export const sessionGenResult = (id: string) =>
  api.get<{ state: string; session?: string; error?: string }>(`/session-gen/${id}/result`)

// File actions
export const streamUrl = (id: number) => `/api/stream/${id}`
export const directUrl = (id: number) => `/api/direct/${id}`
export const strmUrl = (id: number) => `/api/strm/${id}`

export interface Source {
  id: number
  name: string
  channel_id: string
  type: string
  scan_mode?: string
  api_id?: string
  api_hash?: string
  session_string?: string
  bot_token?: string
  name_regex?: string
  last_scan_message_id: number
  last_scan_at?: number
  created_at: number
}

export interface MediaItem {
  id: number
  source_id: number
  message_id: number
  file_name: string
  file_size: number
  mime_type?: string
  media_type: string
  title?: string
  description?: string
  cover?: string
  release_date?: string
  rating?: number
  genre?: string
  tags?: string
  external_id?: string
  scraped_at?: number
  file_hash: string
  message_date?: number
  created_at: number
  source_name?: string
  channel_id?: string
  has_direct?: boolean
  stream_url?: string
  direct_url?: string | null
  strm_url?: string
}

// 选集列表项
export interface EpisodeItem {
  id: number
  source_id: number
  message_id: number
  file_name: string
  file_size: number
  mime_type: string | null
  media_type: string
  title: string | null
  cover: string | null
  message_date: number | null
  tags: string | null
}

export interface EpisodesResponse {
  items: EpisodeItem[]
  current_id: number
}

export interface User {
  id: number
  username: string
  role: string
  email: string | null
  created_at: number
}

export default api
