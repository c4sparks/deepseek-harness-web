// 提问弹窗切片：官方 waterfall 交互（输入框上方）的 pending 数据与应答。
// 与消息行上的提问「记录」行无关（那部分在聚合层的消息域）。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { QuestionSpec } from '../protocol'
import type { ChatStore } from './types'

export interface QuestionSlice {
  store: Pick<ChatStore, 'pendingQuestion' | 'submitQuestion' | 'cancelQuestion'>
  /** chatQuestion 帧到达：置弹窗数据。 */
  openQuestionDialog(rpcId: string | undefined, sessionId: string | undefined, questions: QuestionSpec[]): void
  /** questionClosed 帧到达：关闭弹窗。 */
  closeQuestion(rpcId: string | undefined): void
  reset(): void
}

export function createQuestion(host: ChatHost): QuestionSlice {
  const pendingQuestion = signal<{ rpcId?: string; sessionId?: string; questions: QuestionSpec[] } | null>(null)

  function openQuestionDialog(rpcId: string | undefined, sessionId: string | undefined, questions: QuestionSpec[]): void {
    pendingQuestion.value = { rpcId, sessionId, questions }
  }
  function submitQuestion(
    key: number,
    rpcId: string | undefined,
    sessionId: string | undefined,
    answers: Array<{ id: string; selected: string[]; custom?: string }>
  ): void {
    void key
    pendingQuestion.value = null // 回答后关闭弹窗
    host.post({ type: 'questionResponse', rpcId, sessionId, answers })
  }
  function cancelQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined): void {
    void key
    pendingQuestion.value = null // 取消/关闭后收起弹窗
    host.post({ type: 'questionCancel', rpcId, sessionId })
  }
  function closeQuestion(rpcId: string | undefined): void {
    // waterfall 提问确认后关闭（清除历史独立 question 行兜底 + 弹窗）
    void rpcId
    pendingQuestion.value = null
  }

  function reset(): void {
    pendingQuestion.value = null
  }

  return { store: { pendingQuestion, submitQuestion, cancelQuestion }, openQuestionDialog, closeQuestion, reset }
}
