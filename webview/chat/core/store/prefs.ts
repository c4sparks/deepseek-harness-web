// 全局显示偏好切片：镜像上游「设置→对话显示」的取值，供过程折叠(Chain)决定形态。
// 与 status 的区别：这里的量**跨会话有效**，所以不参与 chat.ts 的 reset 串联——
// 换会话不该把显示形态重置回默认，那是全局偏好而不是会话状态。
import { signal } from '@preact/signals'
import type { ChatStore } from './types'

export interface PrefsSlice {
  store: Pick<ChatStore, 'transcriptView'>
  /** 宿主推来的取值；undefined 不改（宿主读不到上游设置时不推送） */
  apply(transcriptView: 'normal' | 'compact' | undefined): void
}

export function createPrefs(): PrefsSlice {
  // 默认 compact：既是上游默认，也是接入前插件固有的形态——读不到设置时维持原样最不意外
  const transcriptView = signal<'normal' | 'compact'>('compact')

  function apply(next: 'normal' | 'compact' | undefined): void {
    if (next === undefined) return
    transcriptView.value = next
  }

  return { store: { transcriptView }, apply }
}
