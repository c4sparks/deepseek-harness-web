// 选择器切片：权限 / 模型 / 模式的选项状态与弹窗开关。
// 唯一跨域点是「/」菜单发起选择后要把结果追加到对话区——由装配层注入消息切片的 showNotice，
// 本切片不直接依赖消息行（保持切片之间无 import 边）。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { PermissionOption, ChatModelInfo, ChatAgentPreset } from '../protocol'
import type { ChatStore, SelectorState } from './types'

/** 追加一条通知行。由聚合层注入，避免选择器切片依赖消息行。 */
export type EmitNotice = (text: string, command?: string, tone?: 'error' | 'ok') => void

export interface SelectorsSlice {
  store: Pick<
    ChatStore,
    | 'sel'
    | 'permNameOf'
    | 'openPopup'
    | 'togglePopup'
    | 'openModelSearch'
    | 'markSlashPick'
    | 'closePopups'
    | 'selectPerm'
    | 'selectModel'
    | 'selectMode'
  >
  /** chatInfo 帧：写权限选项与当前值。 */
  setPermOptions(options: PermissionOption[] | undefined, currentValue: string | undefined): void
  /** chatInfo 帧：写模型分组与当前模型/推理等级。 */
  setModels(models: ChatModelInfo | undefined): void
  /** chatInfo 帧：写 agent 模式选项与锁定态。 */
  setModes(info: { presets?: ChatAgentPreset[] } | undefined, current: string | undefined, locked: boolean | undefined): void
  reset(): void
}

export function createSelectors(host: ChatHost, emitNotice: EmitNotice): SelectorsSlice {
  // 由「/」菜单打开的选择(permission/model)：选中后把操作结果追加到对话区；按钮入口不设此标记
  let slashPickKind: 'permission' | 'model' | null = null
  const permNameOf = new Map<string, string>()
  const openPopup = signal<'perm' | 'model' | 'mode' | 'modelSearch' | null>(null)
  const sel = signal<SelectorState>({
    permOptions: [],
    currentPerm: '',
    modelGroups: [],
    modelFailures: [],
    curProvider: '',
    curModel: '',
    curEffort: '',
    modeOptions: [],
    currentMode: '',
    modeLocked: false,
  })

  function closePopups(): void {
    openPopup.value = null
    slashPickKind = null
  }
  /** 标记下一次 selectPerm/selectModel 是「/」菜单发起(用于把操作结果追加到对话区)。 */
  function markSlashPick(kind: 'permission' | 'model'): void {
    slashPickKind = kind
  }
  function togglePopup(w: 'perm' | 'model' | 'mode'): void {
    openPopup.value = openPopup.value === w ? null : w
  }
  function openModelSearch(): void {
    openPopup.value = 'modelSearch'
  }
  function rememberPermName(o: { value: string; name?: string }): void {
    permNameOf.set(o.value, o.name || o.value)
  }
  function setPermOptions(options: PermissionOption[] | undefined, currentValue: string | undefined): void {
    const opts = options ?? []
    for (const o of opts) rememberPermName(o)
    sel.value = { ...sel.value, permOptions: opts, currentPerm: currentValue ?? '' }
  }
  function selectPerm(value: string): void {
    const opts = sel.value.permOptions
    const found = opts.find((o) => o.value === value)
    if (found) rememberPermName(found)
    sel.value = { ...sel.value, currentPerm: value }
    host.post({ type: 'chatSelectPermission', preset: value })
    // 由「/permission」发起：把切到的预设名追加到对话区(按钮入口不设标记，不进对话)
    if (slashPickKind === 'permission') {
      const label = found ? found.name || found.value : value
      emitNotice(label, 'permission', 'ok')
    }
    closePopups()
  }
  function setModels(models: ChatModelInfo | undefined): void {
    if (!models) return
    const cur = models.current
    sel.value = {
      ...sel.value,
      modelGroups: models.groups ?? [],
      modelFailures: models.failures ?? [],
      curProvider: cur?.provider ?? '',
      curModel: cur?.model ?? '',
      curEffort: cur?.reasoningEffort ?? '',
    }
  }
  function selectModel(provider: string, model: string, effort?: string): void {
    // 对齐上游 ui-model-selection selectionOf：
    //   重新选当前同一 provider+model → 保留当前推理等级；
    //   切到别的模型 → 用该模型 reasoning.defaultEffort（模型默认等级随模型走）。
    // 显式传 effort(用户主动改等级)时始终用它。
    const s0 = sel.value
    const sameRoute = s0.curProvider === provider && s0.curModel === model
    // '' 是「Default」(提供方默认) 的哨兵：显式清掉等级、不发给宿主，由上游按提供方默认解析。
    // 不能复用 undefined —— 那是「未指定」，要按 sameRoute/defaultEffort 自动推断
    const explicitDefault = effort === ''
    let eff = effort
    if (explicitDefault) {
      eff = undefined
    } else if (eff === undefined) {
      if (sameRoute) {
        eff = s0.curEffort || undefined
      } else {
        const g = s0.modelGroups?.find((x) => x.id === provider)
        const m = g?.models.find((x) => x.id === model)
        eff = m?.reasoning?.defaultEffort || undefined
      }
    }
    sel.value = { ...sel.value, curProvider: provider, curModel: model }
    if (eff !== undefined) {
      sel.value = { ...sel.value, curEffort: eff }
    } else if (!sameRoute || explicitDefault) {
      // 切走的模型没有默认等级 / 用户显式选 Default：本地先清空，等宿主 postChatInfo 回刷真实值
      sel.value = { ...sel.value, curEffort: '' }
    }
    host.post({
      type: 'chatSelectModel',
      provider,
      model,
      reasoningEffort: eff !== undefined ? eff || undefined : undefined,
    })
    // 由「/model」发起：把选到的 提供方 · 模型 · 等级 追加到对话区(按钮入口不设标记，不进对话)
    if (slashPickKind === 'model') {
      const gName = s0.modelGroups?.find((x) => x.id === provider)?.name || provider
      const mName = s0.modelGroups?.find((x) => x.id === provider)?.models.find((x) => x.id === model)?.name || model
      const label = `${gName} · ${mName}${eff ? ` · ${eff}` : ''}`
      emitNotice(label, 'model', 'ok')
    }
  }
  function setModes(info: { presets?: ChatAgentPreset[] } | undefined, current: string | undefined, locked: boolean | undefined): void {
    if (!info?.presets) return
    const rows = info.presets.filter((r) => !r.broken).map((r) => ({ id: r.id, name: r.name, description: r.description }))
    const currentMode =
      (current && rows.some((m) => m.id === current) ? current : '') || rows[0]?.id || ''
    const lockedVal = locked === true
    sel.value = { ...sel.value, modeOptions: rows, currentMode, modeLocked: lockedVal }
    if (lockedVal) closePopups()
  }
  function selectMode(id: string): void {
    sel.value = { ...sel.value, currentMode: id }
    host.post({ type: 'chatSelectMode', agentPreset: id })
    closePopups()
  }

  /** 新会话清空：只清弹窗与「/」发起标记，不动 sel 与 permNameOf（权限名回退表跨会话仍有效）。 */
  function reset(): void {
    openPopup.value = null
    slashPickKind = null
  }

  return {
    store: { sel, permNameOf, openPopup, togglePopup, openModelSearch, markSlashPick, closePopups, selectPerm, selectModel, selectMode },
    setPermOptions,
    setModels,
    setModes,
    reset,
  }
}
