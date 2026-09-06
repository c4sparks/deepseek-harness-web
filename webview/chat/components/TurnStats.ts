// 用量 / 用时 弹窗组件（对齐 dsh 官方字段）。喂入 chatDone.stats 原始值(usageRaw)。
// 独立成组件，后续要改字段文案/布局/触发方式只动这里。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { compactTokens } from '../core/format'

// 全局单实例弹窗：任意一行打开用量/用时弹窗时，关闭其它行已打开的弹窗（最新点击胜出）
const closeOthers = new Set<() => void>()

export function TurnStats({ usage }: { usage: Record<string, unknown> }) {
  const [open, setOpen] = useState<'u' | 't' | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // close 用 ref 固定身份：注册表/关闭其它时按稳定函数身份排除自身
  const closeRef = useRef<() => void>(() => {})
  closeRef.current = () => setOpen(null)
  const selfClose = useRef<() => void>(() => {})
  // 弹窗打开时让所在 .msg 的悬停动作区(m.msg-meta)常显，移出消息不闪烁/不消失；
  // 打开本行弹窗时先关掉其它行已打开的（含 meta-open 清理）
  useEffect(() => {
    const msg = wrapRef.current?.closest('.msg')
    if (open) {
      msg?.classList.add('meta-open')
      for (const fn of [...closeOthers]) {
        if (fn !== selfClose.current) fn()
      }
    } else {
      msg?.classList.remove('meta-open')
    }
  }, [open])
  useEffect(() => {
    const fn = () => closeRef.current()
    selfClose.current = fn
    closeOthers.add(fn)
    return () => {
      closeOthers.delete(fn)
    }
  }, [])
  const num = (k: string): number | undefined => {
    const v = usage[k]
    return typeof v === 'number' ? (v as number) : undefined
  }
  const inp = num('inputTokens')
  const out = num('outputTokens')
  const cache = num('cacheReadTokens')
  const reason = num('reasoningTokens')
  const provider = usage['provider']
  const model = usage['model']
  const hit =
    typeof inp === 'number' && typeof cache === 'number' && inp + cache > 0 ? Math.round((cache / (inp + cache)) * 100) : undefined
  const total = (inp && inp > 0 ? inp : 0) + (cache && cache > 0 ? cache : 0) + (out && out > 0 ? out : 0)
  const wall = num('wallSec')
  const tps = num('tps')
  const ttft = num('ttftSec')
  const fmt = (v: number | undefined): string => (typeof v === 'number' ? v.toLocaleString('en-US') : '—')
  const row = (k: string, v: string): unknown => html`<div class="tt-row"><span class="tt-k">${k}</span><span class="tt-v">${v}</span></div>`
  const hasUsage = total > 0 || (typeof provider === 'string' && provider.length > 0)
  const hasTime = wall !== undefined || tps !== undefined || ttft !== undefined
  if (!hasUsage && !hasTime) return null
  // 图标旁常显数值：用量=本轮总量(compact)，用时=本轮总用时(秒)
  const usageBadge = compactTokens(total)
  const wallText = (() => {
    if (wall === undefined) return ''
    const s = wall >= 10 ? Math.round(wall) : Math.round(wall * 10) / 10
    return String(s) + '秒'
  })()
  return html`<div class="turn-meta" ref=${wrapRef}>
    ${hasUsage
      ? html`<button class=${'tm-btn' + (open === 'u' ? ' active' : '')} title="本轮用量"
          onClick=${() => setOpen(open === 'u' ? null : 'u')}><span class="codicon codicon-graph-line"></span>${usageBadge ? html`<span class="tm-txt">${usageBadge}</span>` : null}</button>`
      : null}
    ${hasTime
      ? html`<button class=${'tm-btn' + (open === 't' ? ' active' : '')} title="本轮用时与速度"
          onClick=${() => setOpen(open === 't' ? null : 't')}><span class="codicon codicon-clock"></span>${wallText ? html`<span class="tm-txt">${wallText}</span>` : null}</button>`
      : null}
    ${open === 'u'
      ? html`<div class="tt-pop">
          ${row('本轮用量', fmt(total > 0 ? total : undefined) + ' tok')}
          ${provider || model ? row('提供方 / 模型', [provider, model].filter(Boolean).join('/')) : null}
          ${row('缓存命中', hit !== undefined ? hit + '%' : '—')}
          ${row('未缓存输入', fmt(inp) + ' tok')}
          ${row('缓存读取', fmt(cache) + ' tok')}
          ${row('输出', fmt(out) + ' tok' + (reason && reason > 0 ? `（其中推理 ${fmt(reason)} tok）` : ''))}
        </div>`
      : null}
    ${open === 't'
      ? html`<div class="tt-pop">
          ${row('本轮总用时', wall !== undefined ? wall + '秒' : '—')}
          ${row('输出速度（TPS）', tps !== undefined ? tps + ' tok/s' : '—')}
          ${row('首 token 用时（TTFT）', ttft !== undefined ? ttft + '秒' : '—')}
        </div>`
      : null}
  </div>`
}
