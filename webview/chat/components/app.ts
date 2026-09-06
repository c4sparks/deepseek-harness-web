// 聊天 UI 组件层(preact + htm)。组件只读 store 信号并渲染;改动一律经 store 动作。
// DOM 结构与旧 index.html 骨架、类名、图标逐一对应,沿用全局 VSCode 主题 CSS。
// 顶部 ChatApp 不读信号 → 挂载后不整体重渲;#titlebar / #dshModal 等命令式子树因此不被 Preact 覆写。
import { html } from 'htm/preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ChatStore, ChatRow, StepModel } from '../core/store/chat'
import type { ImageAttachment, QuestionSpec } from '../core/protocol'
import { renderMd } from '../core/markdown'
import { MODE_NAMES, DANGEROUS_PERMS } from '../core/format'
import { showDialog } from '../modal'
import { TurnStats } from './TurnStats'

// ---------------- Welcome ----------------
function Welcome({ store }: { store: ChatStore }) {
  if (store.view.value !== 'welcome') return null
  const sugg: Array<[string, string]> = [
    ['解释选中代码', '请解释一下我选中的代码'],
    ['重构这段代码', '请把这段代码重构得更清晰，并说明改动'],
    ['写单元测试', '请为这段代码写单元测试'],
  ]
  return html`<div id="welcome">
    <div class="welcome-title">AI 助手</div>
    <div class="welcome-desc">通过本地 DeepSeek Harness 对话。选中代码右键可 @ 到输入框。</div>
    <div class="suggestions">
      ${sugg.map(([label, p]) => html`<button class="suggestion" key=${p} onClick=${() => store.suggestion(p)}>${label}</button>`)}
    </div>
  </div>`
}

// ---------------- 思维链 ----------------
function Thinking({ row }: { row: Extract<ChatRow, { kind: 'assistant' }> }) {
  if (row.done) {
    if (row.stepCount === 0 && row.toolCount === 0) return null
    const parts: string[] = []
    if (row.stepCount > 0) parts.push(row.stepCount + ' 步')
    if (row.toolCount > 0) parts.push(row.toolCount + ' 个工具')
    return html`<div class="thinking"><div class="acts"><div class="summary">🤔 已思考 · ${parts.join(' · ')}</div></div></div>`
  }
  const steps = row.steps
  if (!row.thinkingVisible && steps.length === 0 && !row.text) return null
  return html`<div class="thinking"><div class="acts">
    ${steps.length === 0
      ? html`<div class="act thinking-dots">🧠 思考中…</div>`
      : steps.map(
          (s: StepModel) => html`<div class="step-box" key=${s.step}>
              <div class="step-head">${s.step >= 1 ? `第 ${s.step} 步` : '思考'}</div>
              ${s.reason ? html`<div class="step-reasoning">${s.reason}</div>` : null}
              ${s.tools.length > 0
                ? html`<div class="step-tools">${s.tools.map((n) => html`<span class="tool-chip" key=${n}>🛠 ${n}</span>`)}</div>`
                : null}
            </div>`
        )}
  </div></div>`
}

function RowMeta({
  time,
  onCopy,
  onRegen,
  copyable,
  regenable,
  hideRegen,
  extraActions,
}: {
  time?: string
  onCopy?: () => void
  onRegen?: () => void
  copyable: boolean
  regenable: boolean
  /** 隐藏“重新生成”（用户提问行只保留复制） */
  hideRegen?: boolean
  /** 追加在“重新生成”按钮之后的行内动作（assistant 用量/用时，顺序用量→用时） */
  extraActions?: unknown
}) {
  return html`<div class="msg-meta"><span class="time">${time ?? ''}</span><span class="msg-actions">
    <button data-act="copy" title="复制" disabled=${!copyable} onClick=${onCopy}>⧉</button>
    ${hideRegen ? null : html`<button data-act="regenerate" title="重新生成" disabled=${!regenable} onClick=${onRegen}>⟳</button>`}
    ${extraActions}
  </span></div>`
}

function UserMessage({ row, store, latest }: { row: Extract<ChatRow, { kind: 'user' }>; store: ChatStore; latest?: boolean }) {
  return html`<div class="msg user${latest ? ' latest' : ''}"><div class="col"><div class="name"></div><div class="body">
    ${row.text ? html`<div class="user-text">${row.text}</div>` : null}
    ${row.images.map(
      (img: ImageAttachment) =>
        html`<div class="user-img" key=${img.name}><img src=${`data:${img.mediaType};base64,${img.data}`} alt=${img.name || '图片'} title=${img.name || ''} /></div>`
    )}
  </div>
    ${RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
      regenable: !!row.text,
      hideRegen: true, // 提问行只保留复制
      onRegen: () => store.regenerate(row.text, row.images),
    })}
  </div></div>`
}

function AssistantMessage({ row, store, latest }: { row: Extract<ChatRow, { kind: 'assistant' }>; store: ChatStore; latest?: boolean }) {
  const bodyHtml = useMemo(() => renderMd(row.text), [row.text])
  return html`<div class="msg assistant${latest ? ' latest' : ''}"><div class="col"><div class="name"></div>
    ${Thinking({ row })}
    <div class="body" dangerouslySetInnerHTML=${{ __html: bodyHtml }}></div>
    ${row.endMsg ? html`<div class="end-note">⚠ ${row.endMsg}</div>` : null}
    ${row.status ? html`<div class="status-badge">${row.status}</div>` : null}
    ${RowMeta({
      time: row.time,
      copyable: !!row.text,
      onCopy: () => store.copy(row.text),
      regenable: !!row.prompt && row.done,
      onRegen: () => row.prompt && store.regenerate(row.prompt),
      // 用量/用时图标排在“重新生成”按钮之后（顺序：用量 → 用时）
      extraActions: row.usageRaw ? html`<${TurnStats} usage=${row.usageRaw} />` : undefined,
    })}
  </div></div>`
}

function ApprovalCard({ row, store }: { row: Extract<ChatRow, { kind: 'approval' }>; store: ChatStore }) {
  return html`<div class="approval">
    <div class="appr-info">
      <span class="appr-title">⚠ 需要批准${row.toolName ? `：${row.toolName}` : ''}</span>
      ${row.description && row.description !== '需要授权操作' ? html`<div class="appr-reason">${row.description}</div>` : null}
    </div>
    <button class="allow" onClick=${() => store.answerApproval(row.approvalId, true, row.key)}>允许</button>
    <button class="reject" onClick=${() => store.answerApproval(row.approvalId, false, row.key)}>拒绝</button>
  </div>`
}

interface AnswerEntry {
  id: string
  selected: string[]
  custom?: string
}

function QuestionCard({ row, store }: { row: Extract<ChatRow, { kind: 'question' }>; store: ChatStore }) {
  const init = (): AnswerEntry[] =>
    row.questions.map((q) => ({ id: q.id, selected: [], custom: undefined }))
  const [answers, setAnswers] = useState<AnswerEntry[]>(init)
  const [free, setFree] = useState<Record<string, string>>({})
  const update = (id: string, fn: (e: AnswerEntry) => AnswerEntry): void =>
    setAnswers((prev) => prev.map((e) => (e.id === id ? fn(e) : e)))
  const toggleOpt = (q: QuestionSpec, entry: AnswerEntry, label: string): void => {
    if (q.multiSelect) {
      update(entry.id, (e) => ({
        ...e,
        selected: e.selected.includes(label) ? e.selected.filter((s) => s !== label) : [...e.selected, label],
      }))
    } else {
      update(entry.id, (e) => ({ ...e, selected: [label] }))
    }
  }
  const inputChange = (id: string, value: string): void => {
    setFree((prev) => ({ ...prev, [id]: value }))
    update(id, (e) => ({ ...e, custom: value.trim() || undefined }))
  }
  const submit = (): void => store.submitQuestion(row.key, row.rpcId, row.sessionId, answers)
  const cancel = (): void => store.cancelQuestion(row.key, row.rpcId, row.sessionId)
  const disabled = row.disabled
  return html`<div class="question">
    <div class="q-title">❓ 需要你确认</div>
    ${row.questions.map((q, qi) => {
      const entry = answers[qi]
      const isSelected = (label: string): boolean => entry?.selected.includes(label) ?? false
      return html`<div class="q-block" key=${q.id}>
        ${q.header ? html`<div class="q-header">${q.header}</div>` : null}
        <div class="q-text">${q.question}</div>
        ${q.detail ? html`<div class="q-detail">${q.detail}</div>` : null}
        ${q.options && q.options.length > 0
          ? html`<div class="q-options">${q.options.map((o) =>
              html`<button class=${'q-option' + (isSelected(o.label) ? ' selected' : '')} key=${o.label}
                onClick=${() => entry && toggleOpt(q, entry, o.label)}>
                <span class="q-opt-label">${o.label}</span>
                ${o.description ? html`<span class="q-opt-desc">${o.description}</span>` : null}
              </button>`
            )}</div>`
          : html`<input class="q-input" value=${free[q.id] ?? ''} placeholder="输入回答…" disabled=${disabled}
              onInput=${(e: Event) => inputChange(q.id, (e.target as HTMLInputElement).value)} />`}
      </div>`
    })}
    <div class="q-bar">
      <button class="q-submit" disabled=${disabled} onClick=${submit}>回答</button>
      <button class="q-cancel" disabled=${disabled} onClick=${cancel}>取消</button>
    </div>
  </div>`
}

function Notice({ row }: { row: Extract<ChatRow, { kind: 'notice' }> }) {
  return html`<div class="msg assistant"><div class="col"><div class="name"></div>
    <div class="body"><div class="user-text" style=${{ color: 'var(--vscode-errorForeground)' }}>⚠ ${row.text}</div></div>
  </div></div>`
}

function MessageList({ store }: { store: ChatStore }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // 新消息/流式推进时若用户本就贴底则自动滚到底(与旧 chat.ts 一致)
  useEffect(() => {
    const el = ref.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 48) el.scrollTop = el.scrollHeight
  })
  if (store.view.value !== 'chat') return null
  const list = store.messages.value
  return html`<div id="messages" ref=${ref}>
    ${list.map((row, i) => {
      const latest = i === list.length - 1
      switch (row.kind) {
        case 'user':
          return html`<${UserMessage} key=${row.key} row=${row} store=${store} latest=${latest} />`
        case 'assistant':
          return html`<${AssistantMessage} key=${row.key} row=${row} store=${store} latest=${latest} />`
        case 'approval':
          return html`<${ApprovalCard} key=${row.key} row=${row} store=${store} />`
        case 'question':
          return html`<${QuestionCard} key=${row.key} row=${row} store=${store} />`
        case 'notice':
          return html`<${Notice} key=${row.key} row=${row} />`
      }
    })}
  </div>`
}

// ---------------- 附件 chips ----------------
function AttachmentBar({ store }: { store: ChatStore }) {
  const imgs = store.images.value
  const paths = store.attachments.value
  if (imgs.length === 0 && paths.length === 0) return html`<div id="attachments" class="hidden"></div>`
  return html`<div id="attachments">
    ${imgs.map(
      (img) => html`<span class="img-chip" key=${img.name}>
        <img class="img-thumb" src=${`data:${img.mediaType};base64,${img.data}`} title=${img.name} />
        <span class="x" onClick=${() => store.removeImage(img)}>✕</span></span>`
    )}
    ${paths.map(
      (p) => html`<span class="file-chip" key=${p}>
        <span class="ficon"><span class="codicon codicon-file"></span></span>
        <span class="fname" title=${p}>${(p.split(/[\\/]/).pop() || p)}</span>
        <span class="x" onClick=${() => store.removeAttachment(p)}>✕</span></span>`
    )}
  </div>`
}

// ---------------- 权限 / 模型 / 模式 弹窗 ----------------
function Popup({ store }: { store: ChatStore }) {
  const open = store.openPopup.value
  const sel = store.sel.value
  const composerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    composerRef.current = document.getElementById('composer')
  })
  // 锚定到对应按钮上方(与旧 anchorPopup 一致)
  const style = (
    btnId: string,
    fixed: boolean
  ): { bottom?: string; left?: string; position?: string; width?: string; maxHeight?: string } => {
    const c = composerRef.current
    const b = document.getElementById(btnId)
    if (!c || !b) return {}
    const cr = c.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    const bottomPx = Math.round(cr.bottom - br.top + 6)
    const leftPx = Math.round(br.left - cr.left)
    const base: { bottom: string; left: string } = { bottom: bottomPx + 'px', left: Math.max(4, Math.min(leftPx, cr.width - 24)) + 'px' }
    if (fixed) {
      const vw = window.innerWidth || document.documentElement.clientWidth
      const vh = window.innerHeight || document.documentElement.clientHeight
      const width = Math.min(360, vw - 16)
      return {
        position: 'fixed',
        left: Math.max(8, Math.min(br.left, vw - width - 8)) + 'px',
        bottom: Math.max(8, vh - br.top + 8) + 'px',
        width: width + 'px',
        maxHeight: Math.max(120, Math.min(vh * 0.46, br.top - 8)) + 'px',
      }
    }
    return base
  }

  // 权限
  let permPopup = html`<div id="permPopup" class="popup hidden"></div>`
  if (open === 'perm') {
    const opts = sel.permOptions
    permPopup = html`<div id="permPopup" class="popup" style=${style('permBtn', false)}>
      ${opts.length === 0
        ? html`<div class="opt" style=${{ opacity: 0.6 }}>没有可用的权限</div>`
        : opts.map(
            (o) => html`<div class=${'opt' + (o.value === sel.currentPerm ? ' selected' : '')} key=${o.value} title=${o.description ?? ''}
              onClick=${async () => {
                if (o.value === sel.currentPerm) {
                  store.closePopups()
                  return
                }
                if (DANGEROUS_PERMS.has(o.value)) {
                  store.closePopups()
                  const label = o.value === 'danger-full-access' ? 'Full access' : o.name || o.value
                  const ok = await showDialog({
                    icon: 'warn',
                    title: `确认启用 ${label}？`,
                    body:
                      `启用 ${label} 后，agent 将减少确认步骤，并且可以直接执行更多操作，` +
                      `包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。`,
                    ack: '我已了解风险，并愿意继续',
                    okText: '启用',
                    okStyle: 'danger',
                    cancelText: '取消',
                  })
                  if (ok) store.selectPerm(o.value)
                  return
                }
                store.selectPerm(o.value)
              }}>${o.name || o.value}</div>`
          )}
    </div>`
  }

  // 模型 + 推理等级
  let modelPopup = html`<div id="modelPopup" class="popup hidden"></div>`
  if (open === 'model') {
    const activeModel = (provider: string, model: string): { name?: string; reasoning?: { efforts?: Array<{ id: string; name: string }> } } | undefined =>
      sel.modelGroups?.find((g) => g.id === provider)?.models.find((m) => m.id === model)
    const efforts = activeModel(sel.curProvider, sel.curModel)?.reasoning?.efforts ?? []
    modelPopup = html`<div id="modelPopup" class="popup" style=${style('modelBtn', false)}>
      <div class="popup-title">模型</div>
      ${sel.modelFailures.length > 0
        ? html`<div class="popup-fail" title=${JSON.stringify(sel.modelFailures)}>⚠ ${sel.modelFailures.length} 组模型加载失败</div>`
        : null}
      ${(sel.modelGroups ?? []).map(
        (g) =>
          g.models.length > 0 &&
          html`<div key=${g.id}>
            <div class="optgroup-label">${g.name || g.id}</div>
            ${g.models.map(
              (m) => html`<div class=${'opt' + (g.id === sel.curProvider && m.id === sel.curModel ? ' selected' : '')} key=${m.id}
                title=${m.description || m.name || m.id}
                onClick=${() => store.selectModel(g.id, m.id)}>${m.name || m.id}</div>`
            )}
          </div>`
      )}
      ${efforts.length > 0
        ? html`<div>
            <div class="optgroup-label">推理等级</div>
            ${efforts.map(
              (e) => html`<div class=${'opt reason' + (e.id === sel.curEffort ? ' selected' : '')} key=${e.id}
                onClick=${() => store.selectModel(sel.curProvider, sel.curModel, e.id)}>${e.name || e.id}</div>`
            )}
          </div>`
        : null}
    </div>`
  }

  // 模式(固定位)
  let modePopup = html`<div id="modePopup" class="popup hidden"></div>`
  if (open === 'mode') {
    modePopup = html`<div id="modePopup" class="popup" style=${style('modeBtn', true)}>
      <div class="popup-title">会话模式</div>
      ${sel.modeOptions.length === 0
        ? html`<div class="opt" style=${{ opacity: 0.6 }}>暂无可用模式</div>`
        : sel.modeOptions.map(
            (m) => html`<div class=${'opt' + (m.id === sel.currentMode ? ' selected' : '')} key=${m.id}
              onClick=${() => store.selectMode(m.id)}>
              <span>${m.name || MODE_NAMES[m.id] || m.id}</span>
              ${m.description ? html`<span class="opt-desc">${m.description}</span>` : null}
            </div>`
          )}
    </div>`
  }

  return html`${permPopup}${modelPopup}${modePopup}`
}

// ---------------- Composer ----------------
function Composer({ store }: { store: ChatStore }) {
  const text = store.text.value
  const processing = store.processing.value
  const sel = store.sel.value
  const focusTick = store.focusTick.value
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // draft 到来 → 聚焦
  useEffect(() => {
    if (focusTick > 0) taRef.current?.focus()
  }, [focusTick])

  // 点击外部关闭弹窗
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Node
      const inSel = (id: string): boolean => {
        const el = document.getElementById(id)
        return !!el && el.contains(t)
      }
      if (inSel('permPopup') || inSel('modelPopup') || inSel('modePopup') || inSel('permBtn') || inSel('modelBtn') || inSel('modeBtn')) return
      if (store.openPopup.value) store.closePopups()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  const permName = (): string => {
    const s = store.sel.value
    const found = s.permOptions.find((o) => o.value === s.currentPerm)
    return found ? found.name || found.value : store.permNameOf.get(s.currentPerm) ?? ''
  }
  const modelName = (): string => {
    const s = store.sel.value
    if (!s.curProvider || !s.curModel) return ''
    const g = s.modelGroups?.find((x) => x.id === s.curProvider)
    const m = g?.models.find((x) => x.id === s.curModel)
    let label = m?.name || s.curModel
    const effort = m?.reasoning?.efforts?.find((x) => x.id === s.curEffort)
    if (s.curEffort && effort) label += ' · ' + (effort.name || s.curEffort)
    return label
  }
  const modeName = (): string => {
    const s = store.sel.value
    const found = s.modeOptions.find((m) => m.id === s.currentMode)
    return found?.name || MODE_NAMES[s.currentMode] || s.currentMode
  }
  const canSend = text.trim().length > 0 || store.attachments.value.length > 0 || store.images.value.length > 0

  return html`<div id="composer"
    onDragOver=${(e: Event) => e.preventDefault()}
    onDrop=${(e: DragEvent) => {
      e.preventDefault()
      const dt = e.dataTransfer
      if (!dt) return
      for (const f of Array.from(dt.files ?? [])) {
        if (f.type && f.type.startsWith('image/')) store.readImageFile(f)
      }
      const uri = dt.getData('text/uri-list')
      if (uri) {
        const first = uri.split('\n').find((l) => l.trim().length > 0)
        if (first && first.startsWith('file:')) store.addAttachment(decodeURIComponent(first.slice(7)))
      }
    }}>
    <${Popup} store=${store} />
    <${AttachmentBar} store=${store} />
    <div id="inputbox">
      <textarea id="input" ref=${taRef} placeholder="向 AI 提问（Ctrl+Enter 发送）" value=${text}
        onInput=${(e: Event) => { store.text.value = (e.target as HTMLTextAreaElement).value }}
        onKeyDown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); store.send() } }}
        onPaste=${(e: ClipboardEvent) => {
          const items = e.clipboardData?.items
          if (!items) return
          for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (file) {
                e.preventDefault()
                store.readImageFile(file)
              }
            }
          }
        }}></textarea>
      <div id="inputbar">
        <button id="attach" title="添加文件/图片" onClick=${() => store.pickFile()}>＋</button>
        <div class="sel-group">
          <button id="permBtn" title=${permName() ? `权限：${permName()}` : '权限'} class=${store.openPopup.value === 'perm' ? 'active' : ''}
            onClick=${() => store.togglePopup('perm')}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>
          </button>
          <span id="permLabel" class="sel-label">${permName()}</span>
        </div>
        <div class="sel-group">
          <button id="modelBtn" title=${modelName() ? `模型：${modelName()}` : '模型与推理等级'} class=${store.openPopup.value === 'model' ? 'active' : ''}
            onClick=${() => store.togglePopup('model')}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>
          </button>
          <span id="modelLabel" class="sel-label">${modelName()}</span>
        </div>
        <div class="sel-group">
          <button id="modeBtn" title=${sel.modeLocked ? `${modeName()}（已固定）` : modeName()} class=${'mode' + (store.openPopup.value === 'mode' ? ' active' : '') + (sel.modeLocked ? ' readonly' : '')}
            onClick=${() => { if (!sel.modeLocked) store.togglePopup('mode') }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/></svg>
          </button>
          <span id="modeLabel" class="sel-label">${modeName()}</span>
        </div>
        <button id="send" title=${processing ? '终止' : '发送'} class=${processing ? 'stop' : ''} disabled=${!processing && !canSend}
          onClick=${() => (processing ? store.cancel() : store.send())}>
          <svg class="send-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 14V3"/><path d="M3.5 6.5 8 2l4.5 4.5"/></svg>
          <svg class="stop-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>
        </button>
      </div>
    </div>
  </div>`
}

function Statsbar({ store }: { store: ChatStore }) {
  const line = store.statsLine.value
  return html`<div id="statsbar" title=${line.title}>${line.text}</div>`
}

// ---------------- 弹窗 / 标题栏 静态壳(命令式子树) ----------------
function ModalShell() {
  return html`<div id="dshModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="dshModalTitle">
    <div class="modal-card">
      <div class="modal-head">
        <span id="dshModalIcon" class="modal-icon modal-icon--info" aria-hidden="true"></span>
        <div><div id="dshModalTitle" class="modal-title"></div><div id="dshModalSub" class="modal-sub"></div></div>
      </div>
      <div id="dshModalCode" class="modal-code hidden"></div>
      <div id="dshModalBody" class="modal-body"></div>
      <label id="dshModalAck" class="modal-ack hidden"><input id="dshModalAckCheck" type="checkbox" /><span id="dshModalAckText"></span></label>
      <div class="modal-actions">
        <button id="dshModalCancel" class="btn btn-ghost" type="button">Cancel</button>
        <button id="dshModalOk" class="btn btn-primary" type="button"></button>
      </div>
    </div>
  </div>`
}

function TitlebarShell() {
  return html`<div id="titlebar">
    <button id="titleWs" title="工作区"><span class="codicon codicon-chevron-right title-ws-caret"></span><span id="titleWsName"></span></button>
    <div class="title-spacer"></div>
    <div id="titleWorkWrap">
      <button class="title-btn" id="titleWorkBtn" title="工作区"><span class="codicon codicon-folder"></span></button>
      <div id="titleWsDropdown" class="hidden"><input id="wsSearch" type="text" placeholder="搜索工作区/会话" autocomplete="off" spellcheck="false" /><div id="wsRows"></div></div>
    </div>
    <button class="title-btn" data-cmd="newSession" title="开启新会话"><span class="codicon codicon-add"></span></button>
    <button class="title-btn hidden" data-cmd="openInBrowser" title="在浏览器中打开"><span class="codicon codicon-globe"></span></button>
    <button class="title-btn" data-cmd="openInEditor" title="在本地打开"><span class="codicon codicon-desktop-download"></span></button>
    <button class="title-btn hidden" data-cmd="reload" title="刷新 dsh 页面"><span class="codicon codicon-refresh"></span></button>
    <button class="title-btn hidden" data-cmd="closeSidebar" title="关闭侧边栏"><span class="codicon codicon-eye"></span></button>
    <button class="title-btn" data-cmd="moveToEditor" title="移动到编辑器"><span class="codicon codicon-open-preview"></span></button>
    <div id="titleMoreWrap">
      <button class="title-btn" id="titleMoreBtn" title="更多"><span class="codicon codicon-ellipsis"></span></button>
      <div id="titleMorePopup" class="hidden"><button class="title-more-item" data-cmd="usage"><span class="codicon codicon-graph-line"></span>查看消费记录</button></div>
    </div>
  </div>`
}

// ---------------- ChatApp(不读信号 → 挂载后不重渲) ----------------
// 入口 chat.ts 已把 <ChatApp> 渲染进 index.html 的 #app,#app 自身只承担纵向 flex 布局;
// ChatApp 不应再自包一层 id="app"(会与挂载点重复 → 嵌套双 #app)。直接返回各列块子树,
// 由挂载点 #app 统一排布(标题栏 / 消息区 / 输入区 / 状态栏)。
function ChatApp({ store }: { store: ChatStore }) {
  return html`${TitlebarShell()}
    <${Welcome} store=${store} />
    <${MessageList} store=${store} />
    <${Composer} store=${store} />
    <${Statsbar} store=${store} />
    ${ModalShell()}`
}

export { ChatApp }
export type { ImageAttachment }
