// DSH 本地服务的 JSON-RPC 客户端。
// 与 DSH 官方网页共用同一套协议：POST /api/<method>，body 为 JSON 信封。
// 传输层只写一次（rpcCall），新增能力只需加一个方法封装。
// 端点（端口/鉴权 URL）为动态识别结果，见 docs/DYNAMIC_DISCOVERY.md。
// 详见 docs/DESIGN.md「原生 RPC 集成」。

import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';

/** DSH 服务默认端口（官方默认 `ctx.webStartup.port ?? 3080`；实际端口以探测结果为准） */
export const DEFAULT_DSH_PORT = 3080;

/** 动态识别出的 DSH 服务端点 */
export interface DshEndpoint {
    /** 实际监听端口（spawn --port 0 或探测得到） */
    port: number;
    /** 浏览器可用地址：`dsh web` 打印的 authenticatedUrl（含鉴权 token）；无则 undefined */
    authUrl?: string;
}

let currentEndpoint: DshEndpoint = { port: DEFAULT_DSH_PORT };

/** 设置探测到的端点（spawn/探测成功后调用；未设置时保持默认端口） */
export function setEndpoint(ep: DshEndpoint): void {
    currentEndpoint = { port: ep.port, authUrl: ep.authUrl };
}

/** 当前端点（副本，勿直接改） */
export function getEndpoint(): DshEndpoint {
    return { ...currentEndpoint };
}

/** 端点明文地址（RPC / CSP 用） */
export function endpointBaseUrl(ep: DshEndpoint = currentEndpoint): string {
    return `http://127.0.0.1:${ep.port}`;
}

/** 端点浏览器地址：优先带 token 的 authenticatedUrl（iframe / 外部浏览器用，P1-4） */
export function endpointAuthUrl(ep: DshEndpoint = currentEndpoint): string {
    return ep.authUrl ?? endpointBaseUrl(ep);
}

/** 单次 RPC 请求超时 */
const RPC_TIMEOUT_MS = 15_000;
/** 等待 AI 回复的默认超时 */
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
/** 轮询回复的间隔 */
const POLL_INTERVAL_MS = 700;

/**
 * 审批应答所需的 rpcId 注册表。
 * /api/respond 按「approval/requested 帧的 rpcId」查找待审批项，这个 rpcId 只出现在
 * 事件总线（/api/events.mux）的帧里，轮询 session.history 拿不到。所以在流式等待期间
 * 挂一条 SSE 长连接捕获 approval/requested，把 approvalId → {rpcId, sessionId} 记在这里，
 * 用户点「允许/拒绝」时才能用正确的 rpcId 应答。
 */
const pendingApprovalRpc = new Map<string, { rpcId: string; sessionId: string }>();

/** Mux 帧（只关心审批相关字段，其余透传） */
interface MuxFrame {
    rpcId?: string;
    payload?: {
        type?: string;
        sessionId?: string;
        approvalId?: string;
        toolName?: string;
        reason?: string;
        [key: string]: unknown;
    };
}

/**
 * 连接 DSH 事件总线的 WebSocket 长连接（ws://…/api/events.mux）。
 * 该端点不是 SSE，而是 WebSocket（HTTP 请求会 426 Upgrade Required）。
 * 返回关闭函数；连接失败/掉线静默（审批/提问走 history 兜底，文字流仍走轮询）。
 */
function connectMux(onFrame: (frame: MuxFrame) => void): () => void {
    let ws: WebSocket | undefined;
    try {
        ws = new WebSocket(`ws://127.0.0.1:${currentEndpoint.port}/api/events.mux`);
        ws.onmessage = (e: { data: unknown }) => {
            try {
                const text = typeof e.data === 'string' ? e.data : String(e.data);
                const frame = JSON.parse(text) as MuxFrame;
                if (frame && frame.payload) {
                    onFrame(frame);
                }
            } catch {
                /* 忽略坏帧 */
            }
        };
        ws.onerror = () => { /* 连接失败静默 */ };
    } catch {
        /* noop */
    }
    return () => {
        try {
            ws?.close();
        } catch {
            /* noop */
        }
    };
}

/** RPC 请求信封（与 DSH 网页完全一致） */
interface RpcRequest {
    type: 'client-request';
    rpcId: string;
    method: string;
    payload: unknown;
}

/** RPC 响应信封 */
interface RpcResponse<T = unknown> {
    type: 'server-response';
    rpcId: string;
    result:
        | { ok: true; value: T }
        | { ok: false; error: RpcError };
}

interface RpcError {
    code?: string;
    message?: string;
    details?: unknown;
}

/** DSH 接口层错误（携带错误码，便于上层区分处理） */
export class DshRpcError extends Error {
    readonly code?: string;
    readonly details?: unknown;

    constructor(method: string, err: RpcError) {
        super(`DSH 接口 ${method} 出错：${err.message ?? err.code ?? '未知错误'}`);
        this.name = 'DshRpcError';
        this.code = err.code;
        this.details = err.details;
    }
}

/**
 * 通用 RPC 调用：调当前端点的任意 DSH 方法并返回 result.value。
 * 失败时抛 DshRpcError（接口层）或 Error（传输层）。
 */
export async function rpcCall<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
    return rpcCallAt<T>(currentEndpoint.port, method, payload);
}

/** 指定端口的 RPC 调用（probe 用，走同一信封与错误归一） */
async function rpcCallAt<T = unknown>(port: number, method: string, payload: unknown = {}): Promise<T> {
    const body: RpcRequest = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload };
    const json = JSON.stringify(body);

    return new Promise<T>((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/api/${method}`,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    host: `127.0.0.1:${port}`,
                },
                timeout: RPC_TIMEOUT_MS,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`DSH 接口 ${method} 失败：HTTP ${res.statusCode}`));
                        return;
                    }
                    let parsed: RpcResponse<T>;
                    try {
                        parsed = JSON.parse(data) as RpcResponse<T>;
                    } catch {
                        reject(new Error(`DSH 接口 ${method} 返回了非 JSON 内容`));
                        return;
                    }
                    if (parsed.result.ok) {
                        resolve(parsed.result.value);
                    } else {
                        reject(new DshRpcError(method, parsed.result.error));
                    }
                });
            }
        );
        req.on('error', (err) =>
            reject(new Error(`无法连接 DSH 服务（${endpointBaseUrl({ port })}）：${err.message}。请先打开「DeepSeek Harness」面板启动服务`))
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`DSH 接口 ${method} 请求超时`));
        });
        req.end(json);
    });
}

/** 执行斜杠命令的返回（commands/execute 成功值；未匹配命令时整个 value 为 undefined） */
export interface DshCommandExec {
    commandId?: string;
    result?: { kind?: 'success' | 'error'; text?: string };
}

/**
 * 执行一条斜杠命令（如 /permission workspace-write）。
 * 注意：命令远程是「namespace/method」斜杠端点 + `args` 包装（agentId 作用域），
 * 与普通会话/工作区那种「点号 + 平铺 payload」的旧端点不同，故单独实现。
 */
export async function runSessionCommand(sessionId: string, line: string): Promise<DshCommandExec | undefined> {
    const method = 'commands/execute';
    const body: RpcRequest = {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload: { args: { agentId: sessionId, line, images: [] } },
    };
    const json = JSON.stringify(body);
    return new Promise<DshCommandExec | undefined>((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: currentEndpoint.port,
                path: `/api/${method}`,
                method: 'POST',
                headers: { 'content-type': 'application/json', host: `127.0.0.1:${currentEndpoint.port}` },
                timeout: RPC_TIMEOUT_MS,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`DSH 接口 ${method} 失败：HTTP ${res.statusCode}`));
                        return;
                    }
                    let parsed: RpcResponse<DshCommandExec | undefined>;
                    try {
                        parsed = JSON.parse(data) as RpcResponse<DshCommandExec | undefined>;
                    } catch {
                        reject(new Error(`DSH 接口 ${method} 返回了非 JSON 内容`));
                        return;
                    }
                    if (parsed.result.ok) {
                        resolve(parsed.result.value);
                    } else {
                        reject(new DshRpcError(method, parsed.result.error));
                    }
                });
            }
        );
        req.on('error', (err) =>
            reject(new Error(`无法连接 DSH 服务（${endpointBaseUrl({ port: currentEndpoint.port })}）：${err.message}。请先打开「DeepSeek Harness」面板启动服务`))
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`DSH 接口 ${method} 请求超时`));
        });
        req.end(json);
    });
}

// ---------- 握手探测（P0-2） ----------

/** 探测结果 */
export interface DshProbeResult {
    ok: boolean;
    endpoint: DshEndpoint;
    /** 信封是否被识别（DSH 可达）；ok=true 时恒为 true */
    envelopeOk?: boolean;
    /** 可连但需要鉴权（HTTP 401/403，新版可能要求 token） */
    authRequired?: boolean;
    /** 人读原因 */
    reason?: string;
}

/**
 * 探测端口上是否运行 DSH 并验证 RPC 信封（握手探测）。
 * 用低风险只读方法 session.list：只要服务端返回 server-response 信封即视为协议 OK
 * （方法缺失 = 版本差异，不是协议不兼容，仍视为可达）。
 */
export async function probeDsh(port: number): Promise<DshProbeResult> {
    const endpoint: DshEndpoint = { port };
    try {
        await rpcCallAt(port, 'session.list', {});
        return { ok: true, endpoint, envelopeOk: true };
    } catch (e) {
        if (e instanceof DshRpcError) {
            // 信封解析成功（server-response 且 ok=false）：DSH 可达
            return { ok: true, endpoint, envelopeOk: true };
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) {
            return {
                ok: false,
                endpoint,
                authRequired: true,
                reason: `端口 ${port} 上的 DSH 需要鉴权（新版可能要求 token），请在 dsh 网页面板中完成登录`,
            };
        }
        if (msg.includes('HTTP ') || msg.includes('非 JSON')) {
            return { ok: false, endpoint, reason: `端口 ${port} 上不是 DSH 或协议不兼容` };
        }
        return { ok: false, endpoint, reason: `端口 ${port} 不可连接` };
    }
}

// ---------- 能力探测（P2 特性门控） ----------

/** 探测出的 DSH 能力（特性门控依据；见 docs/DYNAMIC_DISCOVERY.md） */
export interface DshCapabilities {
    /** DSH 版本（CLI --version 捕获，尽力而为） */
    version?: string;
    /** /api/events.mux WebSocket 可用（审批/提问帧；不可用则走 history approval/asked 兜底） */
    mux: boolean;
    /** assistant/chunk 增量流式可用（核心能力，默认开启） */
    streaming: boolean;
}

let currentCapabilities: DshCapabilities = { mux: true, streaming: true };

/** 更新探测到的能力（合并写入） */
export function setCapabilities(c: Partial<DshCapabilities>): void {
    currentCapabilities = { ...currentCapabilities, ...c };
}

/** 当前能力（副本） */
export function getCapabilities(): DshCapabilities {
    return { ...currentCapabilities };
}

/** 探测 /api/events.mux WebSocket 是否可用（短连接，3s 超时，静默） */
function probeMux(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`);
            const timer = setTimeout(() => {
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
                resolve(false);
            }, 3000);
            ws.onopen = () => {
                clearTimeout(timer);
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
                resolve(true);
            };
            ws.onerror = () => {
                clearTimeout(timer);
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
                resolve(false);
            };
            ws.onclose = () => {
                clearTimeout(timer);
                resolve(false);
            };
        } catch {
            resolve(false);
        }
    });
}

/** 探测端点能力（mux WS；streaming 为核心能力，默认开启） */
export async function probeCapabilities(port: number): Promise<DshCapabilities> {
    const mux = await probeMux(port);
    return { mux, streaming: true };
}

// ---------- 端口探测 / 就绪等待 ----------

/** 检查端口是否可连接（成功即认为服务已运行） */
export function checkPort(port: number = DEFAULT_DSH_PORT, host = '127.0.0.1', timeout = 1500): Promise<boolean> {
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
export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await checkPort(port, '127.0.0.1', 800)) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/** DSH 服务当前是否可访问 */
export function isRunning(): Promise<boolean> {
    return checkPort(currentEndpoint.port);
}

// ---------- 会话 / 对话 ----------

/** 消息内容块：文本 / 图片（base64，mediaType 支持 png/jpeg/webp/gif） */
export type DshContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string };

/** 创建会话，返回 sessionId。可选指定 workspaceId 让会话归到某个工作区。 */
export async function createSession(opts: { workspaceId?: string } = {}): Promise<string> {
    const value = await rpcCall<{ sessionId: string }>('session.create', {
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    });
    return value.sessionId;
}

/** 向会话发送消息（异步队列，返回接受即成功）。content 支持文本 + 图片块。 */
export async function sendPrompt(sessionId: string, content: DshContentPart[]): Promise<void> {
    await rpcCall<{ accepted: boolean }>('session.prompt', {
        sessionId,
        mode: 'queue',
        content,
    });
}

/** 会话历史事件（协议形状；事件类型名见 DSH_EVENT_TYPES） */
interface HistoryEvent {
    event?: {
        seq?: number;
        type?: string;
        surfaceOp?: string;
        data?: {
            content?: Array<{ type?: string; text?: string }>;
            usage?: DshReplyStats;
            message?: {
                role?: string;
                content?: Array<{ type?: string; text?: string }>;
            };
            chunk?: { type?: string; text?: string };
            step?: number;
            name?: string;
            id?: string;
            reason?: string;
            toolName?: string;
            arguments?: string;
        };
    };
}

// ---------- 事件投影（P1-3）：协议事件 → 插件结构化事件，DSH 改名只改这一处 ----------

/** DSH 历史事件类型名 —— 协议耦合点：DSH 升级改名时只改这里 */
export const DSH_EVENT_TYPES = {
    userMessage: 'user/message',
    assistantMessage: 'assistant/message',
    assistantChunk: 'assistant/chunk',
    stepStart: 'step/start',
    toolCall: 'tool/call',
    approvalAsked: 'approval/asked',
    turnEnd: 'turn/end',
    chunkTextDelta: 'text-delta',
    chunkReasoningDelta: 'reasoning-delta',
} as const;

/** 是否为会话表面消息（surfaceOp 缺省或 append；用于历史视图，排除 compaction 替换/移除） */
function isSurfaceAppend(op?: string): boolean {
    return op === undefined || op === 'append';
}

/** 投影后的结构化事件（消费方不再感知协议字段名） */
export type DshProjectedEvent =
    | { kind: 'user-message'; seq: number; text: string; surface: boolean }
    | { kind: 'assistant-message'; seq: number; text: string; usage?: DshReplyStats; surface: boolean }
    | { kind: 'text-delta'; seq: number; text: string }
    | { kind: 'reasoning-delta'; seq: number; step: number; text: string }
    | { kind: 'step-start'; seq: number; step?: number }
    | { kind: 'tool-call'; seq: number; step?: number; tool?: string }
    | { kind: 'approval-asked'; seq: number; approvalId?: string; reason?: string; toolName?: string }
    | { kind: 'turn-end'; seq: number };

/** 解析单条历史事件；不认识/无有效载荷返回 undefined */
export function projectHistoryEvent(entry: HistoryEvent): DshProjectedEvent | undefined {
    const ev = entry.event;
    if (!ev) {
        return undefined;
    }
    const seq = ev.seq ?? 0;
    switch (ev.type) {
        case DSH_EVENT_TYPES.userMessage: {
            const content = ev.data?.content ?? [];
            let text = '';
            for (const part of content) {
                if (part.type === 'text' && part.text) {
                    text += part.text;
                }
            }
            return { kind: 'user-message', seq, text, surface: isSurfaceAppend(ev.surfaceOp) };
        }
        case DSH_EVENT_TYPES.assistantMessage: {
            const content = ev.data?.message?.content ?? [];
            let text = '';
            for (const part of content) {
                if (part.type === 'text' && part.text) {
                    text += part.text;
                }
            }
            return {
                kind: 'assistant-message',
                seq,
                text,
                // 协议：assistant/message 的 data.usage 与 data.message 平级（TokenUsage）
                usage: ev.data?.usage,
                surface: isSurfaceAppend(ev.surfaceOp),
            };
        }
        case DSH_EVENT_TYPES.assistantChunk: {
            const chunk = ev.data?.chunk;
            if (!chunk) {
                return undefined;
            }
            const step = ev.data?.step ?? 0;
            if (chunk.type === DSH_EVENT_TYPES.chunkTextDelta && chunk.text) {
                return { kind: 'text-delta', seq, text: chunk.text };
            }
            if (chunk.type === DSH_EVENT_TYPES.chunkReasoningDelta && chunk.text) {
                return { kind: 'reasoning-delta', seq, step, text: chunk.text };
            }
            return undefined;
        }
        case DSH_EVENT_TYPES.stepStart:
            return { kind: 'step-start', seq, step: ev.data?.step };
        case DSH_EVENT_TYPES.toolCall:
            return { kind: 'tool-call', seq, step: ev.data?.step, tool: ev.data?.name };
        case DSH_EVENT_TYPES.approvalAsked: {
            const d = ev.data as Record<string, unknown> | undefined;
            return {
                kind: 'approval-asked',
                seq,
                approvalId: d?.id === undefined ? undefined : String(d.id),
                reason: d?.reason === undefined ? undefined : String(d.reason),
                toolName: d?.toolName === undefined ? undefined : String(d.toolName),
            };
        }
        case DSH_EVENT_TYPES.turnEnd:
            return { kind: 'turn-end', seq };
        default:
            return undefined;
    }
}

/** 拉取会话历史事件流 */
async function getHistoryEvents(sessionId: string): Promise<HistoryEvent[]> {
    const value = await rpcCall<{ events: HistoryEvent[] }>('session.history', { sessionId });
    return value.events ?? [];
}

/**
 * 会话消息历史（供恢复会话渲染）：仅取表面 append 的 user/assistant 文本消息，按 seq 顺序返回。
 * 协议解析复用 projectHistoryEvent（事件改名只改投影一处）。
 */
export async function getSessionMessages(
    sessionId: string
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    const events = await getHistoryEvents(sessionId);
    const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    for (const entry of events) {
        const ev = projectHistoryEvent(entry);
        if (!ev) {
            continue;
        }
        if (ev.kind === 'user-message' && ev.surface && ev.text) {
            out.push({ role: 'user', text: ev.text });
        } else if (ev.kind === 'assistant-message' && ev.surface && ev.text) {
            out.push({ role: 'assistant', text: ev.text });
        }
    }
    return out;
}

/** 读取会话历史投影（官方统计 sessionStats / tokenUsage / permissions / title 等） */
export async function getSessionProjections(sessionId: string): Promise<Record<string, unknown>> {
    const value = await rpcCall<{ projections?: { values?: Record<string, unknown> } }>('session.history', {
        sessionId,
    });
    return value.projections?.values ?? {};
}

/** 从事件流中提取（baselineSeq 之后的）assistant 文本回复 */
function extractAssistantText(events: HistoryEvent[], baselineSeq = 0): string {
    const parts: string[] = [];
    for (const entry of events) {
        const ev = projectHistoryEvent(entry);
        if (!ev || ev.kind !== 'assistant-message' || ev.seq <= baselineSeq) {
            continue; // 只取本次发送之后产生的新回复，避免误取历史轮次
        }
        if (ev.text) {
            parts.push(ev.text);
        }
    }
    return parts.join('');
}

/**
 * 轮询会话历史，直到收到本次（baselineSeq 之后）AI 的文本回复（或超时 / 取消）。
 * baselineSeq 用于会话复用时区分"新回复"与"历史轮次"。
 */
export async function waitForReply(
    sessionId: string,
    opts: { baselineSeq?: number; timeoutMs?: number; isCancelled?: () => boolean } = {}
): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    const baselineSeq = opts.baselineSeq ?? 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (opts.isCancelled?.()) {
            throw new Error('已取消');
        }
        const events = await getHistoryEvents(sessionId);
        const done = events.some((e) => {
            const ev = projectHistoryEvent(e);
            return ev?.kind === 'turn-end' && ev.seq > baselineSeq;
        });
        if (done) {
            const text = extractAssistantText(events, baselineSeq);
            if (text) {
                return text;
            }
            throw new Error('DSH 未返回可用的文本回复（可能 agent 正在等待审批或没有产生文本输出）');
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`DSH 处理超时（${Math.round(timeoutMs / 1000)}s）`);
}

/** 给会话重命名（方便在 DSH 面板会话列表里辨认） */
export async function renameSession(sessionId: string, title: string): Promise<void> {
    await rpcCall('session.rename', { sessionId, title });
}

/**
 * 往一个已存在的会话发消息，等 AI 回复。支持会话复用（多轮连续问答）。
 */
export async function askInSession(
    sessionId: string,
    text: string,
    opts: { timeoutMs?: number; isCancelled?: () => boolean } = {}
): Promise<string> {
    const before = await getHistoryEvents(sessionId);
    const baselineSeq = before.reduce((max, e) => Math.max(max, e.event?.seq ?? 0), 0);
    await sendPrompt(sessionId, [{ type: 'text', text }]);
    return waitForReply(sessionId, { baselineSeq, ...opts });
}

/**
 * 高层封装：新建会话并直出 AI 回复（单轮）。
 * 需要连续问答时请改用 askInSession + 复用的 sessionId。
 */
export async function ask(
    text: string,
    opts: { timeoutMs?: number; isCancelled?: () => boolean } = {}
): Promise<string> {
    const sessionId = await createSession();
    return askInSession(sessionId, text, opts);
}

/** 审批响应：经 /api/respond 用 client-response 信封返回（允许一次 / 拒绝）。
 *  rpcId 必须回显 approval/requested 帧里的 rpcId，且 value 里要有 sessionId + approvalId，
 *  否则服务端按 not-pending 拒绝，审批会一直挂着。 */
export async function respondApproval(
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected'
): Promise<void> {
    const entry = pendingApprovalRpc.get(approvalId);
    if (!entry?.rpcId) {
        throw new Error('DSH 未给出该审批的应答标识，无法在本地应答；请到 dsh 网页面板中处理');
    }
    await postRespond(entry.rpcId, { sessionId, approvalId, outcome }, '审批');
}

/** ask_user_question 的回答：经 /api/respond 回显 question/requested 帧的 rpcId。 */
export async function respondQuestion(
    sessionId: string,
    rpcId: string,
    answers: Array<{ id: string; selected: string[]; custom?: string }>
): Promise<void> {
    await postRespond(rpcId, { sessionId, answer: { answers } }, '提问');
}

/** 取消 ask_user_question（client-response 的 result.ok=false + code=cancelled） */
export async function cancelQuestion(sessionId: string, rpcId: string): Promise<void> {
    await postRespond(
        rpcId,
        { sessionId, answer: { answers: [] } },
        '取消提问',
        { ok: false, error: { code: 'cancelled', message: 'user cancelled' } }
    );
}

/** 统一 POST /api/respond：回显 rpcId，带 sessionId 上下文，解析 accepted。 */
async function postRespond(
    rpcId: string,
    value: unknown,
    what: string,
    result: { ok: boolean; error?: { code: string; message: string } } = { ok: true }
): Promise<void> {
    const body = {
        type: 'client-response',
        rpcId,
        result: result.ok ? { ok: true, value } : result,
    };
    await new Promise<void>((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: currentEndpoint.port,
                path: '/api/respond',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    host: `127.0.0.1:${currentEndpoint.port}`,
                },
                timeout: RPC_TIMEOUT_MS,
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data) as { accepted?: boolean; reason?: string };
                        if (parsed.accepted) {
                            resolve();
                        } else {
                            reject(
                                new Error(
                                    `DSH 未接受${what}应答${parsed.reason ? `（${parsed.reason}）` : ''}，请在 dsh 网页面板中处理`
                                )
                            );
                        }
                    } catch {
                        resolve(); // 非 JSON 响应按成功处理（旧版服务）
                    }
                });
            }
        );
        req.on('error', (err) => reject(err));
        req.end(JSON.stringify(body));
    });
}

// ---------- 流式 ----------

/** dsh 回复统计（token 用量 / 步数） */
export interface DshReplyStats {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    steps?: number;
}

/** 实时活动：步骤开始 / 工具调用（step 关联到思维链的哪一步） */
export interface DshActivity {
    type: 'step' | 'tool';
    step?: number;
    tool?: string;
}

/** 审批请求（rpcId / sessionId 由 mux 帧带出，用于本地应答） */
export interface DshApproval {
    approvalId?: string;
    description?: string;
    rpcId?: string;
    sessionId?: string;
}

/** ask_user_question 的选项 */
export interface DshQuestionOption {
    label: string;
    description?: string;
}

/** ask_user_question 的题目 */
export interface DshQuestion {
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: DshQuestionOption[];
    multiSelect?: boolean;
}

/** 提问请求（rpcId / sessionId 由 mux 帧带出） */
export interface DshQuestionRequest {
    rpcId?: string;
    sessionId?: string;
    questions?: DshQuestion[];
}

/** 轮询历史的统计数据（assistant/message 的 usage + step/start 计数） */
function collectStats(events: HistoryEvent[], baselineSeq: number): DshReplyStats {
    let stats: DshReplyStats = {};
    let steps = 0;
    for (const entry of events) {
        const ev = projectHistoryEvent(entry);
        if (!ev || ev.seq <= baselineSeq) {
            continue;
        }
        if (ev.kind === 'step-start') {
            steps++;
        }
        if (ev.kind === 'assistant-message' && ev.usage) {
            stats = { ...ev.usage };
        }
    }
    stats.steps = steps;
    return stats;
}

/**
 * 轮询历史，把 assistant 的 text-delta 增量逐步回调 onDelta，实现流式输出。
 * 期间挂一条 mux SSE 长连接捕获 approval/requested 帧（应答所需的 rpcId 只在这里）。
 * reasoning-delta 按 step 分组回调，配合 onActivity 的 step 编号可渲染成思维链。
 * 返回完整文本 + 统计。
 */
export async function waitForReplyStreaming(
    sessionId: string,
    baselineSeq: number,
    onDelta: (delta: string) => void,
    opts: {
        onReasoning?: (delta: string, step?: number) => void;
        onActivity?: (a: DshActivity) => void;
        onApproval?: (a: DshApproval) => void;
        onQuestion?: (q: DshQuestionRequest) => void;
        timeoutMs?: number;
        isCancelled?: () => boolean;
    } = {}
): Promise<{ text: string; stats: DshReplyStats }> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let lastText = '';
    // step -> 已推送的 reasoning 长度（轮询每次重读全部事件，靠它去重）
    const lastReasoningByStep = new Map<number, number>();
    const seenActivity = new Set<number>();
    const emittedApprovals = new Set<string>();
    const emittedQuestions = new Set<string>();

    // 审批/提问应答依赖 mux 帧的 rpcId：mux 可用时开一条 WS 长连接，只记本会话的请求；
    // 不可用（能力门控 P2）则走 history approval/asked 兜底（无 rpcId，需去网页面板处理）。
    let closeMux: () => void = () => {
        /* 无 mux：审批/提问走 history 兜底 */
    };
    if (getCapabilities().mux) {
        closeMux = connectMux((frame) => {
            const p = frame.payload;
            if (!p || !p.type || !p.sessionId || p.sessionId !== sessionId) {
                return;
            }
            if (p.type === 'approval/resolved') {
                const doneId = String(p.approvalId ?? '');
                if (doneId) {
                    pendingApprovalRpc.delete(doneId);
                }
                return;
            }
            if (p.type === 'question/requested') {
                const rpcId = frame.rpcId ?? '';
                if (opts.onQuestion && rpcId && !emittedQuestions.has(rpcId)) {
                    emittedQuestions.add(rpcId);
                    opts.onQuestion({
                        rpcId,
                        sessionId,
                        questions: (p.questions as DshQuestion[]) ?? [],
                    });
                }
                return;
            }
            if (p.type !== 'approval/requested') {
                return;
            }
            const approvalId = String(p.approvalId ?? '');
            if (!approvalId) {
                return;
            }
            pendingApprovalRpc.set(approvalId, { rpcId: frame.rpcId ?? '', sessionId });
            if (opts.onApproval && !emittedApprovals.has(approvalId)) {
                emittedApprovals.add(approvalId);
                opts.onApproval({
                    approvalId,
                    rpcId: frame.rpcId ?? '',
                    sessionId,
                    description: String(p.reason ?? p.toolName ?? '需要授权操作'),
                });
            }
        });
    }

    try {
        while (Date.now() < deadline) {
            if (opts.isCancelled?.()) {
                throw new Error('已取消');
            }
            const events = await getHistoryEvents(sessionId);
            const textParts: string[] = [];
            const reasoningByStep = new Map<number, string[]>();
            for (const entry of events) {
                const ev = projectHistoryEvent(entry);
                if (!ev || ev.seq <= baselineSeq) {
                    continue;
                }
                const seq = ev.seq;
                switch (ev.kind) {
                    case 'text-delta':
                        textParts.push(ev.text);
                        break;
                    case 'reasoning-delta': {
                        let arr = reasoningByStep.get(ev.step);
                        if (!arr) {
                            arr = [];
                            reasoningByStep.set(ev.step, arr);
                        }
                        arr.push(ev.text);
                        break;
                    }
                    case 'step-start':
                        if (opts.onActivity && !seenActivity.has(seq)) {
                            seenActivity.add(seq);
                            opts.onActivity({ type: 'step', step: ev.step });
                        }
                        break;
                    case 'tool-call':
                        if (opts.onActivity && !seenActivity.has(seq)) {
                            seenActivity.add(seq);
                            opts.onActivity({ type: 'tool', step: ev.step, tool: ev.tool });
                        }
                        break;
                    case 'approval-asked':
                        if (opts.onApproval && !seenActivity.has(seq)) {
                            // 兜底：mux 连不上时也能显示审批（此时本地无 rpcId，需去网页面板处理）
                            seenActivity.add(seq);
                            const approvalId = ev.approvalId;
                            if (approvalId && !emittedApprovals.has(approvalId)) {
                                emittedApprovals.add(approvalId);
                                opts.onApproval({
                                    approvalId,
                                    description: ev.reason || ev.toolName || '需要授权操作',
                                });
                            }
                        }
                        break;
                    default:
                        break;
                }
            }
            const text = textParts.join('');
            if (text.length > lastText.length) {
                onDelta(text.slice(lastText.length));
                lastText = text;
            }
            if (opts.onReasoning) {
                // 按 step 顺序补齐各步 reasoning，保证思维链排版顺序正确
                const steps = [...reasoningByStep.keys()].sort((a, b) => a - b);
                for (const step of steps) {
                    const full = reasoningByStep.get(step)!.join('');
                    const emitted = lastReasoningByStep.get(step) ?? 0;
                    if (full.length > emitted) {
                        opts.onReasoning(full.slice(emitted), step);
                        lastReasoningByStep.set(step, full.length);
                    }
                }
            }
            const done = events.some((e) => {
                const ev = projectHistoryEvent(e);
                return ev?.kind === 'turn-end' && ev.seq > baselineSeq;
            });
            if (done) {
                return { text, stats: collectStats(events, baselineSeq) };
            }
            await new Promise((r) => setTimeout(r, 600));
        }
        throw new Error(`DSH 处理超时（${Math.round(timeoutMs / 1000)}s）`);
    } finally {
        closeMux();
    }
}

/** 往已有会话发消息，流式回调增量（支持会话复用）。content 支持文本 + 图片。 */
export async function askInSessionStreaming(
    sessionId: string,
    content: DshContentPart[],
    onDelta: (delta: string) => void,
    opts: {
        onReasoning?: (delta: string, step?: number) => void;
        onActivity?: (a: DshActivity) => void;
        onApproval?: (a: DshApproval) => void;
        onQuestion?: (q: DshQuestionRequest) => void;
        timeoutMs?: number;
        isCancelled?: () => boolean;
    } = {}
): Promise<{ text: string; stats: DshReplyStats }> {
    const before = await getHistoryEvents(sessionId);
    const baselineSeq = before.reduce((max, e) => Math.max(max, e.event?.seq ?? 0), 0);
    await sendPrompt(sessionId, content);
    return waitForReplyStreaming(sessionId, baselineSeq, onDelta, opts);
}
