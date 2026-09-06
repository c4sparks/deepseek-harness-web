// ===== 标题栏 webview 侧装配入口 =====
// chat.ts 只 import 本文件、只调 initChatTitlebar(...) 一次；具体实现的细节收在各自模块。
// 目前唯一实现是「自绘标题栏」（原生标题栏在宿主渲染，webview 侧无 JS）。
//
// 删自绘标题栏(只留原生) 时：
//   1. 删除 titlebarSelfDrawn.ts 整个文件；
//   2. 本文件改为空（不再 import），或随 titlebarSelfDrawn 一起删，chat.ts 顶部 import 也删。
// 原生标题栏分支没有 webview 代码，因此本装配在删自绘后不再需要。
import { initSelfDrawnTitlebar } from './titlebarSelfDrawn'

/** 标题栏需要的宿主句柄：postMessage = 发消息；onMessage = 订阅宿主消息（注册到页面唯一通道）。 */
export interface ChatTitlebarApi {
  postMessage(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): () => void
}

/** 装配标题栏：按 <body data-titlebar-mode> 决定是否启用自绘标题栏 */
export function initChatTitlebar(api: ChatTitlebarApi): void {
  // 自绘标题栏模块内部自己会守卫 mode==='selfDrawn'，这里直接委托
  initSelfDrawnTitlebar(api)
}
