// 过程链（Chain）：`N 次工具调用 · M 条消息` 是**外层折叠**（点它展开/收起过程明细）。
// 有过程内容(工具/上下文注入/召回/计数) → 折叠头(默认收起，点开看明细：注入/思考/工具/web/提问卡 平铺)；
// 纯思考(无注入/无工具/无计数) → 不显示折叠头，思考行直接平铺在前（官方"一开始是思考"）。
// 进行中(未结束)明细展开(能看到思考/工具在动)，定稿收起成折叠头 —— 与官方 turnClosed 一致。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatRow, ChainItem, ChatStore } from '../../core/store/chat'
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

  // 是否收纳成外层折叠：链里有工具项(ask 提问除外——其交互在 waterfall 弹窗)、上下文注入/召回项，或定稿计数>0
  const chainToolCount = chain.filter((c) => c.kind === 'tool' && c.name !== 'ask_user_question').length
  const hasContext = chain.some((c) => c.kind === 'context')
  const hasFold =
    chainToolCount > 0 ||
    hasContext ||
    row.counts.toolCallCount > 0 ||
    row.counts.messageCount > 0

  // 折叠计数：定稿用官方 counts；进行中用链内实际工具数(实时)
  const parts: string[] = []
  const toolCount = row.done ? row.counts.toolCallCount : chainToolCount
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  if (row.counts.messageCount > 0) parts.push(`${row.counts.messageCount} 条消息`)
  const foldLabel = parts.length > 0 ? parts.join(' · ') : '已思考'

  // 活跃 reasoning = 最后一条 reasoning 且正文未开始（live 内滚跟随最新）
  let lastReasonIdx = -1
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].kind === 'reasoning') lastReasonIdx = i
  }
  const itemNode = (item: ChainItem, idx: number): unknown => {
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
    : null // 纯思考：无折叠头，思考行平铺

  // 有折叠：点开才看明细；纯思考：明细恒展（思考行平铺在前）
  const detailVisible = hasFold ? open : true

  return html`<div class="chain">
    ${head}
    ${detailVisible ? html`<div class="chain-detail">${chain.map(itemNode)}</div>` : null}
  </div>`
}
