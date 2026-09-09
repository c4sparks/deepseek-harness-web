// web 卡展示字典（官方 zh 原文，`web.*`），照抄 ui-conversation locales.ts，不自行翻译。
export interface WebLabels {
  http: string
  noResults: string
  sourcesTruncated: string
  contentTruncated: string
}

/** 官方 zh：`web.http` / `web.noResults` / `web.sourcesTruncated` / `web.contentTruncated`。 */
export function webLabels(): WebLabels {
  return {
    http: 'HTTP',
    noResults: '未找到结果',
    sourcesTruncated: '来源列表已截断',
    contentTruncated: '内容已截断',
  }
}
