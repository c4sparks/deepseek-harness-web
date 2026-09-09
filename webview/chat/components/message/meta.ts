// 行动作条（RowMeta）：时间 + 复制/重新生成 + 追加动作(TurnStats 用量/用时)。
import { html } from 'htm/preact'

export function RowMeta({
  time,
  onCopy,
  onRegen,
  copyable,
  regenable,
  hideRegen,
  extraActions,
}: {
  time?: string
  onCopy?: () => void
  onRegen?: () => void
  copyable: boolean
  regenable: boolean
  /** 隐藏“重新生成”（用户提问行只保留复制） */
  hideRegen?: boolean
  /** 追加在“重新生成”按钮之后的行内动作（assistant 用量/用时，顺序用量→用时） */
  extraActions?: unknown
}) {
  return html`<div class="msg-meta"><span class="time">${time ?? ''}</span><span class="msg-actions">
    <button data-act="copy" title="复制" disabled=${!copyable} onClick=${onCopy}><span class="codicon codicon-copy"></span></button>
    ${hideRegen ? null : html`<button data-act="regenerate" title="重新生成" disabled=${!regenable} onClick=${onRegen}><span class="codicon codicon-refresh"></span></button>`}
    ${extraActions}
  </span></div>`
}
