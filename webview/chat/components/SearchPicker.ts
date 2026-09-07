// 公共「可搜索选择弹窗」：顶部搜索框(按名称/值模糊过滤) + 选项列表 + 方向键/Enter 选择。
// 用于需要从一组可选项里选一个值的场景(如权限预设 /permission、后续 @ 引用、模型等)，
// 弹窗定位/外点关闭由外层(anchor popup)负责，本组件只负责内部内容与键盘导航。
import { html } from 'htm/preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

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
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
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
    <div class="spicker-list">
      ${n === 0
        ? html`<div class="opt" style=${{ opacity: 0.6, cursor: 'default' }}>${emptyText}</div>`
        : list.map(
            (o, i) => html`<div class=${'opt' + (i === active ? ' selected' : '')} key=${o.value}
              onMouseEnter=${() => setIdx(i)}
              onClick=${() => choose(o)} title=${o.description ?? ''}>
              <span class="sp-name">${o.value === currentId ? '✓ ' : ''}${o.name || o.value}</span>
              ${o.description ? html`<span class="sp-desc">${o.description}</span>` : null}
            </div>`
          )}
    </div>
  </div>`
}
