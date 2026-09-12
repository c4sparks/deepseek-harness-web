// 历史恢复切片：把宿主快照重放出的消息列表重建为对话行。
// 恢复前先全量清空（跨全部切片），故 resetAll 由装配层注入而非本切片自行 import。
import type { HistoryMessage } from '../protocol'
import { toolTitle, deriveToolSummary, formatMsgClock } from '../format'
import type { DshTurnProcessItem } from './types'
import type { MessagesSlice } from './messages'

export interface HistoryDeps {
  messages: MessagesSlice
  /** 全量清空（含各切片），历史恢复开始时调用。 */
  resetAll(): void
}

export interface HistorySlice {
  renderHistory(list: HistoryMessage[], sessionId: string | undefined): void
}

export function createHistory(deps: HistoryDeps): HistorySlice {
  const { messages, resetAll } = deps

  function renderHistory(list: HistoryMessage[], sessionId: string | undefined): void {
    resetAll()
    void sessionId
    let lastUser = ''
    for (const item of list) {
      if (item.role === 'user') {
        lastUser = item.text
        // 系统提示词行（上游 system-prompt）：宿主挂在该回合第一条 user 行上。
        // 此刻当前 user 行还没 push → 直接 push 就落在它之前。
        // （不能用 systemLine：那是给实时回插用的，会找到「上一条」user 行，第二回合起就错位了）
        if (item.systemPrompt) messages.push({ kind: 'sysprompt', key: messages.nextKey(), text: item.systemPrompt })
        messages.addUser(item.text, [], item.time) // 恢复历史:显示快照里该消息的原时刻
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
        messages.push({
          kind: 'assistant',
          key: messages.nextKey(),
          time: item.time !== undefined ? formatMsgClock(item.time) : '',
          done: true,
          prompt: lastUser,
          text: item.text,
          stats: '',
          usageRaw: hasUsage ? u : undefined,
          status: item.status,
          // 历史链：宿主快照重放出 reasoning/context/tool，恢复后可折叠展开
          chain: (item.chain ?? []).map(
            (h): DshTurnProcessItem =>
              h.kind === 'reasoning'
                ? { kind: 'reasoning', key: messages.nextKey(), text: h.text }
                : h.kind === 'context'
                  ? {
                      kind: 'context',
                      key: messages.nextKey(),
                      content: h.content,
                      source: h.source,
                      provenance: h.provenance,
                      form: h.form,
                    }
                  : {
                      kind: 'tool',
                      key: messages.nextKey(),
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
                      blocks: h.blocks,
                    }
          ),
          counts: {
            toolCallCount: item.counts?.toolCallCount ?? 0,
            messageCount: item.counts?.messageCount ?? 0,
            subagentCount: item.counts?.subagentCount ?? 0,
          },
          bodyStarted: true,
        })
      }
    }
    messages.store.processing.value = false
    // 恢复会话后落到最新（若历史非空）
    if (messages.store.messages.value.length > 0) {
      messages.bumpScroll()
    }
  }

  return { renderHistory }
}
