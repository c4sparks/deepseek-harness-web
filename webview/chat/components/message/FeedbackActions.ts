// 行动作条里的消息反馈入口（👍/👎）：与上游 MessageFeedbackActions 同判定。
//
// 两个按钮**只在悬停/聚焦时**触发一次反馈表读取（懒加载）—— 每条定稿消息都挂这个控件，
// 挂载即读会把整个会话的反馈表在同一瞬间拉多遍（上游同此取舍）。
// 已记录的那一侧用 `.active` 常显（不靠 hover），文案换成「取消标记」。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'
import type { FeedbackRating } from '../../core/protocol'

export function FeedbackActions({ store, messageId }: { store: ChatStore; messageId: string }) {
  const rating = store.feedbackItems.value.get(messageId)?.rating
  const button = (kind: FeedbackRating, icon: string, label: string, activeLabel: string) => {
    const active = rating === kind
    return html`<button data-act=${kind === 'positive' ? 'like' : 'dislike'}
      class=${'fb-btn' + (active ? ' active' : '')}
      aria-pressed=${active}
      title=${active ? activeLabel : label} aria-label=${active ? activeLabel : label}
      onFocus=${() => store.ensureFeedbackLoaded()}
      onPointerEnter=${() => store.ensureFeedbackLoaded()}
      onClick=${() => store.chooseFeedback(messageId, kind)}>
      <span class=${'codicon ' + icon}></span>
    </button>`
  }
  return html`<span class="fb-actions">
    ${button('positive', 'codicon-thumbsup', '好的回答', '取消标记')}
    ${button('negative', 'codicon-thumbsdown', '有问题的回答', '取消标记')}
  </span>`
}
