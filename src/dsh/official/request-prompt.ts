// 模型请求头（`request/header`）→ 系统提示词行（对齐上游 ui-chat `conversation-nodes/request-prompt.ts`）。
// 被 stream.ts（实时）与 session.ts（历史）共用 —— 同一逻辑只写一份，避免两边判据漂移。
//
// 上游规则：数据源是**该请求实际发给模型的 system**（不是 agent-instructions 注入事件）；
// 是否渲染这条行由 `showsPrompt` 决定（见 requestShowsPrompt）。

/** 一次 request/header 载荷的投影：该请求的 system 与上游 reason。 */
export interface RequestPromptView {
    /** 该请求实际发给模型的完整 system；缺失/非字符串 → 空串（调用方据此不渲染） */
    system: string;
    /** 上游 reason：initial / series / change */
    reason: string | undefined;
}

/**
 * 从 `request/header` 事件的 data 读出 system 与 reason。
 * @param data - 事件 data（`{ header: { system, tools, config }, reason }`）。
 * @returns 投影后的 system / reason。
 */
export function readRequestPrompt(data: Record<string, unknown> | undefined): RequestPromptView {
    const header = (data?.['header'] ?? {}) as Record<string, unknown>;
    const system = typeof header['system'] === 'string' ? header['system'] : '';
    const reason = typeof data?.['reason'] === 'string' ? (data['reason'] as string) : undefined;
    return { system, reason };
}

/**
 * 一次请求的 tools 指纹（判断 tools 是否变化用）。tools 可能是很大的 schema 数组，
 * 只在需要比较时才序列化由调用方决定（上游同样按整体相等判断）。
 * @param data - 事件 data。
 * @returns 序列化后的指纹；tools 缺失 → 空串。
 */
export function requestToolsKey(data: Record<string, unknown> | undefined): string {
    const header = (data?.['header'] ?? {}) as Record<string, unknown>;
    return header['tools'] === undefined ? '' : JSON.stringify(header['tools']);
}

/**
 * 上游 `showsPrompt` 判据：这条系统提示词行要不要渲染。
 * 首次（无前一条）/ 非 change / 起新序列 / system 或 tools 变更时为真 ——
 * 否则一个回合内的后续 step 会重复出一条。
 * @param prev - 前一条 request/header 的 system 与 tools 指纹；无则视为首次。
 * @param system - 本次 system。
 * @param toolsKey - 本次 tools 指纹。
 * @param reason - 本次 reason。
 * @param startsSeries - 上游 `startsSeries`（本次请求是否起了一个新的可见消息序列）。
 * @returns 是否渲染。
 */
export function requestShowsPrompt(
    prev: { system: string; toolsKey: string } | undefined,
    system: string,
    toolsKey: string,
    reason: string | undefined,
    startsSeries: boolean
): boolean {
    if (prev === undefined) { return true; }
    if (reason !== 'change') { return true; }
    if (startsSeries) { return true; }
    return prev.system !== system || prev.toolsKey !== toolsKey;
}
