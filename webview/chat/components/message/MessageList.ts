// 消息列表（按行类型分发）：用户/assistant/审批/提问/notice。智能跟随滚动。
import { html } from 'htm/preact'
import { useEffect, useRef } from 'preact/hooks'
import type { ChatStore } from '../../core/store/chat'
import { UserRow } from './UserRow'
import { AssistantRow } from './AssistantRow'
import { ApprovalRow } from './ApprovalRow'
import { QuestionRow } from './QuestionRow'
import { NoticeRow } from './NoticeRow'
import { ContextInjectionRow } from './ContextInjectionRow'
import { TurnStatus } from './TurnStatus'

export function MessageList({ store }: { store: ChatStore }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // 智能跟随滚动：是否粘在底部由「用户滚动手势」决定(stickRef)，而非每条新消息的瞬时距离。
  const stickRef = useRef(true)
  // 上次滚动位置：按“方向”判断用户是否在向上拖——一旦向上滚(哪怕 1px)立即解除跟随。
  const lastTopRef = useRef(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (store.scrollPend.value > 0) {
      el.scrollTop = el.scrollHeight
      store.scrollPend.value = 0
      stickRef.current = true
      return
    }
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  })
  if (store.view.value !== 'chat') return null
  const list = store.messages.value
  return html`<div id="messages" ref=${ref}
    onScroll=${() => {
      const el = ref.current
      if (!el) return
      if (el.scrollTop < lastTopRef.current) {
        stickRef.current = false // 用户向上拖 → 解除跟随
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) {
        stickRef.current = true // 已回到底部 → 恢复跟随
      }
      lastTopRef.current = el.scrollTop
    }}>
    ${list.map((row, i) => {
      const latest = i === list.length - 1
      switch (row.kind) {
        case 'user':
          return html`<${UserRow} key=${row.key} row=${row} store=${store} latest=${latest} />`
        case 'context':
          return html`<${ContextInjectionRow} key=${row.key} row=${row} />`
        case 'assistant':
          return html`<${AssistantRow} key=${row.key} row=${row} store=${store} latest=${latest} />`
        case 'approval':
          return html`<${ApprovalRow} key=${row.key} row=${row} store=${store} />`
        case 'question':
          return html`<${QuestionRow} key=${row.key} row=${row} store=${store} />`
        case 'notice':
          return html`<${NoticeRow} key=${row.key} row=${row} />`
      }
    })}
    ${store.processing.value ? html`<${TurnStatus} />` : null}
  </div>`
}
