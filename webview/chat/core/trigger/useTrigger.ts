// 输入触发(trigger)通用框架："/" 斜杠命令、"@ " 引用等“输入框内前缀触发”都收敛到这里。
// 一个触发器 = 一个 TriggerDef，注册进 Composer 后由本钩子统一负责：
//   命中检测(match) → 候选行(rows) → 过滤 → 键盘/点击选择 → pick 分派(改文本或执行)。
// 新加触发类型时新建一个文件(如 at.ts)实现 TriggerDef，并在 Composer 的 defs 数组里加一项即可，
// 避免把逻辑堆进 Composer/单文件。
import { useEffect, useState } from 'preact/hooks'
import { html } from 'htm/preact'
import type { ChatStore } from '../store/chat'

/** 菜单里的一行候选（slash 命令 / 技能 / 本地动作 / 将来 @ 的文件…）。 */
export interface TriggerRow {
  /** 语义分类（slash: command/skill/local；@: file …）。 */
  kind: string
  /** 名字（不含触发符），过滤按它做。 */
  name: string
  /** 展示前缀，如 '/'。 */
  prefix: string
  description: string
  /** 可选输入提示（如 permission 的 "<preset>"）。 */
  hint?: string
  /** 分组标识（同组连续排一起）；提供 groupLabel 时在该组首行前渲染分组头。 */
  group?: string
  groupLabel?: string
}

/** pick 时提供给 def 的输入改写助手。 */
export interface TriggerPickHelpers {
  /** 用 value 替换「触发符之后到光标前」的整段，光标移到末尾并聚焦。 */
  replace(value: string): void
  /** 删除「触发符之后到光标前」的整段（清掉刚输入的触发内容）。 */
  clear(): void
}

export interface TriggerDef {
  id: string
  /** 依文本与光标判定是否命中本触发器；命中返回触发符位置 start 与查询串 query。 */
  match(text: string, caret: number): { query: string; start: number } | null
  /** 返回全部候选行（过滤由框架按 query 做）。可在内部做异步目录预取。 */
  rows(): TriggerRow[]
  /** 选中某行后的行为。 */
  pick(row: TriggerRow, helpers: TriggerPickHelpers): void
}

export interface TriggerMenuApi {
  open: boolean
  rows: TriggerRow[]
  active: number
  /** 待渲染的浮层片段（空/关时为 null）。 */
  popup: unknown
  /** 文本或光标变化后调用（刷新命中/过滤）。 */
  sync(): void
  /** 关闭并复位。 */
  reset(): void
  /** 绑到 textarea 的 keydown。 */
  onKeyDown(e: KeyboardEvent): void
}

const MENU_ID = 'triggerPopup'

/** 一个触发器菜单的控制器。defs 可按需传入，命中取第一个 match 非空者。 */
export function useTriggerMenu(defs: TriggerDef[], store: ChatStore, taRef: { current: HTMLTextAreaElement | null }): TriggerMenuApi {
  // 当前命中：触发符所属 def + 触发符位置 + 查询串
  const [sel, setSel] = useState<{ defId: string; start: number; query: string } | null>(null)
  const [idx, setIdx] = useState(0)

  // 命中当前 def（依 defs 每次渲染都重建，按 id 匹配即可）
  const def = sel ? defs.find((d) => d.id === sel.defId) : undefined
  const allRows = def ? def.rows() : []
  const q = sel?.query.trim().toLowerCase() ?? ''
  const rows = q ? allRows.filter((r) => r.name.toLowerCase().includes(q)) : allRows
  const open = !!def && rows.length > 0
  const active = Math.min(Math.max(idx, 0), Math.max(rows.length - 1, 0))

  const close = (): void => {
    setSel(null)
    setIdx(0)
  }

  const sync = (): void => {
    const el = taRef.current
    const text = store.text.value
    const caret = el?.selectionStart ?? text.length
    for (const d of defs) {
      const m = d.match(text, caret)
      if (m) {
        setSel((prev) => (prev && prev.defId === d.id && prev.start === m.start && prev.query === m.query ? prev : { defId: d.id, start: m.start, query: m.query }))
        return
      }
    }
    close()
  }

  // 点击输入框与菜单之外 → 关闭
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Node
      const ta = taRef.current
      const menu = document.getElementById(MENU_ID)
      if (!ta?.contains(t) && !menu?.contains(t)) close()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = (row: TriggerRow): void => {
    if (!def || !sel) return
    const text = store.text.value
    const caret = taRef.current?.selectionStart ?? text.length
    const start = sel.start
    const replace = (value: string): void => {
      const next = text.slice(0, start) + value + text.slice(caret)
      store.text.value = next
      const nc = start + value.length
      queueMicrotask(() => {
        const el = taRef.current
        el?.setSelectionRange(nc, nc)
        el?.focus()
      })
    }
    const clear = (): void => {
      store.text.value = text.slice(0, start) + text.slice(caret)
      queueMicrotask(() => {
        const el = taRef.current
        el?.setSelectionRange(start, start)
        el?.focus()
      })
    }
    def.pick(row, { replace, clear })
    close()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      store.send()
      return
    }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => (i + 1) % rows.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => (i - 1 + rows.length) % rows.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      if (rows[active]) pick(rows[active])
    } else if (e.key === 'Escape') {
      close()
    }
  }

  const popup = open
    ? html`<div id=${MENU_ID} class="popup" role="listbox">
        ${rows.map((r, i) => {
          const showHead = r.groupLabel && (i === 0 || rows[i - 1].group !== r.group)
          return html`${showHead ? html`<div class="optgroup-label">${r.groupLabel}</div>` : null}
            <div class=${i === active ? 'opt selected' : 'opt'} role="option" aria-selected=${i === active}
              onMouseEnter=${() => setIdx(i)}
              onClick=${() => pick(r)} title=${r.description}>
              <span class="trigger-name">${r.prefix}${r.name}</span>
              <span class="trigger-desc">${r.description}${r.hint ? `　${r.hint}` : ''}</span>
            </div>`
        })}
      </div>`
    : null

  return { open, rows, active, popup, sync, reset: close, onKeyDown }
}
