// dsh 0.1.2-rc.1 流式对话：session/follow 驱动的 waitTurn 与 ask 系列。
import { openMuxStream } from "./api";
import {
    createSession,
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
}
function numberOr(v: unknown): number | undefined {
    return typeof v === 'number' ? v : undefined;
}
function stringOf(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
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
                finish(new Error('已取消'));
            }
        }, 400);
        const emitProjections = (values: Record<string, unknown>): void => {
            const tokenUsage = values['tokenUsage'] as Record<string, number> | undefined;
            const stats = values['sessionStats'] as Record<string, number> | undefined;
            if (tokenUsage) {
                lastStats = {
                    ...lastStats,
                    inputTokens: numberOr(tokenUsage['uncachedInputTokens']),
                    outputTokens: numberOr(tokenUsage['outputTokens']),
                    cacheReadTokens: numberOr(tokenUsage['cacheReadTokens']),
                    cacheWriteTokens: numberOr(tokenUsage['cacheWriteTokens']),
                };
            }
            if (stats && typeof stats['steps'] === 'number') {
                lastStats.steps = stats['steps'];
            }
        };
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
                        onDelta(chunk.text);
                    } else if (chunk.type === CHUNK_REASONING && typeof chunk.text === 'string') {
                        const step = typeof d['step'] === 'number' ? d['step'] : undefined;
                        opts.onReasoning?.(chunk.text, step);
                    }
                    break;
                }
                case 'assistant/message': {
                    sawAssistantMessage = true;
                    const usage = usageOf(d);
                    if (usage) {
                        lastStats = {
                            ...lastStats,
                            inputTokens: numberOr(usage['inputTokens'] ?? usage['uncachedInputTokens']),
                            outputTokens: numberOr(usage['outputTokens']),
                            cacheReadTokens: numberOr(usage['cacheReadTokens']),
                            cacheWriteTokens: numberOr(usage['cacheWriteTokens']),
                            reasoningTokens: numberOr(usage['reasoningTokens']),
                            totalTokens: numberOr(usage['totalTokens']),
                        };
                    }
                    break;
                }
                case 'step/start':
                    opts.onActivity?.({ type: 'step', step: typeof d['step'] === 'number' ? d['step'] : undefined });
                    break;
                case 'tool/call':
                    opts.onActivity?.({
                        type: 'tool',
                        step: typeof d['step'] === 'number' ? d['step'] : undefined,
                        tool: stringOf(d['name']) ?? stringOf(d['toolName']) ?? undefined,
                    });
                    break;
                case 'step/end':
                    lastStats.steps = (lastStats.steps ?? 0) + 1;
                    break;
                case 'turn/end': {
                    const reason = d['reason'] as { kind?: string; message?: string; error?: { message?: string } } | undefined;
                    if (reason && reason.kind === 'error') {
                        errorAtEnd = { message: reason.error?.message ?? reason.message ?? '会话回合出错' };
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
                    const v = value as Record<string, unknown> | undefined;
                    if (!v) {
                        return;
                    }
                    if (v['type'] === 'snapshot') {
                        const proj = (v['projections'] as { values?: Record<string, unknown> } | undefined)?.values;
                        if (proj) {
                            emitProjections(proj);
                        }
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
    return { text, stats: lastStats };
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
): Promise<{ text: string; stats: DshReplyStats }> {
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
