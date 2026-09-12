// 聊天页核心状态(信号 store)的装配层：只做切片创建与接线，不含行为逻辑。
// 行模型在 messages，输入区在 composer，目录在 catalogs，选择器在 selectors，提问弹窗在 question，
// 会话状态在 status，历史恢复在 history，发送动作在 outbox，宿主消息归约器在 reducer；
// 跨切片依赖全部由本层注入（切片之间不互相 import）。
// 组件只读 store 上的信号并渲染;要发宿主一律走 store 动作(内部 host.post)。
import type { ChatHost } from '../host'
import { MODE_NAMES } from '../format'
import { createMessages } from './messages'
import { createComposer } from './composer'
import { createCatalogs } from './catalogs'
import { createSelectors } from './selectors'
import { createQuestion } from './question'
import { createAttachments } from './attachments'
import { createStatus } from './status'
import { createHistory } from './history'
import { createOutbox } from './outbox'
import { createReducer } from './reducer'
import type { ChatStore } from './types'

// 行模型与 store 接口的对外导出保持不变(定义在 ./types)。
export type { ChatRow, ChatStore, DshTurnProcessItem, RefChip, SelectorState, TurnCounts } from './types'

export { MODE_NAMES }

export function createChatStore(host: ChatHost): ChatStore {
  // 1. 消息行模型：selectors 的通知行要用它的 showNotice，须最先创建
  const messages = createMessages(host)

  // 2. 其余叶切片（selectors 注入消息切片的 showNotice，不反向 import）
  const composer = createComposer(host)
  const catalogs = createCatalogs(host)
  const status = createStatus()
  const selectors = createSelectors(host, messages.store.showNotice)
  const question = createQuestion(host)
  const attachments = createAttachments(host)

  // 3. 发送动作（跨输入区 + 目录 + 消息域，依赖注入）
  const outbox = createOutbox({ host, composer, catalogs, messages })

  // 4. 全量清空：跨切片唯一入口。各切片只清自己的量，这里按固定顺序串联。
  const reset = (): void => {
    messages.resetRows()
    composer.reset()
    status.reset()
    selectors.reset()
    catalogs.reset()
    question.reset()
    attachments.reset()
  }

  // 5. 历史恢复与归约器（都需要 reset）
  const history = createHistory({ messages, resetAll: reset })
  const reducer = createReducer({ messages, composer, catalogs, selectors, question, status, attachments, outbox, history, reset })

  // 显式列举装配（不用展开）：字段漏装配被返回类型拦截，字段重复在编译期直接报错。
  return {
    // 消息域
    messages: messages.store.messages,
    view: messages.store.view,
    processing: messages.store.processing,
    scrollPend: messages.store.scrollPend,
    showNotice: messages.store.showNotice,
    answerApproval: messages.store.answerApproval,
    // 发送动作
    send: outbox.store.send,
    suggestion: outbox.store.suggestion,
    regenerate: outbox.store.regenerate,
    // 归约器
    onHostMessage: reducer.store.onHostMessage,
    // 输入区切片
    text: composer.store.text,
    attachments: composer.store.attachments,
    images: composer.store.images,
    refs: composer.store.refs,
    focusTick: composer.store.focusTick,
    runSlash: composer.store.runSlash,
    pickFile: composer.store.pickFile,
    copy: composer.store.copy,
    cancel: composer.store.cancel,
    addImage: composer.store.addImage,
    removeImage: composer.store.removeImage,
    addAttachment: composer.store.addAttachment,
    removeAttachment: composer.store.removeAttachment,
    addRef: composer.store.addRef,
    removeRef: composer.store.removeRef,
    readImageFile: composer.store.readImageFile,
    // 目录切片
    slashCatalog: catalogs.store.slashCatalog,
    atCatalog: catalogs.store.atCatalog,
    requestSlashList: catalogs.store.requestSlashList,
    requestAtList: catalogs.store.requestAtList,
    // 选择器切片
    sel: selectors.store.sel,
    permNameOf: selectors.store.permNameOf,
    openPopup: selectors.store.openPopup,
    togglePopup: selectors.store.togglePopup,
    openModelSearch: selectors.store.openModelSearch,
    markSlashPick: selectors.store.markSlashPick,
    closePopups: selectors.store.closePopups,
    selectPerm: selectors.store.selectPerm,
    selectModel: selectors.store.selectModel,
    selectMode: selectors.store.selectMode,
    // 提问切片
    pendingQuestion: question.store.pendingQuestion,
    submitQuestion: question.store.submitQuestion,
    cancelQuestion: question.store.cancelQuestion,
    // 会话状态切片
    busy: status.store.busy,
    sessionCwd: status.store.sessionCwd,
    statsLine: status.store.statsLine,
    planState: status.store.planState,
    // 附件大类
    attachmentCache: attachments.store.attachmentCache,
    requestAttachment: attachments.store.requestAttachment,
    goalState: status.store.goalState,
  }
}
