// 通用弹窗（dialog）模块：本插件所有确认/提示类弹层统一走这里。
// 样式复用 index.html 里的 .modal / .btn 体系，保证后续新增弹窗风格一致。
// 用法：
//   import { showDialog } from './modal'
//   const ok = await showDialog({
//     icon: 'warn',
//     title: 'Switch permission?',
//     sub: '说明一句话',
//     code: 'danger-full-access',   // 可选，等宽代码行
//     body: '详细说明…',
//     okText: 'Switch',
//     okStyle: 'danger',            // 'primary' | 'danger'
//   })
//   返回 true=用户确认，false=取消 / 点遮罩 / 按 Esc。

export interface DialogOptions {
  title: string
  sub?: string
  body?: string
  /** 等宽代码行（可选） */
  code?: string
  icon?: 'warn' | 'info'
  okText?: string
  cancelText?: string
  okStyle?: 'primary' | 'danger'
  /** 风险确认勾选文案；提供后用户需先勾选才能点确定（仿 dsh 危险权限确认） */
  ack?: string
}

const ICONS: Record<'warn' | 'info', string> = {
  warn:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
    '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
}

function part<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

let resolveActive: ((value: boolean) => void) | null = null
let wired = false

function closeDialog(value: boolean): void {
  if (!resolveActive) {
    return
  }
  const resolve = resolveActive
  resolveActive = null
  part<HTMLElement>('dshModal').classList.add('hidden')
  document.removeEventListener('keydown', onKeydown, true)
  resolve(value)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    closeDialog(false)
  }
}

function wire(): void {
  const modal = part<HTMLElement>('dshModal')
  // 点遮罩关闭（点卡片内部不关）
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeDialog(false)
    }
  })
  part<HTMLButtonElement>('dshModalCancel').addEventListener('click', () => closeDialog(false))
  part<HTMLButtonElement>('dshModalOk').addEventListener('click', () => closeDialog(true))
  // 有风险勾选时：勾上才允许确定
  part<HTMLInputElement>('dshModalAckCheck').addEventListener('change', (e) => {
    part<HTMLButtonElement>('dshModalOk').disabled = !(e.target as HTMLInputElement).checked
  })
}

/** 打开一个模态弹窗，Promise 在关闭时 resolve：确认=true，取消/遮罩/Esc=false。 */
export function showDialog(options: DialogOptions): Promise<boolean> {
  if (!wired) {
    wire()
    wired = true
  }
  // 同一时刻只允许一个弹窗：先关掉旧的（视为取消）
  if (resolveActive) {
    closeDialog(false)
  }

  const icon = part<HTMLElement>('dshModalIcon')
  icon.innerHTML = ICONS[options.icon === 'warn' ? 'warn' : 'info']
  icon.className = 'modal-icon ' + (options.icon === 'warn' ? 'modal-icon--warn' : 'modal-icon--info')

  part<HTMLElement>('dshModalTitle').textContent = options.title
  part<HTMLElement>('dshModalSub').textContent = options.sub ?? ''

  const codeEl = part<HTMLElement>('dshModalCode')
  codeEl.classList.toggle('hidden', !options.code)
  codeEl.textContent = options.code ?? ''

  part<HTMLElement>('dshModalBody').textContent = options.body ?? ''

  const cancel = part<HTMLButtonElement>('dshModalCancel')
  cancel.textContent = options.cancelText ?? 'Cancel'

  const ok = part<HTMLButtonElement>('dshModalOk')
  ok.textContent = options.okText ?? 'OK'
  ok.className = 'btn ' + (options.okStyle === 'danger' ? 'btn-danger' : 'btn-primary')

  // 风险确认勾选（可选）：未勾选时确定不可点
  const ackRow = part<HTMLElement>('dshModalAck')
  const ackCheck = part<HTMLInputElement>('dshModalAckCheck')
  const hasAck = !!options.ack
  ackRow.classList.toggle('hidden', !hasAck)
  part<HTMLElement>('dshModalAckText').textContent = options.ack ?? ''
  ackCheck.checked = false
  ok.disabled = hasAck

  part<HTMLElement>('dshModal').classList.remove('hidden')
  // 有风险勾选时焦点给勾选框，否则给"取消"，避免误按回车直接确认
  if (hasAck) {
    ackCheck.focus()
  } else {
    cancel.focus()
  }
  document.addEventListener('keydown', onKeydown, true)

  return new Promise<boolean>((resolve) => {
    resolveActive = resolve
  })
}
