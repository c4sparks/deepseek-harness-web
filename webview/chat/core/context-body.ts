// 上下文注入行的展开体：按展示形态解析注入内容，供注入行渲染（适配上游 0.1.5-rc.2）。
// 只做「数据提取 + 结构描述」，把模型读到的 content/source 解析成可渲染的分支；
// 具体 htm 渲染在 ContextInjectionRow 组件里；解析规则不自行发明。

import { contextLabels, type ContextLabels } from './context-labels'

/** 与上游 `KNOWN_FORMS` 一致。 */
export type KnownContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'

const MAX_CHARS = 20_000
const MAX_ENTRIES = 200

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function mapList(list: unknown[]): Array<Record<string, unknown> | null> {
  return list.map((x) => asRecord(x))
}

/** 内容块 run：相邻文本合并为一 run（与模型实际读到一致的扁平顺序），未知块单独一 run。 */
export type ContentRun = { text: string } | { block: unknown }

export function contentRuns(content: readonly unknown[]): ContentRun[] {
  const runs: ContentRun[] = []
  for (const block of content) {
    const b = asRecord(block)
    if (b === null || b['type'] !== 'text') {
      runs.push({ block })
      continue
    }
    const text = typeof b['text'] === 'string' ? b['text'] : ''
    const last = runs[runs.length - 1]
    if (last !== undefined && 'text' in last) last.text += text
    else runs.push({ text })
  }
  return runs
}

function unknownBlocks(content: readonly unknown[]): unknown[] {
  const blocks: unknown[] = []
  for (const run of contentRuns(content)) {
    if ('block' in run) blocks.push(run.block)
  }
  return blocks
}

function boundedText(text: string, labels: ContextLabels): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n${labels.jsonTruncated(text.length)}`
    : text
}

/** 展示用单值（字符串原样；其它形状紧凑 JSON；自身同样带上限）。 */
function fieldValue(value: unknown, labels: ContextLabels): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value)
  return boundedText(text, labels)
}

// ---------- 表单读取 ----------

interface InstructionChange {
  action: 'set' | 'replace' | 'remove'
  path: string
  digest?: string
}

function instructionChanges(source: unknown): InstructionChange[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['changes']
  if (!Array.isArray(list)) return null
  const changes: InstructionChange[] = []
  const seen = new Set<string>()
  for (const entry of mapList(list)) {
    if (entry === null) return null
    const path = entry['path']
    if (typeof path !== 'string' || path === '') return null
    const action = entry['action']
    if (action !== 'set' && action !== 'replace' && action !== 'remove') return null
    const digest = entry['digest']
    if (seen.has(path)) continue
    seen.add(path)
    changes.push({ action, path, ...(typeof digest === 'string' ? { digest } : {}) })
  }
  return changes.length === 0 ? null : changes
}

function instructionAction(action: InstructionChange['action'], baseline: boolean, labels: ContextLabels): string {
  if (action === 'remove') return labels.instructionsRemoved
  if (baseline) return labels.instructionsLoaded
  return action === 'set' ? labels.instructionsAdded : labels.instructionsUpdated
}

interface CatalogEntry {
  name: string
  description: string
}

function catalogEntries(source: unknown): CatalogEntry[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['entries']
  if (!Array.isArray(list)) return null
  const entries: CatalogEntry[] = []
  for (const entry of mapList(list)) {
    if (entry === null) return null
    const name = entry['name']
    const description = entry['description']
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return null
    entries.push({ name, description })
  }
  return entries
}

interface SnapshotSection {
  name: string
  text: string
}

function snapshotSections(source: unknown): SnapshotSection[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['sections']
  if (!Array.isArray(list)) return null
  const sections: SnapshotSection[] = []
  for (const section of mapList(list)) {
    if (section === null) return null
    const name = section['name']
    const text = section['text']
    if (typeof name !== 'string' || name === '' || typeof text !== 'string') return null
    sections.push({ name, text })
  }
  return sections.length === 0 ? null : sections
}

function relaySender(source: unknown): string | null {
  const sender = asRecord(source)?.['senderSessionId']
  return typeof sender === 'string' && sender !== '' ? sender : null
}

interface RecalledSession {
  label: string
  retained: number
  omitted: number
  truncated: boolean
}

function recalledSessions(source: unknown): RecalledSession[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['references']
  if (!Array.isArray(list)) return null
  const sessions: RecalledSession[] = []
  for (const reference of mapList(list)) {
    if (reference === null) return null
    const label = reference['label']
    const retained = reference['retainedMessages']
    const omitted = reference['omittedMessages']
    const truncated = reference['truncated']
    if (
      typeof label !== 'string' || label === '' ||
      typeof retained !== 'number' || typeof omitted !== 'number' ||
      typeof truncated !== 'boolean'
    ) return null
    sessions.push({ label, retained, omitted, truncated })
  }
  return sessions.length === 0 ? null : sessions
}

function noticeSummary(source: unknown): string | null {
  const summary = asRecord(source)?.['summary']
  return typeof summary === 'string' && summary !== '' ? summary : null
}

// ---------- 结构描述 ----------

/** 源字段（opaque 展示）：`kind` 恒省略；`form` 仅 opaque 保留。 */
export interface SourceField {
  key: string
  value: string
}

function sourceFields(source: unknown, formRendered: boolean, labels: ContextLabels): SourceField[] {
  const record = asRecord(source)
  if (record === null) return []
  const hidden = formRendered ? ['kind', 'form'] : ['kind']
  const rows = Object.entries(record).filter(([key]) => !hidden.includes(key))
  return rows.map(([key, value]) => ({ key, value: fieldValue(value, labels) }))
}

export type ContextBodySpec =
  | { kind: 'opaque'; runs: ContentRun[]; fields: SourceField[] }
  | { kind: 'instructions'; files: Array<{ path: string; action: string; digest?: string }>; runs: ContentRun[] }
  | { kind: 'catalog'; update: boolean; entries: CatalogEntry[]; more: number; unknown: unknown[] }
  | { kind: 'snapshot'; sections: SnapshotSection[] }
  | { kind: 'notice'; runs: ContentRun[] }
  | { kind: 'relay'; sender: string; runs: ContentRun[] }
  | { kind: 'recall'; sessions: RecalledSession[]; runs: ContentRun[] }

export interface ContextBodyResult {
  /** 实际渲染成的 form（null = opaque 兜底） */
  rendered: KnownContextForm | null
  /** 收起行的一句话说明；仅 notice 记录时有值 */
  summary: string | null
  body: ContextBodySpec
}

const opaque = (props: { content: readonly unknown[]; source: unknown }, labels: ContextLabels): ContextBodyResult => ({
  rendered: null,
  summary: null,
  body: { kind: 'opaque', runs: contentRuns(props.content), fields: sourceFields(props.source, false, labels) },
})

/**
 * 为一条上下文选择它的展开体；识别不出返回 null（调用方走兜底）。
 * @param form - 生产者声明的 form。
 * @param props - 该行的 content/source。
 * @returns 实际渲染的 form、收起行 summary、以及 body 结构描述。
 */
export function contextBody(
  form: KnownContextForm | null,
  props: { content: readonly unknown[]; source: unknown },
): ContextBodyResult {
  const labels = contextLabels()
  switch (form) {
    case 'instructions': {
      const changes = instructionChanges(props.source)
      if (changes === null) return opaque(props, labels)
      const baseline = asRecord(props.source)?.['baseline'] === true
      return {
        rendered: 'instructions',
        summary: null,
        body: {
          kind: 'instructions',
          files: changes.map((c) => ({ path: c.path, action: instructionAction(c.action, baseline, labels), digest: c.digest })),
          runs: contentRuns(props.content),
        },
      }
    }
    case 'catalog': {
      const entries = catalogEntries(props.source)
      if (entries === null) return opaque(props, labels)
      const update = asRecord(props.source)?.['update'] === true
      const shown = entries.slice(0, MAX_ENTRIES)
      return {
        rendered: 'catalog',
        summary: null,
        body: { kind: 'catalog', update, entries: shown, more: entries.length - shown.length, unknown: unknownBlocks(props.content) },
      }
    }
    case 'snapshot': {
      const sections = snapshotSections(props.source)
      if (sections === null) return opaque(props, labels)
      return { rendered: 'snapshot', summary: null, body: { kind: 'snapshot', sections } }
    }
    case 'notice': {
      const summary = noticeSummary(props.source)
      if (summary === null) return opaque(props, labels)
      return { rendered: 'notice', summary, body: { kind: 'notice', runs: contentRuns(props.content) } }
    }
    case 'relay': {
      const sender = relaySender(props.source)
      if (sender === null) return opaque(props, labels)
      return { rendered: 'relay', summary: null, body: { kind: 'relay', sender, runs: contentRuns(props.content) } }
    }
    case 'recall': {
      const sessions = recalledSessions(props.source)
      if (sessions === null) return opaque(props, labels)
      return { rendered: 'recall', summary: null, body: { kind: 'recall', sessions, runs: contentRuns(props.content) } }
    }
    case null:
      return opaque(props, labels)
  }
}

/** 便捷：把一条 context 行（content/source/form）解析成 UI 渲染所需的全部结构。 */
export function contextView(form: string | null, content: readonly unknown[], source: unknown): ContextBodyResult {
  const known: KnownContextForm | null =
    form === 'instructions' || form === 'catalog' || form === 'snapshot' || form === 'notice' || form === 'relay' || form === 'recall'
      ? form
      : null
  return contextBody(known, { content, source })
}
