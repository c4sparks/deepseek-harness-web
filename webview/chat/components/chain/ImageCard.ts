// 图片卡（子类卡）：读类工具返回图片时的展开体 —— 标签 + 图廊 + 信封文本。
// 只负责「摆什么」；取件/加载态/失败重试/尺寸/看全尺寸都在附件大类（components/attachment）里。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'
import type { ImageCard as ImageCardData } from '../../core/image-card'
import { AttachmentGallery } from '../attachment/AttachmentGallery'

export function ImageCard({ card, store }: { card: ImageCardData; store: ChatStore }) {
  return html`<div class="img-card">
    <div class="img-label">${card.label}</div>
    <${AttachmentGallery} store=${store} images=${card.images} />
    ${card.text !== '' ? html`<div class="img-meta">${card.text}</div>` : null}
  </div>`
}
