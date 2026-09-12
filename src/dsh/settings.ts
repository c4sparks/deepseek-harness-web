// dsh 设置读取（适配上游 0.1.5-rc.2）：读「设置 → 对话显示」的 紧凑/标准，供对话区跟随。
// 只读——写入仍由上游设置页负责，插件不改用户设置文档。
// 实时跟随走 $events 的 emit（settings/document-updated）；emit 之外仍有「read 时值一变就通知」兜底。
import { rpcCall } from './rpc';
import { dshEvents } from './events';

/** 对话显示形态：compact=已完成回合的过程内容收起成折叠头；normal=过程行平铺。 */
export type DshTranscriptView = 'normal' | 'compact';

/** 「对话显示」所属的设置命名空间。 */
const TRANSCRIPT_VIEW_NS = 'ui-chat';

/** 设置文档变更的 $events emit 事件名。 */
const SETTINGS_UPDATED_EVENT = 'settings/document-updated';

/** settings/describe 应答里本模块用到的部分（其余命名空间与 schema 不解析）。 */
interface SettingsDescribeValue {
    namespaces?: Array<{
        ns?: string;
        /** 合成后的生效值（含默认与 base） */
        value?: Record<string, unknown>;
        /** 用户段 */
        user?: Record<string, unknown>;
    }>;
}

/** 最近一次成功读到的值；undefined = 还没成功读到过。 */
let cached: DshTranscriptView | undefined;

/** 已通知给订阅者的值（去重：同值不重复回调）。 */
let notified: DshTranscriptView | undefined;

/** 失败日志只打一次：服务未起时会被反复调用，刷屏会淹没其它日志。 */
let warnedFailure = false;

/** 在飞的那次读取：并发调用复用同一次 RPC，避免 emit 密集时打多份。 */
let inflight: Promise<DshTranscriptView | undefined> | undefined;

const subscribers = new Set<(value: DshTranscriptView) => void>();

/** $events 流的订阅句柄（首个订阅者建立、无人订阅时释放）。 */
let unsubscribeStream: (() => void) | undefined;

/** 按上游 schema 归一化：只有精确 'normal' 才算 normal，其余（缺失/非法）一律 compact。 */
function normalize(raw: unknown): DshTranscriptView {
    return raw === 'normal' ? 'normal' : 'compact';
}

async function doRead(): Promise<DshTranscriptView | undefined> {
    let value: SettingsDescribeValue;
    try {
        value = await rpcCall<SettingsDescribeValue>('settings.describe', {});
        warnedFailure = false;
    } catch (e) {
        // 读不到时**不返回默认值**：返回 compact 会把「读失败」伪装成「用户选了紧凑」，
        // 让已经按 normal 展开的界面瞬间抖回收起。调用方拿到 undefined 应保留上次值。
        if (!warnedFailure) {
            warnedFailure = true;
            console.warn(`[dsh-settings] 读取设置失败：${e instanceof Error ? e.message : String(e)}`);
        }
        return undefined;
    }
    const ns = value?.namespaces?.find((item) => item?.ns === TRANSCRIPT_VIEW_NS);
    // 优先生效值，回退用户段；两者都没有 = 用户没设过，按上游默认 compact
    cached = normalize(ns?.value?.['transcriptView'] ?? ns?.user?.['transcriptView']);
    if (cached !== notified) {
        notified = cached;
        for (const cb of subscribers) {
            cb(cached);
        }
    }
    return cached;
}

/** 最近一次成功读到的值（新面板回填用，省一次 RPC）。 */
export function getCachedTranscriptView(): DshTranscriptView | undefined {
    return cached;
}

/**
 * 读一次「设置 → 对话显示」。成功且取值有变化时，顺带通知订阅者（于是「读」即「对齐」）。
 * @returns 取值；undefined = 本次没读到（服务未起 / 上游没挂设置 provider / 调用失败）
 */
export function readTranscriptView(): Promise<DshTranscriptView | undefined> {
    if (inflight !== undefined) {
        return inflight;
    }
    inflight = doRead().finally(() => {
        inflight = undefined;
    });
    return inflight;
}

/** emit 分发：只在**确证**是别的命名空间时跳过——形状不符时保守重读，避免上游换帧形状后这里永不更新。 */
function onEmit(event: string, args: readonly unknown[]): void {
    if (event !== SETTINGS_UPDATED_EVENT) {
        return;
    }
    const ns = args[0];
    if (typeof ns === 'string' && ns !== TRANSCRIPT_VIEW_NS) {
        return;
    }
    void readTranscriptView();
}

/**
 * 订阅「对话显示」取值变化（仅在成功读到且与上次通知值不同时回调；读失败不回调）。
 * @param cb - 变化回调
 * @returns 退订函数（最后一个订阅者退订时释放 $events 流订阅）
 */
export function subscribeTranscriptView(cb: (value: DshTranscriptView) => void): () => void {
    subscribers.add(cb);
    if (unsubscribeStream === undefined) {
        unsubscribeStream = dshEvents.subscribeStream({
            onEmit,
            // 断线期间的 emit 不补发：重连后重读一次对齐
            onReady: () => {
                void readTranscriptView();
            },
        });
    }
    void readTranscriptView(); // 立即读一次，让新订阅者尽快拿到当前值
    return () => {
        subscribers.delete(cb);
        if (subscribers.size === 0 && unsubscribeStream !== undefined) {
            unsubscribeStream();
            unsubscribeStream = undefined;
        }
    };
}
