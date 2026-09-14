// 任务清单卡（输入框上方的常驻条）：模型给自己列的待办清单 + 每步的执行状态。
//
// 它不是对话流里的东西 —— 清单不属于任何一个回合：本轮开始清空、回合结束仍保留，
// 所以它挂在 composer 上方，与消息列表无关。空清单整块不渲染。
// 布局照上游：一行头（清单图标 + 标题 + 三段式计数 + 折叠箭头），展开才出列表；
// 状态只看图标 —— 进行中是**转圈**，已完成是打勾，未开始是空心圈，行本身不高亮（可能同时多项在进行）。
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import type { TodoItem } from '../core/protocol'

/** 状态 → codicon（无 `codicon-` 前缀）。进行中那项加转圈修饰类。 */
function statusIcon(status: TodoItem['status']): { icon: string; spin: boolean } {
  if (status === 'completed') return { icon: 'pass-filled', spin: false }
  if (status === 'in_progress') return { icon: 'loading', spin: true }
  return { icon: 'circle-large-outline', spin: false }
}

/**
 * 头部计数：三段式「N 已完成 · N 进行中 · N 待处理」，**零计数的段不出现**。
 * 段间用全角间隔（HTML 会把连续空格并成一个，用 `\u2002` 才有呼吸感）。
 */
function progressText(todos: readonly TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.filter((t) => t.status === 'in_progress').length
  const pending = todos.length - done - active
  return [
    ...(done > 0 ? [`${done} 已完成`] : []),
    ...(active > 0 ? [`${active} 进行中`] : []),
    ...(pending > 0 ? [`${pending} 待处理`] : []),
  ].join('\u2002·\u2002')
}

export function TodoCard({ todos }: { todos: readonly TodoItem[] }) {
  // 默认折叠（清单是参考信息，不该常驻占掉输入区上方的空间）
  const [collapsed, setCollapsed] = useState(true)
  if (todos.length === 0) return null
  return html`<section class="todo-card" aria-label="任务">
    <div class="todo-body">
      <button type="button" class="todo-head" aria-expanded=${!collapsed} title=${collapsed ? '展开任务清单' : '收起任务清单'}
        onClick=${() => setCollapsed((v) => !v)}>
        <span class="codicon codicon-checklist todo-lead" aria-hidden="true"></span>
        <span class="todo-title">任务</span>
        <span class="todo-progress">${progressText(todos)}</span>
        <span class=${'codicon todo-chev ' + (collapsed ? 'codicon-chevron-up' : 'codicon-chevron-down')} aria-hidden="true"></span>
      </button>
      ${collapsed
        ? null
        : html`<ul class="todo-list">
            ${todos.map((t, i) => {
              const { icon, spin } = statusIcon(t.status)
              return html`<li key=${`${String(i)}:${t.content}`} class="todo-item" data-status=${t.status}>
                <span class=${'codicon todo-glyph codicon-' + icon + (spin ? ' codicon-modifier-spin' : '')} aria-hidden="true"></span>
                <span class="todo-content" title=${t.content}>${t.content}</span>
              </li>`
            })}
          </ul>`}
    </div>
  </section>`
}
