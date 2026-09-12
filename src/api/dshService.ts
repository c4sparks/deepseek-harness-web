// 服务层：面向 UI 的干净接口。UI 层只依赖本模块；dsh 协议层在 src/dsh/（门面 src/dsh/index.ts）。
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
    createSession,
    askInSession,
    askInSessionStreaming,
    getSessionProjections,
    getSessionMessages,
    type DshEndpoint,
    type DshReplyStats,
    type DshTurnCounts,
    type DshActivity,
    type DshApproval,
    type DshContentPart,
    type DshQuestionRequest,
    type DshContext,
    type DshSystemPrompt,
    type SessionMessageItem,
    rpcCall,
    runSessionCommand,
    readSessionAttachment,
    modelCatalog,
    workspaceList,
    dshEvents,
    listAgentPresets as listAgentPresetsRpc,
    selectAgentPreset as selectAgentPresetRpc,
    readTranscriptView as readTranscriptViewRpc,
    getCachedTranscriptView as getCachedTranscriptViewRpc,
    subscribeTranscriptView as subscribeTranscriptViewRpc,
    type DshAgentPresetRoster,
    type DshTranscriptView,
} from '../dsh';
import { sessionDisplayTitle } from '../dsh/official/session-title';

const NODE_REQUIREMENT = '^22.19.0 || >=24.0.0';

/** 工作区视图（workspace.list / workspace.create 返回） */
export interface WorkspaceView {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
    /** ISO-8601 创建时刻（dsh workspace 域持久化，同 workspace.json） */
    createdAt?: string;
    /** ISO-8601 最近一次落盘变更时刻（会话挂载/改名等会刷新；同 workspace.json 的 updatedAt） */
    updatedAt?: string;
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
    console.warn(`[dsh-debug] stdout 命中行=${m[0].trim()}`);
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

/** 官方 session.list 列表 item 的 durable title：优先顶层 title，回退 projectionValues / projections.values 里的 title。
 *  空/缺返回 undefined（交 sessionDisplayTitle 走 cwd basename / sessionId 兜底）。 */
function durableTitleOf(s: {
    title?: string;
    projectionValues?: Record<string, unknown>;
    projections?: { values?: Record<string, unknown> };
}): string | undefined {
    if (typeof s.title === 'string' && s.title.trim() !== '') {
        return s.title;
    }
    const pv = s.projectionValues ?? (s.projections?.values as Record<string, unknown> | undefined);
    const t = pv?.['title'];
    return typeof t === 'string' && t.trim() !== '' ? t : undefined;
}

/** 建会话需要工作区却没有（无任何 dsh 工作区、且没有可映射的 VS Code 文件夹时抛出）。
 *  上层据此提示“请先选择/创建工作区”，而不是静默建出“未分组”会话。 */
export class DshNoWorkspaceError extends Error {
    readonly code = 'NO_WORKSPACE';
    constructor() {
        super('请先选择或创建工作区，再开启会话');
        this.name = 'DshNoWorkspaceError';
    }
}

export class DshService {
    // 进程状态
    private dshProcess: ChildProcess | null = null;
    private dshStartedByUs = false;
    private dshStderr = '';
    private dshStdout = '';
    private ready = false;
    private starting = false;
    private ensurePromise: Promise<boolean> | undefined;
    // 共享会话（右键/对话/网页同一条线）
    private currentSessionId: string | undefined;
    // 当前工作区（缺省按 VS Code 文件夹自动解析，避免会话全部掉进"未分组"）
    private currentWorkspaceId: string | undefined;

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
     * 组装插件自启 dsh web 的启动参数。
     * 固定部分始终包含 `web --no-open --port 0`（stdout 动态发现端口 + 不弹浏览器）；
     * `dsh.webArgs` 只追加额外参数（如 --host / --trusted-host），不负责选择哪个 dsh。
     */
    private launchWebArgs(): string[] {
        const base = ['web', '--no-open', '--port', '0'];
        const configured = vscode.workspace.getConfiguration('dsh').get<unknown>('webArgs', []);
        if (!Array.isArray(configured)) {
            return base;
        }
        const extra = configured
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
        return [...base, ...extra];
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
        const webArgs = this.launchWebArgs();
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
        if (this.ensurePromise) {
            // 并发入口（聊天初始化/工作区/本地打开）共享同一次启动，等待其完成即可。
            return this.ensurePromise;
        }
        const task = this.runEnsure();
        this.ensurePromise = task;
        try {
            return await task;
        } finally {
            if (this.ensurePromise === task) {
                this.ensurePromise = undefined;
            }
        }
    }

    private async runEnsure(): Promise<boolean> {
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
            console.warn(`[dsh-debug] ensureRunning discovered=${JSON.stringify(discovered)}`);
            // ⑤ 握手探测：验证信封（P0-2）；失败给出明确原因而非难懂报错
            const probe = await probeDsh(discovered?.port ?? DEFAULT_DSH_PORT);
            console.warn(`[dsh-debug] probe ok=${probe.ok} authRequired=${probe.authRequired} reason=${probe.reason}`);
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

    /** 扩展停用时收尾：回收 dsh 协议流与后台进程（Webview 面板由 DshPanel 先关闭）。 */
    dispose(): void {
        this.ready = false;
        dshEvents.stop();
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

    /** 该工作区内可复用的现存空会话（blank 且未归档、属于该工作区），无则 undefined ——“复用现成新会话”，避免反复新建越积越多。 */
    private async findReusableBlank(workspaceId: string): Promise<string | undefined> {
        try {
            const { items: wsItems, archivedSessionIds } = await this.listWorkspaces();
            const ws = wsItems.find((w) => w.workspaceId === workspaceId);
            if (!ws) {
                return undefined;
            }
            const wsPath = ws.path ? normalizePath(ws.path) : undefined;
            const archived = new Set(archivedSessionIds ?? []);
            const memberIds = new Set(ws.sessionIds ?? []);
            const sessionList = await this.call<{
                items?: Array<{ sessionId?: string; blank?: boolean; origin?: string; cwd?: string }>;
            }>('session.list', {});
            const rows = (sessionList.items ?? []).filter(
                (s) => !!s.sessionId && s.blank && s.origin !== 'subagent' && !archived.has(s.sessionId!)
            );
            // 仅复用**属于目标工作区**的空白会话：既优先当前正在用的(避免反复“新建”跳去更旧的空会话)，
            // 也绝不跨工作区复用——否则切到新工作区后“新建”会复用旧工作区的当前空白，导致新会话没归对该工作区。
            // （rc1 新建会话必 attach 到目标工作区，故 belongs 对真正的新建空白恒真。）
            const members = rows.filter(
                (s) =>
                    memberIds.has(s.sessionId!) ||
                    (wsPath !== undefined && typeof s.cwd === 'string' && normalizePath(s.cwd) === wsPath)
            );
            const currentFirst = members.find((s) => s.sessionId === this.currentSessionId);
            return currentFirst ? currentFirst.sessionId : members[0]?.sessionId;
        } catch {
            // 列表拉取失败不阻塞：照常新建
        }
        return undefined;
    }

    /**
     * 开启新会话并设为当前。指定 workspaceId 时归入该工作区，缺省用当前文件夹对应的工作区（无文件夹才回未分组）。
     * 同一工作区已存在空白“新会话”时先复用它，不重复创建 → 反复点“新建会话”不会越积越多。
     */
    async newSession(workspaceId?: string): Promise<string> {
        // 工作区优先取显式指定 → 当前 → 自动默认（dsh 里最新 / 当前 VS Code 文件夹）。
        // 三者皆无时不再回退到不带 workspaceId 的 createSession（会落“未分组”），而是抛错让上层引导选工作区。
        let wsId = workspaceId ?? this.currentWorkspaceId;
        if (!wsId) {
            wsId = await this.ensureCurrentWorkspace();
        }
        if (!wsId) {
            throw new DshNoWorkspaceError();
        }
        this.currentWorkspaceId = wsId;
        const reusable = await this.findReusableBlank(wsId);
        if (reusable) {
            this.currentSessionId = reusable;
            return reusable;
        }
        const sid = await createSession({ workspaceId: wsId });
        this.currentSessionId = sid;
        return sid;
    }

    // ---------- 工作区 / 会话历史恢复 ----------

    /**
     * 列出全部工作区（含归档）。
     * 适配 dsh v0.1.5-rc.2：该版本没有 `workspace.list` 远程方法，工作区枚举由 api.workspaceList()
     * 经 `workspace/follow`（/api/remote.mux 流）的 baseline 帧返回（详见 src/dsh/api.ts 中 workspaceList 的 JSDoc）。
     */
    async listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: string[] }> {
        return workspaceList();
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
        const list = await this.listWorkspaces();
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
     * 解析“当前工作区”，与 dsh 自身一致：插件不额外存记录，直接取 dsh 持久化的
     * workspace 数据（workspace.list ← ~/.dsh/storages/workspace.json 同一份存储）
     * 里 updatedAt 最新者（同值按返回顺序决平手）。
     * 切换工作区 = 给目标工作区挂会话（newSession），其 updatedAt 随之刷新为最新，
     * 下次解析仍是它。仅当 dsh 里一个工作区都没有（全新环境）才回退到
     * “按当前 VS Code 文件夹建首个工作区”兜底，避免会话掉进未分组。
     */
    async ensureCurrentWorkspace(): Promise<string | undefined> {
        if (this.currentWorkspaceId) {
            return this.currentWorkspaceId;
        }
        try {
            const { items } = await this.listWorkspaces();
            let best: WorkspaceView | undefined;
            let bestTime = Number.NEGATIVE_INFINITY;
            for (const w of items) {
                const t = Date.parse(w.updatedAt ?? '');
                if (Number.isNaN(t)) {
                    continue;
                }
                if (t > bestTime) {
                    bestTime = t;
                    best = w;
                }
            }
            if (best) {
                this.currentWorkspaceId = best.workspaceId;
                return best.workspaceId;
            }
        } catch {
            // 列表读不到时落到文件夹兜底
        }
        return this.ensureWorkspaceForFolder();
    }

    /**
     * 当前工作区的根路径（终端卡 cwd 标签的兜底来源）。
     * **只读**：不新建工作区、不改归属——拿不到就返回 undefined，让标签回退 `$`。
     * 工具调用参数里通常不带 workdir，此时用会话工作区根兜底，本方法提供同一份数据。
     */
    async currentWorkspacePath(): Promise<string | undefined> {
        const id = this.currentWorkspaceId;
        if (!id) {
            return undefined;
        }
        try {
            const { items } = await this.listWorkspaces();
            const ws = items.find((w) => w.workspaceId === id);
            // **原样返回作者写法**（只去尾部分隔符），**不要走 normalizePath**：这个值一路传到 webview
            // 当"显示用的相对根"（收起行摘要、读卡横幅、终端卡 cwd 标签），小写化会把 `MyProject`
            // 显示成 `myproject`；换成正斜杠又会让工具给的 Windows 路径（`C:\...`）对不上前缀，
            // 相对化直接失效、整条绝对路径被原样画出来。需要比较归属的地方用 normalizePath，别在这里归一化。
            const path = (ws?.path ?? '').replace(/[/\\]+$/, '');
            return path !== '' ? path : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * 列出某工作区下的已有会话（workspace.list 的 sessionIds + session.list 汇总映射标题）。
     * 排除 subagent 内部会话；空白会话展示为「新会话」；运行中排前。
     * 注意：新建会话不做强制改名，问答后沿用 dsh 自动生成的会话标题。
     */
    async listWorkspaceSessions(
        workspaceId: string
    ): Promise<Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current: boolean }>> {
        const wsList = await this.listWorkspaces();
        const ws = (wsList.items ?? []).find((w) => w.workspaceId === workspaceId);
        const ids = new Set(ws?.sessionIds ?? []);
        const wsPath = ws?.path ? normalizePath(ws.path) : undefined;
        if (ids.size === 0 && wsPath === undefined) {
            return [];
        }
        const sessionList = await this.call<{
            items?: Array<{
                sessionId?: string;
                running?: boolean;
                blank?: boolean;
                origin?: string;
                cwd?: string;
                /** 官方列表 item：durable title 投影在顶层 title 字段（非空字符串才设置） */
                title?: string;
                /** 官方列表 item：当前 host 计算的投影值包（键含 title 等） */
                projectionValues?: Record<string, unknown>;
                projections?: { values?: Record<string, unknown> };
            }>;
        }>('session.list', {});
        const out: Array<{ sessionId: string; title: string; running: boolean; blank: boolean; current: boolean }> = [];
        for (const s of sessionList.items ?? []) {
            if (!s.sessionId || s.origin === 'subagent') {
                continue;
            }
            const inWorkspace =
                ids.has(s.sessionId) ||
                (wsPath !== undefined && typeof s.cwd === 'string' && normalizePath(s.cwd) === wsPath);
            if (!inWorkspace) {
                continue;
            }
            const isCurrent = s.sessionId === this.currentSessionId;
            // 纯空「新会话」：除非它就是当前正在用的会话(显示为选中)，否则不列出
            //（与 dsh 网页一致：无内容的旧会话不占列表，避免越积越多）。运行中的保留。
            if (s.blank && !s.running && !isCurrent) {
                continue;
            }
            out.push({
                sessionId: s.sessionId,
                // 官方三层 fallback：title → cwd basename → sessionId（blank 由 UI 显示“新会话”）
                // durable title 读官方列表 item 顶层 title；兼容旧/变体形状回退 projectionValues / projections.values.title。
                title:
                    s.blank
                        ? '新会话'
                        : sessionDisplayTitle({
                              title: durableTitleOf(s),
                              cwd: s.cwd,
                              sessionId: s.sessionId ?? '',
                          }),
                running: !!s.running,
                blank: !!s.blank,
                current: isCurrent,
            });
        }
        out.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.running) - Number(a.running));
        // 会话名一致性诊断：打印官方返回的每条 sessionId+title（env DSH_RAWLOG=1/full）
        if (process.env['DSH_RAWLOG']) {
            for (const r of out) {
                console.log(`[dsh-raw] session-list ${r.sessionId} title=${JSON.stringify(r.title)} running=${r.running} blank=${r.blank} current=${r.current}`);
            }
        }
        return out;
    }

    /** 恢复会话：设为当前共享会话并返回消息历史（供 UI 渲染，协议解析复用事件投影） */
    async restoreSession(sessionId: string): Promise<SessionMessageItem[]> {
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

    /** 列出可用模型 + 当前选择 + 推理等级（rc1：目录=session/modelCatalog，当前=modelSelection 投影） */
    async listModels(): Promise<{
        current?: { provider?: string; model?: string; reasoningEffort?: string };
        groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string; reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string } }> }>;
        /** 上游对加载失败 provider/组的提示（原样透传；UI 只显示组数） */
        failures?: unknown[];
    }> {
        const catalog = await modelCatalog();
        let current: { provider?: string; model?: string; reasoningEffort?: string } | undefined;
        // 有当前会话 → 读它的 modelSelection 投影；无会话但已有当前工作区 → 先挂一个（已带工作区，不会落未分组）；
        // 两者皆无（尚未选工作区）→ 只返回全局模型目录、当前选择留空，绝不静默建“未分组”会话。
        const sid = this.currentSessionId ?? (this.currentWorkspaceId ? await this.getSession() : undefined);
        if (sid) {
            try {
                const proj = await getSessionProjections(sid);
                const sel = proj['modelSelection'] as
                    | { next?: { provider?: string; model?: string; reasoningEffort?: string } | null; lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null }
                    | undefined;
                current = sel?.next ?? sel?.lastUsed ?? undefined;
            } catch {
                // 投影读不到不阻塞
            }
        }
        return {
            current: current ?? catalog.default,
            groups: catalog.groups,
            failures: catalog.failures,
        };
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

    /** 列出 dsh 支持的 agent 模式（当前会话仍按投影 agentPreset 单独读） */
    async listAgentPresets(): Promise<DshAgentPresetRoster> {
        return listAgentPresetsRpc();
    }

    /**
     * 读上游「设置 → 对话显示」（紧凑/标准）。
     * 只读透传：读不到返回 undefined，调用方应保留上次值，别拿它当默认值（那会把读失败伪装成用户选择）。
     */
    async readTranscriptView(): Promise<DshTranscriptView | undefined> {
        return readTranscriptViewRpc();
    }

    /** 最近一次读到的对话显示形态（新面板回填用，省一次 RPC） */
    getCachedTranscriptView(): DshTranscriptView | undefined {
        return getCachedTranscriptViewRpc();
    }

    /** 订阅上游「设置 → 对话显示」变更（emit 实时跟随 + 重连后重读对齐）；返回退订函数 */
    subscribeTranscriptView(cb: (value: DshTranscriptView) => void): () => void {
        return subscribeTranscriptViewRpc(cb);
    }

    /** 切换当前会话的 agent 模式（仅空白会话可切，后端会拒绝已开始的会话） */
    async switchAgentPreset(agentPreset: string): Promise<string> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法切换模式');
        }
        const sid = await this.getSession();
        return selectAgentPresetRpc(sid, agentPreset);
    }

    /**
     * 读取图片附件字节（会话内**被引用过**的附件；供聊天页图片卡按需取，见 webview 的附件大类）。
     * @param attachmentId - 结果 image 块里的 `attachment.attachmentId` 原值（不透明，不解析）。
     * @returns 媒体类型 + 裸 base64。
     */
    async readImageAttachment(attachmentId: string): Promise<{ mediaType: string; data: string }> {
        const sid = await this.getSession();
        return readSessionAttachment(sid, attachmentId);
    }

    /** 切换权限预设：执行 /permission 斜杠命令（走 commands/execute 斜杠端点，勿用 session.prompt 文本） */
    async setPermissionPreset(preset: string): Promise<void> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法切换权限');
        }
        const sid = await this.getSession();
        const exec = await runSessionCommand(sid, `/permission ${preset}`);
        if (!exec || exec.result?.kind === 'error') {
            throw new Error(exec?.result?.text || `未知权限预设：${preset}`);
        }
    }

    /** 对话：确保 DSH 在运行，发消息到共享会话，等 AI 回复 */
    async ask(text: string, opts: { isCancelled?: () => boolean } = {}): Promise<string> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法对话');
        }
        const sid = await this.getSession();
        return askInSession(sid, text, opts);
    }

    /** 响应审批：允许一次 / 拒绝（rc.1 走 $events 流应答） */
    async approvalResponse(approvalId: string, allow: boolean): Promise<void> {
        const handled = await dshEvents.approve(approvalId, allow ? 'allowed-once' : 'rejected');
        if (!handled) {
            throw new Error('未找到对应的审批请求（可能已过期或已在网页端处理），请到 dsh 网页面板确认');
        }
    }

    /** 流式对话：增量回调 onDelta / onReasoning / onActivity / onQuestion，返回完整文本 + 统计 */
    async askStreaming(
        content: DshContentPart[],
        onDelta: (delta: string) => void,
        opts: {
            onReasoning?: (delta: string, step?: number, index?: number) => void;
            onActivity?: (a: DshActivity) => void;
            onApproval?: (a: DshApproval) => void;
            onQuestion?: (q: DshQuestionRequest) => void;
            /** 提问已失效（$events 流断，pending 作废）：UI 应关掉对应弹窗，别留成死窗口 */
            onQuestionClosed?: (rpcId: string) => void;
            onContext?: (c: DshContext) => void;
            onSystemPrompt?: (s: DshSystemPrompt) => void;
            /** 正文整段覆盖（上游瞬态增量被放弃时撤回半截文本，见 stream.ts 的 attempt 生命周期） */
            onTextReset?: (full: string) => void;
            isCancelled?: () => boolean;
        } = {}
    ): Promise<{ text: string; stats: DshReplyStats; time?: number; end?: { kind: string; message?: string }; counts?: DshTurnCounts }> {
        if (!(await this.ensureRunning())) {
            throw new Error('DSH 服务不可用，无法对话');
        }
        const sid = await this.getSession();
        const unsubscribe = dshEvents.subscribe(sid, {
            onApproval: (request) => {
                opts.onApproval?.({
                    approvalId: request.eventId,
                    sessionId: request.agentId,
                    toolName: request.toolName,
                    description: request.reason, // reason 为真实原因；无则 UI 用 toolName 拼提示
                });
            },
            onQuestion: (request) => {
                opts.onQuestion?.({
                    rpcId: request.eventId,
                    sessionId: request.agentId,
                    questions: request.questions,
                });
            },
            // $events 流断时上游会给每个 pending 提问回调一次：此刻它已无法应答，
            // 让 UI 关掉弹窗（否则用户点取消只会得到「未找到对应的提问」）
            onCancel: (eventId) => {
                opts.onQuestionClosed?.(eventId);
            },
        });
        try {
            return await askInSessionStreaming(sid, content, onDelta, opts);
        } finally {
            unsubscribe();
        }
    }

    /** 回答 ask_user_question（rc.1 走 $events 流应答） */
    async answerQuestion(
        rpcId: string,
        sessionId: string,
        answers: Array<{ id: string; selected: string[]; custom?: string }>
    ): Promise<void> {
        const handled = await dshEvents.answerQuestion(rpcId, answers);
        if (!handled) {
            throw new Error('未找到对应的提问（可能已过期或已在网页端处理），请到 dsh 网页面板确认');
        }
    }

    /** 取消 ask_user_question（rc.1 以 UserQuestionError/ASK_CANCELLED 拒绝该 waterfall） */
    async cancelQuestion(rpcId: string, sessionId: string): Promise<void> {
        const handled = await dshEvents.cancelQuestion(rpcId);
        if (!handled) {
            throw new Error('未找到对应的提问（可能已过期或已在网页端处理），请到 dsh 网页面板确认');
        }
    }

}
