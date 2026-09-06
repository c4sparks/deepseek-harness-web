// 扩展装配层：注册命令、拼装各层。
//   服务层：src/api/dshService.ts（dsh 进程/会话/对话编排）
//   dsh 层：src/dsh/（api / events / webProxy，门面 src/dsh/index.ts）
//   UI 层：侧边栏对话视图（本文件内）+ DSH 网页面板（src/dshPanel.ts）
import * as vscode from 'vscode';
import * as path from 'path';
import { DshService } from './api/dshService';
import { type DshContentPart, type DshReplyStats } from './dsh';
import { DshPanel } from './dshPanel';
import {
    applyNativeTitlebarContext,
    TITLEBAR_MODE,
    TITLEBAR_MODE_ATTR,
    installChatTitlebar,
    makeTitlebarPanelBroadcaster,
    type TitlebarChatHost,
    type TitlebarMode,
} from './titlebar/index';

const dsh = new DshService();
const panel = new DshPanel({
    ensureRunning: () => dsh.ensureRunning(),
    // DSH 网页面板开关/查看模式变化 → 广播 panelState（自绘标题栏 webview 消费）。
    // 原生标题栏模式下本函数返回 undefined（走 setContext 喂 package.json when）→ 自动 no-op。
    onPanelStateChange: makeTitlebarPanelBroadcaster((msg) => postToChats(msg)),
});

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

/** 单条消费记录：字段按 dsh 返回原样存（未返回则为空，不补 0） */
interface UsageRecord {
    time: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
}

/** 记录一次对话的消费到持久化存储（time 取 dsh 对该回答的自带时间戳，缺省才用本地时刻） */
async function recordUsage(state: vscode.Memento, stats: DshReplyStats | undefined, apiTime?: number): Promise<void> {
    if (!stats) {
        return;
    }
    const key = 'dsh.usage';
    // epoch 秒/毫秒自适应，统一存毫秒；无 API 时刻才回退本地 Date.now()
    const ts =
        typeof apiTime === 'number' && Number.isFinite(apiTime) && apiTime > 0
            ? (apiTime > 1e12 ? apiTime : apiTime * 1000)
            : Date.now();
    const record: UsageRecord = {
        time: ts,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        reasoningTokens: stats.reasoningTokens,
        totalTokens: stats.totalTokens,
    };
    if (
        record.inputTokens === undefined &&
        record.outputTokens === undefined &&
        record.cacheReadTokens === undefined &&
        record.cacheWriteTokens === undefined &&
        record.reasoningTokens === undefined &&
        record.totalTokens === undefined
    ) {
        return; // 无任何已消耗用量（如停在首个 token 前），不写空行
    }
    const existing = state.get<UsageRecord[]>(key) ?? [];
    const next = [...existing, record].slice(-500);
    await state.update(key, next);
}

/** 打开消费记录报告面板：按自然周/月分组、可折叠（原样展示 dsh 字段，未返回显示 —） */
async function openUsageReport(state: vscode.Memento): Promise<void> {
    const records = state.get<UsageRecord[]>('dsh.usage') ?? [];
    const panel = vscode.window.createWebviewPanel(
        'dshUsage',
        '消费记录',
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );

    // ---- 本地自然日/周/月分组 ----
    const now = new Date();
    const DAY = 86_400_000;
    const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const mondayStart = (d: Date): number => {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
        return x.getTime();
    };
    const todayStart = dayStart(now);
    const curWeekStart = mondayStart(now);
    const prevWeekStart = curWeekStart - 7 * DAY;
    const curMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    const bucketOf = (t: number): string => {
        if (t >= todayStart) {
            return '今天';
        }
        if (t >= todayStart - DAY) {
            return '昨天';
        }
        if (t >= curWeekStart) {
            return '本周';
        }
        if (t >= prevWeekStart) {
            return '上周';
        }
        if (t >= prevMonthStart && t < curMonthStart) {
            return '上个月';
        }
        return '更早';
    };
    const groups = new Map<string, UsageRecord[]>();
    for (const r of records) {
        const lb = bucketOf(r.time);
        const arr = groups.get(lb) ?? [];
        arr.push(r);
        groups.set(lb, arr);
    }
    const ORDER = ['今天', '昨天', '本周', '上周', '上个月', '更早'];

    const fmt = (v: number | undefined): string => (typeof v === 'number' ? String(v) : '—');
    // 大数缩写（仅用于汇总行）：≥1e3 → 1.0K、≥1e6 → 1.2M，更大 → G/T；<1000 显示原值
    const compact = (n: number): string => {
        const abs = Math.abs(n);
        if (abs < 1000) {
            return String(n);
        }
        const table: Array<[number, string]> = [
            [1e12, 'T'],
            [1e9, 'G'],
            [1e6, 'M'],
            [1e3, 'K'],
        ];
        for (const [base, unit] of table) {
            if (abs >= base) {
                return (n / base).toFixed(1) + unit;
            }
        }
        return String(n);
    };
    const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'totalTokens'): number =>
        records.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
    const anyOf = (k: 'cacheWriteTokens' | 'totalTokens'): boolean => records.some((r) => typeof r[k] === 'number');
    const hasCacheWrite = anyOf('cacheWriteTokens');
    const hasTotal = anyOf('totalTokens');
    const summary = [
        `<strong>${records.length} 条对话</strong>`,
        `总输入 ${compact(sum('inputTokens'))}`,
        `总输出 ${compact(sum('outputTokens'))}`,
        `缓存读 ${compact(sum('cacheReadTokens'))}`,
        hasCacheWrite ? `缓存写 ${compact(sum('cacheWriteTokens'))}` : '',
        `推理 ${compact(sum('reasoningTokens'))}`,
        hasTotal ? `合计(totalTokens) ${compact(sum('totalTokens'))}` : '',
    ]
        .filter(Boolean)
        .join(' · ');

    const rowHtml = (r: UsageRecord): string =>
        `<tr><td>${new Date(r.time).toLocaleString()}</td><td>${fmt(r.inputTokens)}</td><td>${fmt(r.outputTokens)}</td>` +
        `<td>${fmt(r.cacheReadTokens)}</td><td>${hasCacheWrite ? fmt(r.cacheWriteTokens) : '—'}</td>` +
        `<td>${fmt(r.reasoningTokens)}</td><td>${hasTotal ? fmt(r.totalTokens) : '—'}</td></tr>`;
    const thead =
        '<tr><th>时间</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>推理</th><th>合计(totalTokens)</th></tr>';

    // 每组内的汇总（只统计该组里真实返回过的数字字段）
    const grpSumOf = (items: UsageRecord[], k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'totalTokens'): number =>
        items.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
    const grpStats = (items: UsageRecord[]): string => {
        const hasCW = items.some((r) => typeof r.cacheWriteTokens === 'number');
        const hasTT = items.some((r) => typeof r.totalTokens === 'number');
        return [
            `总输入 ${compact(grpSumOf(items, 'inputTokens'))}`,
            `总输出 ${compact(grpSumOf(items, 'outputTokens'))}`,
            `缓存读 ${compact(grpSumOf(items, 'cacheReadTokens'))}`,
            hasCW ? `缓存写 ${compact(grpSumOf(items, 'cacheWriteTokens'))}` : '',
            `推理 ${compact(grpSumOf(items, 'reasoningTokens'))}`,
            hasTT ? `合计(totalTokens) ${compact(grpSumOf(items, 'totalTokens'))}` : '',
        ]
            .filter(Boolean)
            .join(' · ');
    };

    const sections = records.length === 0
        ? '<div class="empty">暂无记录</div>'
        : ORDER
              .filter((lb) => groups.has(lb))
              .map((lb, idx) => {
                  const items = (groups.get(lb) ?? []).slice().reverse();
                  return (
                      `<details class="grp" ${idx === 0 ? 'open' : ''}>` +
                      `<summary>${lb} · ${items.length} 条` +
                      `<span class="grp-stat">${grpStats(items)} tok</span></summary>` +
                      `<table>${thead}${items.map(rowHtml).join('')}</table>` +
                      `</details>`
                  );
              })
              .join('');

    panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 12px; color: var(--vscode-foreground, #ddd); font-size: 13px; }
    h1 { font-size: 15px; margin: 0 0 4px; }
    .note { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin: 0 0 8px; }
    .summary { margin: 8px 0; }
    .empty { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
    .grp { border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.12)); border-radius: 8px; margin: 6px 0; overflow: hidden; }
    .grp summary { cursor: pointer; padding: 6px 10px; font-weight: 600; user-select: none; background: rgba(255,255,255,0.04); }
    .grp summary:hover { background: rgba(255,255,255,0.08); }
    .grp-stat { font-weight: normal; font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-left: 12px; }
    .grp table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-top: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; text-align: right; }
    th:first-child, td:first-child { text-align: left; }
    th { background: rgba(255,255,255,0.05); }
</style>
</head>
<body>
<h1>消费记录</h1>
<div class="note">仅统计本插件发起的对话（侧边栏 / 右键处理）。在 dsh 网页 / 桌面里使用产生的用量不在其中，因此可能与你的总用量不一致。</div>
<div class="summary">${summary} tok</div>
${sections}
</body>
</html>`;
}

/** Activity Bar 对话视图：点图标自动打开 DSH 面板；内容区为对话 */
/** 当前活动的聊天 webview（侧边栏视图或编辑器面板），供右键 @代码 / 新会话 投递 */
let chatTarget: vscode.Webview | undefined;
/** 编辑器区的聊天面板（移动到编辑器后创建），供"回到侧边栏"关闭 */
let chatPanel: vscode.WebviewPanel | undefined;
/** 已收到 webview `ready` 的聊天视图（保证 postMessage 到达已挂好监听的页面） */
const readyChats = new WeakSet<vscode.Webview>();

/** 全部存活聊天 webview：侧栏视图 launcherView + 当前 chatTarget + 编辑器面板 chatPanel（去重） */
function allChatWebviews(): vscode.Webview[] {
    const set = new Set<vscode.Webview>();
    if (launcherView?.webview) {
        set.add(launcherView.webview);
    }
    if (chatTarget) {
        set.add(chatTarget);
    }
    if (chatPanel?.webview) {
        set.add(chatPanel.webview);
    }
    return [...set];
}

/** 向当前所有存活聊天 webview（侧栏视图 + 编辑器面板）投递消息，避免目标被重建后内容丢失 */
function postToChats(message: unknown): void {
    for (const w of allChatWebviews()) {
        try {
            void w.postMessage(message);
        } catch {
            // 视图重建期间的旧引用：忽略，下次 resolve 会换新目标
        }
    }
}

/** 确保至少有一个聊天 webview 可用；没有则唤起侧栏并等待 resolve */
async function ensureChatWebview(): Promise<vscode.Webview | undefined> {
    if (chatTarget || chatPanel) {
        return chatTarget ?? chatPanel?.webview;
    }
    try {
        await vscode.commands.executeCommand('workbench.view.extension.dsh');
    } catch {
        return undefined;
    }
    const deadline = Date.now() + 2500;
    while (!chatTarget && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return chatTarget;
}

/** 等待指定聊天 webview 发过 `ready`，避免消息发到尚未挂好监听的页面 */
async function waitChatReady(webview: vscode.Webview): Promise<boolean> {
    if (readyChats.has(webview)) {
        return true;
    }
    const deadline = Date.now() + 3000;
    while (!readyChats.has(webview) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readyChats.has(webview);
}

/**
 * 加载聊天 HTML 到 webview（重写资源 + CSP；缺失回退自绘）。
 * titlebarMode：本页标题栏实现（A 原生 / B 页内自绘），静态注入 <body data-titlebar-mode>
 * 供 chat.ts 首帧同步读取（避免 ready 后消息导致“先画自绘再隐藏”的闪烁/竞态）。
 */
async function loadChatHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    titlebarMode: TitlebarMode
): Promise<void> {
    const chatRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'chat');
    try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(chatRoot, 'index.html'));
        let html = new TextDecoder('utf-8').decode(content);
        html = html.replace(/\s+crossorigin/g, '');
        html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_match, attr: string, p: string) => {
            const asset = vscode.Uri.joinPath(chatRoot, p);
            return `${attr}="${webview.asWebviewUri(asset)}"`;
        });
        // 原生/自绘 标题栏通道：原生标题栏模式时 index.html 的 CSS 让 #titlebar 首帧即 display:none
        html = html.replace('<body>', `<body ${TITLEBAR_MODE_ATTR}="${titlebarMode}">`);
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
        // 先列模型（内部会经 getSession() 确保当前会话存在），再读投影，
        // 否则第一次推送时会话尚未建立、permissions/统计会为空
        let models: { current?: unknown; groups?: unknown[] } = {};
        try {
            models = await dsh.listModels();
        } catch {
            // 模型列表失败不阻塞投影
        }
        const projections = await dsh.getProjections();
        let agentPresets:
            | { presets: Array<{ id: string; name?: string; description?: string; isDefault: boolean; broken?: string }> }
            | undefined;
        try {
            agentPresets = await dsh.listAgentPresets();
        } catch {
            // 模式列表失败只隐藏模式选择，不影响聊天
        }
        const projectionAgentPreset = projections?.['agentPreset'];
        const agentPreset =
            typeof projectionAgentPreset === 'string'
                ? projectionAgentPreset
                : agentPresets?.presets.find((p) => p.isDefault)?.id;
        const sessionMeta = projections?.['sessionListMetadata'] as { blank?: boolean } | undefined;
        const agentPresetLocked = sessionMeta?.blank === false;
        void webview.postMessage({
            type: 'chatInfo',
            projections,
            models,
            agentPresets,
            agentPreset,
            agentPresetLocked,
        });
    } catch {
        // 服务未就绪时静默
    }
}

/**
 * 聊天 webview 统一接线：加载 UI + 处理消息（聊天/停止/文件/复制/工作区）。侧边栏和编辑器面板共用。
 * titlebarMode：模式字符串（侧边栏恒 = TITLEBAR_MODE；编辑器面板恒 'nativeTitle' 作"纯聊天无标题栏"标记）。
 */
function setupChatWebview(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    globalState: vscode.Memento,
    titlebarMode: TitlebarMode,
    isSidebar: boolean
): void {
    webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'chat')],
    };
    chatTarget = webview;
    void loadChatHtml(webview, extensionUri, titlebarMode);
    // 打开视图即确保 DSH 运行 + 当前工作区；chatInfo（权限/模型/统计）推送
    // 改由 webview 的 ready 触发，避免页面 JS 未就绪时 postMessage 丢失
    void (async () => {
        try {
            await dsh.ensureRunning();
            // 与 dsh 一致：当前工作区取 dsh 持久化数据里 updatedAt 最新的（不覆盖手动切换、不另存）
            await dsh.ensureCurrentWorkspace();
        } catch {
            // 服务不可用：后续命令会再触发
        }
    })();
    // 右键 @代码 草稿补投：只在侧栏实例创建时补（draft 只投侧栏对话），且等 ready 再发
    if (pendingDraft && isSidebar) {
        const draft = pendingDraft;
        pendingDraft = undefined;
        void (async () => {
            try {
                if (await waitChatReady(webview)) {
                    void webview.postMessage({ type: 'draft', text: draft });
                }
            } catch {
                // 实例销毁：忽略
            }
        })();
    }

    const gen = { n: 0 };
    const post = (msg: unknown) => {
        void webview.postMessage(msg);
    };

    /** 整轮停止：使进行中的 askStreaming 失效，并请 dsh 取消当前会话回合，随后复位聊天 UI。 */
    const stopTurn = (): void => {
        gen.n++; // 使进行中的流失效
        void (async () => {
            try {
                const sid = await dsh.getSession();
                await dsh.call('session.cancel', { sessionId: sid });
            } catch {
                // 取消失败忽略
            }
        })();
        post({ type: 'chatDone', end: { kind: 'cancelled' } }); // 停止 → UI 显示“已停止 · Stopped”
    };

    // 握手：等页面脚本就绪后再推一次 chatInfo（避免重建/切回视图时数据丢失）
    let chatInfoPushed = false;

    // 标题栏装配：按本 webview 的模式(mode)挂对应实现的消息处理（自绘标题栏 才有 webview→扩展 消息）。
    // 原生标题栏模式由宿主渲染按钮，webview 侧不需要扩展消息处理。删自绘标题栏时本行保持不变。
    const chatTitlebarHost: TitlebarChatHost = {
        post,
        listWorkspaces: () => listAllWorkspaces(),
        displayName: (w) => wsDisplayName(w),
        listWorkspaceSessions: (id) => listWorkspaceSessionsOf(id),
        wsSwitchNew: (id) => wsSwitchNew(id),
        wsRestore: (id, sid, blank) => wsRestore(id, sid, blank),
        wsCreateNew: () => wsCreateNew(),
        getPanelState: () => ({ panelOpen: panel.hasPanel(), viewMode: panel.viewMode }),
        ensureReadyForList: async () => {
            await dsh.ensureRunning();
            await dsh.ensureCurrentWorkspace();
        },
        getCurrentWorkspaceId: () => dsh.getCurrentWorkspaceId(),
    };
    installChatTitlebar(webview, titlebarMode, chatTitlebarHost);

    webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'ready' && !chatInfoPushed) {
            chatInfoPushed = true;
            readyChats.add(webview);
            void (async () => {
                try {
                    await dsh.ensureRunning();
                    await dsh.ensureCurrentWorkspace();
                } catch {
                    // 服务不可用：后续操作再触发
                }
                await postChatInfo(webview);
            })();
            return;
        }
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
                                        toolName: a.toolName,
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
                        // 该回合已被停止/取代(stopTurn 已发 chatDone)：只补记已消耗的 usage，不重复发完成帧
                        await recordUsage(globalState, result.stats, result.time);
                        return;
                    }
                    // 本轮 usage/计时已在 stream.ts 用官方模块(official/turn-stats.ts)算好，直接下发
                    post({ type: 'chatDone', text: result.text, stats: result.stats, time: result.time, end: result.end });
                    await recordUsage(globalState, result.stats, result.time);
                    void postChatInfo(webview); // 刷新官方统计/权限
                } catch (e) {
                    if (g !== gen.n) {
                        return;
                    }
                    // 错误以“回合终止原因”呈现(end-note)，不把 '⚠ …' 塞进正文当内容
                    const message = e instanceof Error ? e.message : String(e);
                    post({ type: 'chatDone', end: { kind: 'error', message } });
                }
            })();
        } else if (msg.type === 'cancel') {
            stopTurn();
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
                    // dsh 接受"只取消该提问"：卡片移除，本轮 agent 继续，正常以 chatDone 结束
                    await dsh.cancelQuestion(msg.rpcId, msg.sessionId);
                    post({ type: 'questionClosed', rpcId: msg.rpcId });
                } catch (e) {
                    // 旧版 dsh 网关会把 ok:false + code:'cancelled' 拒成 bad-response，提问既无法单独
                    // 取消、本轮又一直挂着（webview 的停止按钮卡在 ■）→ 回退为整轮停止，避免 UI 卡死。
                    post({ type: 'questionClosed', rpcId: msg.rpcId });
                    vscode.window.showWarningMessage(
                        `未能单独取消提问（${(e as Error).message}），已改为停止本轮对话`
                    );
                    stopTurn();
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
        } else if (msg.type === 'chatSelectMode') {
            void (async () => {
                try {
                    const applied = await dsh.switchAgentPreset(msg.agentPreset);
                    await postChatInfo(webview);
                    vscode.window.showInformationMessage(`已切换到模式：${applied}`);
                } catch (e) {
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        } else if (msg.type === 'chatSelectPermission') {
            void (async () => {
                try {
                    // 危险权限（如 danger-full-access）的确认已由聊天 UI 自绘弹窗完成
                    await dsh.setPermissionPreset(msg.preset);
                    // 等权限投影落定后再刷新（commands.execute 返回后事件已入账，稍等一拍更稳）
                    await new Promise((r) => setTimeout(r, 300));
                    await postChatInfo(webview);
                    vscode.window.showInformationMessage(`切换至: ${msg.preset}`);
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
        // 侧边栏/面板是「视图」，原生 view/title 能渲染到 → 直接按 TITLEBAR_MODE 走；isSidebar=true
        setupChatWebview(view.webview, this.extensionUri, this.globalState, TITLEBAR_MODE, true);
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

/** 拿到 AI 回复后，让用户选择如何应用（原生 QuickPick） */
async function showApplyOptions(reply: string, ctx: SelectionContext, allowReplace: boolean): Promise<void> {
    const items: Array<{ label: string; description: string; action: 'replace' | 'insert' | 'copy' | 'open' }> = [
        ...(allowReplace
            ? [{ label: '$(symbol-event) 替换选中的代码', description: '用 AI 结果覆盖选中区域', action: 'replace' as const }]
            : []),
        { label: '$(insert) 插入到光标处', description: '把结果插到光标位置', action: 'insert' as const },
        { label: '$(copy) 复制到剪贴板', description: '复制 AI 回复全文', action: 'copy' as const },
        { label: '$(new-file) 在新编辑器标签打开', description: '不修改当前文件', action: 'open' as const },
    ];
    // items 先填再 show：sideX 等宿主对「show() 之后再写 items」的 QuickPick 可能不重绘列表
    //（现象：只剩搜索框、下面无选项），导致无法选择替换/插入。故用 createQuickPick 手动装配。
    const pick = vscode.window.createQuickPick<{ label: string; description: string; action: 'replace' | 'insert' | 'copy' | 'open' }>();
    pick.placeholder = allowReplace ? 'AI 处理完成，选择如何应用结果' : 'AI 回答完成，选择如何处理';
    pick.items = items;
    pick.show();

    let closed = false;
    const close = (): void => {
        if (!closed) {
            closed = true;
            pick.dispose();
        }
    };
    const runAction = (chosen: { action: 'replace' | 'insert' | 'copy' | 'open' }): void => {
        void (async () => {
            switch (chosen.action) {
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
        })();
    };
    pick.onDidChangeSelection((selection) => {
        const chosen = selection[0];
        if (!chosen || closed) {
            return;
        }
        close();
        runAction(chosen);
    });
    pick.onDidHide(close);
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
    action?: 'info' | 'ws' | 'wsnew' | 'session' | 'new';
    workspaceId?: string;
    sessionId?: string;
    blank?: boolean;
};

/** 会话行（webview dropdown 展开用） */
interface WsSessionRow {
    sessionId: string;
    title: string;
    running: boolean;
    blank: boolean;
    /** 是否为当前正在使用的会话（用于 QuickPick / dropdown 标“当前”） */
    current?: boolean;
}

/** UI 展示用工作区名：title 优先，缺省用路径末级 */
function wsDisplayName(w: { path: string; title: string }): string {
    return w.title || path.basename(w.path);
}

/** 列出全部工作区（供 QuickPick / webview dropdown 共用） */
async function listAllWorkspaces(): Promise<Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>> {
    return ((await dsh.listWorkspaces()).items ?? []) as Array<{
        workspaceId: string;
        path: string;
        title: string;
        sessionIds: string[];
    }>;
}

/** 拉取某工作区的会话（供 QuickPick / webview dropdown 共用） */
async function listWorkspaceSessionsOf(wsId: string): Promise<WsSessionRow[]> {
    return dsh.listWorkspaceSessions(wsId) as Promise<WsSessionRow[]>;
}

/** 切到工作区并开新会话（供 QuickPick / webview dropdown 共用；调用方负责关 UI） */
async function wsSwitchNew(wsId: string): Promise<void> {
    if (!(await ensureChatWebview())) {
        throw new Error('聊天视图未就绪，请先打开侧边栏 DSH 面板');
    }
    dsh.setCurrentWorkspace(wsId);
    await dsh.newSession(wsId);
    postToChats({ type: 'clear' });
    for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
        void postChatInfo(w);
    }
    vscode.window.showInformationMessage('已切换工作区');
}

/** 把会话恢复到当前聊天（供 QuickPick / webview dropdown 共用；调用方负责关 UI） */
async function wsRestore(wsId: string, sessionId: string, blank: boolean): Promise<void> {
    const target = await ensureChatWebview();
    if (!target) {
        throw new Error('聊天视图未就绪，请先打开侧边栏 DSH 面板');
    }
    if (!(await waitChatReady(target))) {
        throw new Error('聊天页面尚未就绪，请稍后重试');
    }
    dsh.setCurrentWorkspace(wsId);
    const messages = await dsh.restoreSession(sessionId);
    console.warn(`[dsh-restore] session=${sessionId} messages=${messages.length}`);
    if (process.env['DSH_RAWLOG']) {
        // 历史用量/计时一致性诊断：打印每条 assistant 消息当前拿到的官方字段
        for (const m of messages) {
            if (m.role !== 'assistant') {
                continue;
            }
            console.log(
                `[dsh-raw] history-assistant len=${m.text.length} provider=${m.provider ?? '-'} model=${m.model ?? '-'} ` +
                    `in=${m.inputTokens ?? '-'} out=${m.outputTokens ?? '-'} cache=${m.cacheReadTokens ?? '-'} ` +
                    `wall=${m.wallSec ?? '-'} ttft=${m.ttftSec ?? '-'} tps=${m.tps ?? '-'}`
            );
        }
    }
    if (messages.length === 0 && !blank) {
        vscode.window.showInformationMessage('已恢复会话，但 dsh 快照中没有返回可显示的历史消息');
    }
    postToChats({ type: 'clear' });
    postToChats({ type: 'chatHistory', messages, sessionId });
    for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
        void postChatInfo(w);
    }
}

/** 新建工作区（弹目录选择；供 QuickPick / webview dropdown 共用） */
async function wsCreateNew(): Promise<boolean> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        openLabel: '作为 dsh 工作区',
    });
    if (!picked || picked.length === 0) {
        return false;
    }
    const dir = picked[0].fsPath;
    const created = await dsh.createWorkspace(dir);
    dsh.setCurrentWorkspace(created.workspace.workspaceId);
    await dsh.newSession(created.workspace.workspaceId);
    postToChats({ type: 'clear' });
    for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
        void postChatInfo(w);
    }
    vscode.window.showInformationMessage(`已新建并切换到工作区：${created.workspace.title || path.basename(dir)}`);
    return true;
}

/**
 * 标题栏"工作区"面板：可展开/折叠的树。
 * 每个工作区一行，前面带折叠图标（▶ 折叠 / ▼ 展开）；展开后在其下方列出
 * 该工作区的会话（点会话=切到该工作区并恢复），并提供"在此工作区新开会话"。
 * 顶部显示当前工作区；底部可新建工作区。Esc / 失焦关闭。
 */
async function showWorkspacePicker(): Promise<void> {
    if (!(await dsh.ensureRunning())) {
        return;
    }
    try {
        // 与 dsh 一致：取 dsh 持久化里 updatedAt 最新的工作区，不再强制绑回当前文件夹
        await dsh.ensureCurrentWorkspace();
    } catch {
        // 忽略：仍可展示已列出的工作区
    }

    let workspaces: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }> = [];
    try {
        workspaces = await listAllWorkspaces();
    } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
        return;
    }

    const expanded = new Set<string>();
    const sessionCache = new Map<string, WsSessionRow[]>();
    const pick = vscode.window.createQuickPick<WsPick>();
    pick.placeholder = '展开工作区查看会话；点会话恢复历史';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;

    let disposed = false;
    const close = (): void => {
        if (!disposed) {
            disposed = true;
            pick.dispose();
        }
    };
    pick.onDidHide(close);

    const currentId = (): string | undefined => dsh.getCurrentWorkspaceId();

    function buildRows(): WsPick[] {
        const curId = currentId();
        const curWs = workspaces.find((w) => w.workspaceId === curId);
        const rows: WsPick[] = [
            {
                label: `$(folder-opened) 工作区：${curWs ? wsDisplayName(curWs) : '未分组'}`,
                description: curId ? '当前' : '未选择',
                action: 'info',
                alwaysShow: true,
            },
        ];
        // sideX 等宿主未必导出 QuickPickItemKind（缺省时取 .Separator 会抛 "reading 'Separator'"）：
        // 仅当其可用时才插入分组分隔行。
        if (vscode.QuickPickItemKind) {
            rows.push({ label: '工作区', kind: vscode.QuickPickItemKind.Separator });
        }
        for (const w of workspaces) {
            const isCurrent = w.workspaceId === curId;
            const open = expanded.has(w.workspaceId);
            rows.push({
                label: `${open ? '$(chevron-down)' : '$(chevron-right)'} ${isCurrent ? '$(check) ' : ''}${wsDisplayName(w)}`,
                description: isCurrent ? '当前' : undefined,
                action: 'ws',
                workspaceId: w.workspaceId,
                alwaysShow: true,
            });
            if (!open) {
                continue;
            }
            rows.push({
                label: '    $(add) 在此工作区新开会话',
                description: isCurrent ? '' : '切换到此工作区',
                action: 'wsnew',
                workspaceId: w.workspaceId,
                alwaysShow: true,
            });
            const sessions = sessionCache.get(w.workspaceId);
            if (sessions) {
                for (const s of sessions) {
                    rows.push({
                        // 当前会话标选中 + 描述「当前」，与自绘 dropdown 一致
                        label: `        ${s.current ? '$(check) ' : s.running ? '$(sync~spin) ' : '$(history) '}${s.title}`,
                        description: s.current ? '当前' : s.running ? '运行中' : '恢复',
                        action: 'session',
                        workspaceId: w.workspaceId,
                        sessionId: s.sessionId,
                        blank: s.blank,
                        alwaysShow: true,
                    });
                }
            }
        }
        rows.push({ label: '$(new-folder) ＋ 新建工作区…', action: 'new', alwaysShow: true });
        return rows;
    }

    /** 仅在本 QuickPick 仍展示时才更新 items。先 show 再填、且已 dispose 不再改行，
     *  可避免对“未挂到 DOM / 已关闭”的列表设行触发 VS Code 内部
     *  “Measuring item node that is not in DOM … ListView”量高报错。 */
    const refresh = (): void => {
        if (disposed) {
            return;
        }
        pick.items = buildRows();
    };

    const loadSessions = async (id: string): Promise<void> => {
        if (sessionCache.has(id) || disposed) {
            return;
        }
        pick.busy = true;
        try {
            const sessions = await listWorkspaceSessionsOf(id);
            console.warn(`[dsh-ws] load workspace=${id} sessions=${sessions.length}`);
            sessionCache.set(id, sessions);
        } catch (e) {
            console.warn(`[dsh-ws] load failed workspace=${id} error=${e instanceof Error ? e.message : String(e)}`);
            sessionCache.set(id, []);
        } finally {
            if (!disposed) {
                pick.busy = false;
            }
        }
    };

    pick.onDidChangeSelection(async (selection) => {
        const row = selection[0];
        if (!row?.action) {
            return;
        }
        try {
            if (row.action === 'ws' && row.workspaceId) {
                const id = row.workspaceId;
                if (expanded.has(id)) {
                    expanded.delete(id);
                } else {
                    expanded.add(id);
                    refresh();
                    await loadSessions(id);
                }
                refresh();
            } else if (row.action === 'wsnew' && row.workspaceId) {
                await wsSwitchNew(row.workspaceId);
                close();
            } else if (row.action === 'session' && row.workspaceId && row.sessionId) {
                await wsRestore(row.workspaceId, row.sessionId, row.blank === true);
                close();
            } else if (row.action === 'new') {
                if (await wsCreateNew()) {
                    close();
                }
            }
        } catch (e) {
            vscode.window.showErrorMessage((e as Error).message);
        }
    });

    // items 先填再 show：sideX 等宿主对「show() 之后再写 items」的 QuickPick 可能不重绘列表
    //（现象：只剩搜索框、下面无行）。官方 createQuickPick 用法即“先 items 后 show”。
    // show() 之后的动态填行只发生在展开/懒加载路径（refresh），那时列表已挂到 DOM，安全。
    pick.items = buildRows();
    pick.show();
}

// ---------- 激活入口（薄装配） ----------

export function activate(context: vscode.ExtensionContext) {
    // 命令：打开 DSH 网页面板
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.open', async () => {
            if (await dsh.ensureRunning()) {
                await panel.openPanel();
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

    // 命令：把选中代码 @ 进左侧栏聊天输入框（只投侧栏 dsh.launcher；不投编辑器面板）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.sendToDsh', async () => {
            const ctx = await requireSelection();
            if (!ctx) {
                return;
            }
            const code = '```' + ctx.editor.document.languageId + '\n' + ctx.text + '\n```';
            await vscode.commands.executeCommand('workbench.view.extension.dsh');
            // 确保侧栏视图已 resolve（launcherView 就绪）；没就绪记 pendingDraft 由侧栏创建时补投
            if (!launcherView?.webview) {
                pendingDraft = code;
                return;
            }
            const w = launcherView.webview;
            // 等该侧栏实例 ready 再投，避免 webview 未挂好 draft 监听就 postMessage 丢内容
            void (async () => {
                try {
                    if (await waitChatReady(w)) {
                        w.postMessage({ type: 'draft', text: code });
                    }
                } catch {
                    // 实例已销毁：忽略
                }
            })();
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
            // 广播到全部存活聊天实例（侧栏 + 编辑器面板），确保点按钮的那个一定被清成新会话
            postToChats({ type: 'clear' });
            for (const w of allChatWebviews()) {
                void postChatInfo(w);
            }
            vscode.window.showInformationMessage('已开启新会话');
        })
    );

    // 命令：在浏览器中打开 DSH
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.openInBrowser', () => panel.openInBrowser())
    );

    // 命令：在本地打开 DSH
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.openInEditor', () => panel.openInEditor())
    );

    // 命令：刷新所有 DSH 面板
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.reload', () => panel.reloadPanels())
    );

    // 命令：关闭侧边栏（标题栏 👁）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.closeSidebar', () => {
            vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
        })
    );

    // 命令：把聊天对话移动到编辑器区（大面板，可全屏；纯聊天，不自绘标题栏）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.moveToEditor', async () => {
            // 与侧栏/DSH 网页面板一致：后台保活上下文，避免切走再切回内容变空白
            const retainPanel = vscode.workspace.getConfiguration('dsh').get<boolean>('retainContextWhenHidden', true);
            const panel = vscode.window.createWebviewPanel(
                'dshChatPanel',
                'DeepSeek Harness',
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: retainPanel }
            );
            chatPanel = panel;
            panel.onDidDispose(() => {
                if (chatPanel === panel) {
                    chatPanel = undefined;
                }
            });
            // 编辑器区 = createWebviewPanel：既渲染不到原生 view/title，也不需要页内自绘标题栏
            //（保持纯聊天）→ 注入 data-titlebar-mode="nativeTitle"，index.html 用 CSS 隐藏 #titlebar、
            // 自绘模块读到非 selfDrawn 直接 return。
            setupChatWebview(panel.webview, context.extensionUri, context.globalState, 'nativeTitle', false);
            panel.reveal(vscode.ViewColumn.One, true);
            // 隐藏侧边栏，看起来"挪过去"了
            vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
            // 把侧边栏正在看的当前会话搬到编辑器：等新面板 ready 后重新 restore 并广播历史
            void (async () => {
                const sessionId = dsh.getSessionId();
                const target = panel.webview;
                if (!sessionId || !(await waitChatReady(target))) {
                    return;
                }
                try {
                    const messages = await dsh.restoreSession(sessionId);
                    console.warn(`[dsh-move] session=${sessionId} messages=${messages.length}`);
                    postToChats({ type: 'clear' });
                    postToChats({ type: 'chatHistory', messages, sessionId });
                    for (const w of new Set([chatTarget, chatPanel?.webview].filter((x): x is vscode.Webview => !!x))) {
                        void postChatInfo(w);
                    }
                } catch (e) {
                    vscode.window.showErrorMessage((e as Error).message);
                }
            })();
        })
    );

    // 命令：聊天回到侧边栏
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.moveToSidebar', () => {
            void moveChatBackToSidebar();
        })
    );

    // 初始化上下文（视图标题栏按钮显隐依据）
    vscode.commands.executeCommand('setContext', 'dshViewMode', panel.viewMode);
    vscode.commands.executeCommand('setContext', 'dshPanelOpen', false);
    // 原生/自绘 标题栏开关（不猜宿主）：selfDrawn → false 屏蔽 package.json 全部 view/title
    // 原生按钮；nativeTitle → true，原生按钮出现并受上面两个上下文继续控制显隐。
    // 实现收在 src/titlebar/native/（删原生标题栏时删本调用即可）。
    applyNativeTitlebarContext(TITLEBAR_MODE === 'nativeTitle');

    // 命令：查看消费记录（弹窗报告面板）
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.usage', () => openUsageReport(context.globalState))
    );

    // Activity Bar 对话视图
    const retainChat = vscode.workspace.getConfiguration('dsh').get<boolean>('retainContextWhenHidden', true);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'dsh.launcher',
            new DshLauncherProvider(context.extensionUri, context.globalState),
            { webviewOptions: { retainContextWhenHidden: retainChat } }
        )
    );
}

// 扩展停用/被卸载前收尾：先关掉自己开的 Webview（避免宿主在卸载时解析已移除扩展的
// extensionId 报错），再回收后台进程
export function deactivate() {
    chatPanel?.dispose();
    chatPanel = undefined;
    panel.dispose();
    dsh.dispose();
}
