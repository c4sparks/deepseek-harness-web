/**
 * 库对宿主 webview 通道的唯一抽象:
 *   post(msg)         = 发一条消息给宿主(等价 vscode.postMessage);
 *   onMessage(cb)     = 订阅宿主发来的消息(等价 window 'message' 监听)。
 * 库内任何模块都不得直接调 acquireVsCodeApi() 或自己加 window 'message' 监听;
 * 一切收发只经注入的 ChatHost —— 这样同一个库可被 VS Code / sidex 等不同宿主复用。
 *
 * makeWindowMessageHost() 是"页面环境"下的实现:由入口(bootstrap)把 acquireVsCodeApi 的
 * postMessage 注入进来,并在页面挂**唯一一个** window 'message' 监听,向多个接收者扇出。
 */
export interface ChatHost {
  post(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): () => void
}

/** 页面实现:单一 window 监听、多接收者扇出。postMsg 通常为 vscode.postMessage。 */
export function makeWindowMessageHost(postMsg: (m: unknown) => void): ChatHost {
  const handlers = new Set<(msg: unknown) => void>()
  let wired = false
  return {
    post: (m) => postMsg(m),
    onMessage(cb) {
      handlers.add(cb)
      if (!wired) {
        wired = true
        window.addEventListener('message', (e) => {
          const m = e.data as unknown
          for (const h of [...handlers]) {
            h(m)
          }
        })
      }
      return () => {
        handlers.delete(cb)
      }
    },
  }
}
