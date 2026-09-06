import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

// 与旧 chat.ts 一致:禁用原生 HTML、自动链接、回车即换行。
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/** markdown → 净化后的 HTML(整段渲染,维持代码围栏状态,不做后缀增量) */
export function renderMd(text: string): string {
  return DOMPurify.sanitize(md.render(text))
}
