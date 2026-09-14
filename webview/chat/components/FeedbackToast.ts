// 反馈结果提示（toast）：成功「感谢你的反馈」/ 失败文案，显示后自行消失。
//
// 为什么不用消息行里的通知行：提示属于**输入区**的即时反馈（上游把 toast 挂在 composer 卡片上），
// 落进对话流会平白多出一行、还会被当成一条对话记录。
import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import type { ChatStore } from '../core/store/chat'

/** 停留时长（与上游一致：成功 3s、失败 6s）。 */
const HOLD_OK_MS = 3000
const HOLD_ERROR_MS = 6000

export function FeedbackToast({ store }: { store: ChatStore }) {
  const toast = store.feedbackToast.value
  const [shown, setShown] = useState<number | null>(null)
  useEffect(() => {
    if (toast === null) return
    setShown(toast.id)
    const timer = setTimeout(() => {
      // 只清掉自己那一条：期间来了新提示就让它继续显示
      if (store.feedbackToast.value?.id === toast.id) store.feedbackToast.value = null
    }, toast.tone === 'ok' ? HOLD_OK_MS : HOLD_ERROR_MS)
    return () => clearTimeout(timer)
  }, [toast?.id])
  if (toast === null || shown !== toast.id) return null
  return html`<div class=${'fb-toast' + (toast.tone === 'error' ? ' is-error' : '')} role="status">
    <span class=${'codicon ' + (toast.tone === 'error' ? 'codicon-warning' : 'codicon-pass-filled')}></span>
    <span>${toast.text}</span>
  </div>`
}
