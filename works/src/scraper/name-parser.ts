/**
 * 智能名称/标签提取器
 *
 * 从 Telegram 频道帖子的文件名中提取名称和标签（tags）
 *
 * 格式示例：
 *   《#飞驰人生3 4K高清》#2026年国产最新喜剧电影 #运动电影 #剧情电影
 *   #飞驰人生3 4K高清 #2026年国产最新喜剧电影 #运动电影
 *   [飞驰人生3] #2026年国产最新喜剧电影
 *
 * 规则：
 *   - 《...》或 [...] 中的内容作为名称，其中的 # 标记如果是第一个则视为名称的一部分
 *   - 名称之外的 # 开头的词作为标签
 *   - 第一个 # 在 《》或 [] 之内则它是名称的一部分
 *   - 没有 《》或 [] 时，第一个 # 后的空格前的词作为名称，后续 # 作为标签
 */

/**
 * 从文件名中提取名称和标签
 *
 * @param fileName 原始文件名（可能包含扩展名等噪声）
 * @returns { name: string; tags: string[] }
 */
export function extractNameAndTags(fileName: string): { name: string; tags: string[] } {
  let raw = fileName

  // 去掉扩展名
  const lastDotIdx = raw.lastIndexOf('.')
  if (lastDotIdx > 0) {
    const ext = raw.substring(lastDotIdx).toLowerCase()
    if (ext.length <= 5) {
      raw = raw.substring(0, lastDotIdx)
    }
  }

  // 去掉开头序号（如 "01 "、"1."、"169."）
  raw = raw.replace(/^\d{1,3}[\s.]+/, '').trim()

  const result: { name: string; tags: string[] } = { name: '', tags: [] }

  // 尝试匹配 《...》 包裹的名称
  const bookMatch = raw.match(/《([^》]+)》/)
  if (bookMatch) {
    let inner = bookMatch[1].trim()
    // 《》内部可能包含 # 前缀的名称和附加信息
    // 例：《#飞驰人生3 4K高清》 -> 名称 "飞驰人生3"，"4K高清" 视为名称的一部分
    inner = inner.replace(/^\s*#+\s?/, '') // 去掉开头的 # 标记
    // 去掉分辨率等后缀噪声
    inner = inner.replace(/\s+(4K|1080p|720p|高清|超清|HDR|UHD).*$/i, '').trim()
    result.name = inner

    // 《》之外的部分提取标签
    const afterBook = raw.substring(raw.indexOf('》') + 1).trim()
    result.tags = extractTags(afterBook)
    return result
  }

  // 尝试匹配 [...] 包裹的名称
  const bracketMatch = raw.match(/\[([^\]]+)\]/)
  if (bracketMatch) {
    let inner = bracketMatch[1].trim()
    // 方括号内如果有 # 开头，它是名称标记，去掉
    inner = inner.replace(/^\s*#+\s?/, '')
    // 去掉分辨率等后缀噪声
    inner = inner.replace(/\s+(4K|1080p|720p|高清|超清|HDR|UHD).*$/i, '').trim()
    result.name = inner

    // 方括号之外的部分提取标签
    const afterBracket = raw.substring(raw.indexOf(']') + 1).trim()
    result.tags = extractTags(afterBracket)
    return result
  }

  // 没有特殊包裹符号的情况
  // 找出所有 # 开头的词，第一个作为名称（去掉 #），其余作为标签
  const hashParts = splitByHash(raw)
  if (hashParts.length > 0) {
    // 第一个 # 词作为名称（去掉 # 前缀）
    let firstName = hashParts[0]
    firstName = firstName.replace(/^#+\s?/, '')
    // 去掉分辨率等后缀噪声
    firstName = firstName.replace(/\s+(4K|1080p|720p|高清|超清|HDR|UHD).*$/i, '').trim()
    result.name = firstName
    // 其余 # 词作为标签
    result.tags = hashParts.slice(1)
  } else {
    // 没有 # 标记，整个字符串作为名称
    result.name = raw
  }

  return result
}

/**
 * 从字符串中提取 # 开头的标签
 *
 * 规则：
 *   - # 后紧跟的文字（到空格或字符串结尾）是一个标签
 *   - 去掉标签中的 # 前缀
 *   - 过滤掉常见的噪声标签（如分辨率、编码格式等）
 */
function extractTags(s: string): string[] {
  const tags: string[] = []

  // 提取所有 #标签
  const tagRegex = /#([^\s#]+)/g
  let m: RegExpExecArray | null
  while ((m = tagRegex.exec(s)) !== null) {
    const tag = m[1].trim()
    if (tag && !isNoiseTag(tag)) {
      tags.push(tag)
    }
  }

  return tags
}

/**
 * 将字符串按 # 分隔成数组
 * 第一个 # 之前的内容（如果有且不是纯空白/纯数字序号）也作为一个元素
 */
function splitByHash(s: string): string[] {
  const parts: string[] = []

  // 找出所有 # 开头的段
  const regex = /#([^\s#]+)/g
  let match: RegExpExecArray | null
  let lastIndex = 0

  while ((match = regex.exec(s)) !== null) {
    // # 之前的内容
    const before = s.substring(lastIndex, match.index).trim()
    // 去掉开头的序号等噪声
    if (before && !/^\d{1,3}$/.test(before)) {
      // 如果这不是第一个匹配且前面有内容，则前面内容也视为名称候选
      if (parts.length === 0 && before) {
        parts.push(before)
      }
    }

    const tag = match[1].trim()
    if (tag) {
      parts.push('#' + tag)
    }

    lastIndex = regex.lastIndex
  }

  // 最后一个 # 之后的内容
  const after = s.substring(lastIndex).trim()
  if (after && parts.length === 0) {
    parts.push(after)
  }

  return parts
}

/**
 * 判断标签是否为噪声词（分辨率、编码、音轨等）
 */
function isNoiseTag(tag: string): boolean {
  const NOISE_TAGS = new Set([
    // 分辨率
    '4K', '4K高清', '1080p', '720p', '2160p', 'UHD', 'HDR', 'FHD', 'HD',
    // 编码
    'H264', 'H265', 'H.264', 'H.265', 'x264', 'x265', 'X264', 'X265',
    'HEVC', 'AVC', 'AV1',
    // 音频编码
    'AC3', 'AAC', 'DTS', 'DTS-HD', 'FLAC', 'DD5.1', 'DD7.1',
    // 来源
    'BluRay', 'Blu-ray', 'WEB-DL', 'WEBDL', 'HDTV', 'HDRip', 'BDRip',
    'DVDRip', 'CAM', 'HDCAM', 'TS', 'HDTS',
    // 语言/字幕
    '双语字幕', '国英音轨', '中英双语', '国语', '粤语', '国语配音',
    // 压制组常见标记
    'HR-HDTV', 'HR-HD',
  ])

  if (NOISE_TAGS.has(tag)) return true

  // 纯数字（可能是分辨率或年份，不算有意义的标签）
  if (/^\d+$/.test(tag)) return true

  // 文件大小格式（如 "1.5GB"）
  if (/^\d+(\.\d+)?[GMK]B$/i.test(tag)) return true

  return false
}

/**
 * 使用正则表达式提取名称和标签
 *
 * @param fileName 文件名
 * @param regex 用户提供的正则表达式
 * @returns 提取的名称和标签
 */
export function extractNameWithRegex(fileName: string, regex: string): { name: string; tags: string[] } {
  try {
    const re = new RegExp(regex)
    const match = re.exec(fileName)
    if (match && match.length > 1) {
      // 返回第一个捕获组作为名称
      const name = match[1].trim()
      // 从文件名中移除匹配的部分，其余部分提取标签
      const remaining = fileName.replace(match[0], '')
      const tags = extractTags(remaining)
      return { name, tags }
    }
    if (match) {
      // 返回整个匹配作为名称
      const name = match[0].trim()
      const remaining = fileName.replace(match[0], '')
      const tags = extractTags(remaining)
      return { name, tags }
    }
    // 没有匹配则使用默认规则
    return extractNameAndTags(fileName)
  } catch {
    // 正则表达式无效则使用默认规则
    return extractNameAndTags(fileName)
  }
}
