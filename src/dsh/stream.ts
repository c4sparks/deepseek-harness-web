// dsh 0.1.2-rc.1 流式对话：session/follow 驱动的 waitTurn 与 ask 系列。
import { openMuxStream } from "./api";
import { deriveTurnTokenUsage, deriveTurnFacts, type TurnLikeEvent } from "./official/turn-stats";
import { parseExitStatus } from "./official/exit-status";
import { readToolResult, resultText } from "./official/result-text";
import { toolStatusOf } from "./official/tool-status";
import { contextForm, contextProvenance } from "./official/context-projection";
import {
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
    /** step=新模型调用开始；tool=发起一次工具调用；toolDone=该工具结果返回(成功或失败) */
    type: 'step' | 'tool' | 'toolDone';
    step?: number;
    /** 工具名（tool/call.data.name 回退 toolName 的原始名，如 pwsh/web_fetch/read） */
    tool?: string;
    name?: string;
    callId?: string;
    /** 工具调用原始参数 JSON 串（tool/call.data.arguments，不解析） */
    argsRaw?: string;
    /** toolDone 的失败原因（tool/result.data.error.code；原样透传，供展示层按码特判，如提问卡的 ASK_CANCELLED） */
    error?: string;
    /** toolDone 的终态（由 error.code + isError 判出，见 official/tool-status.ts）。webview 直接采用，不再自己按 error 判 */
    status?: 'ok' | 'error' | 'stopped';
    /** toolDone 的结果文本（tool/result message.content 文本；Terminal/Read 等卡展示输出） */
    output?: string;
    /** 退出码（输出末尾 marker 解析；Terminal 卡 Pill 展示；输出已剥 marker） */
    exitCode?: number;
    /** 终止信号名（[killed by signal: X]；优先于退出码） */
    signal?: string;
    /** tool/result.data.meta 原文透传（web_fetch 的 statusCode/截断、web_search 的 sources/answer 等卡数据源；未知形状原样带） */
    meta?: unknown;
}
/** 过程折叠计数（对齐官方 turn-process 的三个计数：toolCallCount=非 subagent 工具调用数；
 *  messageCount=最终答复前带文本的中间 assistant 消息数；subagentCount=名字识别为 subagent 委派的调用数。
 *  三者全 0 时折叠头文案兜底「已思考」） */
export interface DshTurnCounts {
    toolCallCount: number;
    messageCount: number;
    subagentCount: number;
}
/** 一次上下文注入（非用户 source 的 user/message：系统提示词/技能目录/跨会话召回/插件…），供 UI 渲染成「上下文注入」折叠行。 */
export interface DshContext {
    seq: number;
    time?: number;
    /** 模型实际读到的 content blocks（原文透传） */
    content: unknown[];
    /** durable user/message source 原文 */
    source: unknown;
    /** 投影角色与生产者名（recall=跨会话召回，其余=上下文注入） */
    provenance: { role: 'inject' | 'recall'; label: string | null };
    /** 生产者声明的展示形态（opaque 用与官方一致），null = opaque */
    form: string | null;
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
    onReasoning?: (delta: string, step?: number, index?: number) => void;
    onActivity?: (a: DshActivity) => void;
    onApproval?: (a: DshApproval) => void;
    onQuestion?: (q: DshQuestionRequest) => void;
    /** 上下文注入行（source.kind !== 'user' 的 user/message：系统提示词/技能/召回…） */
    onContext?: (c: DshContext) => void;
}
interface TurnResult {
    text: string;
    stats: DshReplyStats;
    /** 该轮回答在 dsh 侧生成的原始时间戳（epoch 秒/毫秒，取 assistant/message 事件自带 time） */
    time?: number;
    /** turn/end 的非正常终止原因（error/aborted/interrupted/max-tokens/blocked…）；正常完成则无 */
    end?: { kind: string; message?: string };
    /** 过程折叠计数（toolCallCount/messageCount，官方口径） */
    counts?: DshTurnCounts;
}
function stringOf(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
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
    // 核心 per-turn（模块）入参：只收集本回合关键事件，结束时交 official/turn-stats.ts 计算，不再自行统计
    const officialEvents: TurnLikeEvent[] = [];
    // 过程折叠计数（官方口径，见 DshTurnCounts）：本回合内累计，turn 结束取数
    let toolCallCount = 0;
    let subagentCount = 0;
    const replyTextSteps = new Set<number>(); // 出现过带文本 assistant/message 的 step
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
                    const chunk = d['chunk'] as { type?: string; text?: string; block?: { type?: string; text?: string } } | undefined;
                    if (!chunk) {
                        return;
                    }
                    officialEvents.push({ type: 'assistant/chunk', time: raw.time, data: { chunk } });
                    if (chunk.type === CHUNK_TEXT && typeof chunk.text === 'string') {
                        text += chunk.text;
                        sawDeltas = true;
                        messageTime ??= raw.time; // 无 assistant/message 时的兜底时刻
                        onDelta(chunk.text);
                    } else if (chunk.type === CHUNK_REASONING && typeof chunk.text === 'string') {
                        const step = typeof d['step'] === 'number' ? d['step'] : undefined;
                        // 块 index（兼容模型一步内多段 reasoning；缺失则回落按 step 归并）
                        const index = (chunk as { index?: unknown }).index;
                        opts.onReasoning?.(chunk.text, step, typeof index === 'number' ? index : undefined);
                    }
                    break;
                }
                case 'assistant/message': {
                    sawAssistantMessage = true;
                    messageTime = raw.time; // 回答消息在服务端生成的原始时刻
                    const full = eventText(raw); // assistant/message 自带整条消息内容
                    if (full) {
                        text = full; // 以 API 整条消息为准，覆盖 text-delta 的本地拼接
                        const st = d['step'];
                        if (typeof st === 'number') {
                            replyTextSteps.add(st); // 带可见文本的 assistant 消息（过程折叠 messageCount 用）
                        }
                    }
                    const msgObj = d['message'] as { source?: { provider?: string; model?: string } } | undefined;
                    const usage = usageOf(d);
                    // 核心 per-turn 模块入参（usage 归一化/optional 规则交给模块）
                    officialEvents.push({
                        type: 'assistant/message',
                        time: raw.time,
                        data: {
                            turn: d['turn'] as number | undefined,
                            step: d['step'] as number | undefined,
                            message: msgObj?.source ? { source: msgObj.source } : undefined,
                            usage,
                        },
                    });
                    break;
                }
                case 'user/message': {
                    // 上下文注入（非用户 source）：系统提示词/技能目录/跨会话召回等，回 UI 渲染成折叠行。
                    // 用官方投影逻辑判定（source.kind !== 'user'），把 content/source/provenance/form 透传。
                    const source = d['source'];
                    const record = source && typeof source === 'object' ? source as Record<string, unknown> : undefined;
                    const kind = record?.['kind'];
                    if (kind !== undefined && kind !== 'user') {
                        const content = Array.isArray(d['content']) ? d['content'] : [];
                        const provenance = contextProvenance(source);
                        opts.onContext?.({
                            seq: raw.seq,
                            time: raw.time,
                            content,
                            source,
                            provenance,
                            form: contextForm(source),
                        });
                    }
                    break;
                }
                case 'turn/start':
                    officialEvents.push({ type: 'turn/start', time: raw.time, data: { turn: d['turn'] as number | undefined } });
                    break;
                case 'step/start':
                    officialEvents.push({ type: 'step/start', time: raw.time, data: { step: d['step'] as number | undefined } });
                    opts.onActivity?.({ type: 'step', step: typeof d['step'] === 'number' ? d['step'] : undefined });
                    break;
                case 'tool/call': {
                    const toolName = stringOf(d['name']) ?? stringOf(d['toolName']);
                    // 抓帧：全部工具的调用参数（原先只打 web 类，排 shell 类问题时看不到有没有 description）
                    if (process.env['DSH_RAWLOG'] && toolName) {
                        console.log('[dsh-debug] tool/call name=' + toolName + ' callId=' + String(d['callId']) + ' args=' + String(d['arguments']).slice(0, 600));
                    }
                    if (toolName) {
                        // 官方口径：subagent 委派单独计数，不进 toolCallCount（折叠头分两项展示）
                        if (toolName === 'subagent' || toolName.startsWith('subagent_')) {
                            subagentCount += 1;
                        } else {
                            toolCallCount += 1;
                        }
                    }
                    opts.onActivity?.({
                        type: 'tool',
                        step: typeof d['step'] === 'number' ? d['step'] : undefined,
                        tool: toolName ?? undefined,
                        name: toolName ?? undefined,
                        callId: stringOf(d['callId']) ?? undefined,
                        argsRaw: stringOf(d['arguments']) ?? undefined,
                    });
                    break;
                }
                case 'tool/result': {
                    // 结果文本（供 Terminal/Read 等卡展示输出）：按上游 schema 解包后展平，
                    // 非 text 块序列化为 pretty JSON。配对 id 在 message.source.callId，不在顶层
                    const payload = readToolResult(d);
                    let output = resultText(payload.blocks, d['error'] as { name?: unknown; code?: unknown } | undefined);
                    // 退出状态：先于截断解析（marker 在输出末尾，截断会切掉）；再从展示输出剥掉 marker
                    if (process.env['DSH_RAWLOG']) {
                        console.log('[dsh-debug] tool/result callId=' + String(payload.callId) + ' meta=' + JSON.stringify(d['meta']).slice(0, 400) + ' blocks=' + JSON.stringify(payload.blocks ?? '').slice(0, 300));
                    }
                    const status = parseExitStatus(output);
                    output = status.output;
                    const exitCode = status.exitCode;
                    const signal = status.signal;
                    if (output.length > 8000) {
                        output = output.slice(0, 8000) + '\n…(输出过长已截断)';
                    }
                    const errCode = (d['error'] as { code?: string } | undefined)?.code;
                    opts.onActivity?.({
                        type: 'toolDone',
                        step: typeof d['step'] === 'number' ? d['step'] : undefined,
                        callId: payload.callId,
                        error: errCode,
                        // 终态由 isError + code 特例判出（不是「有码即失败」）
                        status: toolStatusOf(errCode, payload.isError),
                        output: output || undefined,
                        exitCode,
                        signal,
                        meta: d['meta'],
                    });
                    break;
                }
                case 'turn/end': {
                    officialEvents.push({ type: 'turn/end', time: raw.time, data: { turn: d['turn'] as number | undefined, reason: d['reason'] as { kind?: string } | undefined } });
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
    // 核心 per-turn（模块）：与历史同口径，替换旧的自行统计/投影差分
    const officialUsage = deriveTurnTokenUsage(officialEvents);
    const officialFacts = deriveTurnFacts(officialEvents);
    for (const [turnKey, u] of officialUsage) {
        lastStats = { ...lastStats, inputTokens: u.uncachedInputTokens, outputTokens: u.outputTokens };
        if (u.cacheReadTokens !== undefined) {
            lastStats.cacheReadTokens = u.cacheReadTokens;
        }
        if (u.cacheWriteTokens !== undefined) {
            lastStats.cacheWriteTokens = u.cacheWriteTokens;
        }
        if (u.reasoningTokens !== undefined) {
            lastStats.reasoningTokens = u.reasoningTokens;
        }
        if (u.routes !== undefined && u.routes.length === 1) {
            lastStats = { ...lastStats, provider: u.routes[0].provider, model: u.routes[0].model };
        }
        const m = officialFacts.metrics.get(turnKey);
        if (m) {
            if (m.ttftMs !== undefined) {
                lastStats.ttftSec = round1(m.ttftMs / 1000);
            }
            if (m.tokensPerSecond !== undefined) {
                lastStats.tps = Math.round(m.tokensPerSecond);
            }
        }
        const rm = officialFacts.runMs.get(turnKey);
        if (rm !== undefined) {
            lastStats.wallSec = rm / 1000; // 不预舍入：展示端按官方整秒向下取整
        }
        break; // 一次回合
    }
    // 过程折叠计数：messageCount = 带文本 assistant 消息数 - 1（去掉最终答复本身），最终答复单独展示
    const counts: DshTurnCounts = {
        toolCallCount,
        messageCount: replyTextSteps.size > 0 ? replyTextSteps.size - 1 : 0,
        subagentCount,
    };
    return { text, stats: lastStats, time: messageTime, end: endMarker, counts };
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
): Promise<{ text: string; stats: DshReplyStats; time?: number; end?: { kind: string; message?: string }; counts?: DshTurnCounts }> {
    const baselineSeq = await currentSeq(sessionId);
    await sendPrompt(sessionId, content);
    return waitTurn(sessionId, baselineSeq, onDelta, opts);
}
