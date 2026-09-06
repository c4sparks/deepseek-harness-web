// dsh 聊天 webview 入口(bootstrap)。
//   - 唯一一处 acquireVsCodeApi() → 构建 ChatHost(单 window 消息监听、多接收者扇出);
//   - 创建 chat store;宿主消息按类型路由:聊天消息归 store,自绘标题栏消息归 titlebar(同一通道);
//   - preact 渲染 <ChatApp> 到 #app;
//   - 渲染完成后再 init 自绘标题栏(读取 #titlebar DOM)、post ready(host 随后才推 chatInfo)。
// 依赖方向:页面 → components/* + core/store + core/host + titlebar(仅注入句柄)。
import { render } from 'preact'
import { html } from 'htm/preact'
import './styles/chat.css' // esbuild 打进 dist/chat/chat.css(index.html 已 <link> 引用)
import { makeWindowMessageHost } from './core/host'
import type { HostToViewMessage } from './core/protocol'
import { createChatStore } from './core/store/chat'
import { ChatApp } from './components/app'
import { initChatTitlebar } from './titlebar'

const vscode = acquireVsCodeApi()
// 页面唯一宿主通道:单 window 监听扇出;页面收发只经 host(自绘标题栏也注册到同一通道)。
const host = makeWindowMessageHost(vscode.postMessage.bind(vscode))

const store = createChatStore(host)

// 宿主 → store(聊天消息;标题栏消息归 titlebar,store 内部忽略)
host.onMessage((msg) => store.onHostMessage(msg as HostToViewMessage))

// 渲染 UI
const app = document.getElementById('app')
if (app) {
  render(html`<${ChatApp} store=${store} />`, app)
}

// 装配标题栏:把自绘标题栏消息处理注册到同一通道;非 selfDrawn 模式内部直接 return。
// 删自绘标题栏(只留原生) 时删除本行 + titlebar 相关文件即可。
initChatTitlebar({ postMessage: (msg) => host.post(msg), onMessage: (cb) => host.onMessage(cb) })

// 页面脚本就绪(渲染 + 消息监听已挂好)→ 通知扩展推送 chatInfo,避免视图重建时早推丢失
host.post({ type: 'ready' })
