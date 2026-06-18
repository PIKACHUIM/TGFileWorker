import type { ScrapeResult, ScrapeSettings } from './index'

export async function scrapeMusicBrainz(name: string, _settings: ScrapeSettings): Promise<ScrapeResult | null> {
  const searchUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(name)}&fmt=json&limit=1`
  console.log('[Scrape:MusicBrainz] 开始刮削，搜索词:', name, '请求URL:', searchUrl)
  try {
    const r = await fetch(
      searchUrl,
      { headers: { 'User-Agent': 'tgfileui-work/1.0 (https://github.com/your/repo)' } }
    )
    console.log('[Scrape:MusicBrainz] 响应状态:', r.status, r.statusText)
    const data = await r.json() as any
    const rec = data?.recordings?.[0]
    if (!rec) {
      console.log('[Scrape:MusicBrainz] 未找到结果，返回recordings数量:', data?.recordings?.length ?? 0)
      return null
    }

    console.log('[Scrape:MusicBrainz] 找到结果，标题:', rec.title, 'ID:', rec.id)
    const artist = rec['artist-credit']?.[0]?.artist?.name
    const release = rec.releases?.[0]
    const coverUrl = release?.id
      ? `https://coverartarchive.org/release/${release.id}/front-250`
      : undefined

    console.log('[Scrape:MusicBrainz] 解析结果 - 艺术家:', artist, '封面:', coverUrl, '发行日期:', release?.date, 'release ID:', release?.id)

    return {
      title: rec.title,
      description: artist ? `艺术家：${artist}` : undefined,
      cover: coverUrl,
      release_date: release?.date,
      external_id: rec.id ? `mb:${rec.id}` : undefined,
    }
  } catch (e) {
    console.error('[Scrape:MusicBrainz] 刮削失败，搜索词:', name, '错误:', e)
    return null
  }
}
