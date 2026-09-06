// ===== 原生标题栏（VS Code view/title）· 宿主侧独立模块 =====
// 原生标题栏 = 按钮渲染在 webview 视图头(host 渲染),webview 页面无任何代码。
// 宿主侧本体只有两处:
//   - 本模块:activate 时 setContext TITLEBAR_NATIVE_CTX(让 package.json menus.view/title 可见);
//   - package.json: menus.view/title 数组(已标注"native 专属",删本目录时整块删)。
// 原生按钮直接 executeCommand dsh.* 命令 —— 这批命令与自绘共享(见 titlebar/index.ts),**不属于 native,
// 删 native 时保留**。
//
// ==== 删原生标题栏(只留自绘)====
//   1. 删本目录(src/titlebar/native/)
//   2. 删 package.json `menus.view/title` 数组
//   3. src/titlebar/index.ts:去掉对 applyNativeTitlebarContext 的调用点(extension.ts activate)
//   4. dshPanel.ts 的 setContext dshPanelOpen/dshViewMode 删原生后成无害死值,可留可清
import * as vscode from 'vscode';

/** package.json menus.view/title 的显隐上下文键(activate 时 setContext)。 */
export const TITLEBAR_NATIVE_CTX = 'dsh.titlebarNative';

/**
 * 置原生标题栏上下文可见性:nativeTitle 模式置 true(原生按钮随 dshPanelOpen/dshViewMode 显隐),
 * selfDrawn 置 false(屏蔽 package.json 全部 view/title 按钮)。
 */
export function applyNativeTitlebarContext(active: boolean): void {
    void vscode.commands.executeCommand('setContext', TITLEBAR_NATIVE_CTX, active);
}
