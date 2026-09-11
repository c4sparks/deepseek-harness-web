/**
 * 宿主 ↔ 聊天页 协议类型(单一来源)。
 * 约束:消息 type 名与 payload 形状与宿主侧(src/extension.ts、src/titlebar/selfDrawn)
 * 一字不差 —— 宿主不改,这里就是聊天页侧的权威契约;改协议必须同步两侧。
 * 标题栏(selfDrawn)专属消息也在本文件,归 titlebar driver 消费。
 */

// ---------- 共享形状 ----------
export interface ImageAttachment {
  mediaType: string
  data: string
  name: string
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionSpec {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

export interface ChatModelGroup {
  id: string
  name: string
  models: Array<{
    id: string
    name: string
    description?: string
    reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string }
  }>
}

export interface ChatModelInfo {
  current?: { provider?: string; model?: string; reasoningEffort?: string }
  groups?: ChatModelGroup[]
  /** 上游对加载失败 provider/组的提示（0.1.2-rc.1 形状未定型，原样透传，UI 只显示组数） */
  failures?: unknown[]
}

export interface PermissionOption {
  value: string
  name: string
  description?: string
}

export interface ChatAgentPreset {
  id: string
  name?: string
  description?: string
  isDefault?: boolean
  broken?: string
}

/** 「/」菜单：dsh 斜杠命令目录条目（commands/list 返回值）。 */
export interface SlashCommandInfo {
  name: string
  description: string
  /** 带参数命令的输入提示（如 permission 的 "<preset>"）。 */
  input?: { hint: string }
}
/** 「/」菜单：当前会话可用技能条目（skills/list 返回值）。 */
export interface SlashSkillInfo {
  name: string
  description: string
  /** 是否允许模型自行调用；false 时仅用户可调（用户斜杠发送仍可用）。 */
  modelInvocable: boolean
}

/** 「@」引用：文件/目录候选（fileReferences/list 返回；path 为相对工作区，无前导斜杠）。 */
export interface AtFileRef {
  path: string
  kind: 'file' | 'directory'
}
/** 「@」引用：会话候选（sessionReferenceResolver/candidates 返回；mention 即选中后应插入的正文 token）。 */
export interface AtSessionRef {
  sessionId: string
  label: string
  sameWorkspace?: boolean
  mention: string
}

/** 实时/历史 过程折叠计数（三个计数：toolCallCount=非 subagent 工具调用数；
 *  messageCount=最终答复前带文本的中间 assistant 消息数；subagentCount=subagent 委派数） */
export interface TurnCounts {
  toolCallCount?: number
  messageCount?: number
  subagentCount?: number
}

/** 历史会话里 assistant 回复的可视"过程动作"（实时另有 chatActivity/chatReasoning 增量拼装） */
export type DshHistoryTurnProcessItem =
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'context'
      content: unknown[]
      source: unknown
      provenance: { role: 'inject' | 'recall'; label: string | null }
      form: string | null
    }
  | { kind: 'tool'; name: string; title?: string; summary?: string; argsRaw?: string; callId?: string; status: 'ok' | 'error' | 'stopped'; error?: string; output?: string; exitCode?: number; signal?: string; meta?: unknown }

/** 单次工具/思考/步骤 活动（宿主 tool/call、tool/result、step/start 透传） */
export interface ViewActivity {
  type?: 'step' | 'tool' | 'toolDone'
  step?: number
  tool?: string
  name?: string
  callId?: string
  argsRaw?: string
  error?: string
  /** toolDone 的终态：宿主按 isError + code 特例判出（见 `src/dsh/official/tool-status.ts`）。
   *  直接采用，**不要**自己按 `error` 判——那样会把「被打断/被取消」误标成失败。 */
  status?: 'ok' | 'error' | 'stopped'
  output?: string
  /** tool/result 输出末尾 marker 解析出的退出码/终止信号（Terminal 卡 Pill 展示；剥掉 marker 后的干净输出在 output） */
  exitCode?: number
  signal?: string
  /** tool/result.data.meta 原文透传（web_fetch 的 statusCode、web_search 的 sources/answer 等卡数据源） */
  meta?: unknown
}

/** 历史会话里的一条上下文注入（source.kind !== 'user' 的 user/message：系统提示词/技能/召回…），对齐官方 ContextInjectionRow。 */
export interface HistoryContextItem {
  role: 'context'
  /** dsh 事件自带时间戳(epoch 秒或毫秒) */
  time?: number
  seq?: number
  /** 模型实际读到的 content blocks（原文透传） */
  content: unknown[]
  /** durable user/message source 原文 */
  source: unknown
  /** 投影角色与生产者名（recall=跨会话召回，其余=上下文注入） */
  provenance: { role: 'inject' | 'recall'; label: string | null }
  /** 生产者声明的展示形态；null = opaque */
  form: string | null
}

export type HistoryMessage =
  | {
      role: 'user'
      text: string
      time?: number
      /** 该回合实际发给模型的 system（上游 `system-prompt` 节点）；仅该回合第一条 user 行带 */
      systemPrompt?: string
    }
  | {
      role: 'assistant'
      text: string
      /** dsh 事件自带时间戳(epoch 秒或毫秒);缺省则页面不显示时间 */
      time?: number
      /** 该条 assistant 消息自带的 usage 与提供方/模型（用量/用时图标数据源，仅 assistant 有） */
      provider?: string
      model?: string
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
      /** 由快照事件时间算出的消息指标（与实时同口径），有则恢复行显示 ⏱ 用时 */
      wallSec?: number
      ttftSec?: number
      tps?: number
      /** 停止状态展示文案（已停止 · Stopped），仅被停止的回合最后一条 assistant 有 */
      status?: string
      /** assistant 回合的过程链（思考/工具），恢复后同样可折叠展开 */
      chain?: DshHistoryTurnProcessItem[]
      counts?: TurnCounts
    }
  | HistoryContextItem

/** 上下文注入数据（实时 chatContext 与历史 HistoryContextItem 共用形状）。 */
export interface LiveContext {
  role?: undefined
  seq?: number
  time?: number
  content: unknown[]
  source: unknown
  provenance: { role: 'inject' | 'recall'; label: string | null }
  form: string | null
}

// ---------- 宿主 → 页面 ----------
export type HostToViewMessage =
  | { type: 'chatActivity'; activity?: ViewActivity }
  | { type: 'chatReasoning'; text?: string; step?: number; index?: number }
  | { type: 'chatContext'; context?: LiveContext }
  | { type: 'chatApproval'; approvalId?: string; description?: string; toolName?: string }
  | {
      type: 'chatQuestion'
      rpcId?: string
      sessionId?: string
      questions?: QuestionSpec[]
    }
  | { type: 'questionClosed'; rpcId?: string }
  | { type: 'chatChunk'; text?: string }
  | {
      type: 'chatDone'
      text?: string
      stats?: Record<string, unknown>
      time?: number
      /** turn/end 非正常终止原因（error/aborted/interrupted/max-tokens/blocked…），正常完成则无 */
      end?: { kind?: string; message?: string }
      /** 过程折叠计数（官方口径） */
      counts?: TurnCounts
    }
  | { type: 'filePicked'; path?: string }
  | {
      type: 'chatInfo'
      projections?: Record<string, unknown>
      /** 当前会话工作区根路径：终端卡 cwd 标签在工具调用未带 workdir 时兜底（官方同口径） */
      cwd?: string
      models?: ChatModelInfo
      agentPresets?: { presets?: ChatAgentPreset[] }
      agentPreset?: string
      agentPresetLocked?: boolean
    }
  | { type: 'draft'; text?: string }
  | { type: 'chatHistory'; messages?: HistoryMessage[]; sessionId?: string }
  | {
      type: 'chatSystemLine'
      /** 一个模型请求实际发给模型的 system（上游 `system-prompt` 节点）：在所属回合开头渲染一条可折叠行 */
      text: string
    }
  | { type: 'clear' }
  | { type: 'busy'; kind?: 'loading' | 'switching' | null }
  // 自绘标题栏专属(selfDrawn 模式才出现;原生模式宿主不发)
  | { type: 'panelState'; panelOpen?: boolean; viewMode?: 'internal' | 'browser' }
  | { type: 'selfInfo'; workspaceName?: string; panelOpen?: boolean; viewMode?: 'internal' | 'browser' }
  | {
      type: 'wsDropdownList'
      currentId?: string
      workspaces?: Array<{ workspaceId: string; name: string; current?: boolean }>
    }
  | {
      type: 'wsDropdownSessions'
      workspaceId?: string
      sessions?: Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current?: boolean }>
    }
  | { type: 'wsActionDone'; ok?: boolean; message?: string }
  // 「/」菜单：目录(命令+技能)与命令执行结果
  | { type: 'slashCatalog'; commands: SlashCommandInfo[]; skills: SlashSkillInfo[] }
  | { type: 'slashResult'; ok?: boolean; command?: string; message?: string }
  // 「@」引用：候选(文件/目录 + 会话)，query=候选对应查询串
  | { type: 'atCatalog'; query: string; files: AtFileRef[]; sessions: AtSessionRef[] }

// ---------- 页面 → 宿主 ----------
export type ViewToHostMessage =
  | { type: 'ready' }
  | { type: 'chatSend'; text: string; images?: ImageAttachment[] }
  | { type: 'cancel' }
  | { type: 'copy'; text: string }
  | { type: 'approvalResponse'; approvalId: string; allow: boolean }
  | { type: 'questionResponse'; rpcId?: string; sessionId?: string; answers: Array<{ id: string; selected: string[]; custom?: string }> }
  | { type: 'questionCancel'; rpcId?: string; sessionId?: string }
  | { type: 'chatSelectPermission'; preset: string }
  | { type: 'chatSelectModel'; provider: string; model: string; reasoningEffort?: string }
  | { type: 'chatSelectMode'; agentPreset: string }
  | { type: 'pickFile' }
  // 自绘标题栏专属
  | { type: 'titleAction'; cmd: string }
  | {
      type: 'wsDropdown'
      op: 'list' | 'sessions' | 'wsnew' | 'session' | 'new'
      workspaceId?: string
      sessionId?: string
      blank?: boolean
    }
  | { type: 'selfInfoReq' }
  // 「/」菜单：请求目录(命令+技能)、执行一条 dsh 斜杠命令
  | { type: 'slashListReq' }
  | { type: 'slashRun'; text: string }
  // 「@」引用：按查询串请求文件/会话候选
  | { type: 'atListReq'; query: string }
