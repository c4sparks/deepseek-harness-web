// ⚠️ CORE-COUPLED（核心耦合；目录名 official，本仓库注释里称“核心”）——只映射 dsh 核心 rc1 规则，勿混入插件自有逻辑；核心变化只改本目录。
// dsh 把连续 assistant/chunk 增量打包成一行（rc1 @deepseek-ai/dsh-session/chunk-rows）：
//   storage record { type:'chunks', event:{ type:'chunkrow/text-chunks'|'reasoning-chunks'|'tool-call-chunks',
//     seq(=seq0), time(=time0), data:{ turn,step,index,dt[], texts[]/args[] } } }
// 本文件把它还原成逐个 assistant/chunk 增量事件（member k: seq=seq0+k, time=time0+Σdt[0..k-1]）。

/** 还原后的事件最小形状（可赋给插件 RawEvent）。 */
export interface ExpandedEvent {
    type: string;
    seq: number;
    time?: number;
    data?: Record<string, unknown>;
}

function plainRaw(x: unknown): ExpandedEvent | undefined {
    if (x === null || typeof x !== 'object') {return undefined;}
    const r = x as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown };
    if (typeof r.type === 'string' && typeof r.seq === 'number') {
        return {
            type: r.type,
            seq: r.seq,
            time: typeof r.time === 'number' ? r.time : undefined,
            data: r.data !== null && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : undefined,
        };
    }
    return undefined;
}

/** 展开一条历史 record：普通事件原样；{type:'chunks'} 打包行还原成增量事件序列。 */
export function expandChunkRows(rec: unknown): ExpandedEvent[] {
    if (rec === null || typeof rec !== 'object') {return [];}
    const rr = rec as { type?: unknown; event?: unknown };
    if (rr.type === 'chunks') {
        const row = rr.event as { type?: string; seq?: unknown; time?: unknown; data?: Record<string, unknown> } | undefined;
        if (!row || typeof row.seq !== 'number' || typeof row.time !== 'number' || !row.data) {return [];}
        let chunkType: string | undefined;
        const texts = Array.isArray(row.data['texts'])
            ? (row.data['texts'] as unknown[])
            : Array.isArray(row.data['args'])
                ? (row.data['args'] as unknown[])
                : [];
        if (row.type === 'chunkrow/text-chunks') {chunkType = 'text-delta';}
        else if (row.type === 'chunkrow/reasoning-chunks') {chunkType = 'reasoning-delta';}
        else if (row.type === 'chunkrow/tool-call-chunks') {chunkType = 'tool-call-delta';}
        if (!chunkType || texts.length === 0) {return [];}
        const dt = Array.isArray(row.data['dt']) ? (row.data['dt'] as unknown[]) : [];
        const seq0 = row.seq as number;
        const time0 = row.time as number;
        const turn = row.data['turn'];
        const step = row.data['step'];
        const out: ExpandedEvent[] = [];
        let cum = 0;
        for (let k = 0; k < texts.length; k += 1) {
            if (k > 0) {
                const g = dt[k - 1];
                cum += typeof g === 'number' ? g : 0;
            }
            const text = texts[k];
            out.push({
                type: 'assistant/chunk',
                seq: seq0 + k,
                time: time0 + cum,
                data: { turn, step, chunk: { type: chunkType, text: typeof text === 'string' ? text : undefined } },
            });
        }
        return out;
    }
    const e = plainRaw(rec);
    return e ? [e] : [];
}
