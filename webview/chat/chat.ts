// dsh 聊天 UI 逻辑：桥接扩展宿主 → DshService.askStreaming() → 本地 dsh
// 注意：acquireVsCodeApi() 每个 webview 只能调用一次
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { showDialog } from './modal'

const vscode = acquireVsCodeApi()
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const welcome = document.getElementById('welcome')!
const messagesEl = document.getElementById('messages')!
const input = document.getElementById('input') as HTMLTextAreaElement
const sendBtn = document.getElementById('send') as HTMLButtonElement
const composer = document.getElementById('composer')!
const attachmentsEl = document.getElementById('attachments')!
const permBtn = document.getElementById('permBtn') as HTMLButtonElement
const permLabel = document.getElementById('permLabel') as HTMLElement
const modelBtn = document.getElementById('modelBtn') as HTMLButtonElement
const modelLabel = document.getElementById('modelLabel') as HTMLElement
const permPopup = document.getElementById('permPopup') as HTMLElement
const modelPopup = document.getElementById('modelPopup') as HTMLElement
const statsBar = document.getElementById('statsbar') as HTMLDivElement

let processing = false
let assistantEl: HTMLElement | null = null
let assistantText = ''
let attachments: string[] = []
interface ImageAttachment {
  mediaType: string
  data: string
  name: string
}
let images: ImageAttachment[] = []
let thinkingEl: HTMLElement | null = null
let stepCount = 0
let toolCount = 0
let lastPrompt = ''

/** 进行中的提问卡（key 为卡的 rpcId；等 host 发 questionClosed 确认后才移除） */
const questionCards = new Map<string, HTMLElement>()

/** 思维链：按 step 渲染的步骤块 */
interface StepBox {
  step: number
  el: HTMLElement
  reasoningEl: HTMLElement
  toolsEl: HTMLElement
  toolNames: Set<string>
}
let stepBoxes: StepBox[] = []
let currentOpenStep = 1

// ---------- 发送/停止 ----------

/** 输入框无内容时禁用发送（灰色不可点） */
function updateSendState(): void {
  if (processing) {
    return
  }
  const has = input.value.trim().length > 0 || attachments.length > 0 || images.length > 0
  sendBtn.disabled = !has
}

function setProcessing(p: boolean): void {
  processing = p
  if (p) {
    sendBtn.classList.add('stop')
    sendBtn.title = '终止'
    sendBtn.disabled = false
    // 立即显示"思考中…"，避免无反馈误以为卡住
    if (!thinkingEl) {
      startAssistantMessage()
    }
    thinkingEl?.classList.remove('hidden')
    const acts = thinkingEl?.querySelector('.acts')
    if (acts && acts.childElementCount === 0) {
      acts.innerHTML = '<div class="act thinking-dots">🧠 思考中…</div>'
    }
  } else {
    sendBtn.classList.remove('stop')
    sendBtn.title = '发送'
    updateSendState()
  }
}

function send(): void {
  const text = input.value.trim()
  if ((!text && attachments.length === 0 && images.length === 0) || processing) {
    return
  }
  const refs = attachments.map((a) => '@' + a.replace(/\\/g, '/'))
  const prompt = [...refs, text].filter(Boolean).join('\n\n')
  const imgs = images
  addUserMessage(prompt, imgs)
  input.value = ''
  attachments = []
  images = []
  renderAttachments()
  setProcessing(true)
  vscode.postMessage({ type: 'chatSend', text: prompt, images: imgs })
  lastPrompt = prompt
}

function cancel(): void {
  vscode.postMessage({ type: 'cancel' })
}

// ---------- 消息渲染 ----------

const ACTIONS =
  '<div class="msg-meta">' +
  '<span class="time"></span>' +
  '<span class="msg-actions">' +
  '<button data-act="copy" title="复制">⧉</button>' +
  '<button data-act="regenerate" title="重新生成">⟳</button>' +
  '</span>' +
  '</div>'

/** 给消息行设置时分秒 */
function setMessageTime(row: HTMLElement, t?: string): void {
  const el = row.querySelector('.time') as HTMLElement | null
  if (el) {
    el.textContent = t ?? new Date().toTimeString().slice(0, 8)
  }
}

/** 给消息挂上 复制/点赞/点踩 操作 */
function attachActions(row: HTMLElement, getText: () => string): void {
  row.querySelectorAll<HTMLButtonElement>('.msg-actions button').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.getAttribute('data-act')
      if (act === 'copy') {
        const t = getText()
        if (t) {
          vscode.postMessage({ type: 'copy', text: t })
        }
      } else if (act === 'regenerate') {
        // 重新生成：用这条消息对应的提示词再问一次
        const prompt = (row as HTMLElement).dataset.prompt || lastPrompt
        if (prompt) {
          setProcessing(true)
          vscode.postMessage({ type: 'chatSend', text: prompt })
        }
      }
    })
  })
}

function addUserMessage(text: string, imgs: ImageAttachment[] = []): void {
  welcome.classList.add('hidden')
  messagesEl.classList.remove('hidden')
  const row = document.createElement('div')
  row.className = 'msg user'
  row.innerHTML =
    '<div class="col"><div class="name"></div><div class="body"></div>' + ACTIONS + '</div>'
  const body = row.querySelector('.body') as HTMLElement
  if (text) {
    const t = document.createElement('div')
    t.className = 'user-text'
    t.textContent = text
    body.appendChild(t)
  }
  // 图片：base64 内联渲染进消息气泡
  for (const img of imgs) {
    const box = document.createElement('div')
    box.className = 'user-img'
    const el = document.createElement('img')
    el.src = `data:${img.mediaType};base64,${img.data}`
    el.alt = img.name || '图片'
    el.title = img.name || ''
    box.appendChild(el)
    body.appendChild(box)
  }
  attachActions(row, () =>
    [text, imgs.length ? '🖼 ' + imgs.map((i) => i.name).filter(Boolean).join(', ') : ''].filter(Boolean).join('\n')
  )
  row.dataset.prompt = text // 用户消息重试用
  setMessageTime(row)
  messagesEl.appendChild(row)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function startAssistantMessage(): HTMLElement {
  welcome.classList.add('hidden')
  messagesEl.classList.remove('hidden')
  stepCount = 0
  toolCount = 0
  stepBoxes = []
  currentOpenStep = 1
  const row = document.createElement('div')
  row.className = 'msg assistant'
  row.innerHTML =
    '<div class="col"><div class="name"></div>' +
    '<div class="thinking hidden"><div class="acts"></div></div>' +
    '<div class="body"></div><div class="stats"></div>' +
    ACTIONS + '</div>'
  attachActions(row, () => assistantText)
  messagesEl.appendChild(row)
  messagesEl.scrollTop = messagesEl.scrollHeight
  thinkingEl = row.querySelector('.thinking') as HTMLElement
  assistantEl = row.querySelector('.body') as HTMLElement
  row.dataset.prompt = lastPrompt // 记住这条回复对应的提示词，供重新生成
  setMessageTime(row)
  return assistantEl
}

/** 工具名 → 友好中文 */
function friendlyToolName(name: string): string {
  const map: Record<string, string> = {
    bash: '执行命令',
    pwsh: '执行命令',
    shell: '执行命令',
    powershell: '执行命令',
    glob: '查找文件',
    read: '读取文件',
    readTextFile: '读取文件',
    think: '思考',
    findings: '分析',
    grep: '搜索',
    search: '搜索',
    write: '写文件',
    edit: '编辑文件',
    str_replace_editor: '编辑文件',
    apply_patch: '应用补丁',
  }
  return map[name] ?? name
}

/** 思考区未创建时先创建（活动/思考先于文本到达） */
function ensureThinking(): HTMLElement {
  if (!thinkingEl) {
    startAssistantMessage()
  }
  return thinkingEl as HTMLElement
}

/** 获取（或创建）某个 step 的思维链块，并按 step 号保持链式顺序 */
function ensureStepBox(step: number): StepBox {
  const t = ensureThinking()
  t.classList.remove('hidden')
  const acts = t.querySelector('.acts') as HTMLElement
  const existing = stepBoxes.find((b) => b.step === step)
  if (existing) {
    return existing
  }
  const el = document.createElement('div')
  el.className = 'step-box'
  el.innerHTML =
    '<div class="step-head"></div>' +
    '<div class="step-reasoning"></div>' +
    '<div class="step-tools"></div>'
  const head = el.querySelector('.step-head') as HTMLElement
  head.textContent = step >= 1 ? `第 ${step} 步` : '思考'
  const box: StepBox = {
    step,
    el,
    reasoningEl: el.querySelector('.step-reasoning') as HTMLElement,
    toolsEl: el.querySelector('.step-tools') as HTMLElement,
    toolNames: new Set(),
  }
  stepBoxes.push(box)
  stepBoxes.sort((a, b) => a.step - b.step)
  const index = stepBoxes.indexOf(box)
  const placeholder = acts.querySelector('.thinking-dots')
  if (placeholder) {
    placeholder.remove()
  }
  const next = acts.children[index] as HTMLElement | null
  acts.insertBefore(el, next)
  messagesEl.scrollTop = messagesEl.scrollHeight
  return box
}

/** 显示思考区并追加一条活动（步骤开始 / 工具调用）到思维链 */
function addActivity(activity: { type?: string; step?: number; tool?: string } | undefined): void {
  if (!activity) {
    return
  }
  if (activity.type === 'step') {
    stepCount++
    const step = activity.step ?? stepCount
    currentOpenStep = step
    ensureStepBox(step)
  } else if (activity.type === 'tool') {
    toolCount++
    const step = activity.step ?? currentOpenStep
    const box = ensureStepBox(step)
    const name = friendlyToolName(activity.tool ?? '')
    if (!box.toolNames.has(name)) {
      box.toolNames.add(name)
      const chip = document.createElement('span')
      chip.className = 'tool-chip'
      chip.textContent = '🛠 ' + name
      box.toolsEl.appendChild(chip)
      messagesEl.scrollTop = messagesEl.scrollHeight
    }
  }
}

/** 追加一段思考文本到对应 step 的思维链块（实时） */
function addReasoning(r: string, step?: number): void {
  const box = ensureStepBox(step ?? currentOpenStep)
  box.reasoningEl.textContent += r
  messagesEl.scrollTop = messagesEl.scrollHeight
}


/** 审批行：显示需要批准的操作 + 允许/拒绝 */
function appendApproval(approvalId: string, description: string): void {
  welcome.classList.add('hidden')
  messagesEl.classList.remove('hidden')
  const row = document.createElement('div')
  row.className = 'approval'
  const desc = document.createElement('span')
  desc.className = 'desc'
  desc.textContent = '⚠ 需要批准：' + (description || '需要授权操作')
  const allow = document.createElement('button')
  allow.className = 'allow'
  allow.textContent = '允许'
  allow.addEventListener('click', () => {
    row.remove()
    vscode.postMessage({ type: 'approvalResponse', approvalId, allow: true })
  })
  const reject = document.createElement('button')
  reject.className = 'reject'
  reject.textContent = '拒绝'
  reject.addEventListener('click', () => {
    row.remove()
    vscode.postMessage({ type: 'approvalResponse', approvalId, allow: false })
  })
  row.appendChild(desc)
  row.appendChild(allow)
  row.appendChild(reject)
  messagesEl.appendChild(row)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

/** host 确认（或确认失败回退整轮停止）后移除提问卡；rpcId 缺省按匿名卡处理 */
function closeQuestionCard(rpcId?: string): void {
  const row = questionCards.get(rpcId ?? '')
  if (row && row.isConnected) {
    row.remove()
  }
  questionCards.delete(rpcId ?? '')
}

/** 提问行：显示 ask_user_question 的题目 + 选项，让用户回答/取消 */
function appendQuestion(q: {
  rpcId?: string
  sessionId?: string
  questions?: Array<{
    id: string
    question: string
    header?: string
    detail?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}): void {
  welcome.classList.add('hidden')
  messagesEl.classList.remove('hidden')
  const row = document.createElement('div')
  row.className = 'question'
  const title = document.createElement('div')
  title.className = 'q-title'
  title.textContent = '❓ 需要你确认'
  row.appendChild(title)

  const answers: Array<{ id: string; selected: string[]; custom?: string }> = []
  for (const item of q.questions ?? []) {
    const block = document.createElement('div')
    block.className = 'q-block'
    if (item.header) {
      const h = document.createElement('div')
      h.className = 'q-header'
      h.textContent = item.header
      block.appendChild(h)
    }
    const text = document.createElement('div')
    text.className = 'q-text'
    text.textContent = item.question
    block.appendChild(text)
    if (item.detail) {
      const d = document.createElement('div')
      d.className = 'q-detail'
      d.textContent = item.detail
      block.appendChild(d)
    }
    const entry: { id: string; selected: string[]; custom?: string } = {
      id: item.id,
      selected: [],
      custom: undefined,
    }
    answers.push(entry)
    if (item.options && item.options.length > 0) {
      const opts = document.createElement('div')
      opts.className = 'q-options'
      for (const opt of item.options) {
        const label = document.createElement('button')
        label.className = 'q-option'
        label.textContent = opt.label
        label.title = opt.description ?? ''
        label.addEventListener('click', () => {
          if (item.multiSelect) {
            const i = entry.selected.indexOf(opt.label)
            if (i >= 0) {
              entry.selected.splice(i, 1)
              label.classList.remove('selected')
            } else {
              entry.selected.push(opt.label)
              label.classList.add('selected')
            }
          } else {
            entry.selected.length = 0
            entry.selected.push(opt.label)
            opts.querySelectorAll('.q-option').forEach((b) => b.classList.remove('selected'))
            label.classList.add('selected')
          }
        })
        opts.appendChild(label)
      }
      block.appendChild(opts)
    } else {
      // 无选项 → 自由文本输入
      const input = document.createElement('input')
      input.className = 'q-input'
      input.placeholder = '输入回答…'
      input.addEventListener('input', () => {
        entry.custom = input.value.trim()
      })
      block.appendChild(input)
    }
    row.appendChild(block)
  }

  const bar = document.createElement('div')
  bar.className = 'q-bar'
  const submit = document.createElement('button')
  submit.className = 'q-submit'
  submit.textContent = '回答'
  submit.addEventListener('click', () => {
    row.remove()
    vscode.postMessage({
      type: 'questionResponse',
      rpcId: q.rpcId,
      sessionId: q.sessionId,
      answers,
    })
  })
  const cancel = document.createElement('button')
  cancel.className = 'q-cancel'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => {
    // 先不删卡：等 host 确认（questionClosed）再移除。取消失败时 host 会回退为整轮停止，
    // 也通过 questionClosed 关闭本卡；若这里立即删卡，取消被拒后本轮会一直挂着、停止按钮卡在 ■。
    cancel.disabled = true
    submit.disabled = true
    vscode.postMessage({ type: 'questionCancel', rpcId: q.rpcId, sessionId: q.sessionId })
  })
  bar.appendChild(submit)
  bar.appendChild(cancel)
  row.appendChild(bar)
  messagesEl.appendChild(row)
  questionCards.set(q.rpcId ?? '', row)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

/** 折叠思考区为摘要 */
function collapseThinking(): void {
  if (!thinkingEl) {
    return
  }
  const parts: string[] = []
  if (stepCount > 0) {
    parts.push(stepCount + ' 步')
  }
  if (toolCount > 0) {
    parts.push(toolCount + ' 个工具')
  }
  if (parts.length > 0) {
    thinkingEl.innerHTML = '<div class="summary">🤔 已思考 · ' + parts.join(' · ') + '</div>'
  } else {
    thinkingEl.classList.add('hidden')
  }
  thinkingEl = null
}

function appendChunk(delta: string): void {
  if (!assistantEl) {
    assistantEl = startAssistantMessage()
  }
  assistantText += delta
  assistantEl.innerHTML = DOMPurify.sanitize(md.render(assistantText))
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function finishAssistant(stats?: Record<string, unknown>): void {
  if (assistantEl) {
    const statsEl = assistantEl.nextElementSibling as HTMLElement | null
    const line = formatStats(stats)
    if (statsEl && line) {
      statsEl.textContent = line
    }
    assistantEl = null
    assistantText = ''
  }
  collapseThinking() // 思考区折叠为摘要
  setProcessing(false)
}

function formatStats(stats?: Record<string, unknown>): string {
  if (!stats) {
    return ''
  }
  // 只用官方接口返回的 token 计数，不自己测量耗时 / 算 tok/s（时间不准且非官方数据）
  const parts: string[] = []
  const steps = stats['steps']
  if (typeof steps === 'number' && steps > 0) {
    parts.push(`${steps} 步`)
  }
  const inp = stats['inputTokens']
  const out = stats['outputTokens']
  const cache = stats['cacheReadTokens']
  const reasoning = stats['reasoningTokens']
  // 本轮缓存命中率 = cacheRead / (uncachedInput + cacheRead)；接口没返回这两项则不显示
  if (typeof inp === 'number' && typeof cache === 'number' && inp + cache > 0) {
    parts.push(`缓存命中 ${Math.round((cache / (inp + cache)) * 100)}%`)
  }
  if (typeof inp === 'number') {
    parts.push(`输入 ${inp} tok`)
  }
  if (typeof out === 'number') {
    parts.push(`输出 ${out} tok`)
  }
  if (typeof cache === 'number' && cache > 0) {
    parts.push(`缓存 ${cache} tok`)
  }
  if (typeof reasoning === 'number' && reasoning > 0) {
    parts.push(`推理 ${reasoning} tok`)
  }
  return parts.join(' · ')
}

// ---------- 附件 ----------

function renderAttachments(): void {
  attachmentsEl.innerHTML = ''
  if (attachments.length === 0 && images.length === 0) {
    attachmentsEl.classList.add('hidden')
    updateSendState()
    return
  }
  attachmentsEl.classList.remove('hidden')
  // 图片缩略图
  for (const img of images) {
    const box = document.createElement('span')
    box.className = 'img-chip'
    const thumb = document.createElement('img')
    thumb.className = 'img-thumb'
    thumb.src = `data:${img.mediaType};base64,${img.data}`
    thumb.title = img.name
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '✕'
    x.addEventListener('click', () => {
      images = images.filter((i) => i !== img)
      renderAttachments()
    })
    box.appendChild(thumb)
    box.appendChild(x)
    attachmentsEl.appendChild(box)
  }
  // 文件引用 chips
  for (const p of attachments) {
    const chip = document.createElement('span')
    chip.className = 'file-chip'
    const icon = document.createElement('span')
    icon.className = 'ficon'
    const iconCodicon = document.createElement('span')
    iconCodicon.className = 'codicon codicon-file'
    icon.appendChild(iconCodicon)
    const fname = document.createElement('span')
    fname.className = 'fname'
    fname.textContent = p.split(/[\\/]/).pop() || p
    fname.title = p
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '✕'
    x.addEventListener('click', () => {
      attachments = attachments.filter((a) => a !== p)
      renderAttachments()
    })
    chip.appendChild(icon)
    chip.appendChild(fname)
    chip.appendChild(x)
    attachmentsEl.appendChild(chip)
  }
  updateSendState()
}

function addAttachment(p: string): void {
  if (!attachments.includes(p)) {
    attachments.push(p)
    renderAttachments()
  }
}

/** 读取图片文件（粘贴 / 拖拽 / 选择）为 base64 内容块 */
function readImageFile(file: File): void {
  const reader = new FileReader()
  reader.onload = () => {
    const result = String(reader.result ?? '')
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(result)
    if (!m) {
      return
    }
    addImage({ mediaType: m[1], data: m[2], name: file.name || '图片' })
  }
  reader.readAsDataURL(file)
}

function addImage(img: ImageAttachment): void {
  images.push(img)
  renderAttachments()
}

// ---------- 事件 ----------

/** 清空聊天区（新会话 / 恢复会话前） */
function clearChat(): void {
  messagesEl.innerHTML = ''
  messagesEl.classList.add('hidden')
  welcome.classList.remove('hidden')
  assistantEl = null
  assistantText = ''
  thinkingEl = null
  stepCount = 0
  toolCount = 0
  stepBoxes = []
  currentOpenStep = 1
  attachments = []
  images = []
  renderAttachments()
  input.value = ''
  setProcessing(false)
  questionCards.clear()
}

// 建议按钮
document.querySelectorAll<HTMLButtonElement>('.suggestion').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = btn.getAttribute('data-p') || ''
    addUserMessage(p)
    setProcessing(true)
    vscode.postMessage({ type: 'chatSend', text: p })
    lastPrompt = p
  })
})

// 发送 / 停止（处理中变 ■，点击停止）
sendBtn.addEventListener('click', () => {
  if (processing) {
    cancel()
  } else {
    send()
  }
})
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault()
    send()
  }
})
input.addEventListener('input', updateSendState)
updateSendState()

// 粘贴图片到输入框 → 图片附件
input.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items
  if (!items) {
    return
  }
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) {
        e.preventDefault()
        readImageFile(file)
      }
    }
  }
})

// ＋ 添加文件
document.getElementById('attach')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'pickFile' })
})

// ---------- 会话历史恢复（由标题栏"工作区"面板触发） ----------

let currentSessionId = ''

/** 渲染恢复的会话历史（user 原文 + assistant markdown；assistant 行重新生成指向对应 user 消息） */
function renderHistory(messages: Array<{ role: string; text: string }>, sessionId: string | undefined): void {
  clearChat()
  let lastUser = ''
  for (const item of messages) {
    if (item.role === 'user') {
      lastUser = item.text
      addUserMessage(item.text)
    } else if (item.role === 'assistant') {
      startAssistantMessage()
      assistantText = item.text
      ;(assistantEl as HTMLElement).innerHTML = DOMPurify.sanitize(md.render(item.text))
      if (lastUser) {
        const row = assistantEl.closest('.msg') as HTMLElement | null
        if (row) {
          row.dataset.prompt = lastUser
        }
      }
      finishAssistant()
    }
  }
  if (sessionId) {
    currentSessionId = sessionId
  }
}

// ---------- 权限 / 模型 / 推理等级（图标 + 向上弹出面板） ----------

let modelGroups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; reasoning?: { efforts?: Array<{ id: string; name: string }> } }> }> = []
let curProvider = ''
let curModel = ''
let curEffort = ''
let permOptions: Array<{ value: string; name: string; description?: string }> = []
let currentPerm = ''
/** 危险权限预设：切换需先经自绘确认弹窗（与 src/extension.ts 保持一致来源） */
const DANGEROUS_PERMS = new Set<string>(['danger-full-access'])

/** 关闭所有弹出面板 */
function closePopups(): void {
  permPopup.classList.add('hidden')
  modelPopup.classList.add('hidden')
  permBtn.classList.remove('active')
  modelBtn.classList.remove('active')
}

/** 把弹出面板锚定到对应图标上方（水平对齐图标，底部贴图标顶部上方一点） */
function anchorPopup(popup: HTMLElement, btn: HTMLElement): void {
  const c = composer.getBoundingClientRect()
  const b = btn.getBoundingClientRect()
  const bottomPx = Math.round(c.bottom - b.top + 6)
  const leftPx = Math.round(b.left - c.left)
  popup.style.bottom = bottomPx + 'px'
  popup.style.left = Math.max(4, Math.min(leftPx, c.width - 24)) + 'px'
}

/** 切换某个图标对应的弹出面板 */
function togglePopup(which: 'perm' | 'model'): void {
  const isOpen = which === 'perm' ? !permPopup.classList.contains('hidden') : !modelPopup.classList.contains('hidden')
  closePopups()
  if (isOpen) {
    return
  }
  if (which === 'perm') {
    anchorPopup(permPopup, permBtn)
    renderPermPopup()
    permPopup.classList.remove('hidden')
    permBtn.classList.add('active')
  } else {
    anchorPopup(modelPopup, modelBtn)
    renderModelPopup()
    modelPopup.classList.remove('hidden')
    modelBtn.classList.add('active')
  }
}

permBtn.addEventListener('click', () => togglePopup('perm'))
modelBtn.addEventListener('click', () => togglePopup('model'))
// 点击面板外任意处关闭（用 contains 判断：按钮内是 SVG，e.target 是 svg/path 而非按钮本身）
document.addEventListener('click', (e) => {
  const t = e.target as Node
  if (permPopup.contains(t) || modelPopup.contains(t) || permBtn.contains(t) || modelBtn.contains(t)) {
    return
  }
  closePopups()
})

// ---------- 权限 ----------

/** 渲染权限弹出面板（读取官方 permissions 投影） */
function renderPermission(options: Array<{ value: string; name: string; description?: string }> | undefined, currentValue: string | undefined): void {
  permOptions = options ?? []
  for (const o of permOptions) {
    rememberPermName(o)
  }
  currentPerm = currentValue ?? ''
  updatePermLabel()
  if (!permPopup.classList.contains('hidden')) {
    renderPermPopup()
  }
}

function renderPermPopup(): void {
  permPopup.innerHTML = ''
  if (permOptions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'opt'
    empty.textContent = '没有可用的权限'
    empty.style.opacity = '0.6'
    permPopup.appendChild(empty)
    return
  }
  for (const opt of permOptions) {
    const el = document.createElement('div')
    el.className = 'opt' + (opt.value === currentPerm ? ' selected' : '')
    el.textContent = opt.name || opt.value
    el.title = opt.description ?? ''
    el.addEventListener('click', () => {
      if (opt.value === currentPerm) {
        closePopups()
        return
      }
      if (DANGEROUS_PERMS.has(opt.value)) {
        // 危险权限：先经自绘确认弹窗（仿 dsh 官方文案 + 风险勾选）确认，再切换
        closePopups()
        const label = opt.value === 'danger-full-access' ? 'Full access' : opt.name || opt.value
        void (async () => {
          const confirmed = await showDialog({
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
          if (!confirmed) {
            return
          }
          rememberPermName(opt)
          currentPerm = opt.value
          vscode.postMessage({ type: 'chatSelectPermission', preset: opt.value })
          updatePermLabel()
        })()
        return
      }
      rememberPermName(opt)
      currentPerm = opt.value
      vscode.postMessage({ type: 'chatSelectPermission', preset: opt.value })
      updatePermLabel()
      closePopups()
    })
    permPopup.appendChild(el)
  }
}

/** 权限 value → 显示名缓存（选项加载/点选时记录，回显前不被清掉，保证标签始终跟随选择） */
const permNameOf = new Map<string, string>()

function rememberPermName(opt: { value: string; name?: string }): void {
  permNameOf.set(opt.value, opt.name || opt.value)
}

/** 在权限图标旁展示当前选择；名称直接采用后端返回的 name/value，不做本地翻译 */
function updatePermLabel(): void {
  const found = permOptions.find((o) => o.value === currentPerm)
  const name = found ? found.name || found.value : (permNameOf.get(currentPerm) ?? '')
  permLabel.textContent = name
  const desc = found?.description ?? ''
  permBtn.title = name ? `权限：${name}${desc ? ` (${desc})` : ''}` : '权限'
}

// ---------- 模型 + 推理等级 ----------

/** 渲染模型弹出面板（读取官方 session.models）；同时展示模型与推理等级 */
function renderModels(models: { current?: { provider?: string; model?: string; reasoningEffort?: string }; groups?: typeof modelGroups } | undefined): void {
  if (!models) {
    return
  }
  const cur = models.current
  curProvider = cur?.provider ?? ''
  curModel = cur?.model ?? ''
  curEffort = cur?.reasoningEffort ?? ''
  modelGroups = (models.groups ?? []) as typeof modelGroups
  updateModelLabel()
  if (!modelPopup.classList.contains('hidden')) {
    renderModelPopup()
  }
}

/** 当前模型信息（在模型组里查找） */
function currentModelInfo(): { id: string; name: string; reasoning?: { efforts?: Array<{ id: string; name: string }> } } | undefined {
  for (const g of modelGroups) {
    for (const m of g.models) {
      if (g.id === curProvider && m.id === curModel) {
        return m
      }
    }
  }
  return undefined
}

function renderModelPopup(): void {
  modelPopup.innerHTML = ''
  const title = document.createElement('div')
  title.className = 'popup-title'
  title.textContent = '模型'
  modelPopup.appendChild(title)
  for (const g of modelGroups) {
    if (g.models.length === 0) {
      continue
    }
    const gl = document.createElement('div')
    gl.className = 'optgroup-label'
    gl.textContent = g.name || g.id
    modelPopup.appendChild(gl)
    for (const m of g.models) {
      const el = document.createElement('div')
      el.className = 'opt' + (g.id === curProvider && m.id === curModel ? ' selected' : '')
      el.textContent = m.name || m.id
      el.addEventListener('click', () => {
        // 切模型与切推理等级解耦：切模型只发 provider+model，不带 effort，
        // 由 dsh 按该模型默认处理；effort 仅在推理等级行上单独选择。
        curProvider = g.id
        curModel = m.id
        vscode.postMessage({ type: 'chatSelectModel', provider: g.id, model: m.id })
        updateModelLabel()
        renderModelPopup()
      })
      modelPopup.appendChild(el)
    }
  }
  // 推理等级：当前模型自带的 efforts
  const active = currentModelInfo()
  const efforts = active?.reasoning?.efforts ?? []
  if (efforts.length > 0) {
    const rl = document.createElement('div')
    rl.className = 'optgroup-label'
    rl.textContent = '推理等级'
    modelPopup.appendChild(rl)
    for (const e of efforts) {
      const el = document.createElement('div')
      el.className = 'opt reason' + (e.id === curEffort ? ' selected' : '')
      el.textContent = e.name || e.id
      el.addEventListener('click', () => {
        curEffort = e.id
        vscode.postMessage({ type: 'chatSelectModel', provider: curProvider, model: curModel, reasoningEffort: curEffort || undefined })
        updateModelLabel()
        renderModelPopup()
      })
      modelPopup.appendChild(el)
    }
  }
}

/** 在模型图标旁展示当前模型 + 推理等级 */
function updateModelLabel(): void {
  let label = ''
  if (curProvider && curModel) {
    const active = currentModelInfo()
    label = active?.name || curModel
    // 推理等级按模型显示：只在当前模型自己声明该 effort 时才拼到标签里
    if (curEffort) {
      const effort = active?.reasoning?.efforts?.find((e) => e.id === curEffort)
      if (effort) {
        label += ' · ' + (effort.name || curEffort)
      }
    }
  }
  modelLabel.textContent = label
  modelBtn.title = label ? `模型：${label}` : '模型与推理等级'
}

/** 用官方投影渲染底部统计条（sessionStats + tokenUsage），超长省略、悬停显示全文 */
function renderStats(projections: Record<string, unknown>): void {
  const s = (projections['sessionStats'] as Record<string, number> | undefined) ?? {}
  const t = (projections['tokenUsage'] as Record<string, number> | undefined) ?? {}
  const parts: string[] = []
  const turns = s['turns'] as number | undefined
  const steps = s['steps'] as number | undefined
  if (typeof turns === 'number' && turns > 0) parts.push(`${turns} 轮`)
  if (typeof steps === 'number' && steps > 0) parts.push(`${steps} 步`)
  const llmMs = s['llmMs'] as number | undefined
  const toolMs = s['toolMs'] as number | undefined
  if (typeof llmMs === 'number' && llmMs > 0) parts.push(`LLM ${(llmMs / 1000).toFixed(1)}s`)
  if (typeof toolMs === 'number' && toolMs > 0) parts.push(`工具调用 ${(toolMs / 1000).toFixed(1)}s`)
  const ttftMs = s['ttftMs'] as number | undefined
  const ttftSteps = s['ttftSteps'] as number | undefined
  if (typeof ttftMs === 'number' && typeof ttftSteps === 'number' && ttftMs > 0 && ttftSteps > 0) {
    parts.push(`首 token 平均 ${(ttftMs / ttftSteps / 1000).toFixed(1)}s`)
  }
  const decodeMs = s['decodeMs'] as number | undefined
  const decodeTokens = s['decodeTokens'] as number | undefined
  if (typeof decodeMs === 'number' && typeof decodeTokens === 'number' && decodeMs > 0 && decodeTokens > 0) {
    parts.push(`${(decodeTokens / (decodeMs / 1000)).toFixed(0)} tok/s`)
  }
  const input = t['uncachedInputTokens'] as number | undefined
  const cache = t['cacheReadTokens'] as number | undefined
  const output = t['outputTokens'] as number | undefined
  if (typeof input === 'number' && typeof cache === 'number' && input + cache > 0) {
    parts.push(`缓存命中 ${((cache / (input + cache)) * 100).toFixed(0)}%`)
  }
  if (typeof input === 'number') parts.push(`输入 ${input} tok`)
  if (typeof output === 'number') parts.push(`输出 ${output} tok`)
  if (typeof cache === 'number' && cache > 0) parts.push(`缓存 ${cache} tok`)
  const line = parts.join(' · ')
  statsBar.textContent = line
  statsBar.title = line
}

// 拖拽文件/图片进输入区 → 附件 chips / 图片缩略图
composer.addEventListener('dragover', (e) => e.preventDefault())
composer.addEventListener('drop', (e) => {
  e.preventDefault()
  const files = Array.from(e.dataTransfer.files ?? [])
  for (const f of files) {
    if (f.type && f.type.startsWith('image/')) {
      readImageFile(f)
    }
  }
  const uri = e.dataTransfer.getData('text/uri-list')
  if (uri) {
    const first = uri.trim().split('\n')[0].trim()
    if (first.startsWith('file:')) {
      addAttachment(decodeURIComponent(first.slice(7)))
    }
  }
})

// 扩展宿主 → webview
window.addEventListener('message', (e) => {
  const m = e.data as { type?: string; text?: string; step?: number; path?: string; stats?: Record<string, unknown>; elapsedMs?: number }
  if (!m || !m.type) {
    return
  }
  if (m.type === 'chatActivity') {
    addActivity((m as { activity?: { type?: string; step?: number; tool?: string } }).activity)
  } else if (m.type === 'chatReasoning') {
    addReasoning(m.text ?? '', m.step)
  } else if (m.type === 'chatApproval') {
    const am = m as { approvalId?: string; description?: string }
    appendApproval(am.approvalId ?? '', am.description ?? '')
  } else if (m.type === 'chatQuestion') {
    appendQuestion(m as { rpcId?: string; sessionId?: string; questions?: Array<{ id: string; question: string; header?: string; detail?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }> })
  } else if (m.type === 'questionClosed') {
    // host 已确认该提问关闭（单独取消被接受，或取消失败已回退整轮停止）
    closeQuestionCard((m as { rpcId?: string }).rpcId)
  } else if (m.type === 'chatChunk') {
    appendChunk(m.text ?? '')
  } else if (m.type === 'chatDone') {
    finishAssistant(m.stats)
    } else if (m.type === 'filePicked') {
    if (m.path) {
      addAttachment(m.path)
    }
  } else if (m.type === 'chatInfo') {
    const info = m as { projections?: Record<string, unknown>; models?: { current?: { provider?: string; model?: string; reasoningEffort?: string }; groups?: unknown[] } }
    if (info.projections) {
      const perms = info.projections['permissions'] as { options?: Array<{ value: string; name: string; description?: string }>; currentValue?: string } | undefined
      renderPermission(perms?.options, perms?.currentValue)
      renderStats(info.projections)
    }
    if (info.models) {
      renderModels(info.models as { current?: { provider?: string; model?: string; reasoningEffort?: string }; groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string; reasoning?: { efforts?: Array<{ id: string; name: string }> } }> }> })
    }
  } else if (m.type === 'draft') {
    input.value = input.value ? input.value + '\n' + (m.text ?? '') : (m.text ?? '')
    input.focus()
  } else if (m.type === 'chatHistory') {
    const hm = m as { messages?: Array<{ role: string; text: string }>; sessionId?: string }
    renderHistory(hm.messages ?? [], hm.sessionId)
  } else if (m.type === 'clear') {
    clearChat()
  }
})

// 页面脚本就绪（消息监听已挂上）→ 通知扩展推送 chatInfo，避免视图重建时早推丢失
vscode.postMessage({ type: 'ready' })
