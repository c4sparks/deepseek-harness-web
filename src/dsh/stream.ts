// dsh 0.1.2-rc.1 流式对话：session/follow 驱动的 waitTurn 与 ask 系列。
import { openMuxStream } from "./api";
import {
    createSession,
    eventText,
    readFollowSnapshot,
    sendPrompt,
    toRawEvent,
    usageOf,
    type DshContentPart,
    type RawEvent,
} from "./session";
const DEFAULT_REPLY_TIMEOUT_MS = 120000;
// ---------- 流式等待（follow 驱动） ----------
export interface DshReplyStats {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    steps?: number;
    /** 该回答所用模型（assistant/message.source），UI 用量弹窗展示 */
    provider?: string;
    model?: string;
    /** 服务端事件时间算出的指标：本轮总用时(秒) / 输出速度(tok/s) / 首 token 用时(秒) */
    wallSec?: number;
    tps?: number;
    ttftSec?: number;
}
export interface DshActivity {
    type: 'step' | 'tool';
    step?: number;
    tool?: string;
}
export interface DshApproval {
    approvalId?: string;
    description?: string;
    rpcId?: string;
    sessionId?: string;
    /** 待批准的真实工具名（上游 request.toolName），UI 直显 */
    toolName?: string;
}
export interface DshQuestionOption {
    label: string;
    description?: string;
}
export interface DshQuestion {
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: DshQuestionOption[];
    multiSelect?: boolean;
}
export interface DshQuestionRequest {
    rpcId?: string;
    sessionId?: string;
    questions?: DshQuestion[];
}
const CHUNK_TEXT = 'text-delta';
const CHUNK_REASONING = 'reasoning-delta';
interface StreamingOpts {
    timeoutMs?: number;
    isCancelled?: () => boolean;
    onReasoning?: (delta: string, step?: number) => void;
    onActivity?: (a: DshActivity) => void;
    onApproval?: (a: DshApproval) => void;
    onQuestion?: (q: DshQuestionRequest) => void;
}
interface TurnResult {
    text: string;
    stats: DshReplyStats;
    /** 该轮回答在 dsh 侧生成的原始时间戳（epoch 秒/毫秒，取 assistant/message 事件自带 time） */
    time?: number;
    /** turn/end 的非正常终止原因（error/aborted/interrupted/max-tokens/blocked…）；正常完成则无 */
    end?: { kind: string; message?: string };
}
function numberOr(v: unknown): number | undefined {
    return typeof v === 'number' ? v : undefined;
}
function stringOf(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}
/** 累加两个可空数值：下一值为 undefined 时保留现值，否则求和（整轮多 assistant/message 的 usage 累计口径）。 */
function addOpt(prev: number | undefined, next: number | undefined): number | undefined {
    if (next === undefined) {
        return prev;
    }
    return (prev ?? 0) + next;
}
/** 保留一位小数的数值（0.1 精度）；非有限数返回 undefined。 */
function round1(n: number | undefined): number | undefined {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        return undefined;
    }
    return Math.round(n * 10) / 10;
}

/** 上游原始帧日志（验证 0.1.2-rc.1 事件 schema 用）。启用：扩展进程 env DSH_RAWLOG=1（紧凑）或 =full（完整 JSON）。 */
function rawLog(src: string, value: unknown): void {
    const mode = process.env['DSH_RAWLOG'];
    if (!mode) {
        return;
    }
    const v = value as { type?: string; seq?: unknown; data?: Record<string, unknown>; records?: unknown[]; projections?: { values?: Record<string, unknown> } } | undefined;
    try {
        if (v && v.type === 'snapshot') {
            const proj = v.projections?.values ?? {};
            const n = Array.isArray(v.records) ? v.records.length : 0;
            if (mode === 'full') {
                console.log(`[dsh-raw] ${src} snapshot ` + JSON.stringify(value).slice(0, 200_000));
            } else {
                console.log(`[dsh-raw] ${src} snapshot projKeys=${Object.keys(proj).join(',') || '(none)'} records=${n}`);
            }
            return;
        }
        if (mode === 'full') {
            console.log(`[dsh-raw] ${src} ` + JSON.stringify(value).slice(0, 200_000));
        } else {
            const keys = v && v.data ? Object.keys(v.data).join(',') : '';
            console.log(`[dsh-raw] ${src} ${String(v?.type ?? 'frame')}${typeof v?.seq === 'number' ? ' seq=' + v.seq : ''}${keys ? ' data=[' + keys + ']' : ''}`);
        }
    } catch {
        console.log(`[dsh-raw] ${src} <log-error>`);
    }
}
/**
 * 会话回合等待（适配 dsh v0.1.2-rc.1）。
 * 打开一次 session/follow，把 snapshot + 实时事件里 seq>baselineSeq 的事件转成增量回调：
 *   - assistant/chunk data.chunk.type==='text-delta' → onDelta 并拼全文；
 *   - data.chunk.type==='reasoning-delta' → onReasoning（按 data.step）；
 *   - step/start、tool/call → onActivity；turn/end（reason.kind==='error' 且无文本）→ 上抛错误；
 * 统计：assistant/message 的 usage，或结束瞬间快照的 tokenUsage/sessionStats 投影。
 * 说明：该版本的审批/提问走客户端 $events（waterfall），不在会话事件流里；
 * dshEvents（src/dsh/events.ts）负责维护 $events 并把请求投递给聊天层，聊天内可直接应答；
 * waitTurn 只负责等会话事件流继续。
 */
async function waitTurn(sessionId: string, baselineSeq: number, onDelta: (d: string) => void, opts: StreamingOpts): Promise<TurnResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let text = '';
    let sawDeltas = false;
    let sawAssistantMessage = false;
    let lastStats: DshReplyStats = {};
    let errorAtEnd: { message: string } | undefined;
    let messageTime: number | undefined;
    let endMarker: { kind: string; message?: string } | undefined;
    // 事件级计时与模型信息（用服务端事件自带 time，不用本地时钟）
    let provider: string | undefined;
    let model: string | undefined;
    let turnStartAt: number | undefined;
    let stepStartAt: number | undefined;
    let firstDeltaAt: number | undefined;
    let lastDeltaAt: number | undefined;
    let turnEndAt: number | undefined;
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let idleTimer: ReturnType<typeof setInterval> | undefined;
        const finish = (err?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (idleTimer) {
                clearInterval(idleTimer);
                idleTimer = undefined;
            }
            try {
                control.cancel();
            } catch {
                /* noop */
            }
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };
        const timer = setTimeout(() => finish(new Error(`DSH 处理超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs + 5000);
        idleTimer = setInterval(() => {
            if (opts.isCancelled?.()) {
                // 客户端停止：保留已收到的 partial usage 正常返回（end=cancelled），不再抛错丢弃
                if (!endMarker) {
                    endMarker = { kind: 'cancelled' };
                }
                finish();
            }
        }, 400);
        // 本轮统计口径：只取本轮 assistant/message 事件自带的 usage，不并入会话级投影，
        // 也不自行累计步数（steps 只展示，不回填到本轮数字里）。
        const handle = (raw: RawEvent): void => {
            if (raw.seq <= baselineSeq) {
                return;
            }
            const d = raw.data ?? {};
            switch (raw.type) {
                case 'assistant/chunk': {
                    const chunk = d['chunk'] as { type?: string; text?: string } | undefined;
                    if (!chunk) {
                        return;
                    }
                    if (chunk.type === CHUNK_TEXT && typeof chunk.text === 'string') {
                        text += chunk.text;
                        sawDeltas = true;
                        messageTime ??= raw.time; // 无 assistant/message 时的兜底时刻
                        if (firstDeltaAt === undefined) {
                            firstDeltaAt = raw.time; // 首个文本增量（TTFT 终点）
                        }
                        lastDeltaAt = raw.time; // 末尾文本增量（解码结束）
                        onDelta(chunk.text);
                    } else if (chunk.type === CHUNK_REASONING && typeof chunk.text === 'string') {
                        const step = typeof d['step'] === 'number' ? d['step'] : undefined;
                        opts.onReasoning?.(chunk.text, step);
                    }
                    break;
                }
                case 'assistant/message': {
                    sawAssistantMessage = true;
                    messageTime = raw.time; // 回答消息在服务端生成的原始时刻
                    const msgObj = d['message'] as { source?: { provider?: string; model?: string } } | undefined;
                    const src = msgObj?.source;
                    if (src && typeof src.provider === 'string') {
                        provider = src.provider;
                    }
                    if (src && typeof src.model === 'string') {
                        model = src.model;
                    }
                    const full = eventText(raw); // assistant/message 自带整条消息内容
                    if (full) {
                        text = full; // 以 API 整条消息为准，覆盖 text-delta 的本地拼接
                    }
                    const usage = usageOf(d);
                    if (usage) {
                        // 整轮口径：一个 turn 可含多个 assistant/message（每步一次），usage 求和累计，
                        // 不用最后一次覆盖（避免多 step / 重试回合低估）。steps 不在此累计。
                        lastStats = {
                            ...lastStats,
                            inputTokens: addOpt(lastStats.inputTokens, numberOr(usage['inputTokens'] ?? usage['uncachedInputTokens'])),
                            outputTokens: addOpt(lastStats.outputTokens, numberOr(usage['outputTokens'])),
                            cacheReadTokens: addOpt(lastStats.cacheReadTokens, numberOr(usage['cacheReadTokens'])),
                            cacheWriteTokens: addOpt(lastStats.cacheWriteTokens, numberOr(usage['cacheWriteTokens'])),
                            reasoningTokens: addOpt(lastStats.reasoningTokens, numberOr(usage['reasoningTokens'])),
                            totalTokens: addOpt(lastStats.totalTokens, numberOr(usage['totalTokens'])),
                        };
                    }
                    break;
                }
                case 'turn/start':
                    if (turnStartAt === undefined) {
                        turnStartAt = raw.time;
                    }
                    break;
                case 'step/start':
                    stepStartAt = raw.time;
                    // 每次 LLM 调用(step)重置“本次调用”解码计时窗口，TTFT/TPS 反映最后一次回答调用
                    firstDeltaAt = undefined;
                    lastDeltaAt = undefined;
                    opts.onActivity?.({ type: 'step', step: typeof d['step'] === 'number' ? d['step'] : undefined });
                    break;
                case 'tool/call':
                    opts.onActivity?.({
                        type: 'tool',
                        step: typeof d['step'] === 'number' ? d['step'] : undefined,
                        tool: stringOf(d['name']) ?? stringOf(d['toolName']) ?? undefined,
                    });
                    break;
                case 'turn/end': {
                    turnEndAt = raw.time;
                    const reason = d['reason'] as { kind?: string; message?: string; error?: { message?: string } } | undefined;
                    const kind = reason?.kind;
                    const message = reason?.error?.message ?? reason?.message;
                    if (kind === 'error') {
                        errorAtEnd = { message: message ?? '会话回合出错' };
                        endMarker = { kind, message }; // 有部分文本的出错回合也标记，UI 不再当正常完成
                    } else if (kind && kind !== 'completed') {
                        // aborted / interrupted / max-tokens / blocked 等：保留原文但标记终止原因
                        endMarker = { kind, message };
                    }
                    finish();
                    break;
                }
                default:
                    break;
            }
        };
        let control: { cancel: () => void } = { cancel: () => {} };
        void openMuxStream(
            'session/follow',
            { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 5000 } } },
            {
                onItem: (value) => {
                    rawLog('follow', value); // 实验抓帧：env DSH_RAWLOG=1/full
                    const v = value as Record<string, unknown> | undefined;
                    if (!v) {
                        return;
                    }
                    if (v['type'] === 'snapshot') {
                        // 会话级投影(tokenUsage/sessionStats)仅供 UI 底部累计条,不经此口径混入本轮
                        const records = Array.isArray(v['records']) ? v['records'] : [];
                        for (const r of records) {
                            const e = toRawEvent(r);
                            if (e) {
                                handle(e);
                            }
                        }
                        return;
                    }
                    const e = toRawEvent(v);
                    if (e) {
                        handle(e);
                    }
                },
                onError: (err) => finish(new Error(`DSH 会话流错误：${err.message}`)),
                onEnd: () => finish(new Error('DSH 会话流意外结束')),
                onClose: () => finish(new Error('DSH 会话流关闭')),
            },
            Math.min(timeoutMs + 5000, 130_000)
        )
            .then((c) => {
                control = c;
                if (settled) {
                    c.cancel();
                }
            })
            .catch((e) => finish(e));
        // 兜底：极端情况没收到 turn/end，按 deadline 结束
        void (async () => {
            while (!settled) {
                if (Date.now() >= deadline) {
                    finish(new Error(`DSH 处理超时（${Math.round(timeoutMs / 1000)}s）`));
                    return;
                }
                await new Promise((r) => setTimeout(r, Math.max(200, Math.min(2000, deadline - Date.now()))));
            }
        })();
    });
    if (errorAtEnd && !sawDeltas && !sawAssistantMessage && !text) {
        throw new Error(errorAtEnd.message);
    }
    // 事件级指标(全用服务端 time)：模型、TTFT、TPS、本轮总用时
    if (provider) {
        lastStats = { ...lastStats, provider, model };
    }
    const ttftBase = stepStartAt ?? turnStartAt;
    if (firstDeltaAt !== undefined && ttftBase !== undefined && firstDeltaAt > ttftBase) {
        lastStats = { ...lastStats, ttftSec: round1((firstDeltaAt - ttftBase) / 1000) };
    }
    const outN = typeof lastStats.outputTokens === 'number' ? lastStats.outputTokens : 0;
    if (firstDeltaAt !== undefined && lastDeltaAt !== undefined && lastDeltaAt > firstDeltaAt && outN > 0) {
        lastStats = { ...lastStats, tps: Math.round(outN / ((lastDeltaAt - firstDeltaAt) / 1000)) };
    }
    const endAt = turnEndAt ?? messageTime ?? lastDeltaAt;
    const startAt = turnStartAt ?? stepStartAt;
    if (endAt !== undefined && startAt !== undefined && endAt > startAt) {
        lastStats = { ...lastStats, wallSec: round1((endAt - startAt) / 1000) };
    }
    return { text, stats: lastStats, time: messageTime, end: endMarker };
}
/** 读取会话当前事件水位（发消息前的 baseline seq）。 */
async function currentSeq(sessionId: string): Promise<number> {
    try {
        const snap = await readFollowSnapshot(sessionId, 500, 6000);
        return snap.events.reduce((max, e) => Math.max(max, e.seq), 0);
    } catch {
        return 0;
    }
}
/** 往已有会话发消息并等回复（非流式：内部收集 text-delta 返回全文）。 */
export async function askInSession(
    sessionId: string,
    text: string,
    opts: { timeoutMs?: number; isCancelled?: () => boolean } = {}
): Promise<string> {
    const baselineSeq = await currentSeq(sessionId);
    await sendPrompt(sessionId, [{ type: 'text', text }]);
    const result = await waitTurn(sessionId, baselineSeq, () => undefined, {
        timeoutMs: opts.timeoutMs,
        isCancelled: opts.isCancelled,
    });
    return result.text;
}
/** 往已有会话发消息，流式回调增量（text / reasoning / activity）。 */
export async function askInSessionStreaming(
    sessionId: string,
    content: DshContentPart[],
    onDelta: (delta: string) => void,
    opts: StreamingOpts = {}
): Promise<{ text: string; stats: DshReplyStats; time?: number; end?: { kind: string; message?: string } }> {
    const baselineSeq = await currentSeq(sessionId);
    await sendPrompt(sessionId, content);
    return waitTurn(sessionId, baselineSeq, onDelta, opts);
}
/** 单轮会话：新建 + 提问 + 等回复。 */
export async function ask(
    text: string,
    opts: { timeoutMs?: number; isCancelled?: () => boolean } = {}
): Promise<string> {
    const sessionId = await createSession();
    return askInSession(sessionId, text, opts);
}
