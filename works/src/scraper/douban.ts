import type { ScrapeResult, ScrapeSettings } from './index'

// 豆瓣无官方 API，使用搜索页抓取，不稳定，独立模块便于后期替换
export async function scrapeDouban(name: string, settings: ScrapeSettings): Promise<ScrapeResult | null> {
  const cookie = settings['douban_cookie'] || ''
  console.log('[Scrape:Douban] 开始刮削, name:', name, 'cookie已配置:', !!cookie, 'cookie长度:', cookie.length)
  try {
    const searchUrl = `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(name)}`
    console.log('[Scrape:Douban] 请求搜索页, URL:', searchUrl)
    const r = await fetch(
      searchUrl,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Cookie: cookie } }
    )
    console.log('[Scrape:Douban] 搜索页响应状态:', r.status, r.statusText)
    const html = await r.text()
    console.log('[Scrape:Douban] 搜索页HTML长度:', html.length)

    // 检查是否被重定向到登录页/验证页
    if (html.includes('验证码') || html.includes('captcha') || html.includes('登录')) {
      console.log('[Scrape:Douban] ⚠️ 检测到页面包含验证码/登录提示，可能需要配置Cookie')
    }

    // 从搜索结果页提取第一个结果链接
    const linkMatch = html.match(/href="(https:\/\/movie\.douban\.com\/subject\/\d+\/)"/)
    console.log('[Scrape:Douban] 搜索结果链接匹配:', !!linkMatch, linkMatch ? linkMatch[1] : null)
    if (!linkMatch) {
      // 输出页面内容片段帮助诊断
      const snippet = html.substring(0, 500).replace(/\n/g, ' ')
      console.log('[Scrape:Douban] 未找到搜索结果链接，可能原因: 1)搜索无结果 2)页面结构变化 3)Cookie失效导致重定向')
      console.log('[Scrape:Douban] 页面前500字符:', snippet)
      return null
    }

    const detailUrl = linkMatch[1]
    console.log('[Scrape:Douban] 请求详情页, URL:', detailUrl)
    const detail = await fetch(detailUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Cookie: cookie }
    })
    console.log('[Scrape:Douban] 详情页响应状态:', detail.status, detail.statusText)
    const detailHtml = await detail.text()
    console.log('[Scrape:Douban] 详情页HTML长度:', detailHtml.length)

    const title = detailHtml.match(/<span property="v:itemreviewed">([^<]+)<\/span>/)?.[1]
    const cover = detailHtml.match(/<img src="(https:\/\/img\d+\.doubanio\.com\/[^"]+)" title="点击看更多海报"/)?.[1]
    const rating = detailHtml.match(/<strong class="ll rating_num[^"]*"[^>]*>([^<]+)<\/strong>/)?.[1]
    const desc = detailHtml.match(/<span property="v:summary"[^>]*>\s*([\s\S]+?)\s*<\/span>/)?.[1]?.trim()
    const date = detailHtml.match(/<span property="v:initialReleaseDate"[^>]*>([^<(]+)/)?.[1]?.trim()
    const subjectId = detailUrl.match(/\/subject\/(\d+)\//)?.[1]

    console.log('[Scrape:Douban] 解析结果 - 标题:', title?.trim(), '封面:', !!cover, '评分:', rating, '简介长度:', desc?.length, '日期:', date, 'subjectId:', subjectId)

    return {
      title: title?.trim(),
      description: desc,
      cover,
      release_date: date,
      rating: rating ? parseFloat(rating) : undefined,
      external_id: subjectId ? `douban:${subjectId}` : undefined,
    }
  } catch (err) {
    console.error('[Scrape:Douban] 刮削失败, name:', name, '错误:', err)
    return null
  }
}
