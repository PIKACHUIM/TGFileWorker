import type { ScrapeResult, ScrapeSettings } from './index'

const DISCOGS_DEFAULT_BASE_URL = 'https://api.discogs.com'

/**
 * 规范化 Discogs BaseURL
 * 用户只需填写「域名 + API 前缀」，例如：
 *  1. 留空：使用默认 https://api.discogs.com
 *  2. 官方：api.discogs.com                  -> https://api.discogs.com
 *  3. 反代：example.edgeone.run/api/discogs  -> https://example.edgeone.run/api/discogs
 *  4. 反代：example.edgeone.run/api/discogs/ -> https://example.edgeone.run/api/discogs（自动去尾斜杠）
 */
function normalizeBaseURL(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '')
  if (!base) return DISCOGS_DEFAULT_BASE_URL
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base
  return base.replace(/\/+$/, '')
}

/**
 * 从音乐文件名中提取搜索关键词列表
 * 规则：去掉扩展名后，按" - "或"-"分割，返回各部分作为候选搜索词
 * 例如：
 *   "周杰伦 - 七里香.mp3"  -> ["周杰伦 - 七里香", "周杰伦", "七里香"]
 *   "Coldplay-Yellow.flac" -> ["Coldplay-Yellow", "Coldplay", "Yellow"]
 *   "七里香.mp3"           -> ["七里香"]
 */
function parseMusicFileName(fileName: string): string[] {
  // 去掉扩展名
  const dotIdx = fileName.lastIndexOf('.')
  if (dotIdx > 0 && fileName.length - dotIdx <= 5) {
    fileName = fileName.substring(0, dotIdx)
  }
  fileName = fileName.trim()
  if (!fileName) return []

  const queries: string[] = [fileName]

  // 按" - "（带空格）分割
  const parts1 = fileName.split(' - ')
  if (parts1.length >= 2) {
    const before = parts1[0]!.trim()
    const after = parts1.slice(1).join(' - ').trim()
    if (before) queries.push(before)
    if (after) queries.push(after)
  } else {
    // 按"-"（不带空格）分割
    const parts2 = fileName.split('-')
    if (parts2.length >= 2) {
      const before = parts2[0]!.trim()
      const after = parts2.slice(1).join('-').trim()
      if (before) queries.push(before)
      if (after) queries.push(after)
    }
  }

  return queries
}

interface DiscogsSearchResult {
  results?: {
    id: number
    title: string
    type: string
    year?: string
    thumb?: string
    cover_image?: string
    genre?: string[]
    style?: string[]
    resource_url?: string
  }[]
}

interface DiscogsReleaseDetail {
  id: number
  title: string
  year?: number
  cover_image?: string
  notes?: string
  artists?: { name: string }[]
  genres?: string[]
  styles?: string[]
  tracklist?: { position: string; title: string; duration: string }[]
  community?: {
    rating?: { average?: number }
  }
}

export async function scrapeDiscogs(name: string, settings: ScrapeSettings): Promise<ScrapeResult | null> {
  const token = settings['discogs_token']
  if (!token) {
    console.log('[Scrape:Discogs] 未配置 discogs_token，跳过')
    return null
  }

  const baseURL = normalizeBaseURL(settings['discogs_base_url'] || '')
  console.log('[Scrape:Discogs] baseURL:', baseURL)

  // 构建候选搜索词列表
  const queries = parseMusicFileName(name)
  console.log('[Scrape:Discogs] 原始文件名:', name, '候选搜索词:', queries)
  if (queries.length === 0) {
    console.log('[Scrape:Discogs] 无有效候选搜索词，返回 null')
    return null
  }

  // 依次尝试各候选词，找到结果即停止
  let searchResult: DiscogsSearchResult['results'] | undefined
  for (const q of queries) {
    try {
      const searchURL = `${baseURL}/database/search?q=${encodeURIComponent(q)}&type=release&token=${token}`
      console.log('[Scrape:Discogs] 尝试搜索词:', q, 'URL:', searchURL.replace(token, '***'))
      const r = await fetch(searchURL, {
        headers: { 'User-Agent': 'tgfileui-work/1.0 (+https://github.com/your/repo)' },
      })
      console.log('[Scrape:Discogs] 搜索响应状态:', r.status)
      const data = (await r.json()) as DiscogsSearchResult
      console.log('[Scrape:Discogs] 搜索结果数:', data.results?.length ?? 0)
      if (data.results && data.results.length > 0) {
        searchResult = data.results
        break
      }
    } catch (e) {
      console.log('[Scrape:Discogs] 搜索词', q, '请求失败:', e)
      continue
    }
  }

  if (!searchResult || searchResult.length === 0) {
    console.log('[Scrape:Discogs] 所有候选搜索词均无结果，返回 null')
    return null
  }

  const first = searchResult[0]!
  console.log('[Scrape:Discogs] 首个搜索结果 id:', first.id, 'title:', first.title)

  // 获取详情
  let detail: DiscogsReleaseDetail | null = null
  try {
    const detailURL = `${baseURL}/releases/${first.id}?token=${token}`
    console.log('[Scrape:Discogs] 获取详情 URL:', detailURL.replace(token, '***'))
    const detailR = await fetch(detailURL, {
      headers: { 'User-Agent': 'tgfileui-work/1.0 (+https://github.com/your/repo)' },
    })
    console.log('[Scrape:Discogs] 详情响应状态:', detailR.status)
    detail = (await detailR.json()) as DiscogsReleaseDetail
  } catch (e) {
    console.log('[Scrape:Discogs] 获取详情失败:', e, '，将使用搜索结果中的基本信息')
    // 详情获取失败，使用搜索结果中的基本信息
  }

  // 优先使用详情数据
  const artists = detail?.artists?.map((a) => a.name) ?? []
  const genres = [...(detail?.genres ?? []), ...(detail?.styles ?? [])]
  const coverImage = detail?.cover_image ?? first.cover_image ?? first.thumb

  return {
    title: detail?.title ?? first.title,
    description: detail?.notes
      ?? (artists.length > 0 ? `艺术家：${artists.join(', ')}` : undefined),
    cover: coverImage,
    release_date: detail?.year
      ? `${detail.year}-01-01`
      : first.year
        ? `${first.year}-01-01`
        : undefined,
    rating: detail?.community?.rating?.average,
    genre: genres.length > 0 ? genres.join(', ') : undefined,
    external_id: (detail?.id ?? first.id) ? `discogs:${detail?.id ?? first.id}` : undefined,
  }
}
