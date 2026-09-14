// 交付文件行（`present`）：行首四态标记 + 标题 + **可见状态词与声明路径**；展开体是结果正文。
//
// 与其它工具行（ToolRow）的差别都在这里：这一行自带头部与展开体，不套通用「输入 / 输出」卡。
// 收起行在展开后**保留**（上游同）：状态词与路径始终可见，正文接在下面。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { DshTurnProcessItem } from '../../core/store/types'
import { toolTitle } from '../../core/format'
import { presentCardModel, type PresentMark } from '../../core/present-card'

type Tool = Extract<DshTurnProcessItem, { kind: 'tool' }>

/** 进行中的标记是**像素追光块**：10px 网格上 8 个 2px 方块，自左上顺时针排。 */
const MATRIX_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
]

/** 行首标记：进行中＝追光块，其余＝状态点（结构同 `.chain-tool-dot`）。 */
function mark(m: PresentMark): unknown {
  if (m !== 'ongoing') {
    return html`<span class=${'chain-tool-dot is-' + m} data-state=${m} aria-hidden></span>`
  }
  return html`<svg class="chain-tool-dot-matrix" data-state="ongoing" width="10" height="10"
    viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden>
    ${MATRIX_CELLS.map(([x, y], i) => html`<rect key=${i} class="chain-tool-dot-cell"
      x=${x} y=${y} width="2" height="2"
      style=${'animation-delay:' + (i - MATRIX_CELLS.length) * 125 + 'ms'}></rect>`)}
  </svg>`
}

export function PresentRow({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false)
  const card = presentCardModel(item)
  // 没有正文就**不可展开**：不显示展开箭头、行也不可点（上游同口径）
  const expandable = card.details !== ''
  const expanded = expandable && open
  const title = item.title ?? toolTitle(item.name)
  const summary = html`<span class="chain-present-summary">
    <span class="chain-present-state">${card.label}</span>
    <span class="chain-present-paths">${card.paths}</span>
  </span>`
  return html`<div class=${'chain-disclosure' + (item.status === 'running' ? ' is-running' : '')}>
    ${expandable
      ? html`<button class="chain-row-head" data-state=${item.status} title=${item.name}
          aria-expanded=${expanded} onClick=${() => setOpen((o) => !o)}>
          <span class=${'codicon chain-chev ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right')}></span>
          ${mark(card.mark)}
          <span class="chain-tool-title">${title}</span>
          ${summary}
        </button>`
      : html`<div class="chain-row-head is-static" title=${item.name}>
          ${mark(card.mark)}
          <span class="chain-tool-title">${title}</span>
          ${summary}
        </div>`}
    ${expanded ? html`<div class="chain-disclosure-body"><pre class="chain-present-output">${card.details}</pre></div>` : null}
  </div>`
}
