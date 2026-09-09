// 工具行（ToolRow，纯分发器）：收起=一行(图标+标题+摘要单行+状态)，展开按官方 toolview 分派卡体。
// ask_user_question → AskCardBody；web_fetch/web_search → WebCard；bash/pwsh/shell → TerminalBlock；
// 其余 → 真实输出+原始参数。各卡体独立文件，改一种不影响其它。
// 铁律：文案/结构取自官方 (terminal/web/ask/tool.title.*)，不自行翻译/不编造展示。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ChainItem, ChatStore } from '../../core/store/chat'
import { toolTitle, toolIconOfTool } from '../../core/format'
import { terminalCardModel } from '../../core/terminal'
import { webCardModel } from '../../core/web-card'
import { askCardModel } from '../../core/ask-card'
import { WebCard } from './WebCard'
import { AskCardBody } from './AskCardBody'
import { TerminalBlock } from './TerminalBlock'

type Tool = Extract<ChainItem, { kind: 'tool' }>

export function ToolRow({ item, store }: { item: Tool; store: ChatStore }) {
  const [open, setOpen] = useState(false)
  const running = item.status === 'running'
  const stIcon =
    item.status === 'running'
      ? 'codicon-loading codicon-modifier-spin'
      : item.status === 'error'
        ? 'codicon-warning'
        : item.status === 'stopped'
          ? 'codicon-circle-outline'
          : null // ok：无角标
  const ask = askCardModel(item)
  const web = webCardModel(item)
  const card = ask === null && web === null ? terminalCardModel(item) : null

  // 收起行预览：提问卡用状态摘要；其余用 item.summary（终端卡回落 description）
  const headSummary =
    ask !== null
      ? ask.summary
      : item.summary ?? (card !== null ? card.description : undefined)

  const head = html`<button class="chain-row-head" onClick=${() => setOpen((o) => !o)} aria-expanded=${open} title=${item.name}>
    <span class=${'codicon chain-chev ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
    <span class="chain-tool-ico codicon codicon-${toolIconOfTool(item.name)}"></span>
    <span class="chain-tool-title">${item.title ?? toolTitle(item.name)}</span>
    ${!open && headSummary ? html`<span class="chain-sep" aria-hidden></span><span class="chain-row-preview">${headSummary}</span>` : null}
    ${item.error ? html`<span class="chain-tool-err">${item.error}</span>` : null}
    ${stIcon ? html`<span class=${'chain-tool-status codicon is-' + item.status + ' ' + stIcon}></span>` : null}
  </button>`

  // ---- 提问行（ask_user_question）：只做问答记录；交互在 composer 上方 waterfall 弹窗 ----
  if (ask !== null) {
    return html`<div class=${'chain-disclosure' + (running ? ' is-running' : '')}>
      ${head}
      ${open ? html`<div class="chain-disclosure-body"><${AskCardBody} card=${ask} item=${item} /></div>` : null}
    </div>`
  }

  // ---- Web 卡（web_fetch / web_search）----
  if (web !== null) {
    return html`<div class=${'chain-disclosure' + (running ? ' is-running' : '')}>
      ${head}
      ${open ? html`<div class="chain-disclosure-body"><${WebCard} card=${web} /></div>` : null}
    </div>`
  }

  // ---- 通用路径：真实输出 + 原始参数(pretty JSON) ----
  if (card === null) {
    let jsonText = item.argsRaw ?? ''
    if (jsonText) {
      try {
        jsonText = JSON.stringify(JSON.parse(jsonText), null, 2)
      } catch {
        /* 原样 */
      }
    }
    const hasBody = !!(item.output || jsonText)
    return html`<div class=${'chain-disclosure' + (running ? ' is-running' : '')}>
      ${head}
      ${open && hasBody
        ? html`<div class="chain-disclosure-body">
            ${item.output ? html`<pre class="chain-tool-out">${item.output}</pre>` : null}
            ${jsonText ? html`<pre class="chain-tool-json">${jsonText}</pre>` : null}
          </div>`
        : null}
    </div>`
  }

  // ---- 终端卡（官方 TerminalBlock → 独立组件）----
  return html`<div class=${'chain-disclosure' + (running ? ' is-running' : '')}>
    ${head}
    ${open
      ? html`<div class="chain-disclosure-body"><${TerminalBlock} card=${card} store=${store} /></div>`
      : null}
  </div>`
}
