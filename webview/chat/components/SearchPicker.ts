// 公共「可搜索选择弹窗」：顶部搜索框(按名称/值模糊过滤) + 选项列表 + 方向键/Enter 选择。
// 用于需要从一组可选项里选一个值的场景(如权限预设 /permission、后续 @ 引用、模型等)，
// 弹窗定位/外点关闭由外层(anchor popup)负责，本组件只负责内部内容与键盘导航。
import { html } from 'htm/preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { keepRowVisible } from '../core/scroll'

export interface SearchOption {
  value: string
  /** 展示名(可为空，空则回落 value) */
  name?: string
  description?: string
}

export interface SearchPickerProps {
  title?: string
  options: SearchOption[]
  /** 当前已选值(可空)；命中时行首标 ✓ */
  currentId?: string
  placeholder?: string
  emptyText?: string
  /** 选中一个值：由外层决定是否确认危险项并关闭弹窗。 */
  onPick(opt: SearchOption): void
  /** 关闭弹窗(Escape)。 */
  onClose(): void
}

export function SearchPicker({ title, options, currentId, placeholder = '搜索…', emptyText = '没有可匹配的选项', onPick, onClose }: SearchPickerProps) {
  const [q, setQ] = useState('')
  // 打开时键盘光标直接落到当前值（有意偏离上游 active=0，理由见 docs/design/03）：少按几次 ↓。
  // 惰性初始化：组件每次打开都重新挂载，之后不随 currentId 变化跳位；搜索输入仍回第 0 项
  const [idx, setIdx] = useState(() => {
    const i = options.findIndex((o) => o.value === currentId)
    return i < 0 ? 0 : i
  })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const lower = q.trim().toLowerCase()
  const list = useMemo(() => {
    const base = lower
      ? options.filter((o) => (o.name || o.value).toLowerCase().includes(lower) || o.value.toLowerCase().includes(lower))
      : options
    return base
  }, [options, lower])
  const n = list.length
  const active = n === 0 ? 0 : Math.min(Math.max(idx, 0), n - 1)
  // 光标移动/过滤变化后把高亮行滚进列表可视区。依赖要带 list：过滤后即使 active 数值没变也要回到正确位置
  useEffect(() => {
    keepRowVisible(listRef.current, active)
  }, [active, list])
  const choose = (o: SearchOption): void => onPick(o)
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (n > 0) setIdx((i) => (i + 1) % n)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (n > 0) setIdx((i) => (i - 1 + n) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (list[active]) choose(list[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  return html`<div class="spicker" onKeyDown=${onKeyDown}>
    ${title ? html`<div class="popup-title">${title}</div>` : null}
    <input ref=${inputRef} class="spicker-search" type="text" placeholder=${placeholder} value=${q} spellcheck="false"
      onInput=${(e: Event) => {
        setQ((e.target as HTMLInputElement).value)
        setIdx(0)
      }} />
    <div class="spicker-list" ref=${listRef} role="listbox">
      ${n === 0
        ? html`<div class="opt" style=${{ opacity: 0.6, cursor: 'default' }}>${emptyText}</div>`
        : list.map(
            (o, i) => html`<div class=${'opt' + (i === active ? ' selected' : '')} key=${o.value}
              role="option" aria-selected=${i === active} data-idx=${i}
              onMouseEnter=${() => setIdx(i)}
              onClick=${() => choose(o)} title=${o.description ?? ''}>
              <span class="sp-name">${o.value === currentId ? '✓ ' : ''}${o.name || o.value}</span>
              ${o.description ? html`<span class="sp-desc">${o.description}</span>` : null}
            </div>`
          )}
    </div>
  </div>`
}
