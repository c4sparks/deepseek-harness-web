// 用户消息行：右侧深色气泡 + @引用 chip + 图片。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import type { ImageAttachment } from '../../core/protocol'
import { RowMeta } from './meta'

export function UserRow({ row, store, latest }: { row: Extract<ChatRow, { kind: 'user' }>; store: ChatStore; latest?: boolean }) {
  return html`<div class="msg user${latest ? ' latest' : ''}"><div class="col"><div class="body">
    ${row.refs && row.refs.length > 0
      ? html`<div class="user-refs">${row.refs.map(
          (r) => html`<span class="msg-ref-chip" key=${r.label + r.kind}>
            <span class="ficon codicon codicon-${r.kind === 'directory' ? 'folder-opened' : r.kind === 'session' ? 'comment-discussion' : 'file'}"></span>${r.label}</span>`
        )}</div>`
      : null}
    ${row.text ? html`<div class="user-text">${row.text}</div>` : null}
    ${row.images.map(
      (img: ImageAttachment) =>
        html`<div class="user-img" key=${img.name}><img src=${`data:${img.mediaType};base64,${img.data}`} alt=${img.name || '图片'} title=${img.name || ''} /></div>`
    )}
  </div>
    ${RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
      regenable: !!row.text,
      hideRegen: true, // 提问行只保留复制
      onRegen: () => store.regenerate(row.text, row.images),
    })}
  </div></div>`
}
