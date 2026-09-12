// 系统提示词行：该回合**实际发给模型**的 system，可折叠（适配上游 0.1.5-rc.2）。
// 位置由数据源决定——宿主把它插在该回合用户提问之前（上游锚在 turn 开头，见 request-prompt.ts）。
// 文案用上游字典 `message.systemPrompt`（系统提示词）。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'

export function SysPromptRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return html`<div class="sysp">
    <button class="sysp-head" onClick=${() => setOpen((o) => !o)} aria-expanded=${open}>
      <span class="codicon codicon-file-text sysp-ico"></span>
      <span class="sysp-title">系统提示词</span>
      <span class=${'codicon ' + (open ? 'codicon-chevron-down sysp-chev' : 'codicon-chevron-right sysp-chev')}></span>
    </button>
    ${open ? html`<div class="sysp-body"><pre class="sysp-text">${text}</pre></div>` : null}
  </div>`
}
