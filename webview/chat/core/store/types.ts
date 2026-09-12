// 聊天页行模型与 store 接口（仅类型，零运行时代码）。
// 独立成文件是为了让各切片能 Pick<ChatStore, K> 而不与 store/chat.ts 形成环；
// 依赖方向固定为 chat.ts 与各切片 → types.ts。
import type { Signal } from '@preact/signals'
import type {
  HostToViewMessage,
  ImageAttachment,
  PermissionOption,
  QuestionSpec,
  ChatModelInfo,
  SlashCommandInfo,
  SlashSkillInfo,
  AtFileRef,
  AtSessionRef,
} from '../protocol'

// ---------- 消息行模型(不可变替换,组件用 stable key) ----------

/** 一条 assistant 回合的过程动作（官方"回合过程"里的成员；reasoning 或 tool 各一条，按发生顺序）。 */
export type DshTurnProcessItem =
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
      /** 结果原始内容块（**仅当结果含图片块时**带；图片块只含附件引用，字节由附件层按需另取） */
      blocks?: unknown
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

/** 过程折叠计数（三个计数：toolCallCount=非 subagent 工具调用数；
 *  messageCount=最终答复前带文本的中间 assistant 消息数；subagentCount=subagent 委派数） */
export interface TurnCounts {
  toolCallCount: number
  messageCount: number
  subagentCount: number
}

export type ChatRow =
  | { kind: 'user'; key: number; text: string; images: ImageAttachment[]; time: string; refs?: Array<{ kind: RefChip['kind']; label: string }> }
  /** 系统提示词行（上游 `system-prompt` 节点）：该回合实际发给模型的 system，可折叠；位置在该回合用户提问之前 */
  | { kind: 'sysprompt'; key: number; text: string }
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
      chain: DshTurnProcessItem[]
      /** 过程折叠计数（官方口径）；定稿前为 0，chatDone 附 counts 后回填 */
      counts: TurnCounts
      /** 正文首 chunk 是否已到达（正文开始 = 过程定稿，链可收起） */
      bodyStarted: boolean
    }
  | { kind: 'approval'; key: number; approvalId: string; description: string; toolName?: string }
  | { kind: 'question'; key: number; rpcId: string; sessionId?: string; questions: QuestionSpec[]; disabled: boolean }
  | { kind: 'notice'; key: number; text: string; command?: string; tone?: 'error' | 'ok' }

/** 附件字节缓存条目（附件大类）：loading 取件中 / ready 就绪 / error 失败（可重试）。 */
export interface AttachmentEntry {
  state: 'loading' | 'ready' | 'error'
  /** 就绪时的媒体类型（如 image/png） */
  mediaType?: string
  /** 就绪时的**裸 base64**（无 data: 前缀，渲染时自行拼） */
  data?: string
  /** 失败原因（原样展示） */
  error?: string
}

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
  /** 当前会话工作区根路径；'' = 未知。终端卡的 cwd 标签在工具调用未带 workdir 时用它兜底（官方同口径） */
  sessionCwd: Signal<string>
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
  /** 官方 waterfall 提问弹窗（输入框上方）：pending 时让用户选择/提交/取消/关闭；null=无 */
  pendingQuestion: Signal<{ rpcId?: string; sessionId?: string; questions: QuestionSpec[] } | null>
  /** 主动触底请求计数：用户发送/重新生成/恢复会话时 +1（MessageList 消费后清零并强制滚到底） */
  scrollPend: Signal<number>
  /** 附件字节缓存（附件大类，按 attachmentId；子类卡渲染时读） */
  attachmentCache: Signal<Record<string, AttachmentEntry>>
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
  /** 按 attachmentId 懒取附件字节（已就绪/在飞时不重复发；失败可重试） */
  requestAttachment(attachmentId: string): void
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
