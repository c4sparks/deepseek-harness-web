// 提问卡展示字典（文案取字典原文，不自造同义词）。
export interface AskLabels {
  rowTitle: string
  waiting: string
  cancelled: string
  cancelledDetail: string
  interrupted: string
  interruptedDetail: string
  answered: (answered: number, total: number) => string
  skipped: string
  /**
   * 结果文本取不到（`output` 缺失/坏形）时，提问卡仍能读出参数里的问题清单，
   * 此时用「未取到回答」呈现问题列表 —— 上游无此态（它落回通用「输入/输出」区的原始 JSON），
   * 属本插件有意偏离，理由与去向见 docs/design/06。
   */
  unread: string
  unreadDetail: string
}
export function askLabels(): AskLabels {
  return {
    rowTitle: '提问',
    waiting: '等待回答',
    cancelled: '已取消',
    cancelledDetail: '本轮已取消，未提交回答',
    interrupted: '已中断',
    interruptedDetail: '本轮已中断，未提交回答',
    answered: (answered: number, total: number) => `${answered}/${total} 已回答`,
    skipped: '未回答',
    unread: '未取到回答',
    unreadDetail: '本条提问没有拿到回答数据，以下是当时问的问题',
  }
}
