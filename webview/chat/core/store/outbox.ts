// 发送切片（用户发起的发送动作）：发送、建议、重新生成，以及目录到达后对被挂起「/」行的裁决。
// 这组动作只读写既有切片的信号，不自持状态；依赖由装配层注入。
import type { ChatHost } from '../host'
import { fileLabels } from '../file-labels'
import type { ImageAttachment } from '../protocol'
import type { ChatStore } from './types'
import type { ComposerSlice } from './composer'
import type { CatalogsSlice } from './catalogs'
import type { MessagesSlice } from './messages'

export interface OutboxDeps {
  host: ChatHost
  composer: ComposerSlice
  catalogs: CatalogsSlice
  messages: MessagesSlice
}

export interface OutboxSlice {
  store: Pick<ChatStore, 'send' | 'suggestion' | 'regenerate'>
  /** 目录到达后裁决被挂起的「/」行（由归约器在 slashCatalog 分支调用）。 */
  resolvePendingSlash(): void
}

export function createOutbox(deps: OutboxDeps): OutboxSlice {
  const { host, composer, catalogs, messages } = deps
  const { text, attachments, images, refs, runSlash } = composer.store
  const { slashCatalog, requestSlashList } = catalogs.store
  const { processing } = messages.store

  function send(): void {
    const msg = text.value.trim()
    const attach = attachments.value
    const imgs = images.value
    if ((!msg && attach.length === 0 && imgs.length === 0 && refs.value.length === 0) || processing.value) return
    // 「/」命令路由：纯文本单行、行首 `/` 且首词命中宿主命令目录 → 执行斜杠命令而非发消息。
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
        // 目录尚未拉到(换会话后首条即发 /xxx)：先挂起、取目录，待目录到达再裁决，
        // 避免把 /compact 之类当普通文本发给 agent
        catalogs.holdPendingSlash(msg)
        requestSlashList()
        return
      }
      // cat 已到但首词未命中(技能/未知斜杠 token)：落回普通发送(技能走 chatSend、未知 token 走消息，与官方一致)
    }
    // 文件走「文件上送」：必须全部就绪才允许发送（canSend 也挡，这里是兜底）
    const notReady = attach.find((a) => a.state !== 'ready')
    if (notReady !== undefined) {
      messages.store.showNotice(fileLabels().stillUploading)
      return
    }
    const files = attach.map((a) => ({ receiptId: a.receiptId as string, name: a.name, path: a.path }))
    const refTokens = refs.value.map((r) => r.token)
    const prompt = [...refTokens, msg].filter(Boolean).join('\n\n') // 发给宿主：含引用 token
    const display = msg
    const refSnap = refs.value.map((r) => ({ kind: r.kind, label: r.label }))
    // 用户主动发送：即使滚动条在上面也强制滚到底看新内容（流式中自己翻上去则不受影响）
    messages.bumpScroll()
    messages.addUser(display, imgs, undefined, refSnap.length ? refSnap : undefined, undefined, files.length > 0 ? files : undefined)
    attachments.value = []
    images.value = []
    refs.value = []
    text.value = ''
    processing.value = true
    messages.beginAssistant(prompt) // 立即出现"思考中…"行(与 setProcessing(true) 行为一致)
    host.post({ type: 'chatSend', text: prompt, images: imgs, ...(files.length > 0 ? { files } : {}) })
  }

  /** 目录到达后裁决被挂起的「/」行：命中命令→执行；未命中→按普通消息发出(仅当用户没改写输入)。 */
  function resolvePendingSlash(): void {
    const line = catalogs.takePendingSlash()
    if (!line) return
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
      messages.addUser(line)
      processing.value = true
      messages.beginAssistant(line)
      host.post({ type: 'chatSend', text: line })
    }
  }

  function suggestion(p: string): void {
    if (!p || processing.value) return
    messages.bumpScroll()
    messages.addUser(p)
    processing.value = true
    messages.beginAssistant(p)
    host.post({ type: 'chatSend', text: p })
  }

  function regenerate(p: string, imgs?: ImageAttachment[]): void {
    if (!p || processing.value) return
    processing.value = true
    messages.bumpScroll()
    messages.beginAssistant(p)
    // user 行带图时重生成保留原图（assistant 行重生成传 text-only，images 为空数组）
    host.post({ type: 'chatSend', text: p, images: imgs ?? [] })
  }

  return { store: { send, suggestion, regenerate }, resolvePendingSlash }
}
