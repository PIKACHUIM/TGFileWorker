// TMDB 文件名解析、标题候选生成和模糊匹配评分逻辑
// 移植自 OpenList 项目的 Go 代码 scraper/tmdb.go

import {
  ParsedVideoTitle,
  TitleCandidate,
  TmdbHit,
  CN_NUM_MAP,
  ARABIC_TO_CN_NUM,
  NOISE_TOKEN_REGEXP,
  NOISE_TOKEN_WHOLE_REGEXP,
  CHINESE_GARBAGE_CONTAINS_RE,
  CHINESE_RELEASE_GROUP_RE,
  LEADING_SERIAL_SPACE_RE,
  LEADING_SERIAL_DOT_CHINESE_RE,
  TRAILING_NUM_RE,
  TRAILING_ROMAN_RE,
  SUBTITLE_SEP_RE,
  TV_HINT_RE,
  CHINESE_REGEXP,
  YEAR_REGEXP,
  ENGLISH_STOPWORDS,
} from './tmdb-types'

// ======================== 文件名解析 ========================

/**
 * 从视频文件名中提取标题和年份
 *
 * 规则：
 *   - 自动去除文件名开头的序号（如 "01 "、"1."、"169."），避免污染英文标题
 *   - 优先把方括号 [中文] 内的中文片段作为中文标题候选
 *   - 文件名中允许使用 . / 空格 / _ / - 分隔多个字段
 *   - 第一个含中文的片段即为中文标题（若上一步括号内未找到中文）
 *   - 中文标题之前的非中文、非年份片段拼接为英文标题
 *   - 第一个 1900-2099 之间的 4 位数字识别为年份
 *
 * 例如：
 *   "Inception.2010.盗梦空间.双语字幕.HR-HDTV.AC3.1024X576.X264-" -> {english:"Inception", chinese:"盗梦空间", year:"2010"}
 *   "Iron.Man.3.2013.钢铁侠3.国英音轨.双语字幕.HR-HDTV.AC3.x264-" -> {english:"Iron Man 3", chinese:"钢铁侠3", year:"2013"}
 *   "The.Dark.Knight.2008.1080p.BluRay"                            -> {english:"The Dark Knight", chinese:"", year:"2008"}
 *   "盗梦空间.2010.1080p.BluRay"                                    -> {english:"", chinese:"盗梦空间", year:"2010"}
 *   "01 [钢铁侠]Iron.Man.2008.2160p.HDR.BluRay..."                  -> {english:"Iron Man", chinese:"钢铁侠", year:"2008"}
 */
export function parseVideoFileName(fileName: string): ParsedVideoTitle {
  // 去掉扩展名（.mkv .mp4 .avi 等，扩展名长度 <= 5）
  const lastDotIdx = fileName.lastIndexOf('.')
  if (lastDotIdx > 0) {
    const ext = fileName.substring(lastDotIdx).toLowerCase()
    if (ext.length <= 5) {
      fileName = fileName.substring(0, lastDotIdx)
    }
  }

  // 1) 先把开头的序号 "01 "、"1."、"169." 去掉，避免它们污染英文标题
  //    仅在能明确判定为序号的场景才剥离
  fileName = stripLeadingSerial(fileName)

  // 2) 在剥离括号之前，先尝试从方括号 [中文] 中抽取中文标题候选
  //    很多发布组习惯是 "01 [中文标题]English.Title.Year..."
  const bracketChinese = extractBracketChinese(fileName)

  // 3) 提取括号中的年份（如 "钢铁侠3 (2013).mkv"），把年份替换到括号外
  fileName = fileName.replace(/[（(\[【]\s*((?:19|20)\d{2})\s*[）)\]】]/g, ' $1 ')

  // 4) 再把剩余括号块替换成空格（其中的中文标题已在第 2 步保存到 bracketChinese）
  fileName = fileName.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ' ')

  // 把多种分隔符统一成 "."，方便后续按 "." 解析
  // 注意：中文之间通常没分隔符，应保留；这里只把 "." 之外的分隔符换成 "."
  fileName = fileName.replace(/[_+]/g, '.')

  // 把空格、" - " 也作为分隔符
  fileName = fileName.replace(/\s+/g, '.')
  fileName = fileName.replace(/-/g, '.')

  // 按"."分割各字段
  const parts = fileName.split('.')

  const result: ParsedVideoTitle = {
    englishTitle: '',
    chineseTitle: '',
    extraChineseTitles: [],
    year: '',
  }

  const englishParts: string[] = []
  const chineseParts: string[] = [] // 收集所有中文片段，便于兜底
  let foundYear = false
  let foundChinese = false // 一旦出现中文片段，后面的非中文片段都不再加入英文标题

  // pureNoise 判断字符串经过噪声词清洗后是否为空（即整体都是噪声词）
  // 用于过滤掉"双语字幕"、"国英音轨" 这种纯噪声片段，避免被当成中文标题
  function pureNoise(s: string): boolean {
    const cleaned = s.replace(NOISE_TOKEN_REGEXP, '').trim()
    return cleaned === ''
  }

  // isChineseReleaseGroup 判断中文片段是否为字幕组/压制组名
  // 这类片段绝不应该被当成片名候选（如 "人人影视"、"YYeTs"、"飞鸟影视"）
  function isChineseReleaseGroup(s: string): boolean {
    s = s.trim()
    if (!s) return false
    if (CHINESE_RELEASE_GROUP_RE.test(s)) return true
    if (CHINESE_GARBAGE_CONTAINS_RE.test(s)) return true
    return false
  }

  for (const p of parts) {
    const trimmed = p.trim()
    if (!trimmed) continue

    // 检测是否含中文
    if (CHINESE_REGEXP.test(trimmed)) {
      // 整体被识别为噪声词的中文片段（如 "双语字幕"、"国英音轨"）直接跳过
      if (pureNoise(trimmed)) continue

      // 字幕组/压制组中文名（如 "人人影视"、"飞鸟影院"）也直接跳过
      if (isChineseReleaseGroup(trimmed)) continue

      chineseParts.push(trimmed)
      foundChinese = true
      continue
    }

    // 检测是否为年份（1900-2099）
    if (YEAR_REGEXP.test(trimmed) && !foundYear) {
      const yearMatch = trimmed.match(YEAR_REGEXP)
      if (yearMatch) {
        result.year = yearMatch[1]
        foundYear = true
        // 年份本身不加入英文标题
        continue
      }
    }

    // 后续非中文片段加入英文标题的判定：
    //   - 必须在年份出现之前（年份后的 ASCII 全是发布信息噪声）
    //   - 必须在中文出现之前（中文后的 ASCII 也是发布信息噪声，避免 "斯巴达勇士 HR HDTV AC3 X264" 这种污染）
    //   - 不能是完全的噪声词（如 HR-HDTV、AC3、x264、分辨率）
    if (foundYear || foundChinese) continue

    if (isNoiseToken(trimmed)) continue

    englishParts.push(trimmed)
  }

  result.englishTitle = englishParts.join(' ')

  // 选定中文标题：
  //   - 优先使用方括号内的中文（最可靠的发布组标记）
  //   - 否则使用解析出的中文片段中第一个
  //   - 同时把所有中文候选去重保留到 ExtraChineseTitles 里，留作兜底
  if (bracketChinese.length > 0) {
    result.chineseTitle = bracketChinese[0]
    result.extraChineseTitles = [...new Set([...bracketChinese.slice(1), ...chineseParts])]
  } else if (chineseParts.length > 0) {
    result.chineseTitle = chineseParts[0]
    result.extraChineseTitles = [...new Set(chineseParts.slice(1))]
  }

  return result
}

// ======================== 标题解析辅助函数 ========================

/**
 * 去除文件名开头的序号前缀
 *
 * 处理两种序号情况：
 *   1. "数字 + 空格"：如 "01 [钢铁侠]Iron.Man..." -> "[钢铁侠]Iron.Man..."
 *   2. "1-2 位数字 + 点/-/_/、 + 中文"：如 "1.漫威短片..." -> "漫威短片..."、"169.谍影重重3" -> "谍影重重3"
 *
 * 不视为序号（保留原样）：
 *   - "30.Days.Of.Night..."（数字 + 点 + 英文，数字是片名一部分）
 *   - "300.Rise.Of.An.Empire..."（同上）
 *   - "300.斯巴达勇士..."（3 位数字 + 点 + 中文，可能是片名 "300"）
 *   - "3096.Days.2013..."（4 位数字直接被排除）
 */
export function stripLeadingSerial(s: string): string {
  // 1) "数字 + 空格"：稳定删除（序号信号最强）
  const spaceMatch = LEADING_SERIAL_SPACE_RE.exec(s)
  if (spaceMatch && spaceMatch.index === 0) {
    return s.substring(spaceMatch[0].length).trim()
  }

  // 2) "1-2 位数字 + 分隔符 + 中文"：视为序号删除；3 位数字保守保留
  const dotMatch = LEADING_SERIAL_DOT_CHINESE_RE.exec(s)
  if (dotMatch && dotMatch.index === 0) {
    const numStr = dotMatch[1]
    // 3 位数字保守保留（避免删除 "300.斯巴达勇士" 中的 "300"）
    if (numStr.length >= 3) return s
    // 1-2 位数字视为序号删除，从中文字符位置开始保留
    return s.substring(dotMatch[0].length - dotMatch[2].length).trim()
  }

  return s
}

/**
 * 从原始文件名中提取出方括号/中文括号里的中文片段
 *
 * "01 [钢铁侠]Iron.Man.2008..."          -> ["钢铁侠"]
 * "19 [复仇者联盟3：无限战争]Avengers..." -> ["复仇者联盟3：无限战争"]
 * "[Pixar][玩具总动员]Toy.Story.1995..."  -> ["玩具总动员"]
 *
 * 仅返回包含中文的括号内容，避免把发布组、字幕组等英文括号信息当成标题
 */
export function extractBracketChinese(fileName: string): string[] {
  const bracketRe = /[（(\[【]([^）)\]】]*)[）)\]】]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = bracketRe.exec(fileName)) !== null) {
    const inner = m[1].trim()
    if (!inner) continue
    // 必须包含中文字符才视为中文标题候选
    if (CHINESE_REGEXP.test(inner)) {
      out.push(inner)
    }
  }
  return out
}

/**
 * 判断一个片段是否是完全的噪声词
 * 覆盖常见发布组/字幕组/编码/音轨/分辨率/语言标记等
 */
export function isNoiseToken(p: string): boolean {
  if (!p) return true
  return NOISE_TOKEN_WHOLE_REGEXP.test(p)
}

// ======================== 中文数字转换 ========================

/**
 * 将标题中的中文数字归一化为阿拉伯数字（仅做轻量处理）
 * 用于「钢铁侠三」->「钢铁侠3」类的归一化
 */
export function cnNumToArabic(s: string): string {
  if (!s) return s
  // 仅当字符串包含中文且数字是单个字符时才转换
  if (!CHINESE_REGEXP.test(s)) return s

  return s.replace(/[〇零一二三四五六七八九十]/g, (match) => {
    const v = CN_NUM_MAP[match]
    return v !== undefined ? v : match
  })
}

/**
 * 将标题中的单个阿拉伯数字归一化为中文数字
 * 用于「钢铁侠3」-> 「钢铁侠三」，提升 TMDB 中文别名命中率
 * 仅替换孤立的单个数字（前后非数字）
 */
export function arabicToCnNum(s: string): string {
  if (!s) return s
  if (!CHINESE_REGEXP.test(s)) return s

  const chars = [...s]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (c >= '0' && c <= '9') {
      // 检查是否是孤立的单个数字（前后不是数字）
      const prevDigit = i > 0 && chars[i - 1] >= '0' && chars[i - 1] <= '9'
      const nextDigit = i + 1 < chars.length && chars[i + 1] >= '0' && chars[i + 1] <= '9'
      if (!prevDigit && !nextDigit) {
        const cnNum = ARABIC_TO_CN_NUM[c]
        result.push(cnNum !== undefined ? cnNum : c)
        continue
      }
    }
    result.push(c)
  }
  return result.join('')
}

// ======================== 标题候选生成 ========================

/**
 * 根据原始标题构造一组候选搜索词（按优先级返回）
 *
 * 候选生成策略，从精确到模糊：
 *   1. 原始标题（保留所有信息）
 *   2. 归一化标题（去括号/噪声词/分隔符 -> 空格合并）
 *   3. 中文数字 -> 阿拉伯数字（钢铁侠三 -> 钢铁侠3）
 *   4. 阿拉伯数字 -> 中文数字（钢铁侠3 -> 钢铁侠三，少数 TMDB 别名用中文数字）
 *   5. 去除尾部数字/罗马数字（钢铁侠3 -> 钢铁侠，盗梦空间2 -> 盗梦空间）
 *   6. 拆分多个词，每个非短词作为独立候选
 *   7. 副标题拆分（「复仇者联盟3：无限战争」 -> 「复仇者联盟3」、「无限战争」）
 */
export function buildTitleCandidates(title: string): string[] {
  if (!title) return []

  const seen = new Set<string>()
  const out: string[] = []

  const add = (s: string) => {
    s = s.trim()
    if (!s || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }

  add(title)

  // 归一化标题
  const norm = normalizeTitle(title)
  add(norm)

  // 副标题拆分：以「：」「:」「-」分隔后得到多个候选
  // 例：「复仇者联盟3：无限战争」-> 主标题 "复仇者联盟3"、副标题 "无限战争"
  const subtitleParts = title.split(SUBTITLE_SEP_RE)
  if (subtitleParts.length > 1) {
    for (const p of subtitleParts) {
      add(p)
    }
  }

  // 中文数字 <-> 阿拉伯数字 双向归一化
  const arabic = cnNumToArabic(norm)
  add(arabic)
  add(arabicToCnNum(norm))

  // 去除尾部数字（系列编号），帮助匹配主作品
  // 例：「钢铁侠3」-> 「钢铁侠」、「Iron Man 3」-> 「Iron Man」
  // 这条对 title / norm / arabic 三者都做，提升 TMDB 中文别名不带后缀作品的命中率
  for (const src of [title, norm, arabic]) {
    if (!src) continue
    add(TRAILING_NUM_RE.test(src) ? src.replace(TRAILING_NUM_RE, '') : src)
  }

  // 去除尾部罗马数字（II / III / IV 等）
  for (const src of [title, norm, arabic]) {
    if (!src) continue
    add(TRAILING_ROMAN_RE.test(src) ? src.replace(TRAILING_ROMAN_RE, '') : src)
  }

  // 若中文标题里夹杂了空格分隔的多个词，把每个非短词单独作为候选
  for (const w of norm.split(/\s+/)) {
    if (w.length >= 2) add(w)
  }
  // 阿拉伯数字归一化版本同样拆词
  for (const w of arabic.split(/\s+/)) {
    if (w.length >= 2) add(w)
  }

  // 数字 + 中文 / 中文 + 数字 的组合标题，把中文部分单独提取作为候选
  // 例：「300勇士」     -> 候选包含 "勇士"
  //     「36总局」      -> 候选包含 "总局"
  const digitChineseRe = /^(\d+)([\u4e00-\u9fff].*)$/
  const chineseDigitRe = /^([\u4e00-\u9fff].*?)(\d+)$/

  for (const src of [title, norm]) {
    if (!src) continue
    let m: RegExpMatchArray | null
    if ((m = src.match(digitChineseRe)) !== null) {
      // 数字部分（如 "300"）
      add(m[1])
      // 中文部分（如 "勇士"），仅当中文长度 >= 2 才有用
      if (m[2].length >= 2) add(m[2])
    }
    if ((m = src.match(chineseDigitRe)) !== null) {
      // 中文部分（去掉尾部数字）
      if (m[1].length >= 2) add(m[1])
      // 数字部分单独作为候选
      add(m[2])
    }
  }

  return out
}

/**
 * 根据 parsedVideoTitle 构造有序的 TitleCandidate 列表
 *
 * 顺序原则：中文优先 -> 英文兜底；高置信度优先 -> 低置信度退化候选
 *
 * 来源标签 (Source)：
 *   - bracket-cn  : 来自方括号内的中文，置信度最高（发布组明确标注）
 *   - main-cn     : 文件名中第一个中文片段
 *   - main-en     : 主英文标题
 *   - merged-cn   : 多个中文片段合并（300勇士：帝国崛起）
 *   - sub-cn      : 中文标题的副标题拆分（无限战争）
 *   - extra-cn    : 其它中文片段
 *   - degenerate-cn / degenerate-en : 去尾数/去括号等退化形式
 */
export function extractCandidates(
  parsed: ParsedVideoTitle,
  bracketChinese: string[]
): TitleCandidate[] {
  const list: TitleCandidate[] = []
  const seen = new Map<string, boolean>() // key: lang|name

  const add = (name: string, lang: string, source: string, conf: number) => {
    name = name.trim()
    if (!name || name.length < 1) return
    const key = `${lang}|${name}`
    if (seen.get(key)) return
    seen.set(key, true)
    list.push({
      name,
      lang,
      year: parsed.year,
      confidence: conf,
      source,
    })
  }

  // 1) 方括号中文：发布组明确标注的片名，最可信
  for (const b of bracketChinese) {
    add(b, 'zh-CN', 'bracket-cn', 0.95)
  }

  // 2) 主中文标题
  if (parsed.chineseTitle) {
    add(parsed.chineseTitle, 'zh-CN', 'main-cn', 0.90)
    // 副标题拆分：「复仇者联盟3：无限战争」-> 「复仇者联盟3」+「无限战争」
    const parts = parsed.chineseTitle.split(SUBTITLE_SEP_RE)
    if (parts.length > 1) {
      for (const p of parts) {
        add(p, 'zh-CN', 'sub-cn', 0.55)
      }
    }
  }

  // 3) 主英文标题
  if (parsed.englishTitle) {
    add(parsed.englishTitle, 'en-US', 'main-en', 0.80)
  }

  // 4) 额外中文候选（解析出多个中文片段时；包括 merged 合并版本）
  for (const t of parsed.extraChineseTitles) {
    let source: string = 'extra-cn'
    let conf = 0.50
    if (t.includes('：') || t.includes(':')) {
      source = 'merged-cn'
      conf = 0.65
    }
    add(t, 'zh-CN', source, conf)
  }

  // 5) 退化候选：对中文/英文都做「去尾部数字」「归一化」
  const addDegenerate = (src: string, lang: string, sourceTag: string) => {
    if (!src) return
    const norm = normalizeTitle(src)
    if (norm !== src) add(norm, lang, sourceTag, 0.35)

    if (TRAILING_NUM_RE.test(src)) {
      const stripped = src.replace(TRAILING_NUM_RE, '')
      if (stripped !== src) add(stripped, lang, sourceTag, 0.30)
    }
    if (TRAILING_NUM_RE.test(norm)) {
      const stripped = norm.replace(TRAILING_NUM_RE, '')
      if (stripped !== norm) add(stripped, lang, sourceTag, 0.30)
    }

    // 中文数字 ⇄ 阿拉伯数字
    const arabic = cnNumToArabic(src)
    if (arabic !== src) add(arabic, lang, sourceTag, 0.35)

    const cnNum = arabicToCnNum(src)
    if (cnNum !== src) add(cnNum, lang, sourceTag, 0.35)
  }

  addDegenerate(parsed.chineseTitle, 'zh-CN', 'degenerate-cn')
  addDegenerate(parsed.englishTitle, 'en-US', 'degenerate-en')

  return list
}

// ======================== 归一化与相似度计算 ========================

/**
 * 对标题做模糊匹配前的归一化处理
 * - 去除括号及其中内容
 * - 去除版本/编码等噪声词
 * - 合并多余空白
 */
export function normalizeTitle(s: string): string {
  if (!s) return s
  // 去掉中英文括号包裹的内容
  s = s.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ' ')
  // 去掉常见噪声词
  s = s.replace(NOISE_TOKEN_REGEXP, ' ')
  // 替换分隔符为空格
  s = s.replace(/[._\-+:]/g, ' ')
  // 合并多余空白
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * 简易标题相似度（0-1）
 *
 * 规则：
 *   - 完全相等 -> 1.0
 *   - 一个字符串包含另一个 -> 0.85
 *   - 归一化（去空格、大小写）后相等 -> 0.95
 *   - 归一化后一个包含另一个 -> 0.7
 *   - 否则用「公共字符占比」粗算（避免引入完整编辑距离的开销）
 */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1.0

  const la = a.toLowerCase().trim()
  const lb = b.toLowerCase().trim()
  if (la === lb) return 0.95

  if (la.includes(lb) || lb.includes(la)) return 0.85

  // 进一步归一化：去掉所有空白与标点，再比一次包含关系
  const normA = normalizeForCompare(la)
  const normB = normalizeForCompare(lb)
  if (normA === normB && normA !== '') return 0.92
  if (normA !== '' && normB !== '' && (normA.includes(normB) || normB.includes(normA))) return 0.7

  // 兜底：公共字符比例（仅取较短字符串里的字符在较长字符串中出现的比例）
  let short = normA
  let long = normB
  if (long.length < short.length) {
    short = normB
    long = normA
  }
  if (!short) return 0

  let hit = 0
  for (const r of short) {
    if (long.includes(r)) hit++
  }
  let ratio = hit / short.length
  // 公共字符比例最高只贡献 0.5，避免冷门误判
  if (ratio > 0.5) ratio = 0.5
  return ratio
}

/**
 * 归一化字符串以做相似度比较：
 * 去掉所有空白、标点（含中文标点），转小写
 */
export function normalizeForCompare(s: string): string {
  const b: string[] = []
  for (const r of s) {
    switch (r) {
      case ' ':
      case '\t':
      case '\n':
      case '.':
      case ',':
      case '-':
      case '_':
      case ':':
      case ';':
      case '!':
      case '?':
      case '：':
      case '，':
      case '。':
      case '、':
      case '！':
      case '？':
      case '(':
      case ')':
      case '[':
      case ']':
      case '（':
      case '）':
      case '【':
      case '】':
        break
      default:
        b.push(r.toLowerCase())
    }
  }
  return b.join('')
}

// ======================== 匹配评分 ========================

/**
 * 给一个 TMDB 搜索结果打分，作为「这个 hit 是否可信」的依据
 *
 * score = 0.5*titleSim + 0.3*yearScore + 0.2*voteScore  (范围 0-1)
 */
export function scoreMatch(query: string, year: string, hit: TmdbHit): number {
  let hitTitle = hit.title || hit.name || ''
  let hitYear = ''
  if (hit.release_date && hit.release_date.length >= 4) {
    hitYear = hit.release_date.substring(0, 4)
  } else if (hit.first_air_date && hit.first_air_date.length >= 4) {
    hitYear = hit.first_air_date.substring(0, 4)
  }

  const titleSim = titleSimilarity(query, hitTitle)

  let yearScore: number
  if (!year) {
    // 无年份信号时给一个中性分（不奖励、不惩罚）
    yearScore = 0.4
  } else if (!hitYear) {
    // 文件名有年份但 TMDB 没填，给较低分
    yearScore = 0.2
  } else if (hitYear === year) {
    yearScore = 1.0
  } else {
    // 容忍 ±1 年（部分电影上映日期记录差一年）
    const diff = Math.abs(parseInt(hitYear) - parseInt(year))
    switch (true) {
      case diff === 1:
        yearScore = 0.5
        break
      case diff === 2:
        yearScore = 0.2
        break
      default:
        yearScore = 0.0
    }
  }

  // vote_average 0-10，用作冷门片名的最弱信号
  let voteScore = hit.vote_average / 10.0
  if (voteScore > 1) voteScore = 1

  return 0.5 * titleSim + 0.3 * yearScore + 0.2 * voteScore
}

// ======================== 端点选择 ========================

/**
 * 根据原始文件名启发式判断走 movie 还是 tv
 * 命中则只走 /search/tv 端点，否则只走 /search/movie，节约一半请求量
 */
export function pickEndpoint(rawFileName: string): string {
  if (TV_HINT_RE.test(rawFileName)) return 'tv'
  return 'movie'
}

// ======================== 英文关键词提取 ========================

/**
 * 从英文标题中提取最有信息量的关键词
 *
 * 规则：
 *  1. 按空格分词，去掉 stopwords 与长度 < 3 的词
 *  2. 取剩余词的前 3 个，用空格拼接（更长的标题往往是 TMDB 上没有的精确组合）
 *  3. 如果剔除后没有剩余词，返回空字符串（让调用方跳过）
 *
 * 例：
 *   "And Soon The Darkness"        -> "Soon Darkness"
 *   "Alvin and the Chipmunks"      -> "Alvin Chipmunks"
 *   "30 Days Of Night Dark Days"   -> "30 Days Night"
 *   "Iron Man"                     -> "Iron Man"（原样保留，关键词都够长）
 *   "The Dark Knight"              -> "Dark Knight"
 */
export function extractEnglishKeywords(s: string): string {
  if (!s) return ''
  const words = s.split(/\s+/)
  const keepers: string[] = []
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[.,;:!?'"]/, '').trim()
    if (ENGLISH_STOPWORDS.has(lw)) continue
    // 长度 < 3 且不是纯数字的词丢弃（数字往往是片名一部分如"300"）
    if (lw.length < 3 && !isAllDigits(lw)) continue
    keepers.push(w)
  }
  if (keepers.length === 0) return ''
  if (keepers.length > 3) keepers.length = 3
  return keepers.join(' ')
}

function isAllDigits(s: string): boolean {
  if (!s) return false
  return /^\d+$/.test(s)
}
