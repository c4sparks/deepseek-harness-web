// 模型图标入口的完整弹窗内容：按提供方分组的模型列表 + 当前模型的推理等级(单页风格)。
// 只负责「内容 + 点选提交」；弹窗定位/外点关闭由外层锚定 popup(#modelPopup)负责。
// 与 /model 的「仅可搜索模型列表」不同，本组件保留分组与推理等级两段，点模型/等级都即关。
import { html } from 'htm/preact'
import type { ChatStore } from '../core/store/chat'

export function ModelPicker({ store }: { store: ChatStore }) {
  const sel = store.sel.value
  const activeModel = (provider: string, model: string): { name?: string; reasoning?: { efforts?: Array<{ id: string; name: string }> } } | undefined =>
    sel.modelGroups?.find((g) => g.id === provider)?.models.find((m) => m.id === model)
  const efforts = activeModel(sel.curProvider, sel.curModel)?.reasoning?.efforts ?? []
  return html`<div class="modelpicker">
    <div class="popup-title">模型</div>
    ${sel.modelFailures.length > 0
      ? html`<div class="popup-fail" title=${JSON.stringify(sel.modelFailures)}>⚠ ${sel.modelFailures.length} 组模型加载失败</div>`
      : null}
    ${(sel.modelGroups ?? []).map(
      (g) =>
        g.models.length > 0 &&
        html`<div key=${g.id}>
          <div class="optgroup-label">${g.name || g.id}</div>
          ${g.models.map(
            (m) => html`<div class=${'opt' + (g.id === sel.curProvider && m.id === sel.curModel ? ' selected' : '')} key=${m.id}
              title=${m.description || m.name || m.id}
              onClick=${() => {
                store.selectModel(g.id, m.id)
                store.closePopups() // 选模型即提交关闭
              }}>${m.name || m.id}</div>`
          )}
        </div>`
    )}
    ${efforts.length > 0
      ? html`<div>
          <div class="optgroup-label">推理等级</div>
          ${efforts.map(
            (e) => html`<div class=${'opt reason' + (e.id === sel.curEffort ? ' selected' : '')} key=${e.id}
              onClick=${() => {
                store.selectModel(sel.curProvider, sel.curModel, e.id)
                store.closePopups() // 选等级即提交关闭
              }}>${e.name || e.id}</div>`
          )}
        </div>`
      : null}
  </div>`
}
