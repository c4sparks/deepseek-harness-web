// 输入框下方的会话级信息：**两张互相独立的卡**（会话统计 / Token 用量）。
//
// 为什么不并成一行字：这两组数各看各的维度（回合与耗时 vs token 桶），并排成一句长文本后
// 既读不出重点、窄面板下还会被整体省略号吃掉。上游就是两个图标 pill，各自点开自己的明细卡。
// 数据都是**会话级**（整份日志的累计），与回答行尾部的「本轮用量/用时」不是一回事。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ChatStore, SessionStatsView, TokenUsageView } from '../core/store/chat'
import {
  cacheHitPercent,
  formatCompactTokens,
  formatDurationCompact,
  formatTokensPerSecond,
} from '../core/format'

/** Token 总用量 = 四个互斥桶之和（上游同口径）。 */
function totalTokens(u: TokenUsageView): number {
  return (u.uncachedInputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + (u.outputTokens ?? 0)
}

/** 缓存命中率：分母 = 未缓存输入 + 缓存读 + 缓存写（上游 billedInput 口径）。 */
function cacheHit(u: TokenUsageView): string {
  const billed = (u.uncachedInputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  return typeof u.cacheReadTokens === 'number' && billed > 0 ? cacheHitPercent(u.cacheReadTokens, billed) : ''
}

/** 输出速度：由解码时长与输出 token 相除得出（投影里没有现成的 tok/s）。 */
function tpsOf(s: SessionStatsView): string {
  const ms = s.decodeMs
  const tokens = s.decodeTokens
  if (typeof ms !== 'number' || typeof tokens !== 'number' || ms <= 0 || tokens <= 0) return ''
  return formatTokensPerSecond(tokens / (ms / 1000))
}

/** 明细卡里的一行（键右对齐数值，数值用等宽数字）。 */
const row = (k: string, v: string): unknown =>
  html`<div class="sp-row"><span class="sp-k">${k}</span><span class="sp-v">${v}</span></div>`

export function StatsCards({ store }: { store: ChatStore }) {
  const stats = store.sessionStats.value
  const usage = store.tokenUsage.value
  // 两个 pill 共用一个互斥的打开槽（上游同款：同一时刻只开一个明细卡）
  const [open, setOpen] = useState<'time' | 'usage' | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 点空白 / Esc 关闭：明细卡是常驻条上的浮层，不关会一直盖着输入框
  useEffect(() => {
    if (open === null) return
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const tokens = usage === null ? 0 : totalTokens(usage)
  const hit = usage === null ? '' : cacheHit(usage)
  const tps = stats === null ? '' : tpsOf(stats)
  // 没有任何统计也没用量 → 整条不渲染（上游：steps 为 0 且无 token 时不渲染）
  if ((stats === null || (stats.steps ?? 0) === 0) && tokens === 0) return null

  const countsText = stats === null ? '' : `${String(stats.turns ?? 0)} 轮 ${String(stats.steps ?? 0)} 步`
  const timeRows: unknown[] = []
  if (stats !== null) {
    const llm = formatDurationCompact(stats.llmMs === undefined ? undefined : stats.llmMs / 1000)
    const tool = formatDurationCompact(stats.toolMs === undefined ? undefined : stats.toolMs / 1000)
    const ttft =
      typeof stats.ttftMs === 'number' && typeof stats.ttftSteps === 'number' && stats.ttftSteps > 0
        ? formatDurationCompact(stats.ttftMs / stats.ttftSteps / 1000)
        : ''
    if (llm !== '') timeRows.push(row('模型用时', llm))
    if (tool !== '') timeRows.push(row('工具调用用时', tool))
    if (ttft !== '') timeRows.push(row('首 token 平均（TTFT）', ttft))
    if (tps !== '') timeRows.push(row('输出速度（TPS）', `${tps} tok/s`))
  }
  const usageRows: unknown[] = []
  if (usage !== null) {
    // 精确计数用千分位（上游同：明细卡给的是可核对的整数，不是缩写）
    const exact = (v: number | undefined): string => (typeof v === 'number' ? v.toLocaleString('en-US') : '')
    if (typeof usage.uncachedInputTokens === 'number') usageRows.push(row('未缓存输入', `${exact(usage.uncachedInputTokens)} tok`))
    if (typeof usage.cacheReadTokens === 'number') usageRows.push(row('缓存读取', `${exact(usage.cacheReadTokens)} tok`))
    if (typeof usage.cacheWriteTokens === 'number') usageRows.push(row('缓存写入', `${exact(usage.cacheWriteTokens)} tok`))
    if (typeof usage.outputTokens === 'number') usageRows.push(row('输出', `${exact(usage.outputTokens)} tok`))
    if (hit !== '') usageRows.push(row('缓存命中', `${hit}%`))
  }
  const timeTitle = countsText !== '' ? countsText : '会话统计'
  const usageTitle = tokens > 0 ? `${formatCompactTokens(tokens)} tok` : 'Token 用量'

  /** 一张卡：pill（图标 + 主读数 + 次读数）+ 点开后向上展开的明细。浮层挂在**自己这一格**里，左对齐自己的 pill。 */
  const card = (
    kind: 'time' | 'usage',
    icon: string,
    title: string,
    headline: string,
    secondary: string,
    rows: unknown[]
  ): unknown => html`<span class="sp-wrap" key=${kind}>
    <button type="button" class="sp-pill" title=${title} aria-haspopup="dialog" aria-expanded=${open === kind}
      aria-label=${secondary !== '' ? `${headline} · ${secondary}` : headline}
      onClick=${() => setOpen(open === kind ? null : kind)}>
      <span class=${'codicon sp-ico codicon-' + icon} aria-hidden="true"></span>
      <span class="sp-text">${headline}</span>
      ${secondary !== ''
        ? html`<span class="sp-sep" aria-hidden="true">·</span><span class="sp-text">${secondary}</span>`
        : null}
    </button>
    ${open === kind
      ? html`<div class="sp-pop" role="dialog" aria-label=${title}>
          <div class="sp-pop-title">${title}</div>
          ${rows}
        </div>`
      : null}
  </span>`

  return html`<div class="stats-cards" ref=${rootRef}>
    ${timeRows.length > 0
      ? card('time', 'dashboard', '会话统计', timeTitle, tps !== '' ? `${tps} tok/s` : '', timeRows)
      : null}
    ${usageRows.length > 0
      ? card('usage', 'database', 'Token 用量', usageTitle, hit !== '' ? `缓存命中 ${hit}%` : '', usageRows)
      : null}
  </div>`
}
