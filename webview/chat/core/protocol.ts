/**
 * 宿主 ↔ 聊天页 协议类型(单一来源)。
 * 约束:消息 type 名与 payload 形状与宿主侧(src/extension.ts、src/titlebar/selfDrawn)
 * 一字不差 —— 宿主不改,这里就是聊天页侧的权威契约;改协议必须同步两侧。
 * 标题栏(selfDrawn)专属消息也在本文件,归 titlebar driver 消费。
 */

// ---------- 共享形状 ----------
/** 任务清单条目（宿主侧折叠 `todo/write` 后下发的形状；两侧同一定义，页面侧叫 TodoItem）。 */
import type { DshTodoItem as TodoItem } from '../../../src/dsh/rows/types'
export type { TodoItem }

export interface ImageAttachment {
  mediaType: string
  data: string
  name: string
}

/** 附件引用（图片）：事件里只有引用、没有字节，字节由附件层按需取（见 store/attachments）。 */
export interface AttachmentRef {
  attachmentId: string
  mediaType: string
  name?: string
  /** 固有像素宽（图廊按它定尺寸） */
  width?: number
  /** 固有像素高 */
  height?: number
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
  /** 上游对加载失败 provider/组的提示（上游形状未定型，原样透传，UI 只显示组数） */
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

// ---------- 宿主 → 页面 ----------
/** 消息反馈的评价取值（与上游 wire 字面量一致，不做本地映射）。 */
export type FeedbackRating = 'positive' | 'negative'

export type HostToViewMessage =
  | { type: 'chatApproval'; approvalId?: string; description?: string; toolName?: string }
  | {
      type: 'chatQuestion'
      rpcId?: string
      sessionId?: string
      questions?: QuestionSpec[]
    }
  | { type: 'questionClosed'; rpcId?: string }
  // 提交失败（宿主侧本地失败：没有工作区 / 服务不可用 / RPC 报错）——**不是渲染指令**：
  // 它属于与审批、提问同一类的「交互事实」。为什么必须单开一条：这类失败发生在服务端**没有回合**的情况下，
  // 事件流里既不会有 turn/end、也没有对应的行，错误无处承载（行模型的 endMsg 只来自 turn/end）。
  // rpcId = 该次提交的标识，页面据此把对应那条本地乐观行标为「未提交成功」。
  | { type: 'chatError'; message?: string; rpcId?: string }
  // 任务清单（输入框上方的常驻条）：整表替换，`null`/缺省 = 没有清单（该区整块不渲染）。
  // 与「行」同源、但不是行：清单不属于任何一个回合，位置也不在对话流里。
  | { type: 'todos'; todos?: TodoItem[] | null }
  | { type: 'filePicked'; path?: string }
  | { type: 'fileUploaded'; key: string; receiptId?: string; name?: string; bytes?: number; error?: string }
  // 附件字节（附件大类）：结果帧只带附件引用，渲染层要显示时按 id 向宿主懒取
  | { type: 'attachmentBytes'; attachmentId: string; mediaType?: string; data?: string; error?: string }
  | {
      type: 'chatInfo'
      projections?: Record<string, unknown>
      /** 当前会话工作区根路径：终端卡 cwd 标签在工具调用未带 workdir 时兜底（上游同口径） */
      cwd?: string
      models?: ChatModelInfo
      agentPresets?: { presets?: ChatAgentPreset[] }
      agentPreset?: string
      agentPresetLocked?: boolean
    }
  // 上游显示偏好（全局，与会话无关）：单独一条轻消息，实时跟随只推它，不重拉 chatInfo 那串 RPC
  | { type: 'chatPrefs'; transcriptView?: 'normal' | 'compact' }
  // 宿主下发的「行」（阶段 4 切渲染源后页面据此渲染；开关关闭时不下发，见 docs/design/08 §11）。
  // 形状为宿主侧的行模型（`src/dsh/rows/types.ts`），页面消费时做一次映射。
  | {
      type: 'rows'
      rows?: unknown[]
      /** 该批行属于哪个会话（页面据此丢弃上一个会话的本地乐观行） */
      sessionId?: string
      /** 本会话是否有一轮**正在跑**（显式事实：页面据此决定「停止」按钮可用，不从行推导） */
      turnActive?: boolean
    }
  // 消息反馈的状态回帧（列表 / 写入结果 / 业务失败）。**不是渲染指令**：它只喂反馈切片。
  | {
      type: 'feedbackState'
      sessionId?: string
      items?: Array<{ messageId: string; rating: 'positive' | 'negative'; version: string }>
      /** 分类 id 全表（首次下发时带一次；页面按 `category.<id>` 取中文标签，认不出就回显 id） */
      categories?: string[]
      /** 业务失败码原样带（version-conflict / note-too-large / …），页面按码选文案 */
      errorCode?: string
      /** 成功写入了一条评价（成功后弹一次「感谢你的反馈」） */
      recorded?: boolean
    }
  | { type: 'draft'; text?: string }
  | { type: 'clear' }
  | { type: 'busy'; kind?: 'loading' | 'switching' | null }
  // 自绘标题栏专属(selfDrawn 模式才出现;原生模式宿主不发)
  | { type: 'panelState'; panelOpen?: boolean; viewMode?: 'internal' | 'browser' }
  | { type: 'selfInfo'; workspaceName?: string; panelOpen?: boolean; viewMode?: 'internal' | 'browser' }
  | {
      type: 'wsDropdownList'
      currentId?: string
      /** `newable: false` = 这一行不能"在此新开会话"（「未分组」没有工作区实体） */
      workspaces?: Array<{ workspaceId: string; name: string; current?: boolean; newable?: boolean }>
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
  // rpcId：本面板 mint 的提交标识，宿主拿它当 session/prompt 的 requestId；
  // 服务端回显 user/message 时带回同一值，页面据此认领本地已出的一行（避免重复出行）
  | { type: 'chatSend'; text: string; images?: ImageAttachment[]; files?: Array<{ receiptId: string; name: string; path?: string }>; rpcId?: string }
  | { type: 'cancel' }
  // 从某条回答分叉出新会话（上游 `session/fork`）：atSeq 是该回答的事件序号，
  // 省略 = 从最后一条已完成回合分叉。宿主负责建子会话、升号并切过去。
  | { type: 'chatFork'; atSeq?: number }
  | { type: 'copy'; text: string }
  | { type: 'approvalResponse'; approvalId: string; allow: boolean }
  // 消息反馈（👍/👎）：list = 读全表（首次交互时懒加载）；rate = 写入/替换；retract = 撤回。
  // ifVersion 是**观察到的现值版本**（null = 首次评价），服务端据此做 CAS。
  | {
      type: 'feedback'
      op: 'list' | 'rate' | 'retract'
      messageId?: string
      rating?: 'positive' | 'negative'
      note?: string
      category?: string
      ifVersion?: string | null
    }
  | { type: 'questionResponse'; rpcId?: string; sessionId?: string; answers: Array<{ id: string; selected: string[]; custom?: string }> }
  | { type: 'questionCancel'; rpcId?: string; sessionId?: string }
  | { type: 'chatSelectPermission'; preset: string }
  | { type: 'chatSelectModel'; provider: string; model: string; reasoningEffort?: string }
  | { type: 'chatSelectMode'; agentPreset: string }
  | { type: 'pickFile' }
  | { type: 'attachmentReq'; attachmentId: string }
  // 在编辑器区打开一个文件（相对路径由宿主按 cwd 解析）；line 为 1 起的行号
  | { type: 'openFile'; path: string; line?: number; cwd?: string }
  // 文件上送：webview 只给路径，字节由宿主读并上传；key 由 webview 生成（多文件并发对得上）
  | { type: 'fileUploadReq'; key: string; path: string }
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
