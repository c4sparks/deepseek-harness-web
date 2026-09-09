// web 卡纯函数模型（对齐官方 ui-tool `models/web-card-model.ts` + `raw-tool-call.ts` 校验）。
// 从 tool item（name/argsRaw/meta/status）派生 WebBlock 需要的卡数据：
//   web_fetch → {kind:'fetch', url, statusCode, truncated}（HTTP 状态码来自 tool/result.data.meta.statusCode）
//   web_search → {kind:'search', answer?, sources[], truncated}
// 校验失败/错误/运行中 → null（调用方回退泛型「输出 + raw JSON」）。照抄官方逻辑，不自行定义。

export interface WebSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

export type WebCard =
  | { kind: 'fetch'; url: string; statusCode: number; truncated: boolean }
  | { kind: 'search'; answer?: string; sources: WebSource[]; truncated: boolean }

/** 仅 http(s) URL 才允许成为可导航外链；其它协议作纯文本（对齐官方 WebBlock safeHref）。 */
export function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** 链接可见标签：有 title 用 title，否则用 hostname，仍为空则原 URL（对齐官方 linkLabel）。 */
export function linkLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title !== '') return title
  try {
    const { hostname } = new URL(url)
    return hostname === '' ? url : hostname
  } catch {
    return url
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 工具名归一：web_fetch/webFetch → fetch；web_search/search → search；其它 null。 */
function validWebTool(name: string): 'web_search' | 'web_fetch' | null {
  if (name === 'web_search' || name === 'search') return 'web_search'
  if (name === 'web_fetch' || name === 'webFetch') return 'web_fetch'
  return null
}

function parseArgs(argsRaw?: string): Record<string, unknown> | null {
  if (!argsRaw) return null
  try {
    const o: unknown = JSON.parse(argsRaw)
    return asRecord(o)
  } catch {
    return null
  }
}

function webSources(value: unknown): WebSource[] | null {
  if (!Array.isArray(value)) return null
  const sources: WebSource[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (record === null) return null
    const url = record['url']
    const title = record['title']
    const snippet = record['snippet']
    const publishedAt = record['publishedAt']
    if (typeof url !== 'string') return null
    if (title !== undefined && typeof title !== 'string') return null
    if (snippet !== undefined && typeof snippet !== 'string') return null
    if (publishedAt !== undefined && typeof publishedAt !== 'string') return null
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return sources
}

/**
 * 从 tool item 派生 web 卡；仅定稿(ok)且 meta 合法时返回，否则 null。
 * @param item - tool item（name/argsRaw/meta/status）。
 */
export function webCardModel(item: { name: string; argsRaw?: string; meta?: unknown; status: string }): WebCard | null {
  if (item.status !== 'ok') return null
  const tool = validWebTool(item.name)
  if (tool === null) return null
  const args = parseArgs(item.argsRaw)
  if (args === null) return null
  const meta = asRecord(item.meta)
  if (meta === null || typeof meta['truncated'] !== 'boolean') return null
  const truncated = meta['truncated'] as boolean

  if (tool === 'web_search') {
    const queries = args['queries']
    const okArgs = Array.isArray(queries) && queries.length > 0 && queries.every((q) => typeof q === 'string' && q.trim() !== '')
    if (!okArgs) return null
    const sources = webSources(meta['sources'])
    if (sources === null) return null
    const answer = meta['answer']
    if (answer !== undefined && typeof answer !== 'string') return null
    return { kind: 'search', ...(typeof answer === 'string' ? { answer } : {}), sources, truncated }
  }

  // web_fetch
  const url = args['url']
  if (typeof url !== 'string' || url.trim() === '') return null
  const metaUrl = meta['url']
  const statusCode = meta['statusCode']
  if (typeof metaUrl !== 'string') return null
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) return null
  return { kind: 'fetch', url: metaUrl, statusCode, truncated }
}
