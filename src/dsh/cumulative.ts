// 会话累计投影 → “本轮”增量(官方用量/计时口径)的专用工具。
//
// dsh 官方弹窗的“本轮用量 / TPS / TTFT”不是每条 assistant/message 的 usage,而是回合
// 前后累计投影(sessionStats/tokenUsage)的差分。本模块集中提供差分与合并逻辑,后续要
// 调整口径(例如 TPS 分母取哪一段、TTFT 取均值还是单次)只改这里即可。
import type { DshReplyStats } from './stream';

/** 差分后我们关心的本轮字段(undefined 表示该键无可靠增量,合并时保留原值)。 */
export type TurnDelta = Partial<
    Pick<DshReplyStats, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'ttftSec' | 'tps'>
>;

/** 从投影对象里取数值字段;非 number 一律 undefined。 */
export function projValue(obj: Record<string, unknown> | undefined, key: string): number | undefined {
    const v = obj?.[key];
    return typeof v === 'number' ? (v as number) : undefined;
}

/** after-before;after 缺失取 undefined,before 缺失把 after 当本轮(如新建会话)。 */
export function diffN(after: number | undefined, before: number | undefined): number | undefined {
    if (typeof after !== 'number') {
        return undefined;
    }
    if (typeof before === 'number') {
        return Math.max(0, after - before);
    }
    return after;
}

/** 本轮增量:tokenUsage 四键差分 + sessionStats 计时差分(ttftSec 均值、tps)。 */
export function turnDelta(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): TurnDelta {
    const bTok = (before?.['tokenUsage'] as Record<string, unknown> | undefined) ?? {};
    const aTok = (after?.['tokenUsage'] as Record<string, unknown> | undefined) ?? {};
    const bS = (before?.['sessionStats'] as Record<string, unknown> | undefined) ?? {};
    const aS = (after?.['sessionStats'] as Record<string, unknown> | undefined) ?? {};
    const out: TurnDelta = {
        inputTokens: diffN(projValue(aTok, 'uncachedInputTokens'), projValue(bTok, 'uncachedInputTokens')),
        outputTokens: diffN(projValue(aTok, 'outputTokens'), projValue(bTok, 'outputTokens')),
        cacheReadTokens: diffN(projValue(aTok, 'cacheReadTokens'), projValue(bTok, 'cacheReadTokens')),
        cacheWriteTokens: diffN(projValue(aTok, 'cacheWriteTokens'), projValue(bTok, 'cacheWriteTokens')),
    };
    const ttftMs = diffN(projValue(aS, 'ttftMs'), projValue(bS, 'ttftMs'));
    const ttftSteps = diffN(projValue(aS, 'ttftSteps'), projValue(bS, 'ttftSteps'));
    const decodeMs = diffN(projValue(aS, 'decodeMs'), projValue(bS, 'decodeMs'));
    const decodeTok = diffN(projValue(aS, 'decodeTokens'), projValue(bS, 'decodeTokens'));
    if (ttftMs !== undefined && ttftSteps !== undefined && ttftSteps > 0) {
        out.ttftSec = Math.round((ttftMs / ttftSteps) / 100) / 10; // 平均单次首 token(秒,1 位小数)
    }
    if (decodeMs !== undefined && decodeMs > 0 && decodeTok !== undefined && decodeTok > 0) {
        out.tps = Math.round(decodeTok / (decodeMs / 1000));
    }
    return out;
}

/** 把差分结果合并进 per-message 基础 stats;只有差分有效的键才覆盖。 */
export function mergeTurnStats(stats: DshReplyStats, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): DshReplyStats {
    const delta = turnDelta(before, after);
    const merged: Record<string, unknown> = { ...(stats as unknown as Record<string, unknown>) };
    for (const key of Object.keys(delta) as Array<keyof TurnDelta>) {
        const v = delta[key];
        if (v !== undefined) {
            merged[key] = v;
        }
    }
    return merged as DshReplyStats;
}
