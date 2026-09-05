// 标题栏两种实现的唯一开关（TS 常量，不是 contributes.configuration 设置项）。
//   原生标题栏（nativeTitle）= VS Code 原生 `view/title`，按钮渲染在 webview 视图头，依赖宿主渲染原生头。
//   自绘标题栏（selfDrawn）   = 页内自绘 #titlebar（sidex 等不渲染原生 webview 视图头的宿主唯一可用形态）。
// 改下面 TITLEBAR_MODE 一个常量即可整套切换。当前默认 'nativeTitle'(原生)；
// 若宿主渲染不出原生 view/title 头（如 sidex 等），切 'selfDrawn' 走页内自绘。
//
// ==== 装配结构：两侧各一个「装配入口」，extension/chat.ts 只认装配，具体实现收在各自模块 ====
//   原生标题栏（nativeTitle）= package.json `menus.view/title`(128-169) + activate setContext + 本文件 nativeTitle 分支。
//                              原生无 webview 代码（宿主渲染按钮）→ webview 装配层无原生分支。
//   自绘标题栏（selfDrawn） = webview/chat/titlebarSelfDrawn.ts + src/titlebarSelfDrawn.ts + index.html #titlebar CSS/DOM。
//   装配入口：
//     - 扩展侧：本文件（唯一 import ./titlebarSelfDrawn）。extension.ts 只调 makeTitlebarPanelBroadcaster / installChatTitlebar。
//     - webview 侧：webview/chat/titlebar.ts（唯一 import ./titlebarSelfDrawn）。chat.ts 只调 initChatTitlebar。
//   shared = src/extension.ts 聊天核心 + workspace helper（两套共用，删任一标题栏都不能删）
//
// ==== 删自绘标题栏（只留原生；需接受：编辑器区聊天面板将无标题栏）====
//   extension.ts / chat.ts **不用改**（它们只调本装配层）。
//   1. 删文件：src/titlebarSelfDrawn.ts、webview/chat/titlebarSelfDrawn.ts
//   2. 删 index.html：#titlebar 的 CSS(18-111) 与 DOM(496-524)（codicon.css 是否删看附件 chip 等其它用法）
//   3. 本文件：删顶部 `import ... from './titlebarSelfDrawn'`、把 makeTitlebarPanelBroadcaster/installChatTitlebar
//      里 selfDrawn 分支去掉（nativeTitle 下两者本就 no-op/undefined）
//   4. webview/chat/titlebar.ts：内容变空或随自绘删除，chat.ts 顶部 import 一并删
// ==== 删原生标题栏（只留自绘）====
//   1. package.json：menus.view/title 数组(128-169)
//   2. 本文件：把 TITLEBAR_MODE 去掉、删 TITLEBAR_NATIVE_CTX，调用方恒传 'selfDrawn'
//      （nativeTitle 相关分支代码可留可删）
//   3. extension.ts activate 里 原生 上下文 setContext；index.html 的 原生 隐藏 CSS(109-111)
//      （dshPanel.ts 的 setContext dshPanelOpen/dshViewMode 删原生后成无害死值，可留可清）
import * as vscode from 'vscode';
// 装配层是扩展侧「唯一 import 自绘模块」的文件：
// 删自绘标题栏时，extension.ts 零改动，只需删本文件下方自绘分支 + 两个 titlebarSelfDrawn.ts 文件 + index.html #titlebar。
import {
    createPanelStateBroadcaster,
    installSelfDrawnTitlebarMessages,
    type SelfDrawnTitlebarCtx,
} from './titlebarSelfDrawn';

/** 标题栏实现类型：原生标题栏 vs 页内自绘标题栏 */
export type TitlebarMode = 'nativeTitle' | 'selfDrawn';

/**
 * 全仓库唯一开关，不猜宿主：'nativeTitle' 就走原生，'selfDrawn' 就走页内自绘（当前默认 'nativeTitle'）。
 * 调用方按用途决定把哪个模式注入 <body data-titlebar-mode>：
 *   - 侧边栏视图（dsh.launcher，原生 view/title 可渲染）= 直接用本常量；
 *   - 编辑器区面板（moveToEditor，createWebviewPanel 渲染不到 view/title）= 恒传
 *     'nativeTitle' 作"纯聊天、无标题栏"标记（见 extension.ts setupChatWebview 调用处）。
 */
export const TITLEBAR_MODE: TitlebarMode = 'nativeTitle';

/** package.json menus.view/title 的显隐上下文键（activate 时 setContext）。 */
export const TITLEBAR_NATIVE_CTX = 'dsh.titlebarNative';

/** loadChatHtml 注入 <body> 的属性；chat.ts 模块顶层同步读取。 */
export const TITLEBAR_MODE_ATTR = 'data-titlebar-mode';

// ---------- 装配入口（extension.ts 只 import 本文件）----------

/** 自绘标题栏需要的宿主能力（extension.ts 组装共享 workspace/面板 helper 后注入） */
export type TitlebarChatHost = SelfDrawnTitlebarCtx;

/**
 * DshPanel 面板开/关或 viewMode 变化 → 广播 panelState（自绘标题栏 webview 消费）。
 * 原生标题栏模式不需要该广播（走 setContext 喂 package.json when），返回空。
 */
export function makeTitlebarPanelBroadcaster(
    broadcast: (msg: unknown) => void
): ((state: { panelOpen: boolean; viewMode: 'internal' | 'browser' }) => void) | undefined {
    if (TITLEBAR_MODE === 'selfDrawn') {
        return createPanelStateBroadcaster(broadcast);
    }
    return undefined;
}

/**
 * 给单个 chat webview 装配标题栏（每 webview 调用一次，见 setupChatWebview）。
 * - selfDrawn：挂自绘标题栏的 webview→扩展 消息处理（titleAction/wsDropdown/selfInfoReq）。
 * - nativeTitle：原生 view/title 按钮由宿主渲染，webview 侧无需扩展消息处理。
 */
export function installChatTitlebar(
    webview: vscode.Webview,
    mode: TitlebarMode,
    host: TitlebarChatHost
): void {
    if (mode === 'selfDrawn') {
        void installSelfDrawnTitlebarMessages(webview, host);
    }
    // nativeTitle：原生头由宿主渲染，webview 内不挂消息处理
}
