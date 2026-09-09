// 官方 waterfall 提问弹窗（输入框上方）：pending 时显示，用户选择/输入 + 「回答(选择后可提交)/取消/关闭」。
// 数据来自 store.pendingQuestion（chatQuestion RPC）；提交→questionResponse，取消/关闭→questionCancel。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import type { QuestionSpec } from '../../core/protocol'

interface AnswerEntry {
  id: string
  selected: string[]
  custom?: string
}

export function QuestionDialog({ store }: { store: ChatStore }) {
  const q = store.pendingQuestion.value
  // 每次新提问(rpcId 变化)由父层 key 强制重挂，useState 随之重建
  const [answers, setAnswers] = useState<AnswerEntry[]>(() => (q ? q.questions.map((x) => ({ id: x.id, selected: [], custom: undefined })) : []))
  const [free, setFree] = useState<Record<string, string>>({})
  if (q === null) return null
  const update = (id: string, fn: (e: AnswerEntry) => AnswerEntry): void =>
    setAnswers((prev) => prev.map((e) => (e.id === id ? fn(e) : e)))
  const toggleOpt = (question: QuestionSpec, label: string): void => {
    const entry = answers.find((e) => e.id === question.id)
    if (!entry) return
    if (question.multiSelect) {
      update(entry.id, (e) => ({ ...e, selected: e.selected.includes(label) ? e.selected.filter((s) => s !== label) : [...e.selected, label] }))
    } else {
      update(entry.id, (e) => ({ ...e, selected: [label] }))
    }
  }
  const inputChange = (id: string, value: string): void => {
    setFree((prev) => ({ ...prev, [id]: value }))
    update(id, (e) => ({ ...e, custom: value.trim() || undefined }))
  }
  const answered = answers.filter((a) => a.selected.length > 0 || (a.custom ?? '') !== '').length
  const canSubmit = answered === q.questions.length // 全答才可提交（官方 waterfall：选择后可提交）
  const submit = (): void => {
    if (!canSubmit) return
    store.submitQuestion(0, q.rpcId, q.sessionId, answers)
  }
  const cancel = (): void => store.cancelQuestion(0, q.rpcId, q.sessionId)
  const close = (): void => store.cancelQuestion(0, q.rpcId, q.sessionId)

  return html`<div class="q-dialog" role="dialog" aria-label="提问">
    <div class="q-dialog-title"><span class="codicon codicon-question inline-ico"></span>提问</div>
    ${q.questions.map((question, qi) => {
      const entry = answers[qi]
      const isSelected = (label: string): boolean => entry?.selected.includes(label) ?? false
      return html`<div class="q-dialog-block" key=${question.id}>
        <div class="q-dialog-q">${question.question}</div>
        ${question.options && question.options.length > 0
          ? html`<div class="q-dialog-options">${question.options.map((o) =>
              html`<button type="button" class=${'q-dialog-opt' + (isSelected(o.label) ? ' selected' : '')} key=${o.label} onClick=${() => toggleOpt(question, o.label)}>
                <span class="q-opt-label">${o.label}</span>
                ${o.description ? html`<span class="q-opt-desc">${o.description}</span>` : null}
              </button>`
            )}</div>`
          : html`<input class="q-dialog-input" value=${free[question.id] ?? ''} placeholder="输入回答…"
              onInput=${(e: Event) => inputChange(question.id, (e.target as HTMLInputElement).value)} />`}
      </div>`
    })}
    <div class="q-dialog-bar">
      <button type="button" class="q-dialog-submit" disabled=${!canSubmit} onClick=${submit}>回答</button>
      <button type="button" class="q-dialog-cancel" onClick=${cancel}>取消</button>
      <button type="button" class="q-dialog-close" title="关闭" onClick=${close}><span class="codicon codicon-close"></span></button>
    </div>
  </div>`
}
