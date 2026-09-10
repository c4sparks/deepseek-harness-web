// 展示层纯函数(无状态/DOM):工具名中文化、消息统计与底部统计条文案。
// 与旧 chat.ts 逻辑一致,供组件与 store 复用。

/** turn/end 终止状态角标：先不翻译，直接回显官方 reason.kind 原值（completed/未知返回空）。与 src/dsh/session.ts 一致。 */
export function turnStatusBadge(kind: string | undefined): string {
  return kind && kind !== 'completed' ? kind : ''
}

/** 零填充两位数 */
const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 消息时钟（对齐 dsh 官方 formatMessageClock + 中文 clock.md/clock.ymd 模板）：
 * 同日 → HH:mm；今年更早 → M月D日 HH:mm；更早年份 → Y年M月D日 HH:mm。
 * 无值返回 ''。t 为 dsh 事件/快照自带 epoch（秒或毫秒，由上游给出）。
 */
export function formatMsgClock(t: number | undefined | null): string {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
    return ''
  }
  const ms = t > 1e12 ? t : t * 1000
  const d = new Date(ms)
  const n = new Date()
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return clock
  }
  const sameYear = d.getFullYear() === n.getFullYear()
  const date = sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  return `${date} ${clock}`
}

/** 工具名 → 友好中文 */
export function friendlyToolName(name: string): string {
  const map: Record<string, string> = {
    bash: '执行命令',
    pwsh: '执行命令',
    shell: '执行命令',
    powershell: '执行命令',
    glob: '查找文件',
    read: '读取文件',
    readTextFile: '读取文件',
    think: '思考',
    findings: '分析',
    grep: '搜索',
    search: '搜索',
    write: '写文件',
    edit: '编辑文件',
    str_replace_editor: '编辑文件',
    apply_patch: '应用补丁',
  }
  return map[name] ?? name
}

/**
 * 工具友好名 → codicon 图标类名（无 codicon- 前缀）。steps[].tools 存的是友好名，故按友好名映射；
 * bash/pwsh/shell 已被 friendlyToolName 并成"执行命令"，壳细分在下游丢失，此处接受。未知原名兜底 wrench。
 */
export function toolIcon(friendly: string): string {
  const map: Record<string, string> = {
    执行命令: 'terminal', // bash / pwsh / shell / powershell
    读取文件: 'file-text', // read / readTextFile
    写文件: 'save', // write
    编辑文件: 'edit', // edit / str_replace_editor
    应用补丁: 'diff-added', // apply_patch
    查找文件: 'files', // glob
    搜索: 'search', // grep / search
    思考: 'lightbulb', // think
    分析: 'graph-line', // findings
  }
  return map[friendly] ?? 'wrench'
}

/**
 * raw 工具名 → 展示标题（中文观感：Pwsh / 网页获取 / 搜索…）。
 * 标题是 UI 层文案，不是模型吐出。无专属标题的工具一律用通用标题「工具调用」，
 * 真实工具名改由摘要承载（见 deriveToolSummary）。
 */
const TOOL_TITLES: Record<string, string> = {
  bash: 'Bash',
  pwsh: 'Pwsh',
  powershell: 'PowerShell',
  shell: 'Shell',
  read: '读取',
  read_image: '读取图片',
  readTextFile: '读取',
  write: '写入',
  edit: '编辑',
  str_replace_editor: '编辑',
  apply_patch: '应用补丁',
  glob: '查找文件',
  grep: 'Grep',
  search: '网页搜索',
  web_search: '网页搜索',
  web_fetch: '网页获取',
  webFetch: '网页获取',
  think: '思考',
  findings: '分析',
  plan: 'plan',
  subagent: 'subagent',
  ask_user_question: '提问',
}

/** 无专属标题的工具统一用「工具调用」。 */
const GENERIC_TOOL_TITLE = '工具调用'

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? GENERIC_TOOL_TITLE
}

/** raw 工具名 → 展示图标 codicon（无 codicon- 前缀；按官方 variant 归类，未知兜底 wrench）。 */
export function toolIconOfTool(name: string): string {
  const map: Record<string, string> = {
    bash: 'terminal',
    pwsh: 'terminal',
    shell: 'terminal',
    powershell: 'terminal',
    read: 'file-text',
    read_image: 'file-text',
    readTextFile: 'file-text',
    write: 'save',
    edit: 'edit',
    str_replace_editor: 'edit',
    apply_patch: 'diff-added',
    glob: 'files',
    grep: 'search',
    search: 'search',
    web_search: 'search',
    web_fetch: 'globe',
    webFetch: 'globe',
    think: 'lightbulb',
    findings: 'graph-line',
    plan: 'list-unordered',
    ask_user_question: 'question',
  }
  return map[name] ?? 'wrench'
}

/** 工具调用原始参数(JSON 串) → 摘要一行（对齐官方 SUMMARY_KEYS：
 *  bash 类取 description/command；read/web_fetch 类取 path/file_path/url；search 类取 query/pattern。
 *  取首个命中字符串的首行，超长截断）。无/解析失败返回 ''。 */
export function deriveToolSummary(argsRaw: string | undefined, name?: string): string {
  if (!argsRaw) return ''
  let obj: unknown
  try {
    obj = JSON.parse(argsRaw)
  } catch {
    return ''
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ''
  const rec = obj as Record<string, unknown>
  const lower = (name ?? '').toLowerCase()
  const isCmd = lower === 'bash' || lower === 'pwsh' || lower === 'powershell' || lower === 'shell' || lower === 'python' || lower === 'code' || lower.endsWith('exec')
  const isRead = lower === 'read' || lower === 'read_image' || lower === 'readtextfile' || lower.includes('fetch') || lower.includes('http')
  const isSearch = lower === 'web_search' || lower === 'search' || lower === 'grep' || lower === 'glob'
  // 文件写入/编辑是独立变体（摘要取路径、**不加「工具名 · 」前缀**）；漏了这行它们会被当成 others 加前缀
  const isWrite = lower === 'write' || lower === 'edit' || lower === 'str_replace_editor' || lower === 'apply_patch'
  if (!isCmd && !isRead && !isSearch && !isWrite) {
    // 无专属标题的工具：无偏好键，取首个非空字符串值，再兜底原始参数首行；
    // 摘要带「工具名 · 」前缀（真实工具名由摘要承载，标题统一是「工具调用」）
    const base = firstStringLine(rec) ?? clipLine(firstLine(argsRaw))
    if (base === '') return ''
    return name ? clipLine(`${name} · ${base}`) : base
  }
  const keys = isCmd
    ? ['description', 'command', 'cmd', 'code', 'script']
    : isWrite
      ? ['path', 'file_path'] // 文件写入/编辑：摘要即文件路径
      : isSearch
        ? ['query', 'pattern', 'url'] // 搜索类偏好键
        : ['path', 'file_path', 'filepath', 'url', 'description', 'query']
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) {
      return clipLine(firstLine(v))
    }
  }
  return ''
}

/** 取文本首行并去空白。 */
function firstLine(text: string): string {
  return text.trim().split('\n')[0].trim()
}

/**
 * 结果文本首行——失败行收起摘要用（对齐上游 `ToolRow`/`bash-sample` 的 `firstLine`：
 * 切到第一个换行符为止，**不 trim**）。
 * 空串/undefined 返回 null（上游那里空结果本就被当作「无结果」，摘要位落回描述）；
 * **首行为空行时返回 `''`**（上游同样如此：此时摘要位整体不显示，而不是落回描述）。
 * @param output - 工具结果文本（宿主已剥退出 marker）。
 * @returns 首行文本、`''`，或无结果时的 null。
 */
export function resultFirstLine(output: string | undefined): string | null {
  if (output === undefined || output === '') return null
  const nl = output.indexOf('\n')
  return nl === -1 ? output : output.slice(0, nl)
}

/** 摘要单行截断（按本插件侧栏宽度设上限）。 */
function clipLine(line: string): string {
  return line.length > 140 ? line.slice(0, 140) + '…' : line
}

/** 对象里首个非空字符串值（按属性声明序）。 */
function firstStringLine(rec: Record<string, unknown>): string | undefined {
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.trim()) return clipLine(firstLine(v))
  }
  return undefined
}

/**
 * 缓存命中率（对齐官方 `formatCacheHitPercent(cacheRead, promptTokens, 1)`）：保留 1 位小数；
 * 整数去尾 `.0`（26.0→26，26.4→26.4，100→100）。
 * @param cacheReadTokens - cacheRead。
 * @param promptTokens - 输入总 tokens（totalToken − outputTokens = uncached+cacheRead+cacheWrite）；0 返回 ''。
 */
export function cacheHitPercent(cacheReadTokens: number, promptTokens: number): string {
  if (promptTokens <= 0) return ''
  const pct = (cacheReadTokens / promptTokens) * 100
  const s = pct.toFixed(1)
  return s.endsWith('.0') ? pct.toFixed(0) : s
}

/** ≥1e3 缩写为 K（如 10240 → 10.2K）；无效/≤0 返回空串 */
export function compactTokens(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return ''
  if (n >= 1000) return (Math.round((n / 1000) * 10) / 10).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

/** 单轮完成统计(chatDone.stats):只取官方字段,不自己测时/算 tok/s */
export function formatTurnStats(stats?: Record<string, unknown>): string {
  if (!stats) {
    return ''
  }
  const parts: string[] = []
  const steps = stats['steps']
  if (typeof steps === 'number' && steps > 0) {
    parts.push(`${steps} 步`)
  }
  const inp = stats['inputTokens']
  const out = stats['outputTokens']
  const cache = stats['cacheReadTokens']
  const cacheWrite = stats['cacheWriteTokens']
  const reasoning = stats['reasoningTokens']
  const inpN = typeof inp === 'number' ? inp : 0
  const cacheWN = typeof cacheWrite === 'number' ? cacheWrite : 0
  if (typeof cache === 'number' && inpN + cache + cacheWN > 0) {
    parts.push(`缓存命中 ${cacheHitPercent(cache, inpN + cache + cacheWN)}%`)
  }
  if (typeof inp === 'number') {
    parts.push(`输入 ${inp} tok`)
  }
  if (typeof out === 'number') {
    parts.push(`输出 ${out} tok`)
  }
  if (typeof cache === 'number' && cache > 0) {
    parts.push(`缓存 ${cache} tok`)
  }
  if (typeof cacheWrite === 'number' && cacheWrite > 0) {
    parts.push(`缓存写 ${cacheWrite} tok`)
  }
  if (typeof reasoning === 'number' && reasoning > 0) {
    parts.push(`推理 ${reasoning} tok`)
  }
  return parts.join(' · ')
}

/** 底部统计条(sessionStats + tokenUsage 投影)→ { text, title };均超长省略/悬停全文 */
export function formatStatsLine(projections: Record<string, unknown>): { text: string; title: string } {
  const s = (projections['sessionStats'] as Record<string, number> | undefined) ?? {}
  const t = (projections['tokenUsage'] as Record<string, number> | undefined) ?? {}
  const parts: string[] = []
  const turns = s['turns'] as number | undefined
  const steps = s['steps'] as number | undefined
  if (typeof turns === 'number' && turns > 0) parts.push(`${turns} 轮`)
  if (typeof steps === 'number' && steps > 0) parts.push(`${steps} 步`)
  const llmMs = s['llmMs'] as number | undefined
  const toolMs = s['toolMs'] as number | undefined
  if (typeof llmMs === 'number' && llmMs > 0) parts.push(`LLM ${(llmMs / 1000).toFixed(1)}s`)
  if (typeof toolMs === 'number' && toolMs > 0) parts.push(`工具调用 ${(toolMs / 1000).toFixed(1)}s`)
  const ttftMs = s['ttftMs'] as number | undefined
  const ttftSteps = s['ttftSteps'] as number | undefined
  if (typeof ttftMs === 'number' && typeof ttftSteps === 'number' && ttftMs > 0 && ttftSteps > 0) {
    parts.push(`首 token 平均 ${(ttftMs / ttftSteps / 1000).toFixed(1)}s`)
  }
  const decodeMs = s['decodeMs'] as number | undefined
  const decodeTokens = s['decodeTokens'] as number | undefined
  if (typeof decodeMs === 'number' && typeof decodeTokens === 'number' && decodeMs > 0 && decodeTokens > 0) {
    parts.push(`${(decodeTokens / (decodeMs / 1000)).toFixed(0)} tok/s`)
  }
  const input = t['uncachedInputTokens'] as number | undefined
  const cache = t['cacheReadTokens'] as number | undefined
  const cacheWrite = t['cacheWriteTokens'] as number | undefined
  const output = t['outputTokens'] as number | undefined
  // 官方 billedInputTokens = uncached + cacheRead + cacheWrite；命中率分母用 billedInput
  const billedInput = (input ?? 0) + (cache ?? 0) + (cacheWrite ?? 0)
  if (typeof cache === 'number' && billedInput > 0) {
    parts.push(`缓存命中 ${cacheHitPercent(cache, billedInput)}%`)
  }
  if (typeof input === 'number') parts.push(`输入 ${input} tok`)
  if (typeof output === 'number') parts.push(`输出 ${output} tok`)
  if (typeof cache === 'number' && cache > 0) parts.push(`缓存 ${cache} tok`)
  if (typeof cacheWrite === 'number' && cacheWrite > 0) parts.push(`缓存写 ${cacheWrite} tok`)
  const line = parts.join(' · ')
  return { text: line, title: line }
}

/** dsh agent 模式展示名(MODE_NAMES) */
export const MODE_NAMES: Record<string, string> = {
  standard: '标准模式',
  minimal: '极简模式',
  cordis: '创造模式',
  ptc: 'PTC 模式',
}

/** 危险权限预设(切换需先经确认弹窗;与 src/extension.ts 保持一致来源) */
export const DANGEROUS_PERMS = new Set<string>(['danger-full-access'])
