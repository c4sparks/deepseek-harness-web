// 回合过程折叠的判定（适配上游 0.1.5-rc.2）：镜像上游「过程窗口就绪 → 可折叠 → 谁被藏起来」那条判据链。
//
// 上游是**逐节点**判的（每个节点各自算 `processWindowReady` / `processMember` / `foldable` / `processHidden`）；
// 插件一回合只有一条行，所以把同一套判据投影到「行 + 链」这一层：
//   - 行 = 上游的**过程控制条**节点（折叠头就是它）；
//   - 链上的过程项 = 过程成员；
//   - 行的正文 = 上游的**回答步**（回答节点不随折叠隐藏）。
// 判据集中在本文件（纯函数、不碰 store 与 DOM），组件只按结果渲染 —— 与 `core/*-card.ts` 同一路子。
//
// 与上游的三处**已知差异**（都不是漏做，是有意为之，改前先看这里）：
//   1. `historyIncomplete`（快照分页是否完整）**尚未接入**：上游拿它做过程窗口的最后一道门，
//      插件链路里还没有这个字段，故暂缺（`undefined` 视为完整）。
//   2. `compactAnswer` 未做（依赖上游的 `steering` 插话节点，插件无此概念）。
//   3. 插件的**有意偏离**：链里只有提问行时不出折叠头（提问不参与过程折叠，见 design/06 §4）。
import type { DshTurnProcess } from '../../../src/dsh/rows/types'

export interface ProcessDisclosureInput {
    /** 回合是否已关闭（上游 `turnClosed`；插件由 `turn/end` 置真的 `done`） */
    done: boolean
    /** 行的过程事实；缺失 = 上游"根本没有控制条节点"（不折叠、也不出折叠头） */
    process: DshTurnProcess | undefined
    /** 用户偏好：紧凑才折叠（上游 `compactTranscript`） */
    compact: boolean
    /** 历史分页不完整（上游 `historyIncomplete`）；链路未接入，缺省视为完整 */
    historyIncomplete?: boolean
    /** 明细当前是否展开（UI 状态；上游按 turn+answerStep 持久化） */
    open: boolean
    /** 插件偏离：链里只含提问行 —— 此时不出折叠头 */
    onlyAsk: boolean
}

export interface ProcessDisclosure {
    /** 过程窗口就绪：判据链的公共前置，缺一即不折叠（也便于排查「为什么没折叠」） */
    windowReady: boolean
    /** 折叠头是否出现（上游：控制条节点自身 `foldable`） */
    head: boolean
    /** 明细（链上过程项）是否展开 */
    detail: boolean
}

/**
 * 判定一条回答行的过程折叠形态。
 * @param input - 行事实 + 用户偏好 + UI 展开态
 * @returns 折叠头与明细的可见性
 */
export function processDisclosure(input: ProcessDisclosureInput): ProcessDisclosure {
    const process = input.process
    // 上游的 `processWindowReady`：事实齐全 + 紧凑 + **有回答锚点** + 回合已关闭（+ 历史分页完整）
    const windowReady =
        process !== undefined &&
        input.compact &&
        process.answerAnchorSeq !== null &&
        input.done &&
        input.historyIncomplete !== true
    // 控制条自身要 foldable：窗口就绪 **且**（过程外置 或 回答步自带推理）
    // —— 「区间内什么都没有」时不折叠，但这不等于"没有过程"：回答步的推理同样算。
    const head = windowReady && (process.hasExternalProcess || process.inlineReasoning) && !input.onlyAsk
    // 折叠时藏的是**过程成员**；回答步在行的正文里，不受影响（上游同）
    return { windowReady, head, detail: !head || input.open }
}
