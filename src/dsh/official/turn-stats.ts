// ⚠️ CORE-COUPLED（核心耦合；目录名 official，本仓库注释里称“核心”）——只映射 dsh 核心 rc1 规则，勿混入插件自有逻辑；核心变化只改本目录。
// 核心 per-turn 用量/计时。
// 口径：
//  - 用量 = deriveTurnTokenUsage：按回合内各 attempt(assistant/message usage)聚合，
//          cacheRead/cacheWrite/reasoning 仅当每个 attempt 都上报才给；routes 每个都有才给；
//  - TTFT  = 该回合最靠前 step 的 step/start→首 token；
//  - TPS   = Σoutput ÷ Σ(首 token→完成 decode)，只计两者都有的 step；
//  - runMs = turn.end.time − turn.start.time。

export interface TurnTokenUsage {
    uncachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    routes?: ReadonlyArray<{ provider: string; model: string }>;
}

export interface TurnMetrics {
    ttftMs?: number;
    tokensPerSecond?: number;
}


export interface TurnLikeEvent {
    type: string;
    time?: number;
    data?: {
        turn?: unknown;
        step?: unknown;
        message?: { source?: { provider?: string; model?: string } };
        usage?: Record<string, unknown>;
        /** 结算事件的内嵌流（用量可能只在这里上报，见下方取值） */
        stream?: unknown;
        chunk?: { type?: string; text?: string; block?: { type?: string; text?: string } };
        reason?: { kind?: string };
    };
}

function isCount(v: unknown): v is number {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function sumAll(values: number[]): number | undefined {
    let total = 0;
    for (const v of values) {
        total += v;
        if (!Number.isSafeInteger(total)) {return undefined;}
    }
    return total;
}
function usageNum(u: Record<string, unknown>, k: string): number | undefined {
    const v = u[k];
    return typeof v === 'number' ? v : undefined;
}

interface Attempt {
    input: number;
    output: number;
    total: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    route?: { provider: string; model: string };
}

/** 归一化一次 attempt 的 usage；不可证 → undefined。 */
function normalizeAttempt(usage: Record<string, unknown>, route?: { provider: string; model: string }): Attempt | undefined {
    const input = usageNum(usage, 'inputTokens');
    const output = usageNum(usage, 'outputTokens');
    const cacheRead = usageNum(usage, 'cacheReadTokens');
    const cacheWrite = usageNum(usage, 'cacheWriteTokens');
    const reasoning = usageNum(usage, 'reasoningTokens');
    const total = usageNum(usage, 'totalTokens');
    if (!isCount(input) || !isCount(output)) {return undefined;}
    if (cacheRead !== undefined && !isCount(cacheRead)) {return undefined;}
    if (cacheWrite !== undefined && !isCount(cacheWrite)) {return undefined;}
    if (reasoning !== undefined && (!isCount(reasoning) || reasoning > output)) {return undefined;}
    const knownPrompt = sumAll([input, ...(cacheRead !== undefined ? [cacheRead] : []), ...(cacheWrite !== undefined ? [cacheWrite] : [])]);
    if (knownPrompt === undefined) {return undefined;}
    let exactTotal: number;
    if (total !== undefined) {
        if (!isCount(total)) {return undefined;}
        const prompt = total - output;
        if (!isCount(prompt) || prompt < knownPrompt) {return undefined;}
        if (cacheRead !== undefined && cacheWrite !== undefined && prompt !== knownPrompt) {return undefined;}
        exactTotal = total;
    } else {
        // 上游 strict：未给 exact total 时必须 cacheRead、cacheWrite 都有才可证；
        // 否则整组不下发（上游因此对这类回合不显示用量图标，仅显示用时）
        if (cacheRead === undefined || cacheWrite === undefined) {return undefined;}
        const d = sumAll([knownPrompt, output]);
        if (d === undefined) {return undefined;}
        exactTotal = d;
    }
    return {
        input,
        output,
        total: exactTotal,
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(route !== undefined ? { route } : {}),
    };
}

function aggregateAttempts(attempts: Attempt[]): TurnTokenUsage | undefined {
    if (attempts.length === 0) {return undefined;}
    const input = sumAll(attempts.map(a => a.input));
    const output = sumAll(attempts.map(a => a.output));
    const total = sumAll(attempts.map(a => a.total));
    if (input === undefined || output === undefined || total === undefined) {return undefined;}
    const cacheRead = attempts.every(a => a.cacheRead !== undefined) ? sumAll(attempts.map(a => a.cacheRead as number)) : undefined;
    const cacheWrite = attempts.every(a => a.cacheWrite !== undefined) ? sumAll(attempts.map(a => a.cacheWrite as number)) : undefined;
    const reasoning = attempts.every(a => a.reasoning !== undefined) ? sumAll(attempts.map(a => a.reasoning as number)) : undefined;
    let routes: TurnTokenUsage['routes'];
    if (attempts.every(a => a.route !== undefined)) {
        const seen = new Map<string, { provider: string; model: string }>();
        for (const a of attempts) {
            const r = a.route as { provider: string; model: string };
            seen.set(`${r.provider}::${r.model}`, r);
        }
        routes = [...seen.values()];
    }
    const out: TurnTokenUsage = {
        uncachedInputTokens: input,
        outputTokens: output,
        totalTokens: total,
    };
    if (cacheRead !== undefined) {out.cacheReadTokens = cacheRead;}
    if (cacheWrite !== undefined) {out.cacheWriteTokens = cacheWrite;}
    if (reasoning !== undefined) {out.reasoningTokens = reasoning;}
    if (routes !== undefined) {out.routes = routes;}
    return out;
}

/** 每回合 token 用量（核心 deriveTurnTokenUsage 口径）。 */
export function deriveTurnTokenUsage(events: readonly TurnLikeEvent[]): Map<number, TurnTokenUsage> {
    const attemptsByTurn = new Map<number, Attempt[]>();
    const invalidTurns = new Set<number>();
    for (const e of events) {
        const d = e.data ?? {};
        if (e.type !== 'assistant/message' || typeof d.turn !== 'number') {continue;}
        // 用量**只认事件自带的 `data.usage`**（上游 `settleMessage` 组装节点时即取这一个字段）：
        // 缺就是没有 —— 不从那一条流里另找来源，否则会在上游隐藏的回合里算出用量与速度。
        const usage = d.usage;
        const source = d.message?.source;
        const route =
            source && typeof source.provider === 'string' && source.provider.length > 0 && typeof source.model === 'string' && source.model.length > 0
                ? { provider: source.provider, model: source.model }
                : undefined;
        const attempt =
            usage && typeof usage === 'object' ? normalizeAttempt(usage as Record<string, unknown>, route) : undefined;
        if (attempt === undefined) {
            // 该回合存在缺 usage / 不可证的 attempt：上游整组不下发
            invalidTurns.add(d.turn);
            continue;
        }
        const arr = attemptsByTurn.get(d.turn) ?? [];
        arr.push(attempt);
        attemptsByTurn.set(d.turn, arr);
    }
    const out = new Map<number, TurnTokenUsage>();
    for (const [turn, attempts] of attemptsByTurn) {
        if (invalidTurns.has(turn)) {continue;}
        const agg = aggregateAttempts(attempts);
        if (agg !== undefined) {out.set(turn, agg);}
    }
    return out;
}

interface ChunkLike {
    type?: string;
    text?: string;
    block?: { type?: string; text?: string };
}
/** “首 token”计时证据 = 首个非空流式增量(text-delta 或 reasoning-delta)；block-end 整块/压缩残留不算（否则 decode≈0→TPS 爆表）。 */
function isTokenDelta(chunk: ChunkLike | undefined): boolean {
    return (
        chunk !== undefined &&
        (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
        typeof chunk.text === 'string' &&
        chunk.text.trim() !== ''
    );
}

/** 每回合计时（核心 deriveTurnMetrics + runMs 口径）。 */
export function deriveTurnFacts(events: readonly TurnLikeEvent[]): {
    metrics: Map<number, TurnMetrics>;
    runMs: Map<number, number>;
} {
    interface Fold {
        best?: { step: number; ttftMs: number };
        decodeMs: number;
        out: number;
        sampled: boolean;
    }
    const folds = new Map<number, Fold>();
    const runMs = new Map<number, number>();
    let turnStart: number | undefined;
    let stepStartAt: number | undefined;
    let firstTokenAt: number | undefined;
    /** 本轮**最低** step：上游 TTFT 固定取它，它没有首 token 就整轮没有 TTFT（不回退到更高的 step）。 */
    let firstStepOfTurn: number | undefined;
    for (const e of events) {
        const t = e.time;
        const d = e.data ?? {};
        if (e.type === 'turn/start') {
            turnStart = t;
            firstStepOfTurn = undefined;
            continue;
        }
        if (e.type === 'turn/end') {
            if (turnStart !== undefined && typeof t === 'number' && typeof d.turn === 'number') {
                runMs.set(d.turn, Math.max(0, t - turnStart));
            }
            continue;
        }
        if (e.type === 'step/start') {
            stepStartAt = t;
            firstTokenAt = undefined;
            if (firstStepOfTurn === undefined && typeof d.step === 'number') {
                firstStepOfTurn = d.step;
            }
            continue;
        }
        if (e.type === 'assistant/chunk' && isTokenDelta(d.chunk as ChunkLike) && firstTokenAt === undefined) {
            firstTokenAt = t;
            continue;
        }
        if (e.type !== 'assistant/message' || typeof d.turn !== 'number') {continue;}
        const step = typeof d.step === 'number' ? d.step : 1;
        const fold = folds.get(d.turn) ?? { decodeMs: 0, out: 0, sampled: false };
        // TTFT **固定取本轮最低 step**（上游 `firstStepTtftMs` 的语义）：那个 step 没有首 token
        // 就整轮没有 TTFT，**不回退**到更高的 step —— 否则会在上游隐藏的回合里显示出来。
        if (
            (firstStepOfTurn === undefined || step === firstStepOfTurn) &&
            firstTokenAt !== undefined &&
            stepStartAt !== undefined &&
            typeof t === 'number' &&
            firstTokenAt > stepStartAt
        ) {
            fold.best = { step, ttftMs: firstTokenAt - stepStartAt };
        }
        const outN = usageNum(d.usage ?? {}, 'outputTokens');
        if (firstTokenAt !== undefined && typeof t === 'number' && t > firstTokenAt && isCount(outN) && outN > 0) {
            fold.decodeMs += t - firstTokenAt;
            fold.out += outN;
            fold.sampled = true;
        }
        folds.set(d.turn, fold);
        firstTokenAt = undefined;
    }
    const metrics = new Map<number, TurnMetrics>();
    for (const [turn, fold] of folds) {
        const entry: TurnMetrics = {};
        if (fold.best !== undefined) {entry.ttftMs = fold.best.ttftMs;}
        if (fold.sampled && fold.decodeMs > 0) {entry.tokensPerSecond = fold.out / (fold.decodeMs / 1000);}
        if (entry.ttftMs !== undefined || entry.tokensPerSecond !== undefined) {metrics.set(turn, entry);}
    }
    return { metrics, runMs };
}
