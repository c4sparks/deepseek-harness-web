// 服务层：面向 UI 的干净接口。UI 层只依赖本模块；API 传输层在 dshApi.ts。
// 职责：进程管理、共享会话、对话、DSH 面板、查看模式、全量 DSH API 通用通道。
import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcess, type SpawnOptions, type StdioOptions } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
    DEFAULT_DSH_PORT,
    getEndpoint,
    setEndpoint,
    probeDsh,
    probeCapabilities,
    setCapabilities,
    endpointAuthUrl,
    endpointBaseUrl,
    createSession,
    renameSession,
    askInSession,
    askInSessionStreaming,
    respondApproval,
    respondQuestion,
    cancelQuestion,
    getSessionProjections,
    getSessionMessages,
    type DshEndpoint,
    type DshReplyStats,
    type DshActivity,
    type DshApproval,
    type DshContentPart,
    type DshQuestionRequest,
    rpcCall,
} from '../dshApi';

const NODE_REQUIREMENT = '^22.19.0 || >=24.0.0';

/** 工作区视图（workspace.list / workspace.create 返回） */
export interface WorkspaceView {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
}

/**
 * 解析 dsh web 打印的 URL 行（官方就绪信号，默认 printUrl=true）：
 *   dsh web: http://127.0.0.1:PORT?token=... (LAN: ...)
 * 只取第一段 loopback URL；拿不到端口返回 undefined。
 */
function parseWebUrlLine(text: string): DshEndpoint | undefined {
    const m = /dsh web: (https?:\/\/[^\s]+)/.exec(text);
    if (!m) {
        return undefined;
    }
    try {
        const u = new URL(m[1].trim());
        const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
        if (!Number.isInteger(port) || port <= 0) {
            return undefined;
        }
        return { port, authUrl: u.href };
    } catch {
        return undefined;
    }
}

/** 工作区路径归一化（分隔符统一 /、去尾斜杠、小写）用于匹配 */
function normalizePath(p?: string): string {
    return (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export class DshService {
    // 进程状态
    private dshProcess: ChildProcess | null = null;
    private dshStartedByUs = false;
    private dshStderr = '';
    private dshStdout = '';
    private ready = false;
    private starting = false;
    private openPanels = new Set<vscode.WebviewPanel>();
    // 共享会话（右键/对话/网页同一条线）
    private currentSessionId: string | undefined;
    // 当前工作区（缺省按 VS Code 文件夹自动解析，避免会话全部掉进"未分组"）
    private currentWorkspaceId: string | undefined;
    // 查看模式
    private _viewMode: 'internal' | 'browser' = 'internal';

    get viewMode(): 'internal' | 'browser' {
        return this._viewMode;
    }

    hasPanel(): boolean {
        return this.openPanels.size > 0;
    }

    /**
     * 通用通道：可调任意 DSH API（session / goal / subagent / workspace / llm / host ...）。
     * 新增功能只需调用 call(method, payload)，无需改动本层。
     */
    call<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
        return rpcCall<T>(method, payload);
    }

    // ---------- 进程 ----------

    private isNodeCompatible(version: string): boolean {
        const [major, minor] = version.split('.').map((s) => parseInt(s, 10));
        if (major === 22) {
            return minor >= 19;
        }
        return major >= 24;
    }

    private checkSystemNode(): Promise<{ ok: boolean; version?: string }> {
        return new Promise((resolve) => {
            execFile('node', ['--version'], (err, stdout) => {
                if (err) {
                    resolve({ ok: false });
                    return;
                }
                const version = (stdout || '').trim().replace(/^v/, '');
                resolve({ ok: this.isNodeCompatible(version), version });
            });
        });
    }

    /**
     * 解析 dsh 启动器（动态识别，四档回退）：
     *   ① dsh.cliPath 显式 CLI 路径
     *   ② dsh.repoPath 源码仓（开发环境在 .vscode/settings.json 配置）→ 仓库根 `pnpm dsh web`
     *   ③ PATH 上的本机 dsh（dsh / dsh.cmd）
     *   ④ npx --yes @deepseek-ai/dsh 兜底
     * 不修改 dsh 任何文件。versionCmd 用于尽力捕获版本（诊断用）。
     */
    private async resolveDshLauncher(): Promise<{ cmd: string; args: string[]; cwd: string; versionCmd?: { cmd: string; args: string[]; cwd: string } }> {
        const isWin = process.platform === 'win32';
        const webArgs = ['web', '--no-open', '--port', '0'];
        // ① 显式 CLI 路径
        const cliPath = vscode.workspace.getConfiguration('dsh').get<string>('cliPath', '').trim();
        if (cliPath && fs.existsSync(cliPath)) {
            return {
                cmd: isWin ? 'cmd.exe' : cliPath,
                args: isWin ? ['/c', cliPath, ...webArgs] : webArgs,
                cwd: os.homedir(),
                versionCmd: {
                    cmd: isWin ? 'cmd.exe' : cliPath,
                    args: isWin ? ['/c', cliPath, '--version'] : ['--version'],
                    cwd: os.homedir(),
                },
            };
        }
        // ② 源码仓（仅开发调试，需在 .vscode/settings.json 配置 dsh.repoPath）→ 仓库根 `pnpm dsh web`
        const repoPath = vscode.workspace.getConfiguration('dsh').get<string>('repoPath', '').trim();
        if (repoPath && fs.existsSync(path.join(repoPath, 'package.json'))) {
            return {
                cmd: isWin ? 'cmd.exe' : 'pnpm',
                args: isWin ? ['/c', 'pnpm', 'dsh', ...webArgs] : ['dsh', ...webArgs],
                cwd: repoPath,
                versionCmd: {
                    cmd: isWin ? 'cmd.exe' : 'pnpm',
                    args: isWin ? ['/c', 'pnpm', 'dsh', '--version'] : ['dsh', '--version'],
                    cwd: repoPath,
                },
            };
        }
        // ③ PATH 上的本机 dsh
        const candidates = isWin ? ['dsh.cmd'] : ['dsh'];
        for (const cmd of candidates) {
            const found = await new Promise<boolean>((resolve) => {
                // Windows 用 where / POSIX 用 which：只查 PATH，不执行目标
                execFile(isWin ? 'where' : 'which', [cmd], { windowsHide: true }, (err) => resolve(!err));
            });
            if (found) {
                return {
                    cmd: isWin ? 'cmd.exe' : cmd,
                    args: isWin ? ['/c', cmd, ...webArgs] : webArgs,
                    cwd: os.homedir(),
                    versionCmd: {
                        cmd: isWin ? 'cmd.exe' : cmd,
                        args: isWin ? ['/c', cmd, '--version'] : ['--version'],
                        cwd: os.homedir(),
                    },
                };
            }
        }
        // ④ npx 兜底（版本捕获跳过，避免联网）
        return {
            cmd: isWin ? 'cmd.exe' : 'npx',
            args: isWin ? ['/c', 'npx', '--yes', '@deepseek-ai/dsh', ...webArgs] : ['--yes', '@deepseek-ai/dsh', ...webArgs],
            cwd: os.homedir(),
        };
    }

    /** 尽力捕获 dsh 版本（非阻塞；失败静默） */
    private captureVersion(vc: { cmd: string; args: string[]; cwd: string }): void {
        execFile(vc.cmd, vc.args, { cwd: vc.cwd, windowsHide: true, timeout: 8000 }, (err, stdout) => {
            if (err) {
                return;
            }
            const v = (stdout || '').trim().split(/\r?\n/)[0].trim();
            if (v) {
                setCapabilities({ version: v });
            }
        });
    }

    /** 启动 dsh web（--port 0 动态端口）；stdout 累积供 URL 行解析（P0-1） */
    private spawnDsh(): Promise<ChildProcess> {
        return new Promise((resolve, reject) => {
            void (async () => {
                try {
                    const launcher = await this.resolveDshLauncher();
                    const opts: SpawnOptions = {
                        cwd: launcher.cwd,
                        windowsHide: true,
                        stdio: ['ignore', 'pipe', 'pipe'] as StdioOptions,
                        ...(process.platform === 'win32' ? {} : { detached: true }),
                    };
                    const child = spawn(launcher.cmd, launcher.args, opts);
                    this.dshProcess = child;
                    this.dshStderr = '';
                    this.dshStdout = '';
                    if (launcher.versionCmd) {
                        this.captureVersion(launcher.versionCmd);
                    }
                    child.stdout?.on('data', (d: Buffer) => { this.dshStdout += d.toString(); });
                    child.stderr?.on('data', (d: Buffer) => { this.dshStderr += d.toString(); });
                    child.once('spawn', () => resolve(child));
                    child.once('error', (err) => reject(err));
                } catch (e) {
                    reject(e as Error);
                }
            })();
        });
    }

    /**
     * 等待子进程 stdout 出现 `dsh web: <url>` 行（含端口 + 鉴权 token）。
     * 超时或进程提前退出仍未出现 → undefined（回退探测默认端口）。
     */
    private waitForWebUrl(child: ChildProcess, timeoutMs: number): Promise<DshEndpoint | undefined> {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const timer = setInterval(() => {
                const ep = parseWebUrlLine(this.dshStdout);
                if (ep) {
                    clearInterval(timer);
                    resolve(ep);
                } else if (Date.now() > deadline) {
                    clearInterval(timer);
                    resolve(undefined);
                }
            }, 100);
            child.once('exit', () => {
                clearInterval(timer);
                resolve(parseWebUrlLine(this.dshStdout));
            });
        });
    }

    private killDshIfOwned() {
        const child = this.dshProcess;
        if (!child || !child.pid || !this.dshStartedByUs) {
            this.dshProcess = null;
            return;
        }
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch {
                try {
                    child.kill('SIGTERM');
                } catch {
                    /* 进程已退出 */
                }
            }
        }
        this.dshProcess = null;
        this.dshStartedByUs = false;
    }

    /**
     * 确保 DSH 服务在运行；未运行自动拉起并等待就绪。
     * 端点动态识别链路：① 探测既有实例（默认端口 3080）→ ② 启动器三档回退
     * （源码仓 pnpm dsh web / PATH dsh / npx）→ ③ 解析 stdout 的 URL 行（真实端口 + 鉴权 token）→ ④ 握手探测验证信封。
     */
    async ensureRunning(): Promise<boolean> {
        if (this.ready) {
            // 快速校验当前端点仍存活（DSH 可能已重启 / 换端口 / 停止），避免用旧端口
            const alive = await probeDsh(getEndpoint().port);
            if (alive.ok) {
                return true;
            }
            this.ready = false; // 失联：重置，走重新发现（探测默认端口或自启）
        }
        if (this.starting) {
            vscode.window.showInformationMessage('DSH 服务正在启动中，请稍候…');
            return false;
        }
        this.starting = true;
        try {
            // ① 探测既有实例：dsh.port > 0 时严格指向该端口（未运行则报错，不自动启动）；
            //    否则探测默认端口 3080，命中直接复用（不接管清理）
            const cfgPort = vscode.workspace.getConfiguration('dsh').get<number>('port', 0);
            const probePort = cfgPort > 0 ? cfgPort : DEFAULT_DSH_PORT;
            const existing = await probeDsh(probePort);
            if (existing.ok) {
                setEndpoint(existing.endpoint);
                this.dshStartedByUs = false;
                this.ready = true;
                return true;
            }
            if (cfgPort > 0) {
                vscode.window.showErrorMessage(`dsh.port 配置的端口 ${cfgPort} 没有检测到 DSH 服务在运行`);
                return false;
            }
            // ② Node 版本检查
            const node = await this.checkSystemNode();
            if (!node.ok) {
                const pick = await vscode.window.showErrorMessage(
                    `未检测到可用的 Node.js（要求 ${NODE_REQUIREMENT}），启动 DSH 需要 Node 环境。`,
                    '打开 Node.js 官网',
                    '取消'
                );
                if (pick === '打开 Node.js 官网') {
                    vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
                }
                return false;
            }
            // ③ 启动（本机已安装 dsh 优先，npx 兜底）
            try {
                await this.spawnDsh();
                this.dshStartedByUs = true;
            } catch (e) {
                vscode.window.showErrorMessage(`启动 DSH 失败：${(e as Error).message}`);
                return false;
            }
            // ④ 等待 stdout URL 行（动态端口 + 鉴权 token）；超时回退探测默认端口
            const child = this.dshProcess;
            const discovered = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在启动 DeepSeek Harness 服务…' },
                () => (child ? this.waitForWebUrl(child, 90_000) : Promise.resolve(undefined))
            );
            if (discovered) {
                setEndpoint(discovered);
            }
            // ⑤ 握手探测：验证信封（P0-2）；失败给出明确原因而非难懂报错
            const probe = await probeDsh(discovered?.port ?? DEFAULT_DSH_PORT);
            if (!probe.ok) {
                const hint = (this.dshStderr.trim().split('\n').pop() || probe.reason || '未知错误').trim();
                vscode.window.showErrorMessage(`DSH 启动失败：${hint}`);
                this.killDshIfOwned();
                return false;
            }
            setEndpoint({ port: probe.endpoint.port, authUrl: discovered?.authUrl });
            // 能力探测（P2）：mux WS 可用性决定审批/提问走 mux 还是 history 兜底
            setCapabilities(await probeCapabilities(probe.endpoint.port));
            if (probe.authRequired) {
                vscode.window.showWarningMessage(probe.reason ?? 'DSH 需要鉴权，请打开 dsh 网页面板完成登录');
            }
            this.ready = true;
            return true;
        } finally {
            this.starting = false;
        }
    }

    /** 扩展停用时回收后台进程 */
    dispose(): void {
        this.ready = false;
        this.killDshIfOwned();
    }

    // ---------- 共享会话 / 对话 ----------

    /** 取当前共享会话，没有则创建 */
    async getSession(): Promise<string> {
        if (this.currentSessionId) {
            return this.currentSessionId;
        }
        return this.newSession();
    }

    /** 开启新会话并设为当前。指定 workspaceId 时归入该工作区，缺省用当前文件夹对应的工作区（无文件夹才回未分组）。 */
    async newSession(workspaceId?: string): Promise<string> {
        const wsId = workspaceId ?? this.currentWorkspaceId;
        if (wsId) {
            this.currentWorkspaceId = wsId;
        }
        const sid = await createSession(wsId ? { workspaceId: wsId } : {});
        await renameSession(sid, 'VS Code 会话');
        this.currentSessionId = sid;
        return sid;
    }

    // ---------- 工作区 / 会话历史恢复 ----------

    /** 列出全部工作区（含归档） */
    async listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: string[] }> {
        return this.call('workspace.list', {});
    }

    /** 新建工作区：采用一个目录 */
    async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
        return this.call('workspace.create', { path });
    }

    /** 当前共享会话 id（webview 会话下拉回显用） */
    getSessionId(): string | undefined {
        return this.currentSessionId;
    }

    /** 当前工作区 id（无则 undefined） */
    getCurrentWorkspaceId(): string | undefined {
        return this.currentWorkspaceId;
    }

    /** 手动切换当前工作区（UI 下拉） */
    setCurrentWorkspace(workspaceId?: string): void {
        this.currentWorkspaceId = workspaceId;
    }

    /**
     * 为当前 VS Code 工作区文件夹解析/复用 DSH 工作区并设为当前；
     * 无文件夹返回 undefined（此时会话回未分组）。按路径归一化匹配，避免重复建。
     */
    async ensureWorkspaceForFolder(): Promise<string | undefined> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.currentWorkspaceId = undefined;
            return undefined;
        }
        const target = normalizePath(folder.uri.fsPath);
        const list = await this.call<{ items?: Array<{ workspaceId?: string; path?: string }> }>('workspace.list', {});
        const existing = (list.items ?? []).find((w) => normalizePath(w.path) === target);
        if (existing?.workspaceId) {
            this.currentWorkspaceId = existing.workspaceId;
            return existing.workspaceId;
        }
        const created = await this.call<{ workspace?: { workspaceId?: string } }>('workspace.create', { path: folder.uri.fsPath });
        this.currentWorkspaceId = created.workspace?.workspaceId;
        return this.currentWorkspaceId;
    }

    /**
     * 列出某工作区下的已有会话（workspace.list 的 sessionIds + session.list 汇总映射标题）。
     * 排除 subagent 内部会话与空白会话；运行中排前。
     */
    async listWorkspaceSessions(workspaceId: string): Promise<Array<{ sessionId: string; title: string; running: boolean }>> {
        const wsList = await this.call<{ items?: Array<{ workspaceId?: string; sessionIds?: string[] }> }>('workspace.list', {});
        const ws = (wsList.items ?? []).find((w) => w.workspaceId === workspaceId);
        const ids = new Set(ws?.sessionIds ?? []);
        if (ids.size === 0) {
            return [];
        }
        const sessionList = await this.call<{
            items?: Array<{ sessionId?: string; running?: boolean; blank?: boolean; origin?: string; projections?: { values?: Record<string, unknown> } }>;
        }>('session.list', {});
        const out: Array<{ sessionId: string; title: string; running: boolean }> = [];
        for (const s of sessionList.items ?? []) {
            if (!s.sessionId || !ids.has(s.sessionId) || s.origin === 'subagent' || s.blank) {
                continue;
            }
            out.push({
                sessionId: s.sessionId,
                title: String((s.projections?.values as Record<string, unknown> | undefined)?.['title'] ?? s.sessionId.slice(0, 8)),
                running: !!s.running,
            });
        }
        out.sort((a, b) => Number(b.running) - Number(a.running));
        return out;
    }

    /** 恢复会话：设为当前共享会话并返回消息历史（供 UI 渲染，协议解析复用事件投影） */
    async restoreSession(sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
        this.currentSessionId = sessionId;
        return getSessionMessages(sessionId);
    }

    // ---------- 官方投影 / 模型 / 权限 ----------

    /** 读取当前会话的官方投影（sessionStats / tokenUsage / permissions / title 等） */
    async getProjections(): Promise<Record<string, unknown>> {
        const sid = this.currentSessionId;
        if (!sid) {
            return {};
        }
        return getSessionProjections(sid);
    }

    /** 列出可用模型 + 当前选择 + 推理等级 */
    async listModels(): Promise<{
        current?: { provider?: string; model?: string; reasoningEffort?: string };
        groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string; reasoning?: { efforts?: Array<{ id: string; name: string }> } }> }>;
    }> {
        const sid = await this.getSession();
        return this.call('session.models', { sessionId: sid });
    }

    /** 选择模型 / 推理等级 */
    async selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void> {
        const sid = await this.getSession();
        await this.call('session.selectModel', {
            sessionId: sid,
            provider,
            model,
            ...(reasoningEffort ? { reasoningEffort } : {}),
        });
    }

    /** 切换权限预设：经 session.prompt 派发 /permission 命令 */
    async setPermissionPreset(preset: string): Promise<void> {
        const sid = await this.getSession();
        await this.call('session.prompt', {
            sessionId: sid,
            mode: 'queue',
            content: [{ type: 'text', text: `/permission ${preset}` }],
        });
    }

    /** 对话：确保 DSH 在运行，发消息到共享会话，等 AI 回复 */
    async ask(text: string, opts: { isCancelled?: () => boolean } = {}): Promise<string> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法对话');
        }
        const sid = await this.getSession();
        return askInSession(sid, text, opts);
    }

    /** 响应审批：允许一次 / 拒绝（应答需带 sessionId，且 rpcId 回显 mux 帧里的） */
    async approvalResponse(approvalId: string, allow: boolean): Promise<void> {
        const sessionId = await this.getSession();
        return respondApproval(sessionId, approvalId, allow ? 'allowed-once' : 'rejected');
    }

    /** 流式对话：增量回调 onDelta / onReasoning / onActivity / onQuestion，返回完整文本 + 统计 */
    async askStreaming(
        content: DshContentPart[],
        onDelta: (delta: string) => void,
        opts: {
            onReasoning?: (delta: string, step?: number) => void;
            onActivity?: (a: DshActivity) => void;
            onApproval?: (a: DshApproval) => void;
            onQuestion?: (q: DshQuestionRequest) => void;
            isCancelled?: () => boolean;
        } = {}
    ): Promise<{ text: string; stats: DshReplyStats }> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法对话');
        }
        const sid = await this.getSession();
        return askInSessionStreaming(sid, content, onDelta, opts);
    }

    /** 回答 ask_user_question（回显 question/requested 帧的 rpcId） */
    async answerQuestion(
        rpcId: string,
        sessionId: string,
        answers: Array<{ id: string; selected: string[]; custom?: string }>
    ): Promise<void> {
        return respondQuestion(sessionId, rpcId, answers);
    }

    /** 取消 ask_user_question */
    async cancelQuestion(rpcId: string, sessionId: string): Promise<void> {
        return cancelQuestion(rpcId, sessionId);
    }

    // ---------- DSH 网页面板 ----------

    private getWebviewContent(): string {
        const ep = getEndpoint();
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; frame-src http://127.0.0.1:${ep.port}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
</head>
<body style="margin:0; padding:0; height:100vh; overflow:hidden;">
    <iframe id="frame" src="${endpointAuthUrl()}" width="100%" height="100%" frameborder="0" style="border:none;"></iframe>
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

    /** 打开（并聚焦）DSH 网页面板；已打开则聚焦，避免重复 */
    openPanel(): vscode.WebviewPanel {
        for (const p of this.openPanels) {
            p.reveal(vscode.ViewColumn.One, true);
            return p;
        }
        const retain = vscode.workspace.getConfiguration('dsh').get<boolean>('retainContextWhenHidden', true);
        const panel = vscode.window.createWebviewPanel(
            'dshWebview',
            'DeepSeek Harness',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: retain }
        );
        panel.webview.html = this.getWebviewContent();
        this.openPanels.add(panel);
        vscode.commands.executeCommand('setContext', 'dshPanelOpen', true);
        panel.onDidDispose(() => {
            this.openPanels.delete(panel);
            if (this.openPanels.size === 0) {
                this.killDshIfOwned();
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
        if (!(await this.ensureRunning())) {
            return;
        }
        // 面板没开时直接开编辑器，避免误跳浏览器
        if (this.openPanels.size === 0) {
            this.openPanel();
            return;
        }
        this._viewMode = 'browser';
        await vscode.commands.executeCommand('setContext', 'dshViewMode', 'browser');
        vscode.env.openExternal(vscode.Uri.parse(endpointAuthUrl()));
    }

    async openInEditor(): Promise<void> {
        if (!(await this.ensureRunning())) {
            return;
        }
        this._viewMode = 'internal';
        await vscode.commands.executeCommand('setContext', 'dshViewMode', 'internal');
        this.openPanel();
    }
}
