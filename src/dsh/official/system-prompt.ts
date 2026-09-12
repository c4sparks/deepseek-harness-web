// 系统提示词的读取。上游 0.1.5 起 system 走独立的 `system/message` 事件
// （旧版在 `request/header` 的 `header.system`，该字段已删）。
// 被 stream.ts（实时）与 session.ts（历史）共用 —— 同一逻辑只写一份，避免两边判据漂移。

/** 一次 `system/message` 载荷的投影。 */
export interface SystemPromptView {
    /** 该请求实际发给模型的完整 system；无 text 块 → 空串（调用方据此不渲染）。 */
    text: string;
    /** 事件所属 turn；缺失为 undefined。 */
    turn: number | undefined;
    /** 事件所属 step；缺失为 undefined。 */
    step: number | undefined;
}

/**
 * 从 `system/message` 事件的 data 读出 system 全文。
 *
 * 取法与上游 `inspectSystemPrompt` 一致：把 `message.content` 里的 **text 块拼起来**
 * （上游原式 `flatMap(b => b.type === 'text' ? [b.text] : []).join('')`），非 text 块忽略。
 *
 * @param data - 事件 data（`{ turn, step, message: { content: ContentBlock[] } }`）。
 * @returns system 全文与所属 turn/step。
 */
export function readSystemPrompt(data: Record<string, unknown> | undefined): SystemPromptView {
    const message = data?.['message'] as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    let text = '';
    for (const candidate of blocks) {
        const block = candidate as { type?: unknown; text?: unknown } | undefined;
        if (block !== undefined && block.type === 'text' && typeof block.text === 'string') {
            text += block.text;
        }
    }
    return {
        text,
        turn: typeof data?.['turn'] === 'number' ? (data['turn'] as number) : undefined,
        step: typeof data?.['step'] === 'number' ? (data['step'] as number) : undefined,
    };
}
