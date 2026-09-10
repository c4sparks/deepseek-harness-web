// 过程链（Chain）：`N 次工具调用 · M 条消息` 是**外层折叠**（点它展开/收起过程明细）。
// 链里有任何过程内容(工具/思考/上下文注入/召回/计数) → 折叠头(进行中展开、定稿收起，
// 点开看明细：注入/思考/工具/web/提问卡 平铺)；计数全为 0 时折叠头文案兜底「已思考」。
// **纯思考同样出折叠头**——上游 foldable 对「有过程成员」成立，与「N 次工具调用」是同一套折叠，
// 不是平铺；定稿后思考行同样收进折叠里。
// 例外：只含提问行(ask)时不出折叠头，平铺显示问行（提问不参与过程折叠，见 docs/design/10 §2.3）。
// 进行中(未结束)明细展开(能看到思考/工具在动)，定稿收起成折叠头 —— 与官方 turnClosed 一致。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatRow, DshTurnProcessItem, ChatStore } from '../../core/store/chat'
import { ReasoningRow } from './ReasoningRow'
import { ToolRow } from './ToolRow'
import { ContextInjectionRow } from '../message/ContextInjectionRow'

type AssistantRow = Extract<ChatRow, { kind: 'assistant' }>

export function Chain({ row, store }: { row: AssistantRow; store: ChatStore }) {
  const chain = row.chain
  // 进行中展开、定稿收起（对齐官方 turnClosed）
  const [open, setOpen] = useState(!row.done)
  useEffect(() => {
    setOpen(!row.done)
  }, [row.done])
  if (chain.length === 0) return null

  // 是否收纳成外层折叠：链里有工具项(ask 提问除外——其交互在 waterfall 弹窗)、思考行、上下文注入/召回项，或定稿计数>0。
  // 思考行必须计入：上游纯思考同样出折叠头（文案兜底「已思考」），不是平铺。
  const chainToolCount = chain.filter((c) => c.kind === 'tool' && c.name !== 'ask_user_question').length
  const hasReasoning = chain.some((c) => c.kind === 'reasoning')
  const hasContext = chain.some((c) => c.kind === 'context')
  const hasFold =
    chainToolCount > 0 ||
    hasReasoning ||
    hasContext ||
    row.counts.toolCallCount > 0 ||
    row.counts.messageCount > 0 ||
    row.counts.subagentCount > 0

  // 折叠计数：定稿用宿主 counts；进行中用链内实际工具数(实时)。
  // 三项顺序与上游一致：工具调用 → 条消息 → subagent；全为 0 兜底「已思考」。
  const parts: string[] = []
  const toolCount = row.done ? row.counts.toolCallCount : chainToolCount
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  if (row.counts.messageCount > 0) parts.push(`${row.counts.messageCount} 条消息`)
  if (row.counts.subagentCount > 0) parts.push(`${row.counts.subagentCount} 个 subagent`)
  const foldLabel = parts.length > 0 ? parts.join(' · ') : '已思考'

  // 活跃 reasoning = 最后一条 reasoning 且正文未开始（live 内滚跟随最新）
  let lastReasonIdx = -1
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].kind === 'reasoning') lastReasonIdx = i
  }
  const itemNode = (item: DshTurnProcessItem, idx: number): unknown => {
    if (item.kind === 'reasoning') {
      return html`<${ReasoningRow} key=${item.key} item=${item} live=${!row.done && !row.bodyStarted && idx === lastReasonIdx} />`
    }
    if (item.kind === 'context') {
      // 系统提示词(agent-instructions, form==='instructions')→左上角常驻，不入链；其余注入(召回/技能/插件)保留
      if (item.form === 'instructions') return null
      return html`<${ContextInjectionRow} key=${item.key} item=${item} />`
    }
    return html`<${ToolRow} key=${item.key} item=${item} store=${store} />`
  }

  const head = hasFold
    ? html`<button class="chain-summary" onClick=${() => setOpen((o) => !o)} aria-expanded=${open}>
        <span class="chain-summary-ico codicon codicon-sparkle"></span>
        <span class="chain-summary-text">${foldLabel}</span>
        <span class=${'codicon chain-summary-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
      </button>`
    : null // 只含提问行：无折叠头，问行平铺

  // 有折叠：点开才看明细；只含提问行：明细恒展
  const detailVisible = hasFold ? open : true

  return html`<div class="chain">
    ${head}
    ${detailVisible ? html`<div class="chain-detail">${chain.map(itemNode)}</div>` : null}
  </div>`
}
