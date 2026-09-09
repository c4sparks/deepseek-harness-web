// 提问卡展开体（官方 ui-tool AskQuestionCard 复刻）：对话行只做「问题↔回复」记录。
// answered=问题→答案列表(空答 ask.skipped)；unanswered=结论(已取消/已中断)+问题列表；
// pending=官方 waterfall 交互在输入框上方弹窗，对话行此处理原输出/参数兜底。
import { html } from 'htm/preact'
import type { ChainItem } from '../../core/store/chat'
import type { AskCard } from '../../core/ask-card'
import { askLabels } from '../../core/ask-labels'

type AskChainItem = Extract<ChainItem, { kind: 'tool' }>

export function AskCardBody({ card, item }: { card: AskCard; item: AskChainItem }) {
  const labels = askLabels()
  if (card.pending) {
    // pending 时交互在 composer 上方 waterfall 弹窗；对话行此处理输出/原始参数兜底
    let jsonText = item.argsRaw ?? ''
    if (jsonText) {
      try {
        jsonText = JSON.stringify(JSON.parse(jsonText), null, 2)
      } catch {
        /* 原样 */
      }
    }
    return html`${item.output ? html`<pre class="chain-tool-out">${item.output}</pre>` : null}
      ${jsonText ? html`<pre class="chain-tool-json">${jsonText}</pre>` : null}`
  }
  const t = card.transcript
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
