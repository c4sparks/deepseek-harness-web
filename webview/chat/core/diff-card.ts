// 差异卡（上游 DiffBlock / diff-card-model 复刻）纯函数模型。
//
// 数据来源两条路，**优先第二条**：
//   1. 参数推导：write(file_path+content) / edit(file_path+old_string+new_string) /
//      str_replace_editor(command=create|str_replace)
//   2. 结果元数据：`meta.diffs`（结构化落盘差异）
// 定稿时 meta.diffs 可用就用它；不可用（缺失/空数组）时 **write 回退到参数推导的整文件差异**
// （与「新建」「原样覆盖」的呈现一致），edit 则回退通用卡（不猜）。
// 因此：**write 不依赖 meta，必然出卡**；edit 依赖 meta.diffs。

export interface DiffHunk {
  path: string
  oldText: string | null
  newText: string
}

export interface DiffCard {
  diffs: DiffHunk[]
}

/** 扁平化后的一行：path 文件头 / ⋯ 同文件间隔 / - 删除行 / + 新增行。 */
export interface DiffRow {
  kind: 'path' | 'gap' | 'del' | 'add'
  text: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseArgs(argsRaw?: string): Record<string, unknown> | null {
  if (!argsRaw) return null
  try {
    return asRecord(JSON.parse(argsRaw))
  } catch {
    return null
  }
}

/**
 * 校验可选的提权字段对（sandbox_permissions / justification）：两者要么都不给，
 * 要么给成合法的一对。args 形状不对时不硬渲染差异，直接回退。
 */
function validEscalationFields(args: Record<string, unknown>): boolean {
  const permission = args['sandbox_permissions']
  const justification = args['justification']
  if (permission === undefined && justification === undefined) return true
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') return false
  return typeof justification === 'string' && justification.trim() !== ''
}

type IntendedDiff = { tool: 'write' | 'edit' | 'str_replace_editor'; diff: DiffHunk }

/** 从参数推导差异（不依赖结果）。形状不合即 null。 */
function intendedDiff(name: string, args: Record<string, unknown>): IntendedDiff | null {
  if (name === 'str_replace_editor') {
    const path = args['path']
    const fileText = args['file_text']
    const oldText = args['old_str']
    const newText = args['new_str']
    if (typeof path !== 'string' || path.trim() === '') return null
    if (args['command'] === 'create') {
      if (fileText !== undefined && typeof fileText !== 'string') return null
      return { tool: 'str_replace_editor', diff: { path, oldText: null, newText: typeof fileText === 'string' ? fileText : '' } }
    }
    if (args['command'] === 'str_replace') {
      if (oldText !== undefined && typeof oldText !== 'string') return null
      if (newText !== undefined && typeof newText !== 'string') return null
      return {
        tool: 'str_replace_editor',
        diff: { path, oldText: typeof oldText === 'string' ? oldText : null, newText: typeof newText === 'string' ? newText : '' },
      }
    }
    return null
  }
  const path = args['file_path']
  if (typeof path !== 'string' || path.trim() === '') return null
  if (!validEscalationFields(args)) return null
  if (name === 'write') {
    const content = args['content']
    return typeof content === 'string' ? { tool: 'write', diff: { path, oldText: null, newText: content } } : null
  }
  if (name !== 'edit') return null
  const oldText = args['old_string']
  const newText = args['new_string']
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null
  if (args['replace_all'] !== undefined && typeof args['replace_all'] !== 'boolean') return null
  // 空 old_string 视作「无删除侧」（上游同：oldText || null）
  return { tool: 'edit', diff: { path, oldText: oldText || null, newText } }
}

/** 校验 meta.diffs：空数组 → 'empty'（让 write 走推导兜底）；形状不合 → null。 */
function appliedDiffs(meta: unknown): DiffHunk[] | 'empty' | null {
  const rec = asRecord(meta)
  if (rec === null) return null
  const diffs = rec['diffs']
  if (!Array.isArray(diffs)) return null
  if (diffs.length === 0) return 'empty'
  const out: DiffHunk[] = []
  for (const hunk of diffs) {
    const h = asRecord(hunk)
    if (h === null) return null
    const { path, oldText, newText } = h
    if (typeof path !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    out.push({ path, oldText, newText })
  }
  return out
}

/**
 * 派生差异卡。只在 running / ok 两种终态出卡（error / stopped 回退通用卡，
 * 与上游 `isError → null` 同口径）。
 * `str_replace_editor` 定稿后没有结果视图，返回 null（上游同）。
 */
export function diffCardModel(item: {
  name: string
  argsRaw?: string
  status: string
  meta?: unknown
}): DiffCard | null {
  if (item.status !== 'running' && item.status !== 'ok') return null
  const args = parseArgs(item.argsRaw)
  if (args === null) return null
  const intended = intendedDiff(item.name, args)
  if (intended === null) return null
  if (item.status === 'running') return { diffs: [intended.diff] }
  if (intended.tool === 'str_replace_editor') return null
  const applied = appliedDiffs(item.meta)
  if (applied === null || applied === 'empty') {
    return intended.tool === 'write' ? { diffs: [intended.diff] } : null
  }
  return { diffs: applied }
}

/**
 * 把一侧文本拆成内容行。空文本是 0 行；**末尾单个换行是行终止符**而非多出的空行
 * （内部 `\n\n` 的真空行保留）。与终端卡对命令输出的处理同一条终止符规则。
 */
export function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** 新增/删除行数合计（footer 与收起行摘要共用同一组数）。 */
export function diffTotals(diffs: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const d of diffs) {
    if (d.oldText !== null) removed += contentLines(d.oldText).length
    added += contentLines(d.newText).length
  }
  return { added, removed }
}

/**
 * 扁平化成卡体行：每个新文件一个 path 头；**同一文件的第二个 hunk**（分散修改）
 * 用 `⋯` 间隔而不是重复路径头。`files` 是 distinct 路径数（同一文件两处修改算 1 个文件）。
 */
export function diffRows(diffs: DiffHunk[]): { rows: DiffRow[]; added: number; removed: number; files: number } {
  const rows: DiffRow[] = []
  const paths = new Set<string>()
  let prevPath: string | undefined
  for (const d of diffs) {
    paths.add(d.path)
    if (d.path !== prevPath) rows.push({ kind: 'path', text: d.path })
    else rows.push({ kind: 'gap', text: '⋯' })
    prevPath = d.path
    if (d.oldText !== null) {
      for (const line of contentLines(d.oldText)) rows.push({ kind: 'del', text: line })
    }
    for (const line of contentLines(d.newText)) rows.push({ kind: 'add', text: line })
  }
  return { rows, ...diffTotals(diffs), files: paths.size }
}

/** 复制内容：逐行带各自前缀（path 头原样、间隔 `⋯`、删除 `- `、新增 `+ `），与卡体所见一致。 */
export function diffCopyText(rows: DiffRow[]): string {
  return rows
    .map((r) => (r.kind === 'del' ? '- ' + r.text : r.kind === 'add' ? '+ ' + r.text : r.text))
    .join('\n')
}

/** 差异卡文案（zh 原文取自上游字典 common `copy` + `diff.files.*`）。 */
export interface DiffLabels {
  copy: string
  files: (n: number) => string
}

export function diffLabels(): DiffLabels {
  return {
    copy: '复制',
    files: (n) => `${n} 个文件`,
  }
}
