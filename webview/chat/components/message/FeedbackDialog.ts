// 「提交反馈」弹窗（输入框上方）：与上游 FeedbackDialog 同内容 ——分类 chips + 详情输入 + 提交。
//
// 为什么评价不直接提交而是先开这个弹窗：上游把「评价」与「说明/分类」当作**同一次提交**，
// 弹窗提交时才写；空草稿也是有效提交（只记一个评价）。冲突（version-conflict）时弹窗**不关**，
// 只在弹窗里报 —— 用户可以直接改完再提交。
import { html } from 'htm/preact'
import type { ChatStore } from '../../core/store/chat'

/** 分类 id → 中文标签（字典原文；宿主下发的 id 认不出时回显 id 本身，不自造词）。 */
const CATEGORY_LABELS: Record<string, string> = {
  'task-result': '任务结果',
  'instruction-following': '指令理解与遵循',
  'product-interaction': '产品功能与交互',
  'service-stability': '稳定性和速度',
  'resource-cost': '资源使用与费用',
  'security-privacy-permission': '安全隐私与权限',
  other: '其他',
}

export function FeedbackDialog({ store }: { store: ChatStore }) {
  const d = store.feedbackDialog.value
  if (d === null) return null
  const categories = store.feedbackCategories.value
  const submit = (): void => store.submitFeedbackDialog()
  return html`<div class="fb-dialog" role="dialog" aria-label="提交反馈">
    <div class="fb-dialog-head">
      <span class="fb-dialog-title">${d.rating === 'positive' ? '好的回答' : '有问题的回答'}</span>
      <button type="button" class="fb-icon" title="关闭" aria-label="关闭"
        disabled=${d.submitting} onClick=${() => store.closeFeedbackDialog()}>
        <span class="codicon codicon-close"></span>
      </button>
    </div>
    <div class="fb-dialog-body">
      ${categories.length > 0
        ? html`<div class="fb-chips" role="group" aria-label="反馈分类">
            ${categories.map((id) => html`<button type="button" key=${id}
              class=${'fb-chip' + (d.category === id ? ' active' : '')}
              aria-pressed=${d.category === id}
              disabled=${d.submitting}
              onClick=${() => store.editFeedbackDialog({ category: d.category === id ? null : id })}>
              ${CATEGORY_LABELS[id] ?? id}
            </button>`)}
          </div>`
        : null}
      <textarea class="fb-detail" rows="3" aria-label="反馈详情"
        placeholder="填写详情以帮助我们改进体验，提交内容会包括当前对话的日志"
        disabled=${d.submitting} value=${d.note}
        onInput=${(e: Event) => store.editFeedbackDialog({ note: (e.target as HTMLTextAreaElement).value })}></textarea>
      ${d.errorCode !== null
        ? html`<div class="fb-dialog-error" role="status">${
            d.errorCode === 'version-conflict'
              ? '这条反馈已在别处改动，已显示最新状态'
              : d.errorCode === 'note-too-large'
                ? '描述太长，请缩短后再提交'
                : '反馈保存失败'
          }</div>`
        : null}
    </div>
    <div class="fb-dialog-bar">
      <button type="button" class="fb-submit" disabled=${d.submitting} onClick=${submit}>
        ${d.submitting ? '正在提交…' : '提交'}
      </button>
    </div>
  </div>`
}
