// assistant 回复行：过程链(思考/工具折叠) + markdown 正文(流式光标) + 终态角标 + 动作条。
import { html } from 'htm/preact'
import { useMemo } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { renderMd } from '../../core/markdown'
import { TurnStats } from '../TurnStats'
import { FeedbackActions } from './FeedbackActions'
import { Chain } from '../chain/Chain'
import { Deliverables } from './Deliverables'
import { RowMeta } from './meta'

export function AssistantRow({ row, store, latest }: { row: Extract<ChatRow, { kind: 'assistant' }>; store: ChatStore; latest?: boolean }) {
  const bodyHtml = useMemo(() => renderMd(row.text), [row.text])
  // 上游无正文流式光标（流式指示靠左下角 TurnStatus），正文不加打字光标
  // 动作条（复制/分叉/反馈/用量/用时）：仅回答结束后(done)显示，回答过程中不出现
  return html`<div class="msg assistant${latest ? ' latest' : ''}"><div class="col">
    <${Chain} row=${row} store=${store} />
    <div class="body" dangerouslySetInnerHTML=${{ __html: bodyHtml }}></div>
    ${row.endMsg ? html`<div class="end-note"><span class="codicon codicon-warning inline-ico"></span>${row.endMsg}</div>` : null}
    ${row.status ? html`<div class="status-badge">${row.status}</div>` : null}
    <${Deliverables} row=${row} store=${store} />
    ${row.done ? RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
      // 「在新对话中分支」：只有**当前对话的最后一条**、已定稿、且带回答锚点的回答才能分叉。
      // 与上游同一门控 —— 它只提供「从末尾分叉」，不提供从历史中间分叉（避免切点歧义）。
      onBranch: () => row.seq !== undefined && store.forkAt(row.seq),
      branchable: !!latest && row.seq !== undefined,
      // 反馈（👍/👎）跟在复制之后；只有拿到回答消息标识的行才有目标 —— 没有就整个不渲染，不给一个点了报错的按钮。
      extraActions: html`${row.messageId !== undefined ? html`<${FeedbackActions} store=${store} messageId=${row.messageId} />` : null}${row.usageRaw ? html`<${TurnStats} usage=${row.usageRaw} />` : null}`,
    }) : null}
  </div></div>`
}
