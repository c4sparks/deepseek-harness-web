// 宿主消息归约器：postMessage 单通道的唯一分发点。
// 只做「消息类型 → 切片方法」的路由与少量极短的载荷兜底；形状解析一律下沉到对应切片
// （投影解析在 status，输入区拼装在 composer）。
import type { HostToViewMessage, PermissionOption } from '../protocol'
import type { ChatStore } from './types'
import type { MessagesSlice } from './messages'
import type { ComposerSlice } from './composer'
import type { CatalogsSlice } from './catalogs'
import type { SelectorsSlice } from './selectors'
import type { QuestionSlice } from './question'
import type { StatusSlice } from './status'
import type { OutboxSlice } from './outbox'
import type { HistorySlice } from './history'

export interface ReducerDeps {
  messages: MessagesSlice
  composer: ComposerSlice
  catalogs: CatalogsSlice
  selectors: SelectorsSlice
  question: QuestionSlice
  status: StatusSlice
  outbox: OutboxSlice
  history: HistorySlice
  /** 清空全部切片（clear 帧）。 */
  reset(): void
}

export interface ReducerSlice {
  store: Pick<ChatStore, 'onHostMessage'>
}

export function createReducer(deps: ReducerDeps): ReducerSlice {
  const { messages, composer, catalogs, selectors, question, status, outbox, history, reset } = deps

  function onHostMessage(m: HostToViewMessage): void {
    switch (m.type) {
      case 'chatActivity':
        messages.activity(m.activity)
        break
      case 'chatReasoning':
        messages.reasoning(m.text ?? '', m.step, m.index)
        break
      case 'chatContext':
        messages.contextRow(m.context, m.context?.time)
        break
      case 'chatApproval':
        messages.pushApproval(m.approvalId ?? '', m.description ?? '需要授权操作', m.toolName)
        break
      case 'chatQuestion':
        // 官方 waterfall 提问弹窗（输入框上方）：pending 时置弹窗数据，用户选择/提交/取消/关闭。
        question.openQuestionDialog(m.rpcId, m.sessionId, m.questions ?? [])
        break
      case 'questionClosed':
        question.closeQuestion(m.rpcId)
        break
      case 'chatChunk':
        messages.chunk(m.text ?? '')
        break
      case 'chatDone':
        messages.finish(m.stats, m.time, m.text, m.end, m.counts)
        break
      case 'filePicked':
        if (m.path) composer.store.addAttachment(m.path)
        break
      case 'chatInfo': {
        status.store.sessionCwd.value = m.cwd ?? ''
        const proj = m.projections
        if (proj) {
          // 权限是选择器的域，cast 极短，留在归约器；统计行/plan/goal 的形状解析下沉到 status
          const perms = proj['permissions'] as { options?: PermissionOption[]; currentValue?: string } | undefined
          selectors.setPermOptions(perms?.options, perms?.currentValue)
          status.applyProjections(proj)
        }
        selectors.setModels(m.models)
        selectors.setModes(m.agentPresets, m.agentPreset, m.agentPresetLocked)
        // 会话建立/切换后预取「/」目录：把「目录未到即发 /xxx」的窗口压到最小（换会话 reset 已把目录清空）
        if (catalogs.needsSlashList()) {
          catalogs.store.requestSlashList()
        }
        break
      }
      case 'draft':
        composer.appendDraft(m.text)
        break
      case 'chatHistory':
        history.renderHistory(m.messages ?? [], m.sessionId)
        break
      case 'chatSystemPrompt':
        status.store.systemPrompt.value = m.systemPrompt ?? null
        break
      case 'clear':
        reset()
        break
      case 'busy':
        status.store.busy.value = m.kind ?? null
        break
      case 'slashCatalog':
        catalogs.receiveSlashCatalog(m.commands, m.skills)
        // 目录到达后：裁决目录未到时挂起的「/」行(命令→执行，其余→普通消息)
        outbox.resolvePendingSlash()
        break
      case 'atCatalog':
        catalogs.receiveAtCatalog(m.query, m.files, m.sessions)
        break
      case 'slashResult':
        // 命令结果一律进对话区(不走 VSCode 通知)：失败红点+红字，成功正常色
        if (m.message) messages.store.showNotice(m.message, m.command, m.ok === false ? 'error' : 'ok')
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

  return { store: { onHostMessage } }
}
