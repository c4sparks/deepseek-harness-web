// 消息行模型切片：不可变 messages 列表、正文流式与过程归约、通知行与审批行。
// 行 key 计数器在本切片内（per-store），不跨 store 实例共享——key 只用于同一列表内的替换匹配
// 与列表渲染 diff，各自从 1 计数即可。
import { computed, signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { ViewActivity, ImageAttachment, LiveContext } from '../protocol'
import { toolTitle, deriveToolSummary, formatMsgClock, turnStatusBadge } from '../format'
import type { ChatRow, ChatStore, DshTurnProcessItem, RefChip } from './types'

export interface MessagesSlice {
  store: Pick<ChatStore, 'messages' | 'view' | 'processing' | 'scrollPend' | 'showNotice' | 'answerApproval'>
  /** 过程事件落链（tool 调用与结果）。 */
  activity(a: ViewActivity | undefined): void
  /** 思考增量（同 step+index 续接为一段）。 */
  reasoning(text: string, step?: number, index?: number): void
  /** 上下文注入入链（instructions 形态跳过）。 */
  contextRow(c: LiveContext | undefined, time?: number): void
  /** 正文增量。 */
  chunk(delta: string): void
  /** 回合收尾：时间/全文/终态角标/用量/counts，并收敛仍 running 的工具。 */
  finish(
    stats?: Record<string, unknown>,
    time?: number,
    text?: string,
    end?: { kind?: string; message?: string },
    counts?: { toolCallCount?: number; messageCount?: number; subagentCount?: number }
  ): void
  /** 追加一条审批行。 */
  pushApproval(approvalId: string, description: string, toolName?: string): void
  /** 追加一条用户行（历史恢复时传入事件自带时刻）。 */
  addUser(text: string, imgs?: ImageAttachment[], time?: number, refs?: Array<{ kind: RefChip['kind']; label: string }>): void
  /** 插入一条系统提示词行（上游 `system-prompt`）：落在最近一条用户行之前，即该回合的开头。 */
  systemLine(text: string): void
  /** 开启（或复用）当前进行中的 assistant 行。 */
  beginAssistant(prompt?: string): void
  /** 取一个列表内唯一行 key。 */
  nextKey(): number
  /** 直接追加一行（历史恢复构行用）。 */
  push(row: ChatRow): void
  /** 请求滚到底（+1 由列表组件消费后清零）。 */
  bumpScroll(): void
  /** 清空消息与进行中标记；不动 scrollPend 与 key 计数器。 */
  resetRows(): void
}

/** 本地时刻串（实时上送用；历史恢复走事件自带时刻）。 */
const nowTime = (): string => formatMsgClock(Date.now())

export function createMessages(host: ChatHost): MessagesSlice {
  const messages = signal<ChatRow[]>([])
  const view = computed<'welcome' | 'chat'>(() => (messages.value.length === 0 ? 'welcome' : 'chat'))
  const processing = signal(false)
  const scrollPend = signal(0)
  let rowKey = 1

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

  const showNotice = (msgText: string, command?: string, tone: 'error' | 'ok' = 'error'): void => {
    push({ kind: 'notice', key: rowKey++, text: msgText, command, tone })
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
        time: '', // 回答行的真实时刻由 chatDone 携带的事件时间填充,此处不伪造
        done: false,
        prompt,
        text: '',
        stats: '',
        chain: [],
        counts: { toolCallCount: 0, messageCount: 0, subagentCount: 0 },
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
    // 实时本地上送用本地时刻;恢复历史时传入事件自带时间戳,不覆盖为"现在"
    push({ kind: 'user', key: rowKey++, text: textMsg, images: imgs, time: time !== undefined ? formatMsgClock(time) : nowTime(), refs })
  }
  /** 系统提示词行：上游把它锚在该回合可见消息序列的开头（用户提问之前），
   *  而该事件到达时用户行已在列表里 → 回插到最近一条用户行之前。 */
  function systemLine(text: string): void {
    if (!text) return
    const rows = messages.value
    let at = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === 'user') { at = i; break }
    }
    const row: ChatRow = { kind: 'sysprompt', key: rowKey++, text }
    messages.value = at === -1 ? [...rows, row] : [...rows.slice(0, at), row, ...rows.slice(at)]
  }
  function beginAssistant(prompt = ''): void {
    ensureAssistant(prompt)
  }
  /** 追加一条过程动作到当前 assistant 行链尾。 */
  const pushChain = (row: Extract<ChatRow, { kind: 'assistant' }>, item: DshTurnProcessItem): void => {
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
      const chain = row.chain.map((c): DshTurnProcessItem => {
        if (c.kind !== 'tool' || c.status !== 'running') return c
        if (matched) return c
        const hit = (a.callId && c.callId === a.callId) || (!a.callId && !c.callId && c.step === a.step)
        if (!hit) return c
        matched = true
        return {
          ...c,
          // 终态由宿主判好传下来（isError + code 特例，见 official/tool-status.ts）。
          // 宿主在 toolDone 帧必带 status；万一缺失就按「未失败」处理——
          // **绝不能**回退成「有 error 即失败」，那正是 ASK_CANCELLED 被标红的根因。
          status: (a.status ?? 'ok') as 'ok' | 'error' | 'stopped',
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
  /** 把一次上下文注入并入当前 assistant 的过程链（与思考/工具同一行链，折叠时仅在展开可见）。
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
      ? chain.map((c, i): DshTurnProcessItem => (i === chain.length - 1 && c.kind === 'reasoning' ? { ...c, text: c.text + rText } : c))
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
        counts: { toolCallCount: 0, messageCount: 0, subagentCount: 0 },
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
    counts?: { toolCallCount?: number; messageCount?: number; subagentCount?: number }
  ): void {
    const idx = activeAssistantIndex()
    if (idx === -1) return
    const row = messages.value[idx]
    if (row.kind !== 'assistant') return
    // time 取 chatDone 里该回答事件的自带时间戳(完成时刻),非本地伪造;
    // text 若带(chatDone 的 assistant/message 全文),以 API 整条消息为准覆盖流式拼接;
    // end = turn/end 非正常终止原因 → 本地化提示,正常完成则不显示
    const rowTime = time !== undefined ? formatMsgClock(time) : row.time
    const rowText = typeof text === 'string' && text !== '' ? text : row.text
    // 所有非正常终止(停止/中断/出错/超长/阻塞) → 右下角角标：直接回显官方 reason.kind 原值
    const statusBadge = turnStatusBadge(end?.kind) || undefined
    // error 时把服务端返回的原始错误消息附上（不翻译）
    const endMsg = end?.kind === 'error' && end?.message ? end.message : ''
    // 收敛仍 running 的工具：正常完成但缺 result → ok；被打断/出错 → stopped（模型通用兜底）
    const abnormal = !!end?.kind && end.kind !== 'completed'
    const chain = row.chain.map((c): DshTurnProcessItem =>
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
      status: statusBadge,
      stats: '', // 用量/用时已由图标+弹窗呈现，不再生成独立脚注文本
      usageRaw: stats ? { ...stats } : undefined,
      counts: {
        toolCallCount: counts?.toolCallCount ?? row.counts.toolCallCount,
        messageCount: counts?.messageCount ?? row.counts.messageCount,
        subagentCount: counts?.subagentCount ?? row.counts.subagentCount,
      },
      bodyStarted: true,
    })
    processing.value = false
  }

  // ---------- 审批 ----------
  function answerApproval(approvalId: string, allow: boolean, key: number): void {
    removeWhere((r) => r.kind === 'approval' && r.key === key)
    host.post({ type: 'approvalResponse', approvalId, allow })
  }
  function pushApproval(approvalId: string, description: string, toolName?: string): void {
    push({ kind: 'approval', key: rowKey++, approvalId, description, toolName })
  }

  const nextKey = (): number => rowKey++
  const bumpScroll = (): void => {
    scrollPend.value = scrollPend.value + 1
  }
  /** 清空消息与进行中标记。不清 scrollPend（触底语义独立）、不清 rowKey（保持单调，避免复用 key 让 diff 误判）。 */
  const resetRows = (): void => {
    messages.value = []
    processing.value = false
  }

  return {
    store: { messages, view, processing, scrollPend, showNotice, answerApproval },
    activity,
    reasoning,
    contextRow,
    chunk,
    finish,
    pushApproval,
    addUser,
    systemLine,
    beginAssistant,
    nextKey,
    push,
    bumpScroll,
    resetRows,
  }
}
