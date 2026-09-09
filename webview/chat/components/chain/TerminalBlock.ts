// 终端卡（官方 TerminalBlock 复刻）——独立组件，与 Web/Ask/Context 各占一个文件，改一种不影响其它。
// 只负责渲染 .term 卡体（命令横幅 + 状态 Pill + 复制 + 输出 + 长输出折叠）；收起/展开头由上级 ToolRow 控制。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import { terminalLabels, promptLabel, stripAnsi, type TermCard } from '../../core/terminal'

/** 官方 TerminalBlock 输出折叠上限（DEFAULT_TERMINAL_MAX_LINES=16；折中段 head/tail）。 */
const MAX_LINES = 16
const HEAD_LINES = 8

function dotState(card: TermCard): 'ongoing' | 'done' | 'error' {
  if (card.running) return 'ongoing'
  return card.failed ? 'error' : 'done'
}

/** settled 时的状态 Pill 文案（干净退出无 Pill；signal 优先于 exitCode）。 */
function statusPill(card: TermCard, labels: ReturnType<typeof terminalLabels>): string | null {
  if (card.running) return null
  if (card.signal !== undefined) return labels.signal(card.signal)
  if (card.exitCode !== undefined && card.exitCode !== 0) return labels.exitCode(card.exitCode)
  return null
}

export function TerminalBlock({ card, store }: { card: TermCard; store: ChatStore }) {
  const labels = terminalLabels()
  const [expanded, setExpanded] = useState(false)
  // 每次收起再展开、或状态/输出变化 → 回到折叠态
  useEffect(() => {
    setExpanded(false)
  }, [card.running, card.output])
  const pill = statusPill(card, labels)
  const outputLines = (card.output ?? '').split('\n').map((l) => stripAnsi(l))
  const capped = outputLines.length > MAX_LINES && !expanded
  const hidden = Math.max(0, outputLines.length - MAX_LINES)
  const headLines = capped ? outputLines.slice(0, HEAD_LINES) : outputLines
  const tailLines = capped ? outputLines.slice(outputLines.length - (MAX_LINES - HEAD_LINES)) : []

  const dot = html`<span class="term-dot" data-state=${dotState(card)}></span>`
  // 命令行首行前：官方状态点(runState) done绿/ongoing蓝/error红
  const promptRows = card.command.map((line, i) => html`
    <div class="term-prompt-line" key=${i}>
      ${i === 0 ? dot : null}
      <span class="term-cwd">${i === 0 ? promptLabel(card.cwd) : '$'}</span>
      <span class="term-cmd">${line}</span>
    </div>`)
  // 复制原始脱轨输出文本（剥 marker），非渲染树
  const copyRaw = (text: string | undefined): void => {
    if (text) store.copy(text)
  }

  return html`<div class="term" data-running=${card.running ? '' : undefined}>
    <div class="term-head">
      <div class="term-prompt">
        <span class="term-state">${card.running ? labels.running : card.failed ? labels.failed : labels.done}</span>
        ${promptRows}
      </div>
      ${pill ? html`<span class="term-status">${pill}</span>` : null}
      ${!card.running && !card.empty
        ? html`<button type="button" class="term-copy" onClick=${() => copyRaw(card.output)}>${labels.copy}</button>`
        : null}
    </div>
    ${card.empty
      ? html`<div class="term-empty">${labels.noOutput}</div>`
      : html`<div class="term-output">
          ${headLines.map((line, i) => html`<div class="term-line" key=${i}>${line || ' '}</div>`)}
          ${hidden > 0
            ? html`<button type="button" class="term-expand" onClick=${() => setExpanded((e) => !e)} aria-expanded=${expanded}>
                ${expanded ? labels.collapse : labels.expand(hidden)}
              </button>`
            : null}
          ${tailLines.map((line, i) => html`<div class="term-line" key=${'t' + i}>${line || ' '}</div>`)}
        </div>`}
  </div>`
}
