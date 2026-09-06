// 展示层纯函数(无状态/DOM):工具名中文化、消息统计与底部统计条文案。
// 与旧 chat.ts 逻辑一致,供组件与 store 复用。

/** turn/end 的终止原因(kind)→ 用户可读短句。正常/未知 kind 返回空串。 */
export function turnEndNote(end: { kind?: string; message?: string } | undefined): string {
  if (!end || !end.kind) return ''
  const kindText: Record<string, string> = {
    error: '回合出错',
    aborted: '回合被中止',
    interrupted: '回合被打断',
    'max-tokens': '达到最大 token 上限',
    blocked: '回合被阻塞',
    cancelled: '已取消',
  }
  const head = kindText[end.kind] ?? `回合以 ${end.kind} 结束`
  const detail = end.message && end.message.trim() ? `：${end.message.trim()}` : ''
  return head + detail
}

/** dsh 事件/快照自带的原始时间戳(epoch 秒或毫秒,由上游给出)→ 本地 HH:mm:ss。无值不伪造。 */
export function formatApiTime(t: number | undefined | null): string {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
    return ''
  }
  const ms = t > 1e12 ? t : t * 1000
  return new Date(ms).toTimeString().slice(0, 8)
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
  if (typeof inp === 'number' && typeof cache === 'number' && inp + cache > 0) {
    parts.push(`缓存命中 ${Math.round((cache / (inp + cache)) * 100)}%`)
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
  if (typeof input === 'number' && typeof cache === 'number' && input + cache > 0) {
    parts.push(`缓存命中 ${((cache / (input + cache)) * 100).toFixed(0)}%`)
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
