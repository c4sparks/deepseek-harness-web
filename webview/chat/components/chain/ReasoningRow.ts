// 思考行（ReasoningRow，Disclosure 形态，对齐官方 ReasoningRow）：
// 收起态=一行动态摘要——定稿/历史取首行，流式(live)取**最新一行**(latestLine)实时跟随；展开才看全文。
// 标签"思考"固定不换行；全文始终在 DOM。
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ChainItem } from '../../core/store/chat'

type Reasoning = Extract<ChainItem, { kind: 'reasoning' }>

/** 收起预览 = 首个非空段（单行，宽不足再省略；全文靠展开）。 */
const firstLine = (text: string): string => {
  for (const ln of text.split('\n')) {
    const t = ln.trim()
    if (t) return t
  }
  return ''
}

/** 收起预览（流式 live）= 最新一行（官方 ReasoningRow `latestLine`，动态跟随思考尾部）。 */
const latestLine = (text: string): string => {
  const visible = text.trimEnd()
  const nl = visible.lastIndexOf('\n')
  return nl === -1 ? visible : visible.slice(nl + 1)
}

export function ReasoningRow({ item, live }: { item: Reasoning; live?: boolean }) {
  const [open, setOpen] = useState(false) // 默认收起(一行动态摘要)；点开看全文
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (open && live && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [item.text, live, open])
  // 收起摘要剥掉 markdown 加粗符号 `**`（如 `**重点**`→`重点`），更干净；全文不动
  const preview = (live ? latestLine(item.text) : firstLine(item.text)).replaceAll('**', '')
  return html`<div class="chain-disclosure">
    <button class="chain-row-head" onClick=${() => setOpen((o) => !o)} aria-expanded=${open} title=${preview || ''}>
      <span class=${'codicon chain-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
      <span class="codicon codicon-lightbulb chain-kind-ico"></span>
      <span class="chain-row-title">思考</span>
      ${open ? null : preview ? html`<span class="chain-sep" aria-hidden></span><span class="chain-row-preview">${preview}</span>` : null}
    </button>
    ${open ? html`<div class=${'chain-reason is-open' + (live ? ' is-live' : '')} ref=${ref}>${item.text}</div>` : null}
  </div>`
}
