// 上下文注入/召回行的官方 zh 字典（`message.context*`），照抄 ui-chat locale.ts，不自行翻译。
// 与 terminal.ts terminalLabels() 同一套路：只放官方原文，参数插值用函数。

export interface ContextLabels {
  contextInjection: string
  contextRecall: string
  instructionsLoaded: string
  instructionsAdded: string
  instructionsUpdated: string
  instructionsRemoved: string
  catalogReplaced: string
  catalogMore: (count: number) => string
  snapshotSupersedes: string
  relayFrom: (session: string) => string
  recallCounts: (retained: number, omitted: number) => string
  recallTruncated: string
  unknownBlock: string
  jsonTruncated: (total: number) => string
}

/** 官方 ui-chat zh：`message.contextInjection` / `message.contextRecall` / `message.context.*` / `message.unknownBlock` / `json.truncated`。 */
export function contextLabels(): ContextLabels {
  return {
    contextInjection: '上下文注入',
    contextRecall: '跨会话召回',
    instructionsLoaded: '已载入',
    instructionsAdded: '已新增',
    instructionsUpdated: '已更新',
    instructionsRemoved: '已移除',
    catalogReplaced: '替换目录',
    catalogMore: (count: number) => '…还有 ' + count + ' 条',
    snapshotSupersedes: '取代先前的快照',
    relayFrom: (session: string) => '来自会话 ' + session,
    recallCounts: (retained: number, omitted: number) => `保留 ${retained} 条 · 省略 ${omitted} 条`,
    recallTruncated: '已截断',
    unknownBlock: '未知内容块',
    jsonTruncated: (total: number) => `… 已截断，共 ${total} 字符`,
  }
}
