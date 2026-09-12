// web 卡展示字典（文案取字典原文，不自造同义词；适配上游 0.1.5-rc.2）。
export interface WebLabels {
  http: string
  noResults: string
  sourcesTruncated: string
  contentTruncated: string
}
export function webLabels(): WebLabels {
  return {
    http: 'HTTP',
    noResults: '未找到结果',
    sourcesTruncated: '来源列表已截断',
    contentTruncated: '内容已截断',
  }
}
