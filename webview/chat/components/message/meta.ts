// 行动作条（RowMeta）：时间 + 复制 + 分叉 + 追加动作(反馈、用量/用时)。
import { html } from 'htm/preact'

export function RowMeta({
  time,
  onCopy,
  onBranch,
  copyable,
  branchable,
  extraActions,
}: {
  time?: string
  onCopy?: () => void
  /** 「在新对话中分支」：只有当前对话的最后一条、且带回答锚点的回答才可用（判据见 AssistantRow） */
  onBranch?: () => void
  copyable: boolean
  branchable?: boolean
  /** 追加在行内动作区末尾（assistant 反馈、用量/用时） */
  extraActions?: unknown
}) {
  // 不可用时也要说清**为什么**：一个点不动的按钮比没有按钮更让人以为是坏了
  const branchLabel = branchable ? '在新对话中分支' : '仅可从已完成轮次的最后一条消息分支'
  return html`<div class="msg-meta"><span class="time">${time ?? ''}</span><span class="msg-actions">
    <button data-act="copy" title="复制" disabled=${!copyable} onClick=${onCopy}><span class="codicon codicon-copy"></span></button>
    ${onBranch === undefined ? null : html`<button data-act="branch" title=${branchLabel} aria-label=${branchLabel}
      disabled=${!branchable} onClick=${onBranch}><span class="codicon codicon-git-branch"></span></button>`}
    ${extraActions}
  </span></div>`
}
