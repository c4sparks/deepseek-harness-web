// 上游 waterfall 提问弹窗（适配上游 0.1.5-rc.2）：一题一屏 + 翻页，与上游 `QuestionComposer` 同口径。
//
// 数据来自 store.pendingQuestion（$events 的 `user-questions/request`）；提交→questionResponse，
// 放弃整组→questionCancel（服务端以 UserQuestionError/ASK_CANCELLED 结算该 waterfall）。
//
// 与上游一致的四条**交互事实**（改前先看，它们不是随手定的）：
//   1. 一次只显示一道题，底部 `1 / 3` 是**进度**不是装饰；单选的选项点一下就自动翻到下一题。
//   2. 自由输入是**每题一个**（不是「其他」选项）：有选项时是内联一行，没选项时是一个输入框。
//   3. 「提交」只在最后一题出现，其它题是「下一题」；它按**当前题**是否已答来决定可用性，
//      「必须全部答完」是在点击时把关并跳到第一道未完成处（上游同）。
//   4. 「跳过本题」是有效作答：该项以 `{ id, selected: [] }` 上报（记录卡显示「未回答」）。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import type { QuestionSpec } from '../../core/protocol'

interface Draft {
  selected: string[]
  custom: string
  skipped: boolean
}

/** 上游把「推荐」做进**选项文案后缀**（没有独立字段）：显示时剥掉、另挂一个「推荐」角标。 */
const RECOMMENDED_SUFFIX = /[（(]\s*(?:Recommended|推荐)\s*[)）]\s*$/

function splitRecommended(label: string): { text: string; recommended: boolean } {
  return RECOMMENDED_SUFFIX.test(label)
    ? { text: label.replace(RECOMMENDED_SUFFIX, '').trim(), recommended: true }
    : { text: label, recommended: false }
}

export function QuestionDialog({ store }: { store: ChatStore }) {
  const q = store.pendingQuestion.value
  // 每次新提问（rpcId 变化）由父层 key 强制重挂，useState 随之重建
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [minimized, setMinimized] = useState(false)
  const [feedback, setFeedback] = useState('')
  if (q === null) return null

  const questions = q.questions
  const current = questions[index]
  if (current === undefined) return null
  const draft: Draft = drafts[current.id] ?? { selected: [], custom: '', skipped: false }
  const answered = (d: Draft): boolean => d.selected.length > 0 || d.custom.trim() !== ''
  const complete = (d: Draft): boolean => d.skipped || answered(d)

  const patch = (id: string, fn: (d: Draft) => Draft): void =>
    setDrafts((prev) => ({ ...prev, [id]: fn(prev[id] ?? { selected: [], custom: '', skipped: false }) }))

  /** 单选：选中即翻页（上游同）；多选：只切换勾选。两者都清掉「跳过」标记。 */
  const selectOption = (question: QuestionSpec, rawLabel: string): void => {
    patch(question.id, (d) =>
      question.multiSelect
        ? {
            ...d,
            skipped: false,
            selected: d.selected.includes(rawLabel) ? d.selected.filter((s) => s !== rawLabel) : [...d.selected, rawLabel],
          }
        : { ...d, skipped: false, selected: [rawLabel], custom: '' }
    )
    setFeedback('')
    if (!question.multiSelect && index < questions.length - 1) setIndex(index + 1)
  }

  /** 自由输入：单选下打字即取消已选（两者互斥）；多选下可并存（上游同）。 */
  const changeCustom = (question: QuestionSpec, value: string): void => {
    patch(question.id, (d) => ({
      ...d,
      skipped: false,
      custom: value,
      selected: question.multiSelect ? d.selected : [],
    }))
    setFeedback('')
  }

  /**
   * 提交整组。**草稿必须由调用方传进来**：`setDrafts` 是异步的，
   * 刚 `patch` 完立刻读 `drafts` 拿到的是**上一次**的状态（跳过后立即提交会因此误判「没做完」）。
   */
  const submitDrafts = (all: Record<string, Draft>): void => {
    const draftOf = (id: string): Draft => all[id] ?? { selected: [], custom: '', skipped: false }
    const firstIncomplete = questions.findIndex((question) => !complete(draftOf(question.id)))
    if (firstIncomplete !== -1) {
      setFeedback('请先完成这道问题。')
      setIndex(firstIncomplete)
      return
    }
    const answers = questions.map((question) => {
      const d = draftOf(question.id)
      // 跳过的题以空答上报（上游同）：记录卡据此显示「未回答」
      const custom = d.custom.trim()
      return { id: question.id, selected: d.selected, ...(custom === '' ? {} : { custom }) }
    })
    store.submitQuestion(0, q.rpcId, q.sessionId, answers)
  }

  /** 前进：本步是最后一题则提交（上游 `continueFlow`）。 */
  const continueFlow = (): void => {
    if (!answered(draft)) {
      setFeedback('请选择一个选项或填写自定义答案。')
      return
    }
    setFeedback('')
    if (index === questions.length - 1) submitDrafts(drafts)
    else setIndex(index + 1)
  }

  /** 跳过本题：标为跳过并前进；它已是最后一题时直接提交（上游同）。 */
  const skip = (): void => {
    const next = { ...drafts, [current.id]: { selected: [], custom: '', skipped: true } }
    setDrafts(next)
    setFeedback('')
    if (index === questions.length - 1) submitDrafts(next)
    else setIndex(index + 1)
  }

  const close = (): void => store.cancelQuestion(0, q.rpcId, q.sessionId)

  const options = current.options ?? []
  return html`<div class="q-dialog${minimized ? ' is-minimized' : ''}" role="dialog" aria-label="提问">
    <div class="q-dialog-head">
      <div class="q-dialog-eyebrow">
        ${current.header ? html`<span class="q-dialog-header">${current.header}</span>` : null}
        <span class="q-dialog-q">${current.question}</span>
      </div>
      <button type="button" class="q-dialog-icon" aria-expanded=${!minimized}
        title=${minimized ? '展开问题卡片' : '收起问题卡片'}
        aria-label=${minimized ? '展开问题卡片' : '收起问题卡片'}
        onClick=${() => setMinimized((v) => !v)}>
        <span class=${'codicon ' + (minimized ? 'codicon-chevron-up' : 'codicon-chevron-down')}></span>
      </button>
      <button type="button" class="q-dialog-icon" title="放弃整组问题" aria-label="放弃整组问题" onClick=${close}>
        <span class="codicon codicon-close"></span>
      </button>
    </div>
    ${minimized
      ? null
      : html`<div class="q-dialog-body">
          ${current.detail ? html`<div class="q-dialog-detail">${current.detail}</div>` : null}
          ${options.length > 0
            ? html`<div class="q-dialog-options" role=${current.multiSelect ? 'group' : 'radiogroup'}>
                ${options.map((o, oi) => {
                  const rec = splitRecommended(o.label)
                  const selected = draft.selected.includes(o.label)
                  return html`<button type="button" key=${o.label}
                    class=${'q-dialog-opt' + (selected ? ' selected' : '')}
                    role=${current.multiSelect ? 'checkbox' : 'radio'} aria-checked=${selected}
                    onClick=${() => selectOption(current, o.label)}>
                    <span class="q-opt-index">${oi + 1}</span>
                    <span class="q-opt-body">
                      <span class="q-opt-label">${rec.text}${rec.recommended ? html`<span class="q-opt-rec">推荐</span>` : null}</span>
                      ${o.description ? html`<span class="q-opt-desc">${o.description}</span>` : null}
                    </span>
                  </button>`
                })}
              </div>
              <textarea class="q-dialog-input q-dialog-custom" rows="1" value=${draft.custom}
                placeholder="输入你的答案"
                onInput=${(e: Event) => changeCustom(current, (e.target as HTMLTextAreaElement).value)}></textarea>`
            : html`<textarea class="q-dialog-input q-dialog-custom is-block" rows="3" autofocus value=${draft.custom}
                placeholder="输入你的答案"
                onInput=${(e: Event) => changeCustom(current, (e.target as HTMLTextAreaElement).value)}></textarea>`}
          ${feedback ? html`<div class="q-dialog-feedback" role="status">${feedback}</div>` : null}
        </div>`}
    <div class="q-dialog-bar">
      <button type="button" class="q-dialog-icon" title="上一题" aria-label="上一题"
        disabled=${index === 0} onClick=${() => { setFeedback(''); setIndex(index - 1) }}>
        <span class="codicon codicon-chevron-left"></span>
      </button>
      <span class="q-dialog-progress">${index + 1} / ${questions.length}</span>
      <button type="button" class="q-dialog-icon" title="下一题" aria-label="下一题"
        disabled=${index === questions.length - 1} onClick=${() => { setFeedback(''); setIndex(index + 1) }}>
        <span class="codicon codicon-chevron-right"></span>
      </button>
      <button type="button" class="q-dialog-submit" disabled=${!answered(draft)} onClick=${continueFlow}>
        ${index === questions.length - 1 ? '提交' : '下一题'}
      </button>
      <button type="button" class="q-dialog-skip" onClick=${skip}>跳过本题</button>
    </div>
  </div>`
}
