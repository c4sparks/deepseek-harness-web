// 会话级「系统提示词」常驻入口（聊天区最左上角）：文件文本图标 + 标签 + 工作区指令文件标签，可点击展开全文。
// 数据=当前会话的 agent-instructions 注入（宿主 getSystemPrompt 下发）；无则整行不渲染。
// 链路里不再逐轮重复系统提示词行（见 Chain.ts 对 form==='instructions' 的过滤）。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import { contentRuns } from '../../core/context-body'

function renderRuns(content: unknown[]) {
  const runs = contentRuns(content)
  return html`${runs.map((run, i) =>
    'text' in run
      ? run.text !== ''
        ? html`<pre class="sysp-text" key=${i}>${run.text}</pre>`
        : null
      : html`<pre class="sysp-text" key=${i}>${JSON.stringify(run.block, null, 2)}</pre>`
  )}`
}

export function SystemPromptEntry({ store }: { store: ChatStore }) {
  const sp = store.systemPrompt.value
  const [open, setOpen] = useState(false)
  if (sp === null) return null
  return html`<div class="sysp">
    <button class="sysp-head" onClick=${() => setOpen((o) => !o)} aria-expanded=${open}>
      <span class=${'codicon codicon-file-text sysp-ico'}></span>
      <span class="sysp-title">系统提示词</span>
      ${sp.label ? html`<span class="sysp-label">${sp.label}</span>` : null}
      <span class=${'codicon ' + (open ? 'codicon-chevron-down sysp-chev' : 'codicon-chevron-right sysp-chev')}></span>
    </button>
    ${open ? html`<div class="sysp-body">${renderRuns(sp.content)}</div>` : null}
  </div>`
}
