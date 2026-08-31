// DeepSeek Harness Web 扩展入口
// 壳子 + 本地调用：管理 DSH 进程生命周期，通过 iframe 嵌入 DSH Web GUI
import * as vscode from 'vscode';
import * as net from 'net';
import { spawn, execFile, type ChildProcess, type SpawnOptions, type StdioOptions } from 'child_process';
import * as os from 'os';

// DSH 服务默认端口与 Node 版本要求
const DSH_PORT = 3080;
const DSH_URL = `http://127.0.0.1:${DSH_PORT}`;
const NODE_REQUIREMENT = '^22.19.0 || >=24.0.0';

// 由本插件管理的 DSH 进程状态
let dshProcess: ChildProcess | null = null;
let dshStartedByUs = false;          // 当前运行的 DSH 是否由本插件拉起
let dshStderr = '';                  // 记录 DSH 启动时的错误输出
let starting = false;                // 启动互斥锁，防止重复拉起
const openPanels = new Set<vscode.WebviewPanel>();

/** 检查端口是否已被占用 */
function checkPort(port: number, host = '127.0.0.1', timeout = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeout);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}

/** 轮询等待端口就绪 */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await checkPort(port, '127.0.0.1', 800)) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/** DSH 要求 Node ^22.19.0 || >=24.0.0 */
function isNodeCompatible(version: string): boolean {
    const [major, minor] = version.split('.').map((s) => parseInt(s, 10));
    if (major === 22) {
        return minor >= 19;
    }
    return major >= 24;
}

/** 检测系统 Node.js 是否可用且版本满足要求 */
function checkSystemNode(): Promise<{ ok: boolean; version?: string }> {
    return new Promise((resolve) => {
        execFile('node', ['--version'], (err, stdout) => {
            if (err) {
                resolve({ ok: false });
                return;
            }
            const version = (stdout || '').trim().replace(/^v/, '');
            resolve({ ok: isNodeCompatible(version), version });
        });
    });
}

/** 后台启动 DSH 服务（npx 自动拉取，无需用户全局安装） */
function spawnDsh(): Promise<void> {
    return new Promise((resolve, reject) => {
        const isWin = process.platform === 'win32';
        const args = ['--yes', '@deepseek-ai/dsh', 'web', '--no-open'];
        const opts: SpawnOptions = {
            cwd: os.homedir(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'] as StdioOptions,
            ...(isWin ? {} : { detached: true }), // 非 Windows 创建独立进程组，便于整组清理
        };
        // Windows 下 npx 是 .cmd，需经 cmd.exe 执行
        let child: ChildProcess;
        if (isWin) {
            child = spawn('cmd.exe', ['/c', 'npx', ...args], opts);
        } else {
            child = spawn('npx', args, opts);
        }
        dshProcess = child;
        dshStderr = '';
        child.stdout?.on('data', () => { /* 消费输出，防止缓冲区阻塞 */ });
        child.stderr?.on('data', (d: Buffer) => { dshStderr += d.toString(); });
        child.once('spawn', () => resolve());
        child.once('error', (err) => reject(err));
    });
}

/** 杀掉由本插件启动的 DSH 进程树 */
function killDshIfOwned() {
    const child = dshProcess;
    if (!child || !child.pid || !dshStartedByUs) {
        dshProcess = null;
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
    dshProcess = null;
    dshStartedByUs = false;
}

/** Webview 页面：iframe 嵌入 DSH Web GUI（显式 CSP 允许本地回环地址） */
function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; frame-src http://127.0.0.1:${DSH_PORT}; style-src 'unsafe-inline';">
</head>
<body style="margin:0; padding:0; height:100vh; overflow:hidden;">
    <iframe src="${DSH_URL}" width="100%" height="100%" frameborder="0" style="border:none;"></iframe>
</body>
</html>`;
}

function createPanel() {
    // 通过设置项控制隐藏时是否保留 Webview 上下文（默认 false 更省内存）
    const retain = vscode.workspace.getConfiguration('dsh').get<boolean>('retainContextWhenHidden', false);
    const panel = vscode.window.createWebviewPanel(
        'dshWebview',
        'DeepSeek Harness',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: retain }
    );
    panel.webview.html = getWebviewContent();
    openPanels.add(panel);
    panel.onDidDispose(() => {
        openPanels.delete(panel);
        // 所有面板都关闭后才清理后台进程，避免误杀仍在使用的服务
        if (openPanels.size === 0) {
            killDshIfOwned();
        }
    });
    return panel;
}

// 激活入口：注册命令，管理 DSH 进程生命周期
export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('dsh.open', async () => {
        // 1. 端口已占用：DSH 已在运行，直接打开
        if (await checkPort(DSH_PORT)) {
            createPanel();
            return;
        }
        if (starting) {
            vscode.window.showInformationMessage('DSH 服务正在启动中，请稍候…');
            return;
        }
        starting = true;
        try {
            // 2. 检查系统 Node.js
            const node = await checkSystemNode();
            if (!node.ok) {
                const pick = await vscode.window.showErrorMessage(
                    `未检测到可用的 Node.js（要求 ${NODE_REQUIREMENT}），启动 DSH 需要 Node 环境。`,
                    '打开 Node.js 官网',
                    '取消'
                );
                if (pick === '打开 Node.js 官网') {
                    vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
                }
                return;
            }
            // 3. 启动 DSH（npx 自动拉取）
            try {
                await spawnDsh();
                dshStartedByUs = true;
            } catch (e) {
                vscode.window.showErrorMessage(`启动 DSH 失败：${(e as Error).message}`);
                return;
            }
            // 4. 等待服务就绪（首次会拉取依赖并初始化，超时放宽）
            const ready = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在启动 DeepSeek Harness 服务…' },
                () => waitForPort(DSH_PORT, 90_000)
            );
            if (!ready) {
                const hint = (dshStderr.trim().split('\n').pop() || '未知错误').trim();
                vscode.window.showErrorMessage(`DSH 启动超时：${hint}`);
                killDshIfOwned();
                return;
            }
            // 5. 打开内嵌面板
            createPanel();
        } finally {
            starting = false;
        }
    });

    context.subscriptions.push(disposable);
}

// 扩展停用时清理后台进程
export function deactivate() {
    killDshIfOwned();
}
