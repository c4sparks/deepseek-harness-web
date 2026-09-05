// 插件 UI 层：DSH 官方网页面板的 Webview 宿主。
// dsh 协议/进程编排在 DshService（src/api/dshService.ts），本文件只负责“在编辑器里
// 打开官方网页”的 UI 生命周期与查看模式，避免 DshService 混入面板逻辑。
import * as vscode from 'vscode';
import {
    getEndpoint,
    ensureEndpointAuth,
    endpointAuthUrl,
    startDshWebProxy,
    type DshEndpoint,
    type DshWebProxy,
} from './dsh';

/** DshPanel 需要的宿主能力（由 DshService 提供）。 */
export interface DshPanelHost {
    ensureRunning(): Promise<boolean>;
    /** 官方网页面板全部关闭时回收插件自启的 dsh（不回收外部实例）。 */
    releaseOwnedDsh(): void;
}

/** 管理“在本地打开/在浏览器打开”的 DSH 网页面板。 */
export class DshPanel {
    private openPanels = new Set<vscode.WebviewPanel>();
    private webProxy: { proxy: DshWebProxy; endpointPort: number; authUrl?: string } | undefined;
    private openingPanel: Promise<vscode.WebviewPanel | undefined> | undefined;
    private _viewMode: 'internal' | 'browser' = 'internal';
    private disposed = false;

    constructor(private readonly host: DshPanelHost) {}

    get viewMode(): 'internal' | 'browser' {
        return this._viewMode;
    }

    hasPanel(): boolean {
        return this.openPanels.size > 0;
    }

    /** 停用插件时关闭全部面板并回收本地代理端口。 */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const p of [...this.openPanels]) {
            p.dispose();
        }
        this.openPanels.clear();
        void this.closeWebProxy();
    }

    // ---------- DSH 网页面板 ----------

    private getWebviewContent(frameUrl: string): string {
        let frameCsp = '';
        try {
            const u = new URL(frameUrl);
            if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port) {
                frameCsp = ` frame-src http://127.0.0.1:${u.port};`;
            }
        } catch {
            frameCsp = '';
        }
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';${frameCsp} style-src 'unsafe-inline'; script-src 'unsafe-inline';">
</head>
<body style="margin:0; padding:0; height:100vh; overflow:hidden;">
    <iframe id="frame" src="${frameUrl}" width="100%" height="100%" frameborder="0" style="border:none;"></iframe>
    <script>
        const vscode = acquireVsCodeApi();
        window.addEventListener('message', (e) => {
            const m = e.data;
            if (m && m.type === 'reload') {
                const f = document.getElementById('frame');
                const src = f.src;
                f.src = 'about:blank';
                setTimeout(() => { f.src = src; }, 50);
            }
        });
    </script>
</body>
</html>`;
    }

    /** 确保当前端点有可复用的认证代理（端点变化时重建）。 */
    private async ensureWebProxy(ep: DshEndpoint): Promise<DshWebProxy> {
        const existing = this.webProxy;
        if (existing && existing.endpointPort === ep.port && existing.authUrl === ep.authUrl) {
            return existing.proxy;
        }
        await this.closeWebProxy();
        const proxy = await startDshWebProxy(ep);
        this.webProxy = { proxy, endpointPort: ep.port, authUrl: ep.authUrl };
        return proxy;
    }

    /** 停用面板后回收本地代理端口。 */
    private async closeWebProxy(): Promise<void> {
        const current = this.webProxy;
        this.webProxy = undefined;
        if (current) {
            await current.proxy.close();
        }
    }

    /**
     * 打开（并聚焦）DSH 网页面板；已打开则聚焦，避免重复。
     * rc.1 起内嵌页经本地认证代理加载（见 getWebviewContent 注释）。
     */
    async openPanel(): Promise<vscode.WebviewPanel | undefined> {
        for (const p of this.openPanels) {
            p.reveal(vscode.ViewColumn.One, true);
            return p;
        }
        if (this.openingPanel) {
            return this.openingPanel;
        }
        const opening = this.createPanel();
        this.openingPanel = opening;
        try {
            return await opening;
        } finally {
            this.openingPanel = undefined;
        }
    }

    private async createPanel(): Promise<vscode.WebviewPanel | undefined> {
        const ep = getEndpoint();
        // 先由扩展进程完成 token → cookie 登录，Webview 内不再自行走 ?token= 跳转
        if (ep.authUrl) {
            const loggedIn = await ensureEndpointAuth(ep);
            if (!loggedIn) {
                vscode.window.showWarningMessage(
                    'DSH 网页登录未完成；内嵌页面可能仍不可用，可稍后用标题栏「在浏览器中打开」。'
                );
            }
        }
        let frameUrl: string;
        try {
            const proxy = await this.ensureWebProxy(ep);
            frameUrl = proxy.url;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`无法建立 DSH 本地网页通道：${msg}`);
            return undefined;
        }
        const retain = vscode.workspace.getConfiguration('dsh').get<boolean>('retainContextWhenHidden', true);
        const panel = vscode.window.createWebviewPanel(
            'dshWebview',
            'DeepSeek Harness',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: retain }
        );
        panel.webview.html = this.getWebviewContent(frameUrl);
        this.openPanels.add(panel);
        vscode.commands.executeCommand('setContext', 'dshPanelOpen', true);
        panel.onDidDispose(() => {
            this.openPanels.delete(panel);
            if (this.openPanels.size === 0) {
                if (!this.disposed) {
                    this.host.releaseOwnedDsh();
                }
                void this.closeWebProxy();
                vscode.commands.executeCommand('setContext', 'dshPanelOpen', false);
            }
        });
        return panel;
    }

    /** 刷新所有 DSH 面板 */
    reloadPanels(): void {
        for (const p of this.openPanels) {
            p.webview.postMessage({ type: 'reload' });
        }
    }

    // ---------- 查看模式（内部面板 ↔ 外部浏览器） ----------

    async openInBrowser(): Promise<void> {
        if (!(await this.host.ensureRunning())) {
            return;
        }
        // 面板没开时先本地打开编辑器，避免误跳浏览器
        if (this.openPanels.size === 0) {
            await this.openPanel();
            return;
        }
        this._viewMode = 'browser';
        await vscode.commands.executeCommand('setContext', 'dshViewMode', 'browser');
        vscode.env.openExternal(vscode.Uri.parse(endpointAuthUrl()));
    }

    async openInEditor(): Promise<void> {
        if (!(await this.host.ensureRunning())) {
            return;
        }
        this._viewMode = 'internal';
        await vscode.commands.executeCommand('setContext', 'dshViewMode', 'internal');
        await this.openPanel();
    }
}
