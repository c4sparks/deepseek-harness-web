// 弹层列表的滚动跟随：把 data-idx 命中的那一行滚进容器可视区。
// 不用 scrollIntoView —— 它会把祖先/整页一起滚，而这里只需要动列表自己的 scrollTop。
/** 把容器内 `data-idx=idx` 的行滚进可视区；容器或行不存在时静默返回。 */
export function keepRowVisible(container: HTMLElement | null, idx: number): void {
  if (!container) return
  const el = container.querySelector<HTMLElement>(`[data-idx="${idx}"]`)
  if (!el) return
  // 用 rect 换算行相对「容器内容顶部」的偏移：行的 offsetParent 未必就是滚动容器，offsetTop 会算错基准
  const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  const bottom = top + el.offsetHeight
  if (top < container.scrollTop) {
    container.scrollTop = top
  } else if (bottom > container.scrollTop + container.clientHeight) {
    container.scrollTop = bottom - container.clientHeight
  }
}
