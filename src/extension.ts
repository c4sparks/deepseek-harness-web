// DeepSeek Harness Web 扩展装配层：注册命令、拼装各层。
//   服务层：src/api/dshService.ts（进程/会话/对话/面板，UI 唯一依赖）
//   API 层：src/api/dshApi.ts（RPC 传输，全量 DSH API）
//   UI 层：侧边栏对话视图（本文件内，后续可换 TinyRobot）+ DSH 网页面板
import * as vscode from 'vscode';
import * as path from 'path';
import { DshService } from './api/dshService';
import { type DshContentPart, type DshReplyStats } from './dshApi';

// 服务实例（UI 层唯一依赖）
const dsh = new DshService();

/** 需要弹窗警告确认后才能切换的危险权限预设（value 集合） */
const DANGEROUS_PERMS = new Set<string>(['danger-full-access']);

// 侧边栏对话视图引用（右键 @ 代码进输入框用）
let launcherView: vscode.WebviewView | undefined;
let pendingDraft: string | undefined;

// ---------- 对话视图（UI 层：消息区 + 输入框） ----------

/** 对话视图 HTML */
function getChatContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; font-family: var(--vscode-font-family); }
        body { display: flex; flex-direction: column; }
        #messages { flex: 1; overflow-y: auto; padding: 8px; box-sizing: border-box; }
        .msg { margin-bottom: 10px; font-size: 12px; line-height: 1.6; }
        .msg .role { font-size: 11px; opacity: 0.7; margin-bottom: 2px; }
        .msg.user .role { color: var(--vscode-charts-blue, #75beff); }
        .msg.ai .role { color: var(--vscode-charts-green, #89d185); }
        .msg .body { white-space: pre-wrap; word-break: break-word; }
        .msg.ai .body { background: rgba(255,255,255,0.06); border-radius: 4px; padding: 6px 8px; }
        #composer { display: flex; gap: 6px; padding: 8px; box-sizing: border-box; border-top: 1px solid rgba(255,255,255,0.12); }
        #input {
            flex: 1; resize: none; min-height: 44px; box-sizing: border-box;
            border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; padding: 6px 8px;
            font-family: var(--vscode-editor-font-family, sans-serif); font-size: 12px;
            color: var(--vscode-editor-foreground, #ddd); background: var(--vscode-input-background, #252526); outline: none;
        }
        #input:focus { border-color: var(--vscode-focusBorder, #4daafc); }
        #send {
            border: 1px solid transparent; border-radius: 4px; padding: 0 12px; cursor: pointer;
            background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); font-size: 12px;
        }
        #send:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    </style>
</head>
<body>
    <div id="messages"></div>
    <div id="composer">
        <textarea id="input" placeholder="发消息给 DSH（Ctrl+Enter 发送）"></textarea>
        <button id="send">发送</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const messages = document.getElementById('messages');
        const input = document.getElementById('input');

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = 'msg ' + role;
            const r = document.createElement('div');
            r.className = 'role';
            r.textContent = role === 'user' ? '你' : 'DSH';
            const b = document.createElement('div');
            b.className = 'body';
            b.textContent = text;
            div.appendChild(r);
            div.appendChild(b);
            messages.appendChild(div);
            messages.scrollTop = messages.scrollHeight;
        }

        function send() {
            const t = input.value.trim();
            if (!t) return;
            appendMsg('user', t);
            input.value = '';
            vscode.postMessage({ type: 'chatSend', text: t });
        }
        document.getElementById('send').addEventListener('click', send);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); send(); }
        });

        let aiText = '';
        let aiEl = null;
        window.addEventListener('message', (e) => {
            const m = e.data;
            if (m.type === 'draft') {
                input.value = input.value ? input.value + '\\n' + m.text : m.text;
                input.focus();
            } else if (m.type === 'chatChunk') {
                if (!aiEl) { appendMsg('ai', ''); aiEl = messages.lastElementChild.querySelector('.body'); }
                aiText += m.text || '';
                aiEl.textContent = aiText;
            } else if (m.type === 'chatDone') {
                aiEl = null;
                aiText = '';
            } else if (m.type === 'clear') {
                messages.innerHTML = '';
                aiEl = null;
                aiText = '';
            }
        });
    </script>
</body>
</html>`;
}

/** 单条消费记录 */
interface UsageRecord {
    time: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
}

/** 记录一次对话的消费到持久化存储 */
async function recordUsage(state: vscode.Memento, stats: DshReplyStats | undefined): Promise<void> {
    if (!stats) {
        return;
    }
    const key = 'dsh.usage';
    const record: UsageRecord = {
        time: Date.now(),
        inputTokens: stats.inputTokens ?? 0,
        outputTokens: stats.outputTokens ?? 0,
        cacheReadTokens: stats.cacheReadTokens ?? 0,
        reasoningTokens: stats.reasoningTokens ?? 0,
    };
    const existing = state.get<UsageRecord[]>(key) ?? [];
    const next = [...existing, record].slice(-500);
    await state.update(key, next);
}

/** 打开消费记录报告面板（弹窗展示） */
async function openUsageReport(state: vscode.Memento): Promise<void> {
    const records = state.get<UsageRecord[]>('dsh.usage') ?? [];
    const panel = vscode.window.createWebviewPanel(
        'dshUsage',
        '消费记录',
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );
    const total = records.reduce(
        (a, r) => ({
            i: a.i + r.inputTokens,
            o: a.o + r.outputTokens,
            c: a.c + r.cacheReadTokens,
            r: a.r + r.reasoningTokens,
        }),
        { i: 0, o: 0, c: 0, r: 0 }
    );
    let rows: string;
    if (records.length === 0) {
        rows = '<tr><td colspan="5" style="text-align:center;color:#888">暂无记录</td></tr>';
    } else {
        rows = [...records]
            .reverse()
            .map(
                (r) =>
                    `<tr><td>${new Date(r.time).toLocaleString()}</td><td>${r.inputTokens}</td><td>${r.outputTokens}</td><td>${r.cacheReadTokens}</td><td>${r.reasoningTokens}</td></tr>`
            )
            .join('');
    }
    panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 12px; color: var(--vscode-foreground, #ddd); font-size: 13px; }
    h1 { font-size: 15px; margin: 0 0 8px; }
    .summary { margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid rgba(255,255,255,0.12); padding: 4px 8px; text-align: right; }
    th:first-child, td:first-child { text-align: left; }
    th { background: rgba(255,255,255,0.06); }
</style>
</head>
<body>
<h1>消费记录</h1>
<div class="summary"><strong>${records.length} 条对话</strong> · 总输入 ${total.i} · 总输出 ${total.o} · 缓存 ${total.c} · 推理 ${total.r} tok</div>
<table><tr><th>时间</th><th>输入 tok</th><th>输出 tok</th><th>缓存 tok</th><th>推理 tok</th></tr>${rows}</table>
</body>
</html>`;
}

/** Activity Bar 对话视图：点图标自动打开 DSH 面板；内容区为对话（TinyRobot / 回退自绘） */
/** 当前活动的聊天 webview（侧边栏视图或编辑器面板），供右键 @代码 / 新会话 投递 */
let chatTarget: vscode.Webview | undefined;
/** 编辑器区的聊天面板（移动到编辑器后创建），供"回到侧边栏"关闭 */
let chatPanel: vscode.WebviewPanel | undefined;

/** 加载聊天 HTML 到 webview（重写资源 + CSP；缺失回退自绘） */
async function loadChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<void> {
    const chatRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'chat');
    try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(chatRoot, 'index.html'));
        let html = new TextDecoder('utf-8').decode(content);
        html = html.replace(/\s+crossorigin/g, '');
        html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_match, attr: string, p: string) => {
            const asset = vscode.Uri.joinPath(chatRoot, p);
            return `${attr}="${webview.asWebviewUri(asset)}"`;
        });
        const csp =
            `default-src 'none'; ` +
            `script-src ${webview.cspSource} 'wasm-unsafe-eval'; ` +
            `style-src ${webview.cspSource} 'unsafe-inline'; ` +
            `font-src ${webview.cspSource} data:; ` +
            `img-src ${webview.cspSource} data: https:; ` +
            `connect-src ${webview.cspSource} https: http:;`;
        html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
        webview.html = html;
    } catch {
        webview.html = getChatContent();
    }
}

/** 拉取会话官方投影（统计/权限）+ 模型列表，推给 webview */
async function postChatInfo(webview: vscode.Webview): Promise<void> {
    try {
        const projections = await dsh.getProjections();
        let models: { current?: unknown; groups?: unknown[] } = {};
        try {
            models = await dsh.listModels();
        } catch {
            // 模型列表失败不阻塞统计
        }
        void webview.postMessage({ type: 'chatInfo', projections, models });
    } catch {
        // 服务未就绪时静默
    }
}

/** 聊天 webview 统一接线：加载 UI + 处理消息（聊天/停止/文件/复制/工作区）。侧边栏和编辑器面板共用。 */
function setupChatWebview(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    globalState: vscode.Memento
): void {
    webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'chat')],
    };
    chatTarget = webview;
    void loadChatHtml(webview, extensionUri);
    // 打开视图即确保 DSH 运行 + 解析文件夹工作区；工作区/会话/统计彼此独立推送，互不阻塞
    void (async () => {
        try {
            await dsh.ensureRunning();
            await dsh.ensureWorkspaceForFolder();
        } catch {
            // 服务不可用：后续命令会再触发
        }
        await Promise.allSettled([postChatInfo(webview)]);
    })();
    // 右键 @代码 草稿补投
    if (pendingDraft) {
        void webview.postMessage({ type: 'draft', text: pendingDraft });
        pendingDraft = undefined;
    }

    const gen = { n: 0 };
    const post = (msg: unknown) => {
        void webview.postMessage(msg);
    };

    webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'chatSend') {
            const g = gen.n;
            void (async () => {
                try {
                    // 组装内容块：文本 + 图片（base64）
                    const parts: DshContentPart[] = [];
                    if (msg.text) {
                        parts.push({ type: 'text', text: msg.text });
                    }
                    for (const img of (msg.images ?? []) as Array<{ mediaType: string; data: string; name?: string }>) {
                        parts.push({
                            type: 'image',
                            mediaType: img.mediaType,
                            data: img.data,
                            name: img.name,
                        } as DshContentPart);
                    }
                    if (parts.length === 0) {
                        return;
                    }
                    const result = await dsh.askStreaming(
                        parts,
                        (delta) => {
                            if (g === gen.n) {
                                post({ type: 'chatChunk', text: delta });
                            }
                        },
                        {
                            onReasoning: (r, step) => {
                                if (g === gen.n) {
                                    post({ type: 'chatReasoning', text: r, step });
                                }
                            },
                            onActivity: (a) => {
                                if (g === gen.n) {
                                    post({ type: 'chatActivity', activity: a });
                                }
                            },
                            onApproval: (a) => {
                                if (g === gen.n) {
                                    post({
                                        type: 'chatApproval',
                                        approvalId: a.approvalId,
                                        description: a.description,
                                    });
                                }
                            },
                            onQuestion: (q) => {
                                if (g === gen.n) {
                                    post({
                                        type: 'chatQuestion',
                                        rpcId: q.rpcId,
                                        sessionId: q.sessionId,
                                        questions: q.questions,
                                    });
                                }
                            },
                        }
                    );
                    if (g !== gen.n) {
                        return; // 已取消
                    }
                    post({ type: 'chatDone', text: result.text, stats: result.stats });
                    await recordUsage(globalState, result.stats);
                    void postChatInfo(webview); // 刷新官方统计/权限
                } catch (e) {
                    if (g !== gen.n) {
                        return;
                    }
                    post({ type: 'chatChunk', text: '⚠ ' + (e as Error).message });
                    post({ type: 'chatDone' });
                }
            })();
        } else if (msg.type === 'cancel') {
            gen.n++; // 使进行中的流失效
            void (async () => {
                try {
                    const sid = await dsh.getSession();
                    await dsh.call('session.cancel', { sessionId: sid });
                } catch {
                    // 取消失败忽略
                }
            })();
            post({ type: 'chatDone' });
        } else if (msg.type === 'pickFile') {
            void (async () => {
                const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: '添加到 dsh 对话' });
                if (picked) {
                    for (const uri of picked) {
                        post({ type: 'filePicked', path: uri.fsPath });
                    }
                }
            })();
        } else if (msg.type === 'copy') {
            void vscode.env.clipboard.writeText(msg.text ?? '');
            vscode.window.showInformationMessage('已复制');
        } else if (msg.type === 'approvalResponse') {
            void (async () => {
                try {
                    await dsh.approvalResponse(msg.approvalId, !!msg.allow);
                } catch (e) {
                    // 本地应答失败（如缺少 rpcId / 服务端拒绝）：提示用户去网页面板处理
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'questionResponse') {
            void (async () => {
                try {
                    await dsh.answerQuestion(msg.rpcId, msg.sessionId, msg.answers);
                } catch (e) {
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'questionCancel') {
            void (async () => {
                try {
                    await dsh.cancelQuestion(msg.rpcId, msg.sessionId);
                } catch (e) {
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'chatSelectModel') {
            void (async () => {
                try {
                    await dsh.selectModel(msg.provider, msg.model, msg.reasoningEffort || undefined);
                    await postChatInfo(webview);
                    vscode.window.showInformationMessage('已切换模型');
                } catch (e) {
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'chatSelectPermission') {
            void (async () => {
                try {
                    // 危险权限（如完全访问）需弹窗警告确认
                    if (DANGEROUS_PERMS.has(msg.preset)) {
                        const choice = await vscode.window.showWarningMessage(
                            `切换到「完全访问」（${msg.preset}）将允许 dsh 无审批地访问本机文件与执行命令。确定切换？`,
                            { modal: true },
                            '确定切换',
                            '取消'
                        );
                        if (choice !== '确定切换') {
                            return;
                        }
                    }
                    await dsh.setPermissionPreset(msg.preset);
                    await postChatInfo(webview);
                    vscode.window.showInformationMessage(`已切换权限：${msg.preset}`);
                } catch (e) {
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        }
    });
}

/** 聊天从编辑器面板回到侧边栏：关面板 + 打开侧边栏 + 聚焦聊天视图 */
async function moveChatBackToSidebar(): Promise<void> {
    chatPanel?.dispose();
    chatPanel = undefined;
    await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
    await vscode.commands.executeCommand('workbench.view.extension.dsh');
}

/** Activity Bar 对话视图（侧边栏） */
class DshLauncherProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly globalState: vscode.Memento
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        launcherView = view;
        setupChatWebview(view.webview, this.extensionUri, this.globalState);
        view.onDidDispose(() => {
            if (launcherView === view) {
                launcherView = undefined;
            }
        });
    }
}

// ---------- 选中代码处理（右键） ----------

/** 读取当前编辑器选中内容；无选中返回 undefined 并提示 */
async function requireSelection(): Promise<{ editor: vscode.TextEditor; selection: vscode.Selection; text: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('请先打开一个文件并选中代码');
        return;
    }
    const text = editor.document.getText(editor.selection).trim();
    if (!text) {
        vscode.window.showWarningMessage('请先选中要处理的代码');
        return;
    }
    return { editor, selection: editor.selection, text };
}

interface SelectionContext {
    editor: vscode.TextEditor;
    selection: vscode.Selection;
    text: string;
}

/** 组装发送给 DSH 的提示词：指令 + 代码文件信息 + 选中代码 */
function buildPrompt(ctx: SelectionContext, instruction: string, noWriteHint: boolean): string {
    const lines = [
        instruction,
        '',
        `代码文件：${path.basename(ctx.editor.document.uri.fsPath)}（语言 ${ctx.editor.document.languageId}）`,
        '',
        '```' + ctx.editor.document.languageId,
        ctx.text,
        '```',
    ];
    if (noWriteHint) {
        lines.push('', '请直接给出文本结果，不要修改磁盘上的任何文件。');
    }
    return lines.join('\n');
}

interface ApplyItem extends vscode.QuickPickItem {
    action: 'replace' | 'insert' | 'copy' | 'open';
}

/** 拿到 AI 回复后，让用户选择如何应用 */
async function showApplyOptions(reply: string, ctx: SelectionContext, allowReplace: boolean): Promise<void> {
    const items: ApplyItem[] = [
        ...(allowReplace
            ? [{ label: '$(symbol-event) 替换选中的代码', description: '用 AI 结果覆盖选中区域', action: 'replace' as const }]
            : []),
        { label: '$(insert) 插入到光标处', description: '把结果插到光标位置', action: 'insert' as const },
        { label: '$(copy) 复制到剪贴板', description: '复制 AI 回复全文', action: 'copy' as const },
        { label: '$(new-file) 在新编辑器标签打开', description: '不修改当前文件', action: 'open' as const },
    ];
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: allowReplace ? 'AI 处理完成，选择如何应用结果' : 'AI 回答完成，选择如何处理',
    });
    if (!pick) {
        return;
    }
    switch (pick.action) {
        case 'replace':
            await ctx.editor.edit((b) => b.replace(ctx.selection, reply));
            break;
        case 'insert':
            await ctx.editor.edit((b) => b.insert(ctx.selection.active, reply));
            break;
        case 'copy':
            await vscode.env.clipboard.writeText(reply);
            vscode.window.showInformationMessage('已复制到剪贴板');
            break;
        case 'open': {
            const doc = await vscode.workspace.openTextDocument({
                content: reply,
                language: ctx.editor.document.languageId,
            });
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
            break;
        }
    }
}

/** 把提示词发给本地 DSH，拿到 AI 回复后提供应用选项 */
async function runDshTask(prompt: string, ctx: SelectionContext, mode: 'apply' | 'ask'): Promise<void> {
    if (!(await dsh.ensureRunning())) {
        return;
    }
    let reply: string;
    try {
        reply = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: mode === 'apply' ? 'DSH 正在处理选中的代码…' : 'DSH 正在回答…',
                cancellable: true,
            },
            (_, token) => dsh.ask(prompt, { isCancelled: () => token.isCancellationRequested })
        );
    } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
        return;
    }
    if (!reply) {
        return;
    }
    await showApplyOptions(reply, ctx, mode === 'apply');
}

// ---------- 标题栏"工作区"面板 ----------

type WsPick = vscode.QuickPickItem & {
    action?: 'info' | 'workspace' | 'new' | 'session';
    workspaceId?: string;
    sessionId?: string;
};

/**
 * 标题栏"工作区"面板：显示当前工作区、列出全部工作区（切换）、新建工作区、
 * 以及当前工作区的会话（恢复历史）。工作区在面板顶部显示"工作区：xxx"。
 */
async function showWorkspacePicker(): Promise<void> {
    if (!(await dsh.ensureRunning())) {
        return;
    }
    try {
        await dsh.ensureWorkspaceForFolder();
    } catch {
        // 忽略：仍可展示已列出的工作区
    }
    const list = await dsh.listWorkspaces();
    const workspaces = list.items ?? [];
    const currentId = dsh.getCurrentWorkspaceId();
    const curWs = workspaces.find((w) => w.workspaceId === currentId);
    const sessions = currentId ? await dsh.listWorkspaceSessions(currentId) : [];

    const items: WsPick[] = [
        {
            label: `$(folder-opened) 工作区：${curWs?.title || curWs?.path || '未分组'}`,
            description: currentId ? '当前' : '未选择',
            action: 'info',
            alwaysShow: true,
        },
        { label: '工作区', kind: vscode.QuickPickItemKind.Separator },
    ];
    for (const w of workspaces) {
        const isCurrent = w.workspaceId === currentId;
        items.push({
            label: `${isCurrent ? '$(check) ' : ''}${w.title || w.path}`,
            description: isCurrent ? '当前' : w.path,
            action: 'workspace',
            workspaceId: w.workspaceId,
            alwaysShow: true,
        });
    }
    items.push({ label: '$(new-folder) ＋ 新建工作区…', action: 'new', alwaysShow: true });

    if (sessions.length > 0) {
        items.push({
            label: `恢复会话（${curWs?.title || '当前工作区'}）`,
            kind: vscode.QuickPickItemKind.Separator,
        });
        for (const s of sessions) {
            items.push({
                label: `${s.running ? '$(sync~spin) ' : '$(history) '}${s.title}`,
                description: s.running ? '运行中' : '',
                action: 'session',
                sessionId: s.sessionId,
            });
        }
    }

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: '选择工作区 / 新建工作区 / 恢复会话',
        matchOnDescription: true,
    });
    if (!pick || !pick.action) {
        return;
    }
    try {
        if (pick.action === 'workspace' && pick.workspaceId) {
            dsh.setCurrentWorkspace(pick.workspaceId);
            await dsh.newSession(pick.workspaceId);
            chatTarget?.postMessage({ type: 'clear' });
            if (chatTarget) {
                void postChatInfo(chatTarget);
            }
            vscode.window.showInformationMessage('已切换工作区');
        } else if (pick.action === 'new') {
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                openLabel: '作为 dsh 工作区',
            });
            if (!picked || picked.length === 0) {
                return;
            }
            const dir = picked[0].fsPath;
            const created = await dsh.createWorkspace(dir);
            dsh.setCurrentWorkspace(created.workspace.workspaceId);
            await dsh.newSession(created.workspace.workspaceId);
            chatTarget?.postMessage({ type: 'clear' });
            if (chatTarget) {
                void postChatInfo(chatTarget);
            }
            vscode.window.showInformationMessage(`已新建并切换到工作区：${created.workspace.title || dir}`);
        } else if (pick.action === 'session' && pick.sessionId) {
            const messages = await dsh.restoreSession(pick.sessionId);
            chatTarget?.postMessage({ type: 'clear' });
            chatTarget?.postMessage({ type: 'chatHistory', messages, sessionId: pick.sessionId });
            if (chatTarget) {
                void postChatInfo(chatTarget);
            }
        }
    } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
    }
}

// ---------- 激活入口（薄装配） ----------

export function activate(context: vscode.ExtensionContext) {
    // 命令：打开 DSH 网页面板
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.open', async () => {
            if (await dsh.ensureRunning()) {
                dsh.openPanel();
            }
        })
    );

    // 命令：用 DSH 处理选中代码（可替换/插入）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.applySelected', async () => {
            const ctx = await requireSelection();
            if (!ctx) {
                return;
            }
            const instruction = await vscode.window.showInputBox({
                prompt: '要让 DSH 对选中的代码做什么？',
                placeHolder: '例如：重构这段代码 / 解释这段代码 / 写单元测试 / 修复 bug',
                value: '重构这段代码',
            });
            if (instruction === undefined) {
                return;
            }
            await runDshTask(buildPrompt(ctx, `请对下面的选中代码执行：${instruction}`, true), ctx, 'apply');
        })
    );

    // 命令：关于选中代码提问（只回答，不改码）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.askSelected', async () => {
            const ctx = await requireSelection();
            if (!ctx) {
                return;
            }
            const question = await vscode.window.showInputBox({
                prompt: '针对选中的代码提问：',
                placeHolder: '例如：这段代码有什么问题？这段逻辑是做什么的？',
            });
            if (question === undefined) {
                return;
            }
            await runDshTask(buildPrompt(ctx, `针对下面的选中代码回答问题：${question}`, false), ctx, 'ask');
        })
    );

    // 命令：把选中代码 @ 进侧边栏对话输入框
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.sendToDsh', async () => {
            const ctx = await requireSelection();
            if (!ctx) {
                return;
            }
            const code = '```' + ctx.editor.document.languageId + '\n' + ctx.text + '\n```';
            await vscode.commands.executeCommand('workbench.view.extension.dsh');
            if (chatTarget) {
                chatTarget.postMessage({ type: 'draft', text: code });
            } else {
                pendingDraft = code;
            }
        })
    );

    // 命令：标题栏"工作区"面板（选/建工作区 + 恢复会话）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.workspace', () => showWorkspacePicker())
    );

    // 命令：开启新会话（需先选工作区）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.newSession', async () => {
            if (!(await dsh.ensureRunning())) {
                return;
            }
            if (!dsh.getCurrentWorkspaceId()) {
                // 未选工作区：先进入工作区面板选择
                await showWorkspacePicker();
                return;
            }
            await dsh.newSession();
            chatTarget?.postMessage({ type: 'clear' });
            if (chatTarget) {
                void postChatInfo(chatTarget);
            }
            vscode.window.showInformationMessage('已开启新会话');
        })
    );

    // 命令：在浏览器中打开 DSH
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.openInBrowser', () => dsh.openInBrowser())
    );

    // 命令：在本地打开 DSH
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.openInEditor', () => dsh.openInEditor())
    );

    // 命令：刷新所有 DSH 面板
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.reload', () => dsh.reloadPanels())
    );

    // 命令：关闭侧边栏（标题栏 👁）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.closeSidebar', () => {
            vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
        })
    );

    // 命令：把聊天对话移动到编辑器区（大面板，可全屏）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.moveToEditor', () => {
            const panel = vscode.window.createWebviewPanel(
                'dshChatPanel',
                'DeepSeek Harness',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );
            chatPanel = panel;
            panel.onDidDispose(() => {
                if (chatPanel === panel) {
                    chatPanel = undefined;
                }
            });
            setupChatWebview(panel.webview, context.extensionUri, context.globalState);
            panel.reveal(vscode.ViewColumn.One, true);
            // 隐藏侧边栏，看起来"挪过去"了
            vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
        })
    );

    // 命令：聊天回到侧边栏
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.moveToSidebar', () => {
            void moveChatBackToSidebar();
        })
    );

    // 初始化上下文（视图标题栏按钮显隐依据）
    vscode.commands.executeCommand('setContext', 'dshViewMode', dsh.viewMode);
    vscode.commands.executeCommand('setContext', 'dshPanelOpen', false);

    // 命令：查看消费记录（弹窗报告面板）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.usage', () => openUsageReport(context.globalState))
    );

    // Activity Bar 对话视图
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'dsh.launcher',
            new DshLauncherProvider(context.extensionUri, context.globalState)
        )
    );
}

// 扩展停用时回收后台进程
export function deactivate() {
    dsh.dispose();
}
