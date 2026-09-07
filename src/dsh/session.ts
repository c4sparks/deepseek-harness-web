// dsh 0.1.2-rc.1 会话域：follow 事件模型/快照、session/model 操作、workspace 枚举。
import * as crypto from "node:crypto";
import { openMuxStream, rpcCall } from "./api";
import { deriveTurnTokenUsage, deriveTurnFacts, type TurnLikeEvent } from "./official/turn-stats";
import { expandChunkRows } from "./official/chunk-rows";
// ---------- 会话事件模型（dsh v0.1.2-rc.1 follow 载荷形状） ----------
export type DshContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string };
/** 一条原始会话事件（v0.1.2-rc.1 的 follow/snapshot 载荷轻量表示）。 */
export interface RawEvent {
    type: string;
    seq: number;
    time?: number;
    data?: Record<string, unknown>;
    surfaceOp?: unknown;
    sourceEventSeqs?: number[];
}
/** 从 follow item / 快照 record 里取出原始事件（record 可能是 { type:'event', event } 包装）。 */
export function toRawEvent(x: unknown): RawEvent | undefined {
    if (x === null || typeof x !== 'object') {
        return undefined;
    }
    const rec = x as { type?: unknown; event?: unknown };
    const raw = rec.type === 'event' && rec.event !== undefined ? rec.event : x;
    const r = raw as RawEvent;
    if (typeof r === 'object' && r !== null && typeof r.type === 'string' && typeof r.seq === 'number') {
        return r;
    }
    return undefined;
}
function textOfBlocks(content: unknown): string {
    const blocks = Array.isArray(content) ? content : [];
    let out = '';
    for (const part of blocks) {
        const p = part as { type?: string; text?: string };
        if (p && p.type === 'text' && typeof p.text === 'string') {
            out += p.text;
        }
    }
    return out;
}
export function usageOf(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const usage = data?.['usage'];
    return usage !== null && typeof usage === 'object' ? (usage as Record<string, unknown>) : undefined;
}
/** 事件自带文本（assistant/message 等）：取 message.content 或 content 的 text part 拼出。 */
export function eventText(event: RawEvent): string {
    const d = event.data ?? {};
    return textOfBlocks((d['message'] as { content?: unknown } | undefined)?.content ?? d['content']);
}
/** 是否为“表层人类消息”（user/message 且 source.kind === 'user'；系统注入的 plugin 消息不算）。 */
function eventIsSurfaceHuman(event: RawEvent): boolean {
    if (event.type !== 'user/message') {
        return false;
    }
    const source = event.data?.['source'] as { kind?: string } | undefined;
    return source?.kind === 'user';
}
// ---------- follow 快照（历史 / 投影读取） ----------
interface FollowSnapshot {
    events: RawEvent[];
    projections: Record<string, unknown>;
    cursor: number;
    hasMore: boolean;
}
/**
 * 打开一次 session/follow 并读到 snapshot 后即取消（适配 dsh v0.1.2-rc.1）。
 * 上游：session-controller 的流式远程 `session/follow`，首帧 snapshot 形如
 *   { header, cursor, records: SessionHistoryRecord[], hasMore, projections:{ asOfSeq, values } }，
 *   之后是实时事件帧。records 可能含 { type:'chunks' } 打包行，本方法只取可展开为 RawEvent 的部分。
 * @param maxMessages snapshot 里返回的“消息对齐”记录上限（调大以覆盖较长会话）。
 */
export async function readFollowSnapshot(sessionId: string, maxMessages = 5000, timeoutMs = 10_000): Promise<FollowSnapshot> {
    return new Promise<FollowSnapshot>((resolve, reject) => {
        let done = false;
        let ctl: { cancel: () => void } | undefined;
        const finish = (snap: FollowSnapshot | undefined, err?: Error): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            try {
                ctl?.cancel();
            } catch {
                /* noop */
            }
            if (err || snap === undefined) {
                reject(err ?? new Error('DSH 读取会话快照失败'));
            } else {
                resolve(snap);
            }
        };
        const timer = setTimeout(() => finish(undefined, new Error('DSH 读取会话快照超时')), timeoutMs);
        void openMuxStream(
            'session/follow',
            { args: { request: { address: { kind: 'session', sessionId }, maxMessages } } },
            {
                onItem: (value) => {
                    const v = value as Record<string, unknown> | undefined;
                    if (!v || v['type'] !== 'snapshot') {
                        return;
                    }
                    const records = Array.isArray(v['records']) ? v['records'] : [];
                    const events: RawEvent[] = [];
                    for (const r of records) {
                        const rr = r as { type?: unknown } | undefined;
                        if (rr && rr.type === 'chunks') {
                            for (const e of expandChunkRows(r)) {
                                events.push(e as RawEvent);
                            }
                        } else {
                            const e = toRawEvent(r);
                            if (e) {events.push(e);}
                        }
                    }
                    events.sort((a, b) => a.seq - b.seq);
                    const proj = (v['projections'] as { values?: Record<string, unknown> } | undefined)?.values ?? {};
                    const cursor = typeof v['cursor'] === 'number' ? v['cursor'] : -1;
                    // 快照日志（回合前后差分实证用）：env DSH_RAWLOG=1/full，含累计投影数值
                    const snapLog = process.env['DSH_RAWLOG'];
                    if (snapLog) {
                        if (snapLog === 'full') {
                            console.log(
                                '[dsh-raw] snapshot-read ' +
                                    JSON.stringify({ cursor, hasMore: v['hasMore'] === true, projections: proj, eventSummaries: events.map((e) => `${e.seq}:${e.type}`) }).slice(0, 200_000)
                            );
                        } else {
                            console.log(
                                `[dsh-raw] snapshot-read cursor=${cursor} projKeys=${Object.keys(proj).join(',') || '(none)'} events=${events.length}`
                            );
                        }
                    }
                    finish({
                        events,
                        projections: proj,
                        cursor,
                        hasMore: v['hasMore'] === true,
                    });
                },
                onError: (err) => finish(undefined, new Error(`DSH 会话快照失败：${err.message}`)),
                onEnd: () => finish(undefined, new Error('DSH 会话流意外结束')),
                onClose: () => finish(undefined, new Error('DSH 会话流关闭')),
            },
            timeoutMs
        )
            .then((c) => {
                ctl = c;
                if (done) {
                    c.cancel();
                }
            })
            .catch((e) => finish(undefined, e));
    });
}
/**
 * 恢复用消息历史（适配 dsh v0.1.2-rc.1）。
 * 上游：该版本无 `session.history` RPC；本方法经 `session/follow` 快照的 records 提取
 * “消息对齐”事件（SessionHistoryRecord），仅保留表层 human user/message 与 assistant/message，
 * 供恢复会话 UI 渲染（不含系统 plugin 注入消息与增量帧）。
 * 每条消息附带该事件自带的原始时间戳 `time`（epoch 秒/毫秒，由上游给出），页面据此显示真实时刻；
 * assistant 消息再附上该消息自带的 usage 与 provider/model（用量/用时图标据此显示，与实时同源）。
 */
export type SessionMessageItem = {
    role: 'user' | 'assistant';
    text: string;
    time?: number;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    /** 由快照事件时间算出的该消息指标（与实时同口径：turn/end−turn/start、step/start→首 token、解码 span） */
    wallSec?: number;
    ttftSec?: number;
    tps?: number;
    /** 停止状态展示文案（已停止 · Stopped），仅该回合被停止/中断/取消时给最后一条 assistant */
    status?: string;
};
export async function getSessionMessages(sessionId: string): Promise<SessionMessageItem[]> {
    const snap = await readFollowSnapshot(sessionId);
    const out: SessionMessageItem[] = [];
    const round10 = (n: number): number => Math.round(n * 10) / 10;
    // 核心 per-turn 统计委托 src/dsh/official/turn-stats.ts；本函数只做“拆消息 + 附加结果”，保持薄
    const lastAsst = new Map<number, number>(); // turn -> out 中最后一条 assistant 下标
    const endStatus = new Map<number, string>(); // 非 completed 的 turn -> 状态(回显 kind)
    const partialText = new Map<number, string>();
    const finalTextTurns = new Set<number>();
    const chunkPiece = (e: RawEvent): string => {
        const ch = e.data?.['chunk'] as { type?: string; text?: string; block?: { type?: string; text?: string } } | undefined;
        if (!ch) {return '';}
        if (ch.type === 'text-delta') {return typeof ch.text === 'string' ? ch.text : '';}
        if (ch.type === 'block-end' && ch.block?.type === 'text') {return typeof ch.block.text === 'string' ? ch.block.text : '';}
        return '';
    };
    for (const e of snap.events) {
        const d = e.data ?? {};
        const turn = typeof d['turn'] === 'number' ? (d['turn'] as number) : undefined;
        // 累计该回合流式文本(半截终止但无最终 message 时用来合成回答行)
        if (turn !== undefined && e.type === 'assistant/chunk') {
            const piece = chunkPiece(e);
            if (piece) {
                partialText.set(turn, (partialText.get(turn) ?? '') + piece);
            }
        }
        if (eventIsSurfaceHuman(e)) {
            const text = textOfBlocks(e.data?.['content']);
            if (text) {
                out.push({ role: 'user', text, time: e.time });
            }
            continue;
        }
        if (e.type === 'assistant/message') {
            const text = eventText(e);
            if (text) {
                out.push({ role: 'assistant', text, time: e.time });
                if (turn !== undefined) {
                    lastAsst.set(turn, out.length - 1);
                    finalTextTurns.add(turn);
                    partialText.delete(turn);
                }
            }
            continue;
        }
        if (e.type === 'turn/end') {
            const kind = (d['reason'] as { kind?: string } | undefined)?.kind;
            if (kind && kind !== 'completed' && turn !== undefined) {
                endStatus.set(turn, kind); // 先回显核心 kind，不翻译
            }
            // 有流式文本、被打断/中止且无最终 assistant/message → 合成半截回答行(官方会显示并给用时)
            if (turn !== undefined && !finalTextTurns.has(turn)) {
                const partial = (partialText.get(turn) ?? '').trim();
                if (partial) {
                    out.push({ role: 'assistant', text: partial, time: e.time });
                    lastAsst.set(turn, out.length - 1);
                    partialText.delete(turn);
                }
            }
        }
    }
    // 核心 per-turn：用量 / TTFT/TPS / runMs 全部由模块算
    const usage = deriveTurnTokenUsage(snap.events as unknown as TurnLikeEvent[]);
    const facts = deriveTurnFacts(snap.events as unknown as TurnLikeEvent[]);
    for (const [turn, idx] of lastAsst) {
        const item = out[idx];
        if (!item || item.role !== 'assistant') {
            continue;
        }
        const st = endStatus.get(turn);
        if (st) {
            item.status = st;
        }
        // 用量 pill 与 用时 pill 各自独立：
        //  用量 只在可证 usage(deriveTurnTokenUsage 推得出)时填；推不出不显示用量
        //  用时(总用时/TTFT/TPS) 与 usage 无关，凡 runMs/metrics 有就填
        const u = usage.get(turn);
        if (u) {
            item.inputTokens = u.uncachedInputTokens;
            item.outputTokens = u.outputTokens;
            if (u.cacheReadTokens !== undefined) {item.cacheReadTokens = u.cacheReadTokens;}
            if (u.cacheWriteTokens !== undefined) {item.cacheWriteTokens = u.cacheWriteTokens;}
            if (u.reasoningTokens !== undefined) {item.reasoningTokens = u.reasoningTokens;}
            if (u.routes !== undefined && u.routes.length === 1) {
                item.provider = u.routes[0].provider;
                item.model = u.routes[0].model;
            }
        }
        const m = facts.metrics.get(turn);
        if (m) {
            if (m.ttftMs !== undefined) {item.ttftSec = round10(m.ttftMs / 1000);}
            if (m.tokensPerSecond !== undefined) {item.tps = Math.round(m.tokensPerSecond);}
        }
        const rm = facts.runMs.get(turn);
        // 不预舍入：保留精确 ms→s，展示端按官方整秒向下取整
        if (rm !== undefined) {item.wallSec = rm / 1000;}
    }
    // 调试：每回合计时诊断（env DSH_RAWLOG=full 才打）
    if (process.env['DSH_RAWLOG'] === 'full') {
        interface Cnt { step: number; td: number; rd: number; be: number; msg: number; ts: number; te: number;
            ss?: number; ftd?: number; frd?: number; msgT?: number; }
        const cnt = new Map<number, Cnt>();
        for (const e of snap.events) {
            const d = e.data ?? {};
            const turn = typeof d['turn'] === 'number' ? (d['turn'] as number) : undefined;
            if (turn === undefined) {continue;}
            const c = cnt.get(turn) ?? { step: 0, td: 0, rd: 0, be: 0, msg: 0, ts: 0, te: 0 };
            if (e.type === 'step/start') {c.step += 1; if (c.ss === undefined) {c.ss = e.time;}}
            else if (e.type === 'turn/start') {c.ts += 1;}
            else if (e.type === 'turn/end') {c.te += 1;}
            else if (e.type === 'assistant/chunk') {
                const ch = d['chunk'] as { type?: string } | undefined;
                if (ch?.type === 'text-delta') {c.td += 1; if (c.ftd === undefined) {c.ftd = e.time;}}
                else if (ch?.type === 'reasoning-delta') {c.rd += 1; if (c.frd === undefined) {c.frd = e.time;}}
                else if (ch?.type === 'block-end') {c.be += 1;}
            } else if (e.type === 'assistant/message') {c.msg += 1; if (c.msgT === undefined) {c.msgT = e.time;}}
            cnt.set(turn, c);
        }
        for (const [turn, idx] of lastAsst) {
            const item = out[idx];
            if (!item || item.role !== 'assistant') {continue;}
            const c = cnt.get(turn);
            const u = usage.get(turn);
            const m = facts.metrics.get(turn);
            const rm = facts.runMs.get(turn);
            console.log(
                `[dsh-raw] history-metrics turn=${turn} ` +
                    `ev=${c ? `ts:${c.ts} te:${c.te} step:${c.step} msg:${c.msg} td:${c.td} rd:${c.rd} be:${c.be}` : '?'} ` +
                    (c && c.ss !== undefined ? `ss=${c.ss} ` : 'ss=- ') +
                    (c && c.ftd !== undefined ? `ftd=${c.ftd} ` : 'ftd=- ') +
                    (c && c.frd !== undefined ? `frd=${c.frd} ` : 'frd=- ') +
                    (c && c.msgT !== undefined ? `msgT=${c.msgT} ` : 'msgT=- ') +
                    `out=${u ? u.outputTokens : '-'} run=${rm ?? '-'}ms ` +
                    `ttft=${m && m.ttftMs !== undefined ? m.ttftMs : '-'}ms tps=${m && m.tokensPerSecond !== undefined ? Math.round(m.tokensPerSecond) : '-'}`
            );
        }
    }
    return out;
}

/**
 * 会话核心投影（适配 dsh v0.1.2-rc.1）。
 * 上游：无 `session.history` 投影；经 `session/follow` 快照的 projections.values 返回。
 * 实测键：title / goal / sessionStats / tokenUsage / permissions / modelSelection /
 * sessionListMetadata / todos / plan / contextPressure 等（rc1 web 组合注册的投影）。
 * 权限 / 统计 / 用量 / 标题等 UI 数据均来自这里。
 */
export async function getSessionProjections(sessionId: string): Promise<Record<string, unknown>> {
    const snap = await readFollowSnapshot(sessionId);
    return snap.projections;
}
// ---------- 会话操作（适配 dsh v0.1.2-rc.1；对应 session-controller 远程方法，载荷统一
//   args{ request: Session*Request }，见 rc1 源码 packages/api/session-controller/src/types.ts） ----------
/** 新建会话（上游 `session/create`；request 的 workspaceId / cwd 二选一）→ sessionId。 */
export async function createSession(opts: { workspaceId?: string; cwd?: string } = {}): Promise<string> {
    const value = await rpcCall<{ sessionId: string }>('session.create', {
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return value.sessionId;
}
/**
 * 向会话发送消息（上游 `session/prompt`，SessionPromptRequest）。
 * v0.1.2-rc.1 起 request 必须带客户端 mint 的 requestId（uuid，user/message 事件会回显）；
 * mode='queue' 表示进 agent 队列。content 支持文本 + 图片（data URL base64）块。
 */
export async function sendPrompt(sessionId: string, content: DshContentPart[]): Promise<void> {
    await rpcCall<{ accepted: boolean }>('session.prompt', {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content,
    });
}
/** 会话改名（上游 `session/rename`，SessionRenameRequest { sessionId, title }）。 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
    await rpcCall<{ title: string; seq: number }>('session.rename', { sessionId, title });
}
/** 取消当前回合（上游 `session/cancel`，SessionCancelRequest { sessionId }）→ { accepted }。 */
export async function cancelSession(sessionId: string): Promise<void> {
    await rpcCall<{ accepted: boolean }>('session.cancel', { sessionId });
}
/** 切换模型 / 推理等级（上游 `session/selectModel`，SessionSelectModelRequest = ModelSelection + sessionId）。 */
export async function selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<void> {
    await rpcCall<{ selected: unknown }>('session.selectModel', {
        sessionId,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
    });
}
/**
 * 模型目录（适配 dsh v0.1.2-rc.1）。
 * 上游接口：session-controller 远程方法 `session/modelCatalog`（无参，payload { args:{} }），
 * 返回 ModelCatalog { default, routableProviders, groups[{ id,name,models[{id,name,description,
 * reasoning:{efforts[]}}] }], failures }（见 rc1 packages/api/session-controller/src/types.ts）。
 * “当前会话选择的模型”不在这里：由 modelSelection 投影给出（见 dshService.listModels）。
 */
export async function modelCatalog(): Promise<{
    default?: { provider?: string; model?: string };
    groups?: Array<{
        id: string;
        name: string;
        models: Array<{
            id: string;
            name: string;
            description?: string;
            reasoning?: { efforts?: Array<{ id: string; name: string }>; defaultEffort?: string };
        }>;
    }>;
    /** 上游对加载失败 provider/组的提示，形状以 0.1.2-rc.1 返回为准（仅透传、UI 只显示组数） */
    failures?: unknown[];
}> {
    return rpcCall('session.modelCatalog', {});
}
// ---------- 工作区 ----------
/** 一个工作区（与上游 WorkspaceView 对齐；见 rc1 packages/api/workspace-controller/src/types.ts）。 */
export interface WorkspaceItem {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
    createdAt?: string;
    updatedAt?: string;
}
/**
 * 工作区列表（适配 dsh v0.1.2-rc.1）。
 * 该版本的 workspace-controller 不再提供独立的 `workspace.list` 远程方法；
 * 枚举改由流式 remote `workspace/follow`（斜杠端点，走 /api/remote.mux）提供：
 * 打开流后服务端首帧 value 形如
 *   { type:'baseline', value:{ items: WorkspaceView[], archivedSessionIds: string[] } }
 * （随后的 ordered 'changed' 增量帧本方法不需要，取到 baseline 即取消）。
 * 返回 items 与 archivedSessionIds。
 */
export async function workspaceList(): Promise<{ items: WorkspaceItem[]; archivedSessionIds: string[] }> {
    return new Promise((resolve, reject) => {
        let done = false;
        let ctl: { cancel: () => void } | undefined;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                reject(new Error('DSH 工作区读取超时'));
            }
        }, 8000);
        const settle = (fn: () => void): void => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                try {
                    ctl?.cancel();
                } catch {
                    /* noop */
                }
                fn();
            }
        };
        void openMuxStream(
            'workspace/follow',
            { args: {} },
            {
                onItem: (value) => {
                    const v = value as Record<string, unknown> | undefined;
                    const inner = (v?.['value'] as Record<string, unknown> | undefined) ?? v;
                    if (inner && Array.isArray(inner['items'])) {
                        settle(() =>
                            resolve({
                                items: inner['items'] as WorkspaceItem[],
                                archivedSessionIds: Array.isArray(inner['archivedSessionIds']) ? (inner['archivedSessionIds'] as string[]) : [],
                            })
                        );
                    }
                },
                onError: (err) => settle(() => reject(new Error(`DSH 工作区读取失败：${err.message}`))),
                onEnd: () => settle(() => reject(new Error('DSH 工作区流意外结束'))),
                onClose: () => settle(() => reject(new Error('DSH 工作区流关闭'))),
            },
            8000
        )
            .then((c) => {
                ctl = c;
                if (done) {
                    c.cancel();
                }
            })
            .catch((e) => settle(() => reject(e)));
    });
}
