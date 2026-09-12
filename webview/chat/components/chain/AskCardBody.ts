// 提问卡展开体（适配上游 0.1.5-rc.2）：只渲染两种**有记录**的形态 ——
// answered=问题→答案列表(空答 ask.skipped)；unanswered=结论(已取消/已中断)+问题列表。
// 「无记录可展示」（进行中 / 问答配对不上 / 结果坏形）**不在这里兜底**：由 ToolRow 落回通用「输入/输出」区。
import { html } from 'htm/preact'
import type { AskCard } from '../../core/ask-card'
import { askLabels } from '../../core/ask-labels'

export function AskCardBody({ card }: { card: AskCard }) {
  const labels = askLabels()
  const t = card.transcript
  // ToolRow 的派发条件就是「transcript 非 null」；此处返回 null 只是防御，别让未来改派发时静默变空
  if (t === null) return null
  if (t.mode === 'unanswered') {
    return html`<div class="ask-card">
      <p class="ask-verdict">${t.verdict}</p>
      <ul class="ask-question-list">${t.questions.map((q, i) => html`<li class="ask-q-unanswered" key=${i}>${q.question}</li>`)}</ul>
    </div>`
  }
  return html`<dl class="ask-card">
    ${t.questions.map((q, i) => html`<div class="ask-item" key=${i}>
      <dt class="ask-question">${q.question}</dt>
      <dd class="ask-answer">
        ${q.answers && q.answers.length > 0
          ? q.answers.map((a, j) => html`<span class="ask-answer-line" key=${j}>${a}</span>`)
          : html`<span class="ask-skipped">${labels.skipped}</span>`}
      </dd>
    </div>`)}
  </dl>`
}
