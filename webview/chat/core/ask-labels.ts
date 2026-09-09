// 提问卡（ask_user_question）展示字典（官方 zh 原文，`ask.*`），照抄 ui-conversation locales.ts，不自行翻译。
export interface AskLabels {
  rowTitle: string
  waiting: string
  cancelled: string
  cancelledDetail: string
  interrupted: string
  interruptedDetail: string
  answered: (answered: number, total: number) => string
  skipped: string
}

/** 官方 zh：`ask.rowTitle` / `ask.waiting` / `ask.cancelled{Detail}` / `ask.interrupted{Detail}` / `ask.answered` / `ask.skipped`。 */
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
  }
}
