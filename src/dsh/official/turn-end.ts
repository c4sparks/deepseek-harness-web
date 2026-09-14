// 回合终止原因的形状（适配上游 0.1.5-rc.2）：镜像上游 turn/end 的 reason.kind 取值集合。
//
// ⚠️ CORE-COUPLED（核心耦合；目录名 official，本仓库注释里称"核心"）——只映射 dsh 核心规则，
// 勿混入插件自有逻辑；核心变化只改本目录。

/**
 * 回合终止原因的取值（对齐上游 `TurnEndReasonMap` 的 6 个键）。
 *
 * 语义提醒：`interrupted` 指**崩溃遗弃回合的事后关闭**（只在冷读/恢复时合成），
 * 用户点停止、取消请求走的是 `aborted`。
 */
export type DshTurnEndKind = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted';

/**
 * 插件**自己产出**终止原因时用的停止占位值。
 *
 * 为什么单独定义：产出侧一旦自造集合外的值（历史上用了 `cancelled`），同一件「用户停止」
 * 会在实时与历史两条路径上显示成不同的词。收在这里由 tsc 兜住，改也只改这一处。
 *
 * 注意 **消费侧不做白名单校验**：上游该类型可合并扩展，运行期可能收到集合外的陌生值，
 * 原样透传比静默丢弃安全。
 */
export const STOPPED_TURN_END: DshTurnEndKind = 'aborted';
