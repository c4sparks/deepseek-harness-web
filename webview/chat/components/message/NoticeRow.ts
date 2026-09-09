// 通知/命令结果行（对话内：失败红点红字，成功常规色；不走 VSCode 通知）。
import { html } from 'htm/preact'
import type { ChatRow } from '../../core/store/chat'

export function NoticeRow({ row }: { row: Extract<ChatRow, { kind: 'notice' }> }) {
  const tone = row.tone === 'ok' ? 'ok' : 'error'
  return html`<div class="msg assistant"><div class="col"><div class="name"></div>
    <div class="body"><div class=${'user-text notice-line notice-' + tone}><span class="notice-dot">●</span>
      ${row.command ? html`<span class="notice-cmd">${row.command} · </span>` : null}<span class="notice-msg">${row.text}</span></div></div>
  </div></div>`
}
