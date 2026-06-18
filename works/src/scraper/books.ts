import type { ScrapeResult, ScrapeSettings } from './index'

export async function scrapeGoogleBooks(name: string, _settings: ScrapeSettings): Promise<ScrapeResult | null> {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(name)}&maxResults=1&langRestrict=zh`
  console.log('[Scraper:GoogleBooks] 开始刮削，名称:', name, '请求URL:', url)
  try {
    const r = await fetch(url)
    console.log('[Scraper:GoogleBooks] 响应状态:', r.status, r.statusText)
    if (!r.ok) {
      console.error('[Scraper:GoogleBooks] 请求失败，HTTP状态码:', r.status, '状态文本:', r.statusText)
      return null
    }
    const data = await r.json() as any
    console.log('[Scraper:GoogleBooks] API返回项目数:', data?.items?.length ?? 0)
    const item = data?.items?.[0]?.volumeInfo
    if (!item) {
      console.warn('[Scraper:GoogleBooks] 未找到匹配结果，名称:', name)
      return null
    }

    const result = {
      title: item.title,
      description: item.description,
      cover: item.imageLinks?.thumbnail?.replace('http://', 'https://'),
      release_date: item.publishedDate,
      genre: item.categories?.join(', '),
      external_id: data.items[0].id ? `gbooks:${data.items[0].id}` : undefined,
    }
    console.log('[Scraper:GoogleBooks] 刮削成功，标题:', result.title, '封面:', result.cover ?? '无', '发布日期:', result.release_date ?? '无')
    return result
  } catch (e) {
    console.error('[Scraper:GoogleBooks] 刮削异常，名称:', name, '错误:', e)
    return null
  }
}
