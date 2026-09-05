// 供 webview/chat 类型检查用：acquireVsCodeApi() 是 VS Code 在 webview 页面运行时
// 注入的全局函数（@types/vscode 只描述扩展宿主侧 API，不含它），TS 默认不认识 → 报红。
// 这里补最小声明即可让 chat.ts:10 的 `const vscode = acquireVsCodeApi()` 有类型。
//
// 注意：每个 webview 只能调用一次 acquireVsCodeApi()（chat.ts 已调）；
// 标题栏等其它 webview 模块不要自取，复用 chat.ts 注入的句柄（见 titlebar.ts 的 ChatTitlebarApi）。
interface VSCodeWebviewApi<S = unknown> {
  /** 向扩展宿主发消息（扩展侧 webview.onDidReceiveMessage 接收） */
  postMessage(message: unknown): void
  /** 读取本 webview 的持久化状态 */
  getState(): S | undefined
  /** 写入本 webview 的持久化状态 */
  setState(state: S): void
}

declare function acquireVsCodeApi<S = unknown>(): VSCodeWebviewApi<S>
