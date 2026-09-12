// 输入区文件附件的展示文案（取对话框字典原文，不自造同义词；改文案前先查字典）。
export interface FileLabels {
  /** 已选未发的文件区标题 */
  pending: string
  /** 「＋」按钮与附件入口 */
  attach: string
  uploading: string
  failed: string
  retry: (name: string) => string
  remove: (name: string) => string
  /** 未就绪时阻止发送的理由 */
  stillUploading: string
}

export function fileLabels(): FileLabels {
  return {
    pending: '待发送文件',
    attach: '添加附件',
    uploading: '上传中…',
    failed: '上传失败，点击重试',
    retry: (name) => `重试上传 ${name}`,
    remove: (name) => `移除文件 ${name}`,
    stillUploading: '文件还在上传，请等待上传完成后发送',
  }
}

/** 文件大小文案：B/KB/MB/GB，<10 保留 1 位小数。 */
export function fileSizeText(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  return `${text}${units[unit]}`
}

/** 扩展名标签：大写、最多 8 字符；无扩展名返回空串。 */
export function fileExt(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toUpperCase().slice(0, 8)
}

