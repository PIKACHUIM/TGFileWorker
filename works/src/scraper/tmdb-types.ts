// TMDB 搜索相关类型定义
// 参考 OpenList 项目的刮削逻辑

/** TMDB 搜索 API 单条结果 */
export interface TmdbHit {
  id: number
  title: string
  name: string
  overview: string
  poster_path: string | null
  release_date: string
  first_air_date: string
  vote_average: number
  media_type: string
  genre_ids: number[]
}

/** TMDB 搜索 API 响应 */
export interface TmdbSearchResult {
  results: TmdbHit[]
  total_results: number
}

/** 单次搜索尝试参数 */
export interface SearchAttempt {
  endpoint: string // multi / movie / tv
  query: string
  year: string
  language: string
}

/** 标题候选：从文件名解析出的搜索线索 */
export interface TitleCandidate {
  /** 待搜索的标题字符串 */
  name: string
  /** 语言：zh-CN / en-US / ""（不指定） */
  lang: string
  /** 候选年份（可空） */
  year: string
  /** 置信度 0-1，越高越优先；用于排序与「命中可信度」校验 */
  confidence: number
  /** 来源标签：bracket-cn / main-cn / merged-cn / sub-cn / extra-cn / main-en / degenerate-cn / degenerate-en */
  source: string
}

/** 解析后的视频标题信息 */
export interface ParsedVideoTitle {
  /** 英文标题（第一个中文片段之前、年份之前的部分） */
  englishTitle: string
  /** 中文标题（最优中文片段） */
  chineseTitle: string
  /** 其他中文片段，作为兜底候选 */
  extraChineseTitles: string[]
  /** 年份 */
  year: string
}

/** 匹配置信度阈值 */
export const MATCH_CONFIDENCE_THRESHOLD = 0.6
/** 兜底阈值 */
export const FALLBACK_THRESHOLD = 0.3
/** 绝望式阈值 */
export const DESPERATE_THRESHOLD = 0.2

/** 英文停用词表（冠词/介词等无信息量小词） */
export const ENGLISH_STOPWORDS: Set<string> = new Set([
  'a', 'an', 'the',
  'of', 'in', 'on', 'at', 'by', 'to', 'for',
  'and', 'or', 'but',
  'is', 'are', 'was', 'were',
  'with', 'from', 'into', 'onto',
  'vs', 'v',
])

/** 副标题分隔符正则：「：」「:」「-」前后空白 */
export const SUBTITLE_SEP_RE = /\s*[：:\-—]\s*/

/** TV 特征正则（SxxExx、季、集、Episode） */
export const TV_HINT_RE = /(s\d{1,2}e\d{1,3}|season\s*\d+|episode\s*\d+|第\s*\d+\s*季|第\s*\d+\s*集)/i

/** 中文数字到阿拉伯数字的映射 */
export const CN_NUM_MAP: Record<string, string> = {
  '〇': '0', '零': '0',
  '一': '1', '二': '2', '三': '3', '四': '4',
  '五': '5', '六': '6', '七': '7', '八': '8', '九': '9',
  '十': '10',
}

/** 阿拉伯数字到中文数字的映射 */
export const ARABIC_TO_CN_NUM: Record<string, string> = {
  '0': '零', '1': '一', '2': '二', '3': '三', '4': '四',
  '5': '五', '6': '六', '7': '七', '8': '八', '9': '九',
}

/** 噪声词正则：发布组、编码、分辨率、音轨等 */
export const NOISE_TOKEN_REGEXP = /(双语字幕|双语|中字|中英字幕|中英双字|中英双语|国英双语|国英双轨|国粤双语|粤语中字|国语中字|英语中字|日语中字|韩语中字|内封字幕|外挂字幕|HDTV|HR-HDTV|BluRay|BDRip|WEB-?DL|WEBRip|HDRip|DVDRip|REMUX|UHD|RAW|TS|TC|CAM|HC|TVRip|x264|x265|h264|h265|HEVC|AVC|XviD|DivX|VP9|AV1|10bit|8bit|HDR10\+?|HDR|SDR|DV|DolbyVision|AAC|AAC2\.0|AC3|EAC3|DD5\.1|DD7\.1|DD\+|DDP|DTS|DTS-HD|DTS-X|DTSX|DTSHD|FLAC|MP3|TrueHD|Atmos|MA|4K|2K|8K|2160p|2160P|1080p|1080P|720p|720P|480p|480P|\d{3,4}[xX×]\d{3,4}|完整版|未删减版|加长版|导演剪辑版|蓝光版|高清版|正版上译公映|正版上译|上译公映|公映译制|译制公映|公映版|上译版|京译版|长译版|国配版|台配版|港配版|国语配音|粤语配音|国粤配音|原声版|原盘|配音版|译制版)/i

/** 噪声词完整匹配正则（判断一个片段是否是纯噪声词） */
export const NOISE_TOKEN_WHOLE_REGEXP = /^(?:双语字幕|中字|国英|国粤|粤语|国语|英语|日语|韩语|国英双轨|国粤英双轨|中英双字|English|Chinese|Cantonese|Mandarin|Japanese|Korean|CHS|CHT|ENG|JPN|KOR|CHS-ENG|CHS-JPN|CHT-ENG|HDTV|HR-HDTV|HR\.HDTV|BluRay|Blu-Ray|BDRip|BDMV|WEB-?DL|WEBRip|HDRip|DVDRip|DVD|REMUX|UHD|RAW|TS|TC|CAM|HC|TVRip|x264|x265|h264|h265|HEVC|AVC|XviD|DivX|VP9|AV1|10bit|8bit|HDR10\+?|HDR|SDR|DV|DolbyVision|AAC|AAC2\.0|AC3|EAC3|DD5\.1|DD7\.1|DD\+|DDP|DTS|DTS-HD|DTS-X|DTSX|DTSHD|FLAC|MP3|TrueHD|Atmos|MA|4K|2K|8K|2160p|2160P|1080p|1080P|720p|720P|480p|480P|\d{3,4}[xX×]\d{3,4}|完整版|未删减版|院线版|导演剪辑版|加长版|年度佳作|BOBO|SWTYBLZ|CMCT|HDS|FRDS|MNHD|WiKi|TLF|RARBG|YIFY|YTS|EVO|SPARKS)$/i

/** 中文字幕组/压制组名的包含匹配正则 */
export const CHINESE_GARBAGE_CONTAINS_RE = /人人影视|人人字幕|YYeTs|字幕组|压制组|发布组|正版上译|上译公映|公映译制|译制公映|公映版|上译版|国配版|台配版|港配版|配音版|译制版/

/** 中文字幕组/压制组名的完整匹配正则 */
export const CHINESE_RELEASE_GROUP_RE = /^(?:人人影视制作|人人影视|人人字幕|人人字幕组|YYeTs|YYETs|FRDS|飞鸟影视|飞鸟影院|风行网|风行影视|远鉴字幕组|远鉴|深影字幕组|深影|破烂熊|圣城家园|TLF|HDS|MNHD|WiKi|CMCT|RARBG|YIFY|YTS|蓝色狂想|蓝色狂想字幕组|肥羊字幕组|衣柜字幕组|喵萌奶茶屋|众乐字幕组|猪猪乐园|猪猪字幕组|流鸣字幕|动漫国字幕组|诸神字幕组|字幕组|压制组|发布组|官方版本|高清影视|高清电影|蓝光原盘)$/

/** 开头序号正则："数字 + 空格" */
export const LEADING_SERIAL_SPACE_RE = /^\s*\d{1,3}\s+/

/** 开头序号正则："数字 + 分隔符 + 中文" */
export const LEADING_SERIAL_DOT_CHINESE_RE = /^\s*(\d{1,3})\s*[.\-_、]\s*([\u4e00-\u9fff])/

/** 尾部数字正则（去掉系列编号） */
export const TRAILING_NUM_RE = /[\s]*[0-9０-９]+\s*$/

/** 尾部罗马数字正则 */
export const TRAILING_ROMAN_RE = /\s+(?:I{1,3}|IV|V|VI{0,3}|IX|X)$/i

/** 年份正则（1900-2099） */
export const YEAR_REGEXP = /\b((?:19|20)\d{2})\b/

/** 中文正则 */
export const CHINESE_REGEXP = /[\u4e00-\u9fff]/
