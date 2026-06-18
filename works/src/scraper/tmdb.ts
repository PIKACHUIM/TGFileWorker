import type { ScrapeResult, ScrapeSettings } from './index'
import type { TmdbSearchResult, TmdbHit, TitleCandidate } from './tmdb-types'
import {
  MATCH_CONFIDENCE_THRESHOLD,
  FALLBACK_THRESHOLD,
  DESPERATE_THRESHOLD,
} from './tmdb-types'
import {
  parseVideoFileName,
  extractBracketChinese,
  extractCandidates,
  scoreMatch,
  pickEndpoint,
  extractEnglishKeywords,
} from './tmdb-parser'

const TMDB_DEFAULT_BASE_URL = 'https://api.themoviedb.org'
const TMDB_DEFAULT_IMAGE_BASE = 'https://image.tmdb.org'

/**
 * 规范化 TMDB BaseURL
 * 用户只需填写「域名 + API 前缀」，例如：
 *  1. 留空：使用默认 https://api.themoviedb.org
 *  2. 官方：api.themoviedb.org                  -> https://api.themoviedb.org
 *  3. 反代：example.edgeone.run/api/tmdb        -> https://example.edgeone.run/api/tmdb
 *  4. 反代：example.edgeone.run/api/tmdb/       -> https://example.edgeone.run/api/tmdb（自动去尾斜杠）
 */
function normalizeBaseURL(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '')
  if (!base) return TMDB_DEFAULT_BASE_URL
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base
  return base.replace(/\/+$/, '')
}

/**
 * 执行单次 TMDB 搜索请求
 */
async function doTMDBSearch(
  baseURL: string,
  apiKey: string,
  imageBase: string,
  endpoint: string,
  query: string,
  year: string,
  language: string
): Promise<TmdbSearchResult | null> {
  const langParam = language ? `&language=${language}` : ''
  const yearParam = year ? `&year=${year}` : ''
  const searchURL = `${baseURL}/3/search/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(query)}${langParam}${yearParam}`

  console.log(`[Scraper:TMDB] 请求 URL: ${searchURL.replace(apiKey, '***')}`)

  try {
    const r = await fetch(searchURL)
    if (!r.ok) {
      const errorText = await r.text()
      console.log(`[Scraper:TMDB] 请求失败 status=${r.status} url=${searchURL.replace(apiKey, '***')} body=${errorText.substring(0, 200)}`)
      return null
    }

    const data = (await r.json()) as TmdbSearchResult

    // /search/movie /search/tv 返回的结果不带 media_type，需要根据 endpoint 补齐
    if (endpoint === 'movie' || endpoint === 'tv') {
      for (const item of data.results || []) {
        if (!item.media_type) item.media_type = endpoint
      }
    }

    console.log(`[Scraper:TMDB] 响应 status=${r.status} hits=${data?.results?.length ?? 0}`)
    return data
  } catch (err) {
    console.log(`[Scraper:TMDB] 请求异常: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * 带命中校验的多候选搜索
 *
 * 流程：
 *  1. 把候选按 Confidence 排序（中文高 > 中文低 > 英文 > 退化）
 *  2. 对每个候选，最多发 2 次请求：带年份精搜 + 不带年份模糊搜
 *  3. 命中即用 scoreMatch 评分：
 *     - score >= matchConfidenceThreshold (0.60) → 立即返回
 *     - score >= fallbackThreshold (0.30) → 暂存为「最佳兜底」继续尝试
 *     - 其它 → 丢弃
 *  4. 全部尝试完仍无强命中 → 返回最佳兜底；都没有则报错
 *
 * 端点选择：根据原始文件名启发式（含 SxxExx/季/集 -> tv，否则 movie）
 */
async function searchWithFallback(
  baseURL: string,
  apiKey: string,
  imageBase: string,
  rawFileName: string,
  parsed: ReturnType<typeof parseVideoFileName>,
  bracketChinese: string[]
): Promise<{ result: TmdbSearchResult; score: number } | null> {
  const candidates = extractCandidates(parsed, bracketChinese)

  // 按 Confidence 倒序，置信度高的先尝试
  candidates.sort((a, b) => b.confidence - a.confidence)

  const endpoint = pickEndpoint(rawFileName)

  // Debug 输出所有待尝试的候选
  console.log(`[Scraper:TMDB] 候选生成 endpoint=${endpoint} year="${parsed.year}" candidates(${candidates.length}):`)
  candidates.forEach((c, i) => {
    console.log(`[Scraper:TMDB]   #${i + 1} source=${c.source.padEnd(13)} lang=${c.lang.padEnd(5)} conf=${c.confidence.toFixed(2)} name="${c.name}"`)
  })

  if (candidates.length === 0) {
    console.log('[Scraper:TMDB] 无法从文件名中提取有效标题')
    return null
  }

  // 去重
  type AttemptKey = string
  const done = new Set<AttemptKey>()
  let attempts = 0

  let bestFallback: TmdbSearchResult | null = null
  let bestScore = 0
  let bestQuery = ''

  const tryOne = async (
    ep: string,
    q: string,
    year: string,
    lang: string,
    source: string
  ): Promise<{ result: TmdbSearchResult; score: number } | null> => {
    const key: AttemptKey = `${ep}|${q}|${year}|${lang}`
    if (done.has(key)) return null
    done.add(key)
    attempts++

    const result = await doTMDBSearch(baseURL, apiKey, imageBase, ep, q, year, lang)
    if (!result || !result.results || result.results.length === 0) {
      console.log(`[Scraper:TMDB] try [${source}] q="${q}" year="${year}" lang="${lang}" -> 0 hits`)
      return null
    }

    const first = result.results[0]
    const score = scoreMatch(q, year, first)

    const hitTitle = first.title || first.name || ''
    let hitYear = ''
    if (first.release_date && first.release_date.length >= 4) hitYear = first.release_date.substring(0, 4)
    else if (first.first_air_date && first.first_air_date.length >= 4) hitYear = first.first_air_date.substring(0, 4)

    console.log(
      `[Scraper:TMDB] try [${source}] q="${q}" year="${year}" lang="${lang}" -> hit{id=${first.id}, title="${hitTitle}", year=${hitYear}, vote=${first.vote_average}} score=${score.toFixed(2)}`
    )

    return { result, score }
  }

  // 主流程：逐候选搜索
  for (const c of candidates) {
    // 5.1 带年份精搜（如果有年份）
    if (c.year) {
      const res = await tryOne(endpoint, c.name, c.year, c.lang, `${c.source}+y`)
      if (res) {
        if (res.score >= MATCH_CONFIDENCE_THRESHOLD) {
          console.log(`[Scraper:TMDB] ✅ 强命中 (${res.score.toFixed(2)} >= ${MATCH_CONFIDENCE_THRESHOLD}) source=${c.source} q="${c.name}"`)
          return res
        }
        if (res.score >= FALLBACK_THRESHOLD && res.score > bestScore) {
          bestFallback = res.result
          bestScore = res.score
          bestQuery = c.name
        }
      }
    }

    // 5.2 不带年份模糊搜（兜底）
    const res = await tryOne(endpoint, c.name, '', c.lang, c.source)
    if (res) {
      if (res.score >= MATCH_CONFIDENCE_THRESHOLD) {
        console.log(`[Scraper:TMDB] ✅ 强命中 (${res.score.toFixed(2)} >= ${MATCH_CONFIDENCE_THRESHOLD}) source=${c.source} q="${c.name}"`)
        return res
      }
      if (res.score >= FALLBACK_THRESHOLD && res.score > bestScore) {
        bestFallback = res.result
        bestScore = res.score
        bestQuery = c.name
      }
    }
  }

  // 没有强命中但有兜底
  if (bestFallback) {
    console.log(`[Scraper:TMDB] ⚠️ 使用低置信度兜底命中 score=${bestScore.toFixed(2)} q="${bestQuery}" (low confidence < ${MATCH_CONFIDENCE_THRESHOLD})`)
    return { result: bestFallback, score: bestScore }
  }

  // 主流程完全无命中 → 进入「降级重试」阶段
  console.log(`[Scraper:TMDB] 主流程无命中，进入降级重试阶段 attempts=${attempts}`)

  // L2: 主候选换 multi 端点 + 不指定语言 → 匹配 TMDB 全语言别名
  for (let i = 0; i < Math.min(3, candidates.length); i++) {
    const c = candidates[i]
    const res = await tryOne('multi', c.name, '', '', `${c.source}@multi`)
    if (res) {
      if (res.score >= MATCH_CONFIDENCE_THRESHOLD) {
        console.log(`[Scraper:TMDB] ✅ L2 multi 端点强命中 (${res.score.toFixed(2)} >= ${MATCH_CONFIDENCE_THRESHOLD}) q="${c.name}"`)
        return res
      }
      if (res.score >= FALLBACK_THRESHOLD && res.score > bestScore) {
        bestFallback = res.result
        bestScore = res.score
        bestQuery = c.name
      }
    }
  }
  if (bestFallback) {
    console.log(`[Scraper:TMDB] ⚠️ L2 低置信度兜底命中 score=${bestScore.toFixed(2)} q="${bestQuery}"`)
    return { result: bestFallback, score: bestScore }
  }

  // L3: 英文标题提取关键词（去冠词及过短词）重新搜索
  if (parsed.englishTitle) {
    const kw = extractEnglishKeywords(parsed.englishTitle)
    if (kw && kw !== parsed.englishTitle) {
      console.log(`[Scraper:TMDB] L3 英文关键词提取: "${parsed.englishTitle}" -> "${kw}"`)
      for (const ep of [endpoint, 'multi']) {
        const res = await tryOne(ep, kw, '', '', 'keywords-en')
        if (res) {
          if (res.score >= MATCH_CONFIDENCE_THRESHOLD) {
            console.log(`[Scraper:TMDB] ✅ L3 关键词强命中 (${res.score.toFixed(2)} >= ${MATCH_CONFIDENCE_THRESHOLD}) q="${kw}"`)
            return res
          }
          if (res.score >= FALLBACK_THRESHOLD && res.score > bestScore) {
            bestFallback = res.result
            bestScore = res.score
            bestQuery = kw
          }
        }
      }
      if (bestFallback) {
        console.log(`[Scraper:TMDB] ⚠️ L3 低置信度兜底命中 score=${bestScore.toFixed(2)} q="${bestQuery}"`)
        return { result: bestFallback, score: bestScore }
      }
    }
  }

  // L4: 「绝望式」阈值——重试主候选但阈值降到 0.20
  // 说明：部分冷门片 vote_average=0、不同语言别名不及时补录，会被 0.30 阈值误杀，
  // 这里使用更宽的 0.20 阈值接纳（总比空手好）
  console.log(`[Scraper:TMDB] L4 启用绝望式阈值 ${DESPERATE_THRESHOLD} 重试主候选`)
  for (let i = 0; i < Math.min(3, candidates.length); i++) {
    const c = candidates[i]
    for (const ep of [endpoint, 'multi']) {
      const res = await tryOne(ep, c.name, '', '', `${c.source}@desperate`)
      if (res && res.score >= DESPERATE_THRESHOLD && res.score > bestScore) {
        bestFallback = res.result
        bestScore = res.score
        bestQuery = c.name
      }
    }
  }
  if (bestFallback) {
    console.log(`[Scraper:TMDB] ⚠️ L4 绝望式兜底命中 score=${bestScore.toFixed(2)} q="${bestQuery}" (阈值仅 ${DESPERATE_THRESHOLD}，结果可能不准)`)
    return { result: bestFallback, score: bestScore }
  }

  const titleInfo = parsed.chineseTitle || parsed.englishTitle || rawFileName
  console.log(`[Scraper:TMDB] ❌ 刮削失败: TMDB未找到匹配结果 "${titleInfo}"`)
  return null
}

/**
 * TMDB 视频刮削器
 *
 * 参考 OpenList 的刮削逻辑，实现：
 *   - 文件名解析：从文件名中提取中文标题、英文标题和年份
 *   - 多候选搜索：按优先级尝试不同的搜索词组合
 *   - 匹配评分：使用 scoreMatch 计算匹配度，选择阈值较高的结果
 *   - 多级降级：主流程 → L2 multi → L3 关键词 → L4 绝望式
 */
export async function scrapeTMDB(name: string, settings: ScrapeSettings): Promise<ScrapeResult | null> {
  const apiKey = settings['tmdb_api_key']
  if (!apiKey) {
    console.log('[Scraper:TMDB] API key 未配置，跳过刮削')
    return null
  }

  const baseURL = normalizeBaseURL(settings['tmdb_base_url'] || '')
  // 如果使用代理地址，图片地址也基于代理地址拼接（代理通常会转发 image.tmdb.org 请求）
  // 否则使用默认的 image.tmdb.org
  const isProxy = baseURL !== TMDB_DEFAULT_BASE_URL
  const imageBase = isProxy ? `${baseURL}/image` : TMDB_DEFAULT_IMAGE_BASE

  // 始终从文件名中解析出标题和年份
  const parsed = parseVideoFileName(name)
  // 在剥离括号前再次抽一次方括号中文，作为最高置信度候选源
  const bracketChinese = extractBracketChinese(name)

  console.log(
    `[Scraper:TMDB] 开始刮削 file="${name}" parsed={chinese="${parsed.chineseTitle}", english="${parsed.englishTitle}", year="${parsed.year}", extras=${JSON.stringify(parsed.extraChineseTitles)}, bracket=${JSON.stringify(bracketChinese)}} baseURL=${baseURL}`
  )

  try {
    // 搜索策略：中文标题优先，英文标题兜底，都搜不到才失败
    const searchResult = await searchWithFallback(baseURL, apiKey, imageBase, name, parsed, bracketChinese)

    if (!searchResult) {
      console.log(`[Scraper:TMDB] ❌ 刮削失败 file="${name}"`)
      return null
    }

    // 取第一个结果（searchWithFallback 已经做了评分和筛选）
    const first = searchResult.result.results[0]
    const mediaType = first.media_type || 'movie'

    console.log(`[Scraper:TMDB] 匹配结果: id=${first.id}, title="${first.title || first.name}", media_type=${mediaType}, poster_path=${first.poster_path ?? '无'}, score=${searchResult.score.toFixed(2)}`)

    // 获取详情
    const detailURL = `${baseURL}/3/${mediaType}/${first.id}?api_key=${apiKey}&language=zh-CN&append_to_response=credits`
    console.log(`[Scraper:TMDB] 详情请求: ${detailURL.replace(apiKey, '***')}`)

    const detailResp = await fetch(detailURL)
    if (!detailResp.ok) {
      // 详情获取失败，仍然返回基本信息
      console.log(`[Scraper:TMDB] 详情请求失败 status=${detailResp.status}，使用搜索结果基本信息`)
      return {
        title: first.title || first.name,
        description: first.overview,
        cover: first.poster_path ? `${imageBase}/t/p/w500${first.poster_path}` : undefined,
        release_date: first.release_date || first.first_air_date,
        rating: first.vote_average,
        genre: undefined,
        external_id: String(first.id),
      }
    }

    const detail = (await detailResp.json()) as any

    const title = detail.title || detail.name || first.title || first.name
    const result: ScrapeResult = {
      title,
      description: detail.overview || first.overview,
      cover: detail.poster_path ? `${imageBase}/t/p/w500${detail.poster_path}` : first.poster_path ? `${imageBase}/t/p/w500${first.poster_path}` : undefined,
      release_date: detail.release_date || detail.first_air_date || first.release_date || first.first_air_date,
      rating: detail.vote_average || first.vote_average,
      genre: detail.genres?.map((g: any) => g.name).join(','),
      external_id: String(detail.id || first.id),
    }

    console.log(`[Scraper:TMDB] 刮削成功 title="${result.title}" cover=${result.cover ? '有' : '无'} rating=${result.rating}`)
    return result
  } catch (err) {
    console.log(`[Scraper:TMDB] 刮削异常: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
