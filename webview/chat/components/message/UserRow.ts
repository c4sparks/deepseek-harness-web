// 用户消息行：右侧深色气泡 + @引用 chip + 图片。
import { html } from 'htm/preact'
import type { ChatRow, ChatStore } from '../../core/store/chat'
import type { ImageAttachment } from '../../core/protocol'
import { RowMeta } from './meta'
import { AttachmentGallery } from '../attachment/AttachmentGallery'
import { fileExt, fileSizeText } from '../../core/file-labels'

export function UserRow({ row, store, latest }: { row: Extract<ChatRow, { kind: 'user' }>; store: ChatStore; latest?: boolean }) {
  // 版式：**附件行（图片/文件）在气泡之外、且在正文之上**，
  // 然后才是正文气泡（内含 @引用 chip 与文本）；引用摘要与动作在最后。
  const hasAtts = row.images.length > 0 || (row.files?.length ?? 0) > 0 || (row.imageRefs?.length ?? 0) > 0
  return html`<div class="msg user${latest ? ' latest' : ''}"><div class="col">
    ${hasAtts
      ? html`<div class="user-atts">
          ${row.images.map(
            (img: ImageAttachment) =>
              html`<div class="user-img" key=${img.name}><img src=${`data:${img.mediaType};base64,${img.data}`} alt=${img.name || '图片'} title=${img.name || ''} /></div>`
          )}
          ${row.files && row.files.length > 0
            ? html`<div class="user-files">${row.files.map((f, i) => {
                const meta = [fileExt(f.name), fileSizeText(f.bytes)].filter(Boolean).join(' ')
                // 有本地路径（实时发送的）→ 可点开；历史回放的只有名字/大小 → 与上游一样只展示
                return f.path !== undefined
                  ? html`<button type="button" class="user-file-chip" key=${i} title=${f.path}
                      onClick=${() => store.openFile(f.path as string)}>
                      <span class="codicon codicon-file"></span>
                      <span class="ufname">${f.name}</span>
                      <span class="ufmeta">${meta}</span>
                    </button>`
                  : html`<span class="user-file-chip" key=${i} title=${f.name}>
                      <span class="codicon codicon-file"></span>
                      <span class="ufname">${f.name}</span>
                      <span class="ufmeta">${meta}</span>
                    </span>`
              })}</div>`
            : null}
          ${row.imageRefs && row.imageRefs.length > 0
            ? html`<div class="user-img"><${AttachmentGallery} store=${store} images=${row.imageRefs} /></div>`
            : null}
        </div>`
      : null}
    <div class="body">
      ${row.refs && row.refs.length > 0
        ? html`<div class="user-refs">${row.refs.map(
            (r) => html`<span class="msg-ref-chip" key=${r.label + r.kind}>
              <span class="ficon codicon codicon-${r.kind === 'directory' ? 'folder-opened' : r.kind === 'session' ? 'comment-discussion' : 'file'}"></span>${r.label}</span>`
          )}</div>`
        : null}
      ${row.text ? html`<div class="user-text">${row.text}</div>` : null}
    </div>
    ${RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
    })}
  </div></div>`
}
