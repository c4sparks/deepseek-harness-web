// assistant 回复行：过程链(思考/工具折叠) + markdown 正文(流式光标) + 终态角标 + 动作条。
import { html } from 'htm/preact'
import { useMemo } from 'preact/hooks'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import { renderMd } from '../../core/markdown'
import { TurnStats } from '../TurnStats'
import { Chain } from '../chain/Chain'
import { RowMeta } from './meta'

export function AssistantRow({ row, store, latest }: { row: Extract<ChatRow, { kind: 'assistant' }>; store: ChatStore; latest?: boolean }) {
  const bodyHtml = useMemo(() => renderMd(row.text), [row.text])
  // 官方无正文流式光标（流式指示靠左下角 TurnStatus），正文不加打字光标
  // 动作条（复制/重新生成/用量/用时）：仅回答结束后(done)显示，回答过程中不出现
  return html`<div class="msg assistant${latest ? ' latest' : ''}"><div class="col">
    <${Chain} row=${row} store=${store} />
    <div class="body" dangerouslySetInnerHTML=${{ __html: bodyHtml }}></div>
    ${row.endMsg ? html`<div class="end-note"><span class="codicon codicon-warning inline-ico"></span>${row.endMsg}</div>` : null}
    ${row.status ? html`<div class="status-badge">${row.status}</div>` : null}
    ${row.done ? RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
      regenable: !!row.prompt,
      onRegen: () => row.prompt && store.regenerate(row.prompt),
      extraActions: row.usageRaw ? html`<${TurnStats} usage=${row.usageRaw} />` : undefined,
    }) : null}
  </div></div>`
}
