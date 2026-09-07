// 聊天页核心状态(信号 store)。把旧 chat.ts 的"模块级变量 + 直接 DOM 写入"收敛为:
//   一个不可变消息列表(messages)+ 少量 UI 信号(processing/选择器/弹窗/统计/焦点),
//   以及一个 typed 归约器 onHostMessage(由入口经 ChatHost 单通道喂入)。
// 组件只读这些信号并渲染;要发宿主一律走 store 动作(内部 host.post)。
// 行为与旧 chat.ts 保持等价(逐函数映射见方案 P3/P4)。
import { computed, signal, type Signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { HostToViewMessage, ImageAttachment, PermissionOption, QuestionSpec, ChatModelInfo, ChatAgentPreset } from '../protocol'
import { friendlyToolName, formatStatsLine, formatMsgClock, turnStatusBadge, MODE_NAMES } from '../format'

export { MODE_NAMES }

// ---------- 消息行模型(不可变替换,组件用 stable key) ----------
export interface StepModel {
  step: number
  reason: string
  tools: string[]
}

export type ChatRow =
  | { kind: 'user'; key: number; text: string; images: ImageAttachment[]; time: string }
  | {
      kind: 'assistant'
      key: number
      time: string
      done: boolean
      prompt: string
      text: string
      stats: string
      /** chatDone.stats 原始值（含 usage 与 provider/model/ttftSec/tps/wallSec），供用量/用时弹窗 */
      usageRaw?: Record<string, unknown>
      /** turn/end 非正常终止原因（已本地化的短句），正常完成则空 */
      endMsg?: string
      /** 停止状态展示文案（已停止 · Stopped），仅被停止/中断/取消的回答有 */
      status?: string
      thinkingVisible: boolean
      collapsed: boolean
      stepCount: number
      toolCount: number
      currentOpenStep: number
      steps: StepModel[]
    }
  | { kind: 'approval'; key: number; approvalId: string; description: string; toolName?: string }
  | { kind: 'question'; key: number; rpcId: string; sessionId?: string; questions: QuestionSpec[]; disabled: boolean }
  | { kind: 'notice'; key: number; text: string }

export interface SelectorState {
  permOptions: PermissionOption[]
  currentPerm: string
  modelGroups: ChatModelInfo['groups']
  modelFailures: unknown[]
  curProvider: string
  curModel: string
  curEffort: string
  modeOptions: Array<{ id: string; name?: string; description?: string }>
  currentMode: string
  modeLocked: boolean
}

export interface ChatStore {
  // 信号
  messages: Signal<ChatRow[]>
  view: Signal<'welcome' | 'chat'>
  processing: Signal<boolean>
  text: Signal<string>
  attachments: Signal<string[]>
  images: Signal<ImageAttachment[]>
  focusTick: Signal<number>
  sel: Signal<SelectorState>
  openPopup: Signal<'perm' | 'model' | 'mode' | null>
  statsLine: Signal<{ text: string; title: string }>
  permNameOf: Map<string, string>
  // 动作
  send(): void
  cancel(): void
  suggestion(p: string): void
  regenerate(p: string, images?: ImageAttachment[]): void
  copy(text: string): void
  pickFile(): void
  addImage(img: ImageAttachment): void
  removeImage(i: ImageAttachment): void
  addAttachment(p: string): void
  removeAttachment(p: string): void
  readImageFile(file: File): void
  togglePopup(w: 'perm' | 'model' | 'mode'): void
  closePopups(): void
  selectPerm(value: string): void
  selectModel(provider: string, model: string, effort?: string): void
  selectMode(id: string): void
  answerApproval(approvalId: string, allow: boolean, key: number): void
  submitQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined, answers: Array<{ id: string; selected: string[]; custom?: string }>): void
  cancelQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined): void
  showNotice(text: string): void
  onHostMessage(m: HostToViewMessage): void
}

let rowKey = 1
const nowTime = (): string => formatMsgClock(Date.now())

export function createChatStore(host: ChatHost): ChatStore {
  const messages = signal<ChatRow[]>([])
  const view = computed<'welcome' | 'chat'>(() => (messages.value.length === 0 ? 'welcome' : 'chat'))
  const processing = signal(false)
  const text = signal('')
  const attachments = signal<string[]>([])
  const images = signal<ImageAttachment[]>([])
  const focusTick = signal(0)
  const openPopup = signal<'perm' | 'model' | 'mode' | null>(null)
  const statsLine = signal({ text: '', title: '' })
  const permNameOf = new Map<string, string>()
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

  // ---------- 不可变列表更新 ----------
  const replace = (key: number, next: ChatRow): void => {
    messages.value = messages.value.map((r) => (r.key === key ? next : r))
  }
  const push = (row: ChatRow): void => {
    messages.value = [...messages.value, row]
  }
  const removeWhere = (pred: (r: ChatRow) => boolean): void => {
    messages.value = messages.value.filter((r) => !pred(r))
  }
  const reset = (): void => {
    messages.value = []
    attachments.value = []
    images.value = []
    text.value = ''
    processing.value = false
    statsLine.value = { text: '', title: '' }
    openPopup.value = null
  }

  // 当前"流式进行中"的 assistant 行(至多一个);无则 undefined
  const activeAssistantIndex = (): number =>
    messages.value.findIndex((r) => r.kind === 'assistant' && !r.done)
  const ensureAssistant = (prompt = ''): ChatRow | undefined => {
    let idx = activeAssistantIndex()
    if (idx === -1) {
      push({
        kind: 'assistant',
        key: rowKey++,
        time: '', // 回答行的真实时刻由 chatDone 携带的 dsh 事件时间填充,此处不伪造
        done: false,
        prompt,
        text: '',
        stats: '',
        thinkingVisible: true,
        collapsed: false,
        stepCount: 0,
        toolCount: 0,
        currentOpenStep: 1,
        steps: [],
      })
      idx = messages.value.length - 1
    } else if (prompt) {
      const row = messages.value[idx]
      if (row.kind === 'assistant' && !row.prompt) {
        replace(row.key, { ...row, prompt })
      }
    }
    return messages.value[idx]
  }

  // ---------- 消息流动作(本地渲染) ----------
  function addUser(textMsg: string, imgs: ImageAttachment[] = [], time?: number): void {
    // 实时本地上送用本地时刻;恢复历史时传入 dsh 事件自带时间戳,不覆盖为"现在"
    push({ kind: 'user', key: rowKey++, text: textMsg, images: imgs, time: time !== undefined ? formatMsgClock(time) : nowTime() })
  }
  function beginAssistant(prompt = ''): void {
    ensureAssistant(prompt)
  }
  function activity(a: { type?: string; step?: number; tool?: string } | undefined): void {
    if (!a) return
    const row = ensureAssistant()
    if (!row || row.kind !== 'assistant') return
    if (a.type === 'step') {
      const step = a.step ?? row.stepCount + 1
      const next = {
        ...row,
        stepCount: row.stepCount + 1,
        currentOpenStep: step,
        thinkingVisible: true,
        steps: upsertStep(row.steps, step),
      }
      replace(row.key, next)
    } else if (a.type === 'tool') {
      const step = a.step ?? row.currentOpenStep
      const name = friendlyToolName(a.tool ?? '')
      const steps = upsertTool(row.steps, step, name)
      replace(row.key, { ...row, toolCount: row.toolCount + 1, thinkingVisible: true, steps })
    }
  }
  function reasoning(rText: string, step?: number): void {
    const row = ensureAssistant()
    if (!row || row.kind !== 'assistant') return
    const at = step ?? row.currentOpenStep
    const steps = row.steps.map((s) => (s.step === at ? { ...s, reason: s.reason + rText } : s))
    replace(row.key, { ...row, steps, thinkingVisible: true })
  }
  function chunk(delta: string): void {
    const idx = activeAssistantIndex()
    if (idx === -1) {
      push({
        kind: 'assistant',
        key: rowKey++,
        time: '',
        done: false,
        prompt: '',
        text: delta,
        stats: '',
        thinkingVisible: true,
        collapsed: false,
        stepCount: 0,
        toolCount: 0,
        currentOpenStep: 1,
        steps: [],
      })
      return
    }
    const row = messages.value[idx]
    if (row.kind === 'assistant') {
      replace(row.key, { ...row, text: row.text + delta })
    }
  }
  function finish(
    stats?: Record<string, unknown>,
    time?: number,
    text?: string,
    end?: { kind?: string; message?: string }
  ): void {
    const idx = activeAssistantIndex()
    if (idx === -1) return
    const row = messages.value[idx]
    if (row.kind !== 'assistant') return
    // time 取 chatDone 里 dsh 对该回答事件的自带时间戳(完成时刻),非本地伪造;
    // text 若带(chatDone 的 assistant/message 全文),以 API 整条消息为准覆盖流式拼接;
    // end = turn/end 非正常终止原因 → 本地化提示,正常完成则不显示
    const rowTime = time !== undefined ? formatMsgClock(time) : row.time
    const rowText = typeof text === 'string' && text !== '' ? text : row.text
    // 所有非正常终止(停止/中断/出错/超长/阻塞) → 右下角角标：直接回显官方 reason.kind 原值
    const status = turnStatusBadge(end?.kind) || undefined
    // error 时把服务端返回的原始错误消息附上（不翻译）
    const endMsg = end?.kind === 'error' && end?.message ? end.message : ''
    replace(row.key, {
      ...row,
      done: true,
      time: rowTime,
      text: rowText,
      endMsg: endMsg || undefined,
      status,
      stats: '', // 用量/用时已由图标+弹窗呈现，不再生成独立脚注文本
      usageRaw: stats ? { ...stats } : undefined,
      collapsed: true,
      thinkingVisible: false,
    })
    processing.value = false
  }

  // ---------- 思维链小工具 ----------
  function upsertStep(steps: StepModel[], step: number): StepModel[] {
    if (steps.some((s) => s.step === step)) return steps
    const next = [...steps, { step, reason: '', tools: [] as string[] }]
    next.sort((a, b) => a.step - b.step)
    return next
  }
  function upsertTool(steps: StepModel[], step: number, name: string): StepModel[] {
    const base = upsertStep(steps, step)
    return base.map((s) => (s.step === step && !s.tools.includes(name) ? { ...s, tools: [...s.tools, name] } : s))
  }

  // ---------- 发送 / 停止 ----------
  function send(): void {
    const msg = text.value.trim()
    const attach = attachments.value
    const imgs = images.value
    if ((!msg && attach.length === 0 && imgs.length === 0) || processing.value) return
    const refs = attach.map((a) => '@' + a.replace(/\\/g, '/'))
    const prompt = [...refs, msg].filter(Boolean).join('\n\n')
    addUser(prompt, imgs)
    attachments.value = []
    images.value = []
    text.value = ''
    processing.value = true
    beginAssistant(prompt) // 立即出现"思考中…"行(与 setProcessing(true) 行为一致)
    host.post({ type: 'chatSend', text: prompt, images: imgs })
  }
  function cancel(): void {
    host.post({ type: 'cancel' })
  }
  function suggestion(p: string): void {
    if (!p || processing.value) return
    addUser(p)
    processing.value = true
    beginAssistant(p)
    host.post({ type: 'chatSend', text: p })
  }
  function regenerate(p: string, images?: ImageAttachment[]): void {
    if (!p || processing.value) return
    processing.value = true
    beginAssistant(p)
    // user 行带图时重生成保留原图（assistant 行重生成传 text-only，images 为空数组）
    const imgs = images ?? []
    host.post({ type: 'chatSend', text: p, images: imgs })
  }
  const copy = (c: string): void => {
    if (c) host.post({ type: 'copy', text: c })
  }
  const pickFile = (): void => {
    host.post({ type: 'pickFile' })
  }

  // ---------- 附件 / 图片 ----------
  function renderAttachmentsDeps(): void {
    // images/attachments 是信号,改动即触发重渲;此函数仅为保持调用点语义占位
  }
  function addImage(img: ImageAttachment): void {
    images.value = [...images.value, img]
    renderAttachmentsDeps()
  }
  const removeImage = (img: ImageAttachment): void => {
    images.value = images.value.filter((i) => i !== img)
  }
  function addAttachment(p: string): void {
    if (!attachments.value.includes(p)) {
      attachments.value = [...attachments.value, p]
    }
  }
  const removeAttachment = (p: string): void => {
    attachments.value = attachments.value.filter((a) => a !== p)
  }
  function readImageFile(file: File): void {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(result)
      if (!m) return
      addImage({ mediaType: m[1], data: m[2], name: file.name || '图片' })
    }
    reader.readAsDataURL(file)
  }

  // ---------- 选择器(权限 / 模型 / 模式) ----------
  function closePopups(): void {
    openPopup.value = null
  }
  function togglePopup(w: 'perm' | 'model' | 'mode'): void {
    openPopup.value = openPopup.value === w ? null : w
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
    sel.value = { ...sel.value, curProvider: provider, curModel: model }
    if (effort !== undefined) sel.value = { ...sel.value, curEffort: effort }
    host.post({
      type: 'chatSelectModel',
      provider,
      model,
      reasoningEffort: effort !== undefined ? effort || undefined : undefined,
    })
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

  // ---------- 审批 / 提问 ----------
  function answerApproval(approvalId: string, allow: boolean, key: number): void {
    removeWhere((r) => r.kind === 'approval' && r.key === key)
    host.post({ type: 'approvalResponse', approvalId, allow })
  }
  function submitQuestion(
    key: number,
    rpcId: string | undefined,
    sessionId: string | undefined,
    answers: Array<{ id: string; selected: string[]; custom?: string }>
  ): void {
    removeWhere((r) => r.kind === 'question' && r.key === key)
    host.post({ type: 'questionResponse', rpcId, sessionId, answers })
  }
  function cancelQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined): void {
    // 先禁用按钮、不删卡;host 确认(questionClosed)后再移除
    messages.value = messages.value.map((r) => (r.kind === 'question' && r.key === key ? { ...r, disabled: true } : r))
    host.post({ type: 'questionCancel', rpcId, sessionId })
  }
  function closeQuestion(rpcId: string | undefined): void {
    removeWhere((r) => r.kind === 'question' && r.rpcId === (rpcId ?? ''))
  }

  const showNotice = (msgText: string): void => {
    push({ kind: 'notice', key: rowKey++, text: msgText })
  }

  // ---------- 历史恢复 ----------
  function renderHistory(
    list: Array<{
      role: string
      text: string
      time?: number
      provider?: string
      model?: string
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
      wallSec?: number
      ttftSec?: number
      tps?: number
      status?: string
    }>,
    sessionId: string | undefined
  ): void {
    reset()
    void sessionId
    let lastUser = ''
    for (const item of list) {
      if (item.role === 'user') {
        lastUser = item.text
        addUser(item.text, [], item.time) // 恢复历史:显示 dsh 快照里该消息的原时刻
      } else if (item.role === 'assistant') {
        // 该条消息自带 usage/provider/model → 用量图标可显示（计时缺回合事件，历史无 TPS/TTFT）
        const u: Record<string, unknown> = {}
        if (item.provider !== undefined) u['provider'] = item.provider
        if (item.model !== undefined) u['model'] = item.model
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'wallSec', 'ttftSec', 'tps'] as const) {
          const v = item[k]
          if (typeof v === 'number') u[k] = v
        }
        // 用量/用时按钮独立：任一(用量 token/provider 或 时间 wall/ttft/tps)存在即挂 TurnStats。
        // 对齐官方：TurnTailNodeView 里 📊 用量 pill ⇐ 该回合 tokenUsage 存在才渲染；
        // ⏱ 用时 pill ⇐ runMs 存在才渲染（deriveTurnMetrics 的 TTFT/TPS 缺行则官方隐藏）。
        const hasUsage =
          typeof u['provider'] === 'string' ||
          typeof u['inputTokens'] === 'number' ||
          typeof u['outputTokens'] === 'number' ||
          typeof u['wallSec'] === 'number' ||
          typeof u['ttftSec'] === 'number' ||
          typeof u['tps'] === 'number'
        push({
          kind: 'assistant',
          key: rowKey++,
          time: item.time !== undefined ? formatMsgClock(item.time) : '',
          done: true,
          prompt: lastUser,
          text: item.text,
          stats: '',
          usageRaw: hasUsage ? u : undefined,
          status: item.status,
          thinkingVisible: false,
          collapsed: true,
          stepCount: 0,
          toolCount: 0,
          currentOpenStep: 1,
          steps: [],
        })
      }
    }
    processing.value = false
  }

  // ---------- typed 归约器(host → 本 store) ----------
  function onHostMessage(m: HostToViewMessage): void {
    switch (m.type) {
      case 'chatActivity':
        activity(m.activity)
        break
      case 'chatReasoning':
        reasoning(m.text ?? '', m.step)
        break
      case 'chatApproval':
        push({
          kind: 'approval',
          key: rowKey++,
          approvalId: m.approvalId ?? '',
          description: m.description ?? '需要授权操作',
          toolName: m.toolName,
        })
        break
      case 'chatQuestion':
        push({
          kind: 'question',
          key: rowKey++,
          rpcId: m.rpcId ?? '',
          sessionId: m.sessionId,
          questions: m.questions ?? [],
          disabled: false,
        })
        break
      case 'questionClosed':
        closeQuestion(m.rpcId)
        break
      case 'chatChunk':
        chunk(m.text ?? '')
        break
      case 'chatDone':
        finish(m.stats, m.time, m.text, m.end)
        break
      case 'filePicked':
        if (m.path) addAttachment(m.path)
        break
      case 'chatInfo': {
        const proj = m.projections
        if (proj) {
          const perms = proj['permissions'] as { options?: PermissionOption[]; currentValue?: string } | undefined
          setPermOptions(perms?.options, perms?.currentValue)
          statsLine.value = formatStatsLine(proj)
        }
        setModels(m.models)
        setModes(m.agentPresets, m.agentPreset, m.agentPresetLocked)
        break
      }
      case 'draft':
        text.value = text.value ? text.value + '\n' + (m.text ?? '') : m.text ?? ''
        focusTick.value++
        break
      case 'chatHistory':
        renderHistory(m.messages ?? [], m.sessionId)
        break
      case 'clear':
        reset()
        break
      // 标题栏消息归 titlebar(入口另行路由),本 store 忽略
      case 'panelState':
      case 'selfInfo':
      case 'wsDropdownList':
      case 'wsDropdownSessions':
      case 'wsActionDone':
        break
    }
  }

  // 启动时统一挂订阅在入口 chat.ts 完成(避免这里二次订阅)
  return {
    messages,
    view,
    processing,
    text,
    attachments,
    images,
    focusTick,
    sel,
    openPopup,
    statsLine,
    permNameOf,
    send,
    cancel,
    suggestion,
    regenerate,
    copy,
    pickFile,
    addImage,
    removeImage,
    addAttachment,
    removeAttachment,
    readImageFile,
    togglePopup,
    closePopups,
    selectPerm,
    selectModel,
    selectMode,
    answerApproval,
    submitQuestion,
    cancelQuestion,
    showNotice,
    onHostMessage,
  }
}
