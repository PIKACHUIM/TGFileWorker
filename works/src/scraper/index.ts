export interface ScrapeResult {
  title?: string
  description?: string
  cover?: string
  release_date?: string
  rating?: number
  genre?: string
  external_id?: string
}

export type ScrapeSettings = Record<string, string>

export async function scrape(
  mediaType: string,
  fileName: string,
  settings: ScrapeSettings
): Promise<ScrapeResult | null> {
  const name = cleanFileName(fileName)
  console.log(`[Scraper] 开始刮削: mediaType="${mediaType}", fileName="${fileName}", cleanedName="${name}"`)

  if (mediaType === 'video') {
    const { scrapeTMDB } = await import('./tmdb')
    const { scrapeDouban } = await import('./douban')
    // TMDB 刮削器内部实现了智能文件名解析（提取中文/英文/年份/噪声过滤等），
    // 传入原始文件名让它自行解析，避免 cleanFileName 丢失有用信息
    const tmdbResult = await scrapeTMDB(fileName, settings)
    console.log(`[Scraper] TMDB 刮削结果:`, tmdbResult ? `找到 "${tmdbResult.title}"` : '无结果')
    if (tmdbResult) return tmdbResult

    const doubanResult = await scrapeDouban(name, settings)
    console.log(`[Scraper] 豆瓣刮削结果:`, doubanResult ? `找到 "${doubanResult.title}"` : '无结果')
    return doubanResult
  }
  if (mediaType === 'audio') {
    const { scrapeDiscogs } = await import('./discogs')
    const { scrapeMusicBrainz } = await import('./musicbrainz')
    const discogsResult = await scrapeDiscogs(name, settings)
    console.log(`[Scraper] Discogs 刮削结果:`, discogsResult ? `找到 "${discogsResult.title}"` : '无结果')
    if (discogsResult) return discogsResult

    const mbResult = await scrapeMusicBrainz(name, settings)
    console.log(`[Scraper] MusicBrainz 刮削结果:`, mbResult ? `找到 "${mbResult.title}"` : '无结果')
    return mbResult
  }
  if (mediaType === 'book') {
    const { scrapeGoogleBooks } = await import('./books')
    const { scrapeDouban } = await import('./douban')
    const gbooksResult = await scrapeGoogleBooks(name, settings)
    console.log(`[Scraper] Google Books 刮削结果:`, gbooksResult ? `找到 "${gbooksResult.title}"` : '无结果')
    if (gbooksResult) return gbooksResult

    const doubanResult = await scrapeDouban(name, settings)
    console.log(`[Scraper] 豆瓣刮削结果:`, doubanResult ? `找到 "${doubanResult.title}"` : '无结果')
    return doubanResult
  }

  console.log(`[Scraper] 未知的 mediaType="${mediaType}"，无法刮削`)
  return null
}

// 去掉扩展名和常见无用字符
export function cleanFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[._\-\[\]()]+/g, ' ').trim()
}
