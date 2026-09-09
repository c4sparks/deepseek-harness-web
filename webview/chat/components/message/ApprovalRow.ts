// 审批卡行（需要批准的工具操作）。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'

export function ApprovalRow({ row, store }: { row: Extract<ChatRow, { kind: 'approval' }>; store: ChatStore }) {
  return html`<div class="approval">
    <div class="appr-info">
      <span class="appr-title"><span class="codicon codicon-warning inline-ico"></span>需要批准${row.toolName ? `：${row.toolName}` : ''}</span>
      ${row.description && row.description !== '需要授权操作' ? html`<div class="appr-reason">${row.description}</div>` : null}
    </div>
    <button class="allow" onClick=${() => store.answerApproval(row.approvalId, true, row.key)}>允许</button>
    <button class="reject" onClick=${() => store.answerApproval(row.approvalId, false, row.key)}>拒绝</button>
  </div>`
}
