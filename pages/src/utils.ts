/**
 * 公共工具函数和常量
 */

// 文件大小格式化
export function formatSize(bytes: number) {
  if (!bytes) return '-'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

// 媒体类型颜色映射
export const TYPE_COLORS: Record<string, string> = {
  video: 'blue', audio: 'green', image: 'orange', book: 'purple', file: 'default'
}

// 媒体类型中文标签
export const TYPE_LABELS: Record<string, string> = {
  video: '视频', audio: '音频', image: '图片', book: '电子书', file: '文件'
}

// 媒体类型选项（用于 Select 组件）
export const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([k, v]) => ({ label: v, value: k }))
