// 终端卡(官方 TerminalBlock)纯函数模型：variant 分类、退出状态解析、提示行标签、zh 字典。
// 铁律：文案/结构取自官方 ui-tool / ui-conversation / ui-primitives，不自行翻译、不编造；
// 本节是对官方源码(terminal-card-model.ts / TerminalBlock.tsx / bash-sample.tsx)的忠实复刻。
// host 侧另有等价解析( src/dsh/official/exit-status.ts )，二者正则保持一致。

/** 工具变体（对齐官方 tool-call-model 的 ToolRowVariant 归组） */
export type ToolVariant = 'bash' | 'read' | 'search' | 'write' | 'edit' | 'code' | 'others'

const TOOL_VARIANTS: Record<string, ToolVariant> = {
  bash: 'bash', pwsh: 'bash', shell: 'bash', powershell: 'bash',
  read: 'read', read_image: 'read', readTextFile: 'read', web_fetch: 'read', webFetch: 'read',
  web_search: 'search', search: 'search', grep: 'search', glob: 'search',
  write: 'write', edit: 'edit', str_replace_editor: 'edit', apply_patch: 'edit',
  run_code: 'code', code: 'code',
}

/** 工具名 → 展示变体（未知兜底 others，对齐官方 classifyTool） */
export function classifyTool(name: string): ToolVariant {
  return TOOL_VARIANTS[name] ?? 'others'
}

/** 是否为终端命令工具（bash/pwsh/shell 归组 → 渲染 Terminal 卡） */
export function isTerminalTool(name: string): boolean {
  return classifyTool(name) === 'bash'
}

// ---- 退出状态解析（Webview 侧；marker 由 shell render 追加，非独立 JSON 字段）----
const SIGNAL_RE = /\n\[killed by signal: ([^\]\n]+)\]$/
const EXIT_RE = /\n\[exit code: (\d+)\]$/

/** 解析输出末尾的退出状态 marker，并返回剥掉 marker 的干净输出。无 marker 返回 exitCode 0。 */
export function parseExitStatus(text: string): { output: string; exitCode?: number; signal?: string } {
  const signal = SIGNAL_RE.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = EXIT_RE.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

/** 剥掉 ANSI 转义序列（终端输出可能带色码，webview 不渲染，先剥离避免乱码） */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** 提示行 cwd 标签（对齐官方 promptLabel：精确等于 home 折叠为 ~，否则取路径末段，无值用 $） */
export function promptLabel(cwd: string | undefined, home?: string): string {
  if (cwd === undefined || cwd === '') return '$'
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (home !== undefined && trimmed === home.replace(/[/\\]+$/, '')) return '~'
  const segment = trimmed.split(/[/\\]/).pop()
  return segment === undefined || segment === '' ? cwd : segment
}

// ---- 展示字典（zh，原文照抄官方 ui-conversation + 共享 base；不自行翻译）----
export interface TerminalLabels {
  signal: (s: string) => string
  exitCode: (c: number) => string
  running: string
  failed: string
  done: string
  copy: string
  copied: string
  noOutput: string
  collapse: string
  expand: (n: number) => string
}

/** 官方 zh 字典原文（terminal.* / copy / collapse） */
export function terminalLabels(): TerminalLabels {
  return {
    signal: (s) => `信号 ${s}`,
    exitCode: (c) => `退出码 ${c}`,
    running: '运行中',
    failed: '失败',
    done: '已完成',
    copy: '复制',
    copied: '复制成功',
    noOutput: '无输出',
    collapse: '收起',
    expand: (n) => `… 其余 ${n} 行`,
  }
}

// ---- 终端卡模型：从 tool item 派生（bash/pwsh/shell 且含 command 才返回，否则 null → 通用路径）----
export interface TermCard {
  /** 命令原文（多行已拆成数组，逐行成提示行） */
  command: string[]
  /** 工具描述/摘要（bash 类 description；展开头行摘要源） */
  description?: string
  /** 工作目录（args.workdir/cwd；用于提示行标签；未给 → $） */
  cwd?: string
  /** 输出（已剥 exit status marker） */
  output?: string
  exitCode?: number
  signal?: string
  running: boolean
  /** 定稿且 exitCode!=0 或 signal（非零退出/信号终止 = 失败） */
  failed: boolean
  /** 定稿且无可见输出 */
  empty: boolean
}

interface ShellArgs {
  command?: string
  description?: string
  workdir?: string
  cwd?: string
}

function parseArgs(argsRaw?: string): ShellArgs | null {
  if (!argsRaw) return null
  try {
    const o = JSON.parse(argsRaw)
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as ShellArgs) : null
  } catch {
    return null
  }
}

/**
 * 从 tool item 派生终端卡。要求：工具变体为 bash 且 arguments 含非空 command（对齐官方 shellCall 校验）；
 * 否则返回 null（调用方回退通用"输出 + raw JSON"）。exitCode/signal 优先取宿主已解析值，缺省再兜底解析。
 */
export function terminalCardModel(
  t: { name: string; argsRaw?: string; output?: string; exitCode?: number; signal?: string; status: string },
): TermCard | null {
  if (!isTerminalTool(t.name)) return null
  const args = parseArgs(t.argsRaw)
  const command = typeof args?.command === 'string' ? args.command : ''
  if (command.trim() === '') return null
  const workdir =
    typeof args?.workdir === 'string' ? args.workdir : typeof args?.cwd === 'string' ? args.cwd : undefined
  const running = t.status === 'running'
  // 宿主已剥 marker 则直接用；否则兜底解析（同一正则，结果一致）
  const parsed = parseExitStatus(t.output ?? '')
  const output = parsed.output
  const exitCode = t.exitCode !== undefined ? t.exitCode : parsed.exitCode
  const signal = t.signal !== undefined ? t.signal : parsed.signal
  const failed = !running && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined)
  const empty = !running && output.trim() === ''
  return {
    command: command.split('\n'),
    description: typeof args?.description === 'string' ? args.description : undefined,
    cwd: workdir,
    output,
    exitCode,
    signal,
    running,
    failed,
    empty,
  }
}
