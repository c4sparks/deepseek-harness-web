// 聊天页核心状态(信号 store)。把旧 chat.ts 的"模块级变量 + 直接 DOM 写入"收敛为:
//   一个不可变消息列表(messages)+ 少量 UI 信号(processing/选择器/弹窗/统计/焦点),
//   以及一个 typed 归约器 onHostMessage(由入口经 ChatHost 单通道喂入)。
// 组件只读这些信号并渲染;要发宿主一律走 store 动作(内部 host.post)。
// 行为与旧 chat.ts 保持等价(逐函数映射见方案 P3/P4)。
import { computed, signal, type Signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type {
  HostToViewMessage,
  ViewActivity,
  HistoryMessage,
  ImageAttachment,
  PermissionOption,
  QuestionSpec,
  ChatModelInfo,
  ChatAgentPreset,
  SlashCommandInfo,
  SlashSkillInfo,
  AtFileRef,
  AtSessionRef,
  LiveContext,
} from '../protocol'
import { toolTitle, deriveToolSummary, formatStatsLine, formatMsgClock, turnStatusBadge, MODE_NAMES } from '../format'

export { MODE_NAMES }

// ---------- 消息行模型(不可变替换,组件用 stable key) ----------

/** 一条 assistant 回合的过程动作（官方"过程折叠窗口"里的成员；reasoning 或 tool 各一条，按发生顺序）。 */
export type ChainItem =
  | { kind: 'reasoning'; key: number; step?: number; index?: number; text: string }
  | {
      kind: 'tool'
      key: number
      step?: number
      callId?: string
      name: string
      title?: string
      summary?: string
      argsRaw?: string
      status: 'running' | 'ok' | 'error' | 'stopped'
      error?: string
      /** tool/result 的结果文本（Terminal/Read 等展开卡展示输出） */
      output?: string
      /** 退出码（输出末尾 marker 解析；Terminal 卡 Pill 展示；输出已剥 marker） */
      exitCode?: number
      /** 终止信号名（[killed by signal: X]；优先于退出码） */
      signal?: string
      /** tool/result.data.meta 原文透传（web_fetch statusCode / web_search sources/answer 等卡数据源） */
      meta?: unknown
      /** ask_user_question 的 RPC 交互数据（chatQuestion 配对挂到该工具行：rpcId/sessionId/带选项的 questions） */
      question?: { rpcId?: string; sessionId?: string; questions?: QuestionSpec[] }
    }
  | {
      kind: 'context'
      key: number
      content: unknown[]
      source: unknown
      provenance: { role: 'inject' | 'recall'; label: string | null }
      form: string | null
    }

/** 过程折叠计数（官方口径：toolCallCount=非 subagent 工具调用数；messageCount=最终答复前带文本的中间 assistant 消息数） */
export interface TurnCounts {
  toolCallCount: number
  messageCount: number
}

export type ChatRow =
  | { kind: 'user'; key: number; text: string; images: ImageAttachment[]; time: string; refs?: Array<{ kind: RefChip['kind']; label: string }> }
  | {
      kind: 'context'
      key: number
      time?: string
      content: unknown[]
      source: unknown
      provenance: { role: 'inject' | 'recall'; label: string | null }
      form: string | null
    }
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
      /** 过程链：思考/工具按发生顺序排列（折叠窗口成员） */
      chain: ChainItem[]
      /** 过程折叠计数（官方口径）；定稿前为 0，chatDone 附 counts 后回填 */
      counts: TurnCounts
      /** 正文首 chunk 是否已到达（正文开始 = 过程定稿，链可收起） */
      bodyStarted: boolean
    }
  | { kind: 'approval'; key: number; approvalId: string; description: string; toolName?: string }
  | { kind: 'question'; key: number; rpcId: string; sessionId?: string; questions: QuestionSpec[]; disabled: boolean }
  | { kind: 'notice'; key: number; text: string; command?: string; tone?: 'error' | 'ok' }

/** 输入框引用贴片（@ 选出，不进正文；发送时转成引用行）。 */
export interface RefChip {
  key: number
  kind: 'file' | 'directory' | 'session'
  label: string
  /** 发送时注入 prompt 的引用文本（文件 @path / 会话 @[label](dsh-session:…)） */
  token: string
  /** 供 tooltip 展示的完整相对路径/会话 id 等 */
  detail?: string
}

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
  /** 过渡态：恢复历史/切工作区等无明确进度等待（驱动 composer 禁用 + 占位/骨架）。null=空闲 */
  busy: Signal<'loading' | 'switching' | null>
  text: Signal<string>
  attachments: Signal<string[]>
  images: Signal<ImageAttachment[]>
  /** 「@」引用贴片（不进正文；发送时转为引用行） */
  refs: Signal<RefChip[]>
  focusTick: Signal<number>
  sel: Signal<SelectorState>
  openPopup: Signal<'perm' | 'model' | 'mode' | 'modelSearch' | null>
  statsLine: Signal<{ text: string; title: string }>
  /** 「/」菜单目录(host 命令+技能)；null=尚未拉到 */
  slashCatalog: Signal<{ commands: SlashCommandInfo[]; skills: SlashSkillInfo[] } | null>
  /** 「@」引用候选(文件/目录+会话)；null=尚未拉到/换会话清空；query=该候选对应的查询串 */
  atCatalog: Signal<{ query: string; files: AtFileRef[]; sessions: AtSessionRef[] } | null>
  /** plan 协作状态(投影 plan)；null=未启用/无该能力 */
  planState: Signal<{ active: boolean; pending: boolean } | null>
  /** 会话目标(投影 goal)；null=无目标/能力缺失。goal bar 常驻条数据源（形状按官方 GoalProjection） */
  goalState: Signal<{ objective: string; phase: string } | null>
  /** 当前会话的系统提示词（工作区指令 agent-instructions），左上角常驻入口数据源；null=无 */
  systemPrompt: Signal<{ label: string | null; content: unknown[] } | null>
  /** 官方 waterfall 提问弹窗（输入框上方）：pending 时让用户选择/提交/取消/关闭；null=无 */
  pendingQuestion: Signal<{ rpcId?: string; sessionId?: string; questions: QuestionSpec[] } | null>
  /** 主动触底请求计数：用户发送/重新生成/恢复会话时 +1（MessageList 消费后清零并强制滚到底） */
  scrollPend: Signal<number>
  permNameOf: Map<string, string>
  // 动作
  send(): void
  cancel(): void
  /** 行首 `/` 菜单需要目录时调用(宿主异步回 slashCatalog；并发去重) */
  requestSlashList(): void
  /** 按查询串请求「@」候选(文件/目录+会话)；宿主异步回 atCatalog，最新查询 wins */
  requestAtList(query: string): void
  /** 执行一条 dsh 斜杠命令(发宿主 slashRun；清空输入) */
  runSlash(text: string): void
  suggestion(p: string): void
  regenerate(p: string, images?: ImageAttachment[]): void
  copy(text: string): void
  pickFile(): void
  addImage(img: ImageAttachment): void
  removeImage(i: ImageAttachment): void
  addAttachment(p: string): void
  removeAttachment(p: string): void
  /** 添加一条 @ 引用贴片（文件/目录/会话） */
  addRef(kind: RefChip['kind'], label: string, token: string, detail?: string): void
  removeRef(key: number): void
  readImageFile(file: File): void
  togglePopup(w: 'perm' | 'model' | 'mode'): void
  /** 打开「仅模型列表的可搜索弹窗」（/model 斜杠入口用；与按钮的完整模型弹窗区分） */
  openModelSearch(): void
  /** 标记下一次 selectPerm/selectModel 是「/」菜单发起（结果追加到对话区）；按钮入口不调用 */
  markSlashPick(kind: 'permission' | 'model'): void
  closePopups(): void
  selectPerm(value: string): void
  selectModel(provider: string, model: string, effort?: string): void
  selectMode(id: string): void
  answerApproval(approvalId: string, allow: boolean, key: number): void
  submitQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined, answers: Array<{ id: string; selected: string[]; custom?: string }>): void
  cancelQuestion(key: number, rpcId: string | undefined, sessionId: string | undefined): void
  showNotice(text: string, command?: string, tone?: 'error' | 'ok'): void
  onHostMessage(m: HostToViewMessage): void
}

let rowKey = 1
const nowTime = (): string => formatMsgClock(Date.now())

export function createChatStore(host: ChatHost): ChatStore {
  const messages = signal<ChatRow[]>([])
  const view = computed<'welcome' | 'chat'>(() => (messages.value.length === 0 ? 'welcome' : 'chat'))
  const processing = signal(false)
  const busy = signal<'loading' | 'switching' | null>(null)
  const text = signal('')
  const attachments = signal<string[]>([])
  const images = signal<ImageAttachment[]>([])
  const refs = signal<RefChip[]>([])
  const focusTick = signal(0)
  let refKey = 1
  const openPopup = signal<'perm' | 'model' | 'mode' | 'modelSearch' | null>(null)
  const statsLine = signal({ text: '', title: '' })
  const slashCatalog = signal<{ commands: SlashCommandInfo[]; skills: SlashSkillInfo[] } | null>(null)
  const atCatalog = signal<{ query: string; files: AtFileRef[]; sessions: AtSessionRef[] } | null>(null)
  const planState = signal<{ active: boolean; pending: boolean } | null>(null)
  const goalState = signal<{ objective: string; phase: string } | null>(null)
  const systemPrompt = signal<{ label: string | null; content: unknown[] } | null>(null)
  const pendingQuestion = signal<{ rpcId?: string; sessionId?: string; questions: QuestionSpec[] } | null>(null)
  const scrollPend = signal(0)
  let slashListInflight = false
  // 「@」候选拉取：单飞行 + 最新查询 wins（输入中不断打 @ 只保留最后查询）
  let atInflight = false
  let atPendingQuery: string | null = null
  /** 目录未到时用户已按 Enter 的「/」行：先存下，待 slashCatalog 到达再裁决(命令→执行/其余→普通消息) */
  let pendingSlash: string | null = null
  // 由「/」菜单打开的选择(permission/model)：选中后把操作结果追加到对话区；按钮入口不设此标记
  let slashPickKind: 'permission' | 'model' | null = null
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
    refs.value = []
    text.value = ''
    processing.value = false
    busy.value = null
    statsLine.value = { text: '', title: '' }
    openPopup.value = null
    // 新会话后 slash 目录需重新拉取(会话内命令/技能可能不同)
    slashCatalog.value = null
    atCatalog.value = null
    planState.value = null
    goalState.value = null
    systemPrompt.value = null
    pendingQuestion.value = null
    slashListInflight = false
    atInflight = false
    atPendingQuery = null
    slashPickKind = null
    pendingSlash = null
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
        chain: [],
        counts: { toolCallCount: 0, messageCount: 0 },
        bodyStarted: false,
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
  function addUser(textMsg: string, imgs: ImageAttachment[] = [], time?: number, refs?: Array<{ kind: RefChip['kind']; label: string }>): void {
    // 实时本地上送用本地时刻;恢复历史时传入 dsh 事件自带时间戳,不覆盖为"现在"
    push({ kind: 'user', key: rowKey++, text: textMsg, images: imgs, time: time !== undefined ? formatMsgClock(time) : nowTime(), refs })
  }
  function beginAssistant(prompt = ''): void {
    ensureAssistant(prompt)
  }
  /** 追加一条过程动作到当前 assistant 行链尾。 */
  const pushChain = (row: Extract<ChatRow, { kind: 'assistant' }>, item: ChainItem): void => {
    replace(row.key, { ...row, chain: [...row.chain, item] })
  }
  function activity(a: ViewActivity | undefined): void {
    if (!a) return
    const row = ensureAssistant()
    if (!row || row.kind !== 'assistant') return
    if (a.type === 'tool') {
      // 追加一条工具调用：raw name + 标题 + 参数摘要；流式中 status running，toolDone 到达后置 ok/error
      const name = a.tool ?? a.name ?? ''
      if (!name) return
      pushChain(row, {
        kind: 'tool',
        key: rowKey++,
        step: a.step,
        callId: a.callId,
        name,
        title: toolTitle(name),
        summary: deriveToolSummary(a.argsRaw, name),
        argsRaw: a.argsRaw,
        status: 'running',
      })
    } else if (a.type === 'toolDone') {
      // 按 callId 精确落位；无 callId 时回落标记该 step 的最后一个 running（官方每步工具收敛）
      let matched = false
      const chain = row.chain.map((c): ChainItem => {
        if (c.kind !== 'tool' || c.status !== 'running') return c
        if (matched) return c
        const hit = (a.callId && c.callId === a.callId) || (!a.callId && !c.callId && c.step === a.step)
        if (!hit) return c
        matched = true
        return {
          ...c,
          status: (a.error ? 'error' : 'ok') as 'ok' | 'error',
          error: a.error,
          output: a.output ?? c.output,
          exitCode: a.exitCode ?? c.exitCode,
          signal: a.signal ?? c.signal,
          meta: a.meta ?? c.meta,
        }
      })
      replace(row.key, { ...row, chain })
    }
    // type 'step'：无需额外动作——reasoning/tool 已按事件顺序落链
  }
  /** 官方 waterfall 提问弹窗（输入框上方）：pending 时置为弹窗数据；回答/取消/关闭后清空。 */
  function openQuestionDialog(rpcId: string | undefined, sessionId: string | undefined, questions: QuestionSpec[]): void {
    pendingQuestion.value = { rpcId, sessionId, questions }
  }
  /** 把一次上下文注入并入当前 assistant 的 process 链（与思考/工具同一行链，折叠时仅在展开可见）。
   *  系统提示词(agent-instructions, form==='instructions')走左上角常驻入口，不入链（否则只含它的链展开为空）。 */
  function contextRow(c: LiveContext | undefined, time?: number): void {
    void time
    if (!c) return
    if (c.form === 'instructions') return
    const row = ensureAssistant()
    if (!row || row.kind !== 'assistant') return
    pushChain(row, {
      kind: 'context',
      key: rowKey++,
      content: c.content,
      source: c.source,
      provenance: c.provenance,
      form: c.form,
    })
  }
  function reasoning(rText: string, step?: number, index?: number): void {
    if (!rText) return
    const row = ensureAssistant()
    if (!row || row.kind !== 'assistant') return
    const chain = row.chain
    const tail = chain[chain.length - 1]
    // 同一段(step+index)持续追加；否则开新的 reasoning 段（每段=一次模型推理，官方按块分行）
    const same =
      tail !== undefined &&
      tail.kind === 'reasoning' &&
      tail.step === step &&
      (index === undefined || tail.index === index || tail.index === undefined)
    const next = same
      ? chain.map((c, i): ChainItem => (i === chain.length - 1 && c.kind === 'reasoning' ? { ...c, text: c.text + rText } : c))
      : [...chain, { kind: 'reasoning' as const, key: rowKey++, step, index, text: rText }]
    replace(row.key, { ...row, chain: next })
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
        chain: [],
        counts: { toolCallCount: 0, messageCount: 0 },
        bodyStarted: delta !== '',
      })
      return
    }
    const row = messages.value[idx]
    if (row.kind === 'assistant') {
      // 正文开始 = 过程定稿：链允许自动收起（组件据 bodyStarted/done 决定折叠）
      replace(row.key, { ...row, text: row.text + delta, bodyStarted: row.bodyStarted || delta !== '' })
    }
  }
  function finish(
    stats?: Record<string, unknown>,
    time?: number,
    text?: string,
    end?: { kind?: string; message?: string },
    counts?: { toolCallCount?: number; messageCount?: number }
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
    // 收敛仍 running 的工具：正常完成但缺 result → ok；被打断/出错 → stopped（模型通用兜底）
    const abnormal = !!end?.kind && end.kind !== 'completed'
    const chain = row.chain.map((c): ChainItem =>
      c.kind === 'tool' && c.status === 'running'
        ? { ...c, status: (abnormal ? 'stopped' : 'ok') as 'ok' | 'stopped', error: c.error }
        : c
    )
    replace(row.key, {
      ...row,
      chain,
      done: true,
      time: rowTime,
      text: rowText,
      endMsg: endMsg || undefined,
      status,
      stats: '', // 用量/用时已由图标+弹窗呈现，不再生成独立脚注文本
      usageRaw: stats ? { ...stats } : undefined,
      counts: {
        toolCallCount: counts?.toolCallCount ?? row.counts.toolCallCount,
        messageCount: counts?.messageCount ?? row.counts.messageCount,
      },
      bodyStarted: true,
    })
    processing.value = false
  }

  // ---------- 发送 / 停止 ----------
  function send(): void {
    const msg = text.value.trim()
    const attach = attachments.value
    const imgs = images.value
    if ((!msg && attach.length === 0 && imgs.length === 0 && refs.value.length === 0) || processing.value) return
    // 「/」命令路由：纯文本单行、行首 `/` 且首词命中 host 命令目录 → 执行 dsh 斜杠命令而非发消息。
    // 技能行(/技能名…)不在此列，照常走 chatSend（宿主 pre-step 识别 /技能名 头）。
    const cat = slashCatalog.value
    if (attach.length === 0 && imgs.length === 0 && !msg.includes('\n') && msg.startsWith('/')) {
      const name = msg.slice(1).split(/[\s　]+/)[0].toLowerCase()
      const matched = !!(name && cat && cat.commands.some((c) => c.name.toLowerCase() === name))
      if (matched) {
        text.value = ''
        host.post({ type: 'slashRun', text: msg })
        return
      }
      if (!cat) {
        // 目录尚未拉到(换会话后首条即发 /xxx)：先挂起、取目录，待 slashCatalog 到达再裁决，
        // 避免把 /compact 之类当普通文本发给 agent
        pendingSlash = msg
        requestSlashList()
        return
      }
      // cat 已到但首词未命中(技能/未知斜杠 token)：落回普通发送(技能走 chatSend、未知 token 走消息，与官方一致)
    }
    const attachRefs = attach.map((a) => '@' + a.replace(/\\/g, '/'))
    const refTokens = refs.value.map((r) => r.token)
    const prompt = [...attachRefs, ...refTokens, msg].filter(Boolean).join('\n\n') // 发给 dsh：含引用 token
    const display = [...attachRefs, msg].filter(Boolean).join('\n\n') // 气泡展示：引用以 chip 呈现，不铺 @token 文本
    const refSnap = refs.value.map((r) => ({ kind: r.kind, label: r.label }))
    // 用户主动发送：即使滚动条在上面也强制滚到底看新内容（流式中自己翻上去则不受影响）
    scrollPend.value = scrollPend.value + 1
    addUser(display, imgs, undefined, refSnap.length ? refSnap : undefined)
    attachments.value = []
    images.value = []
    refs.value = []
    text.value = ''
    processing.value = true
    beginAssistant(prompt) // 立即出现"思考中…"行(与 setProcessing(true) 行为一致)
    host.post({ type: 'chatSend', text: prompt, images: imgs })
  }
  function cancel(): void {
    host.post({ type: 'cancel' })
  }
  /** 行首 `/` 菜单需要目录时调用；宿主异步回 slashCatalog（并发去重）。 */
  function requestSlashList(): void {
    if (slashListInflight) return
    slashListInflight = true
    host.post({ type: 'slashListReq' })
  }
  /** 「@」按查询串请求候选；最新查询 wins（输入过程只保留最后串，落后响应到达后自动补发）。 */
  function requestAtList(query: string): void {
    atPendingQuery = query
    if (atInflight) return
    // 已持有同一查询的候选且无待发请求 → 跳过（光标/输入抖动去重）
    if (atCatalog.value && atCatalog.value.query === query) return
    atInflight = true
    host.post({ type: 'atListReq', query })
  }
  /** slashCatalog 到达后裁决被挂起的「/」行：命中命令→执行；未命中→按普通消息发出(仅当用户没改写输入)。 */
  function resolvePendingSlash(): void {
    if (!pendingSlash) return
    const line = pendingSlash
    pendingSlash = null
    const cat = slashCatalog.value
    if (!cat) return // 目录仍未拉到(理论上不会)：直接放弃，避免误发
    const name = line.slice(1).split(/[\s　]+/)[0].toLowerCase()
    if (name && cat.commands.some((c) => c.name.toLowerCase() === name)) {
      // 命令：直接执行（runSlash 只在输入仍等于本行时清空，避免盖掉用户新输入）
      runSlash(line)
      return
    }
    // 未命中命令：按普通消息发（技能行 / 未知斜杠 token；用户已改写输入则放弃，交给下一次发送）
    if (text.value === line) {
      text.value = ''
      addUser(line)
      processing.value = true
      beginAssistant(line)
      host.post({ type: 'chatSend', text: line })
    }
  }
  /** 执行一条 dsh 斜杠命令：清空输入后发宿主（不入聊天气泡）。 */
  function runSlash(line: string): void {
    const t = (line ?? '').trim()
    if (!t.startsWith('/')) return
    if (text.value === t) text.value = ''
    host.post({ type: 'slashRun', text: t })
  }
  function suggestion(p: string): void {
    if (!p || processing.value) return
    scrollPend.value = scrollPend.value + 1
    addUser(p)
    processing.value = true
    beginAssistant(p)
    host.post({ type: 'chatSend', text: p })
  }
  function regenerate(p: string, images?: ImageAttachment[]): void {
    if (!p || processing.value) return
    processing.value = true
    scrollPend.value = scrollPend.value + 1
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
  /** 添加一条 @ 引用贴片（label 用于显示，token 为发送时注入 prompt 的引用文本）。 */
  function addRef(kind: RefChip['kind'], label: string, token: string, detail?: string): void {
    refs.value = [...refs.value, { key: refKey++, kind, label, token, detail }]
  }
  const removeRef = (key: number): void => {
    refs.value = refs.value.filter((r) => r.key !== key)
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
      push({ kind: 'notice', key: rowKey++, text: label, command: 'permission', tone: 'ok' })
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
    // 对齐官方 ui-model-selection selectionOf：
    //   重新选当前同一 provider+model → 保留当前推理等级；
    //   切到别的模型 → 用该模型 reasoning.defaultEffort（模型默认等级随模型走）。
    // 显式传 effort(用户主动改等级)时始终用它。
    const s0 = sel.value
    const sameRoute = s0.curProvider === provider && s0.curModel === model
    let eff = effort
    if (eff === undefined) {
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
    } else if (!sameRoute) {
      // 切走的模型没有默认等级：本地先清空旧等级，等宿主 postChatInfo 回刷真实值
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
      push({ kind: 'notice', key: rowKey++, text: label, command: 'model', tone: 'ok' })
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

  const showNotice = (msgText: string, command?: string, tone: 'error' | 'ok' = 'error'): void => {
    push({ kind: 'notice', key: rowKey++, text: msgText, command, tone })
  }

  // ---------- 历史恢复 ----------
  function renderHistory(list: HistoryMessage[], sessionId: string | undefined): void {
    reset()
    void sessionId
    let lastUser = ''
    for (const item of list) {
      if (item.role === 'user') {
        lastUser = item.text
        addUser(item.text, [], item.time) // 恢复历史:显示 dsh 快照里该消息的原时刻
      } else if (item.role === 'context') {
        // 上下文注入并入 assistant 链（session 已归并），不再作为独立行
        continue
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
          // 历史链：宿主快照重放出 reasoning/context/tool，恢复后可折叠展开
          chain: (item.chain ?? []).map(
            (h): ChainItem =>
              h.kind === 'reasoning'
                ? { kind: 'reasoning', key: rowKey++, text: h.text }
                : h.kind === 'context'
                  ? {
                      kind: 'context',
                      key: rowKey++,
                      content: h.content,
                      source: h.source,
                      provenance: h.provenance,
                      form: h.form,
                    }
                  : {
                      kind: 'tool',
                      key: rowKey++,
                      callId: h.callId,
                      name: h.name,
                      title: h.title ?? toolTitle(h.name),
                      summary: h.summary ?? deriveToolSummary(h.argsRaw, h.name),
                      argsRaw: h.argsRaw,
                      status: h.status,
                      error: h.error,
                      output: h.output,
                      exitCode: h.exitCode,
                      signal: h.signal,
                      meta: h.meta,
                    }
          ),
          counts: {
            toolCallCount: item.counts?.toolCallCount ?? 0,
            messageCount: item.counts?.messageCount ?? 0,
          },
          bodyStarted: true,
        })
      }
    }
    processing.value = false
    // 恢复会话后落到最新（若历史非空）
    if (messages.value.length > 0) {
      scrollPend.value = scrollPend.value + 1
    }
  }

  // ---------- typed 归约器(host → 本 store) ----------
  function onHostMessage(m: HostToViewMessage): void {
    switch (m.type) {
      case 'chatActivity':
        activity(m.activity)
        break
      case 'chatReasoning':
        reasoning(m.text ?? '', m.step, m.index)
        break
      case 'chatContext':
        contextRow(m.context, m.context?.time)
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
        // 官方 waterfall 提问弹窗（输入框上方）：pending 时置弹窗数据，用户选择/提交/取消/关闭。
        openQuestionDialog(m.rpcId, m.sessionId, m.questions ?? [])
        break
      case 'questionClosed':
        closeQuestion(m.rpcId)
        break
      case 'chatChunk':
        chunk(m.text ?? '')
        break
      case 'chatDone':
        finish(m.stats, m.time, m.text, m.end, m.counts)
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
          // plan 协作状态(plan/mode 折叠)，能力未组合则键缺失→保持 null
          const p = proj['plan'] as { active?: boolean; pending?: boolean } | undefined
          planState.value = p && typeof p.active === 'boolean' ? { active: p.active, pending: !!p.pending } : null
          // goal 常驻（官方 goal bar 数据源）：goal 投影 null=无目标、缺键=能力未组合。
          // 形状按官方 GoalProjection{goal:{objective,phase,…}}，顺带兼容扁平 string/object 的旧/变体。
          const rawGoal: unknown = proj['goal']
          let goalObj: string | undefined
          let goalPhase = ''
          if (typeof rawGoal === 'string') {
            goalObj = rawGoal || undefined
          } else if (rawGoal && typeof rawGoal === 'object') {
            const rec = rawGoal as Record<string, unknown>
            const nested = rec['goal']
            const src = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : rec
            const obj = src['objective']
            const ph = src['phase']
            if (typeof obj === 'string' && obj) goalObj = obj
            if (typeof ph === 'string') goalPhase = ph
          }
          goalState.value = goalObj ? { objective: goalObj, phase: goalPhase } : null
        }
        setModels(m.models)
        setModes(m.agentPresets, m.agentPreset, m.agentPresetLocked)
        // 会话建立/切换后预取「/」目录：把「目录未到即发 /xxx」的窗口压到最小（换会话 reset 已把目录清空）
        if (!slashListInflight && (!slashCatalog.value || (slashCatalog.value.commands.length === 0 && slashCatalog.value.skills.length === 0))) {
          requestSlashList()
        }
        break
      }
      case 'draft':
        text.value = text.value ? text.value + '\n' + (m.text ?? '') : m.text ?? ''
        focusTick.value++
        break
      case 'chatHistory':
        renderHistory(m.messages ?? [], m.sessionId)
        break
      case 'chatSystemPrompt':
        systemPrompt.value = m.systemPrompt ?? null
        break
      case 'clear':
        reset()
        break
      case 'busy':
        busy.value = m.kind ?? null
        break
      case 'slashCatalog':
        slashCatalog.value = { commands: m.commands ?? [], skills: m.skills ?? [] }
        slashListInflight = false
        // 目录到达后：裁决目录未到时挂起的「/」行(命令→执行，其余→普通消息)
        resolvePendingSlash()
        break
      case 'atCatalog':
        atInflight = false
        if (atPendingQuery !== null) {
          const q = atPendingQuery
          if (q === m.query) {
            // 响应匹配最新查询：落库
            atCatalog.value = { query: m.query, files: m.files ?? [], sessions: m.sessions ?? [] }
            atPendingQuery = null
          } else {
            // 期间查询串又前进：用最新串继续拉(丢弃这份落后响应)
            atPendingQuery = null
            requestAtList(q)
          }
        }
        break
      case 'slashResult':
        // 命令结果一律进对话区(不走 VSCode 通知)：失败红点+红字，成功正常色
        if (m.message) showNotice(m.message, m.command, m.ok === false ? 'error' : 'ok')
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
    busy,
    text,
    attachments,
    images,
    refs,
    focusTick,
    sel,
    openPopup,
    statsLine,
    slashCatalog,
    atCatalog,
    planState,
    goalState,
    systemPrompt,
    pendingQuestion,
    scrollPend,
    permNameOf,
    send,
    cancel,
    requestSlashList,
    requestAtList,
    runSlash,
    suggestion,
    regenerate,
    copy,
    pickFile,
    addImage,
    removeImage,
    addAttachment,
    removeAttachment,
    addRef,
    removeRef,
    readImageFile,
    togglePopup,
    openModelSearch,
    markSlashPick,
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
