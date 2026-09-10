// 目录切片：「/」命令与技能目录、「@」文件与会话候选的拉取与到达。
// 三个飞行/挂起私有用方法封装，不向聚合层暴露裸变量。
// 注意：目录到达后对挂起「/」行的裁决（resolvePendingSlash）跨 composer 与消息域，留在聚合层。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { SlashCommandInfo, SlashSkillInfo, AtFileRef, AtSessionRef } from '../protocol'
import type { ChatStore } from './types'

export interface CatalogsSlice {
  store: Pick<ChatStore, 'slashCatalog' | 'atCatalog' | 'requestSlashList' | 'requestAtList'>
  /** slashCatalog 帧到达：落库并解除飞行标记（裁决由聚合层随后调用）。 */
  receiveSlashCatalog(commands: SlashCommandInfo[] | undefined, skills: SlashSkillInfo[] | undefined): void
  /** atCatalog 帧到达：落库；期间查询串前进则丢弃本份并用最新串补发。 */
  receiveAtCatalog(query: string, files: AtFileRef[] | undefined, sessions: AtSessionRef[] | undefined): void
  /** 会话建立/切换后是否需要预取「/」目录。 */
  needsSlashList(): boolean
  /** 目录未到时用户已回车：先挂起该「/」行。 */
  holdPendingSlash(line: string): void
  /** 取出并清空挂起的「/」行。 */
  takePendingSlash(): string | null
  reset(): void
}

export function createCatalogs(host: ChatHost): CatalogsSlice {
  const slashCatalog = signal<{ commands: SlashCommandInfo[]; skills: SlashSkillInfo[] } | null>(null)
  const atCatalog = signal<{ query: string; files: AtFileRef[]; sessions: AtSessionRef[] } | null>(null)
  let slashListInflight = false
  // 「@」候选拉取：单飞行 + 最新查询 wins（输入中不断打 @ 只保留最后查询）
  let atInflight = false
  let atPendingQuery: string | null = null
  /** 目录未到时用户已按 Enter 的「/」行：先存下，待 slashCatalog 到达再裁决(命令→执行/其余→普通消息) */
  let pendingSlash: string | null = null

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

  function receiveSlashCatalog(commands: SlashCommandInfo[] | undefined, skills: SlashSkillInfo[] | undefined): void {
    slashCatalog.value = { commands: commands ?? [], skills: skills ?? [] }
    slashListInflight = false
  }

  function receiveAtCatalog(query: string, files: AtFileRef[] | undefined, sessions: AtSessionRef[] | undefined): void {
    atInflight = false
    if (atPendingQuery !== null) {
      const q = atPendingQuery
      if (q === query) {
        // 响应匹配最新查询：落库
        atCatalog.value = { query, files: files ?? [], sessions: sessions ?? [] }
        atPendingQuery = null
      } else {
        // 期间查询串又前进：用最新串继续拉(丢弃这份落后响应)
        atPendingQuery = null
        requestAtList(q)
      }
    }
  }

  function needsSlashList(): boolean {
    // 换会话 reset 已把目录清空；此处把「目录未到即发 /xxx」的窗口压到最小
    return !slashListInflight && (!slashCatalog.value || (slashCatalog.value.commands.length === 0 && slashCatalog.value.skills.length === 0))
  }

  function holdPendingSlash(line: string): void {
    pendingSlash = line
  }
  function takePendingSlash(): string | null {
    const line = pendingSlash
    pendingSlash = null
    return line
  }

  function reset(): void {
    // 新会话后 slash 目录需重新拉取(会话内命令/技能可能不同)
    slashCatalog.value = null
    atCatalog.value = null
    slashListInflight = false
    atInflight = false
    atPendingQuery = null
    pendingSlash = null
  }

  return {
    store: { slashCatalog, atCatalog, requestSlashList, requestAtList },
    receiveSlashCatalog,
    receiveAtCatalog,
    needsSlashList,
    holdPendingSlash,
    takePendingSlash,
    reset,
  }
}
