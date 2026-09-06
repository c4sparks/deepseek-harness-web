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
  models: Array<{ id: string; name: string; description?: string; reasoning?: { efforts?: Array<{ id: string; name: string }> } }>
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

export interface HistoryMessage {
  role: 'user' | 'assistant'
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
}

// ---------- 宿主 → 页面 ----------
export type HostToViewMessage =
  | { type: 'chatActivity'; activity?: { type?: 'step' | 'tool'; step?: number; tool?: string } }
  | { type: 'chatReasoning'; text?: string; step?: number }
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
    }
  | { type: 'filePicked'; path?: string }
  | {
      type: 'chatInfo'
      projections?: Record<string, unknown>
      models?: ChatModelInfo
      agentPresets?: { presets?: ChatAgentPreset[] }
      agentPreset?: string
      agentPresetLocked?: boolean
    }
  | { type: 'draft'; text?: string }
  | { type: 'chatHistory'; messages?: HistoryMessage[]; sessionId?: string }
  | { type: 'clear' }
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
