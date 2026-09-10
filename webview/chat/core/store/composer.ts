// 输入区切片：文本、图片、附件、@ 引用贴片，以及不经由消息行的宿主直通动作
// （取消 / 复制 / 选文件 / 执行斜杠命令）。不依赖 messages 信号。
import { signal } from '@preact/signals'
import type { ChatHost } from '../host'
import type { ImageAttachment } from '../protocol'
import type { ChatStore, RefChip } from './types'

export interface ComposerSlice {
  store: Pick<
    ChatStore,
    | 'text'
    | 'attachments'
    | 'images'
    | 'refs'
    | 'focusTick'
    | 'runSlash'
    | 'pickFile'
    | 'copy'
    | 'cancel'
    | 'addImage'
    | 'removeImage'
    | 'addAttachment'
    | 'removeAttachment'
    | 'addRef'
    | 'removeRef'
    | 'readImageFile'
  >
  /** 宿主草稿消息到达：并入输入框文本并触发焦点。 */
  appendDraft(draft: string | undefined): void
  reset(): void
}

export function createComposer(host: ChatHost): ComposerSlice {
  const text = signal('')
  const attachments = signal<string[]>([])
  const images = signal<ImageAttachment[]>([])
  const refs = signal<RefChip[]>([])
  const focusTick = signal(0)
  let refKey = 1

  /** 执行一条 dsh 斜杠命令：清空输入后发宿主（不入聊天气泡）。 */
  function runSlash(line: string): void {
    const t = (line ?? '').trim()
    if (!t.startsWith('/')) return
    if (text.value === t) text.value = ''
    host.post({ type: 'slashRun', text: t })
  }
  const copy = (c: string): void => {
    if (c) host.post({ type: 'copy', text: c })
  }
  const pickFile = (): void => {
    host.post({ type: 'pickFile' })
  }
  function cancel(): void {
    host.post({ type: 'cancel' })
  }

  // ---------- 附件 / 图片 ----------
  function renderAttachmentsDeps(): void {
    // images/attachments 是信号,改动即触发重渲;此函数仅为保持调用点语义占位
  }
  function addImage(img: ImageAttachment): void {
    images.value = [...images.value, img]
    renderAttachmentsDeps()
  }
  const removeImage = (img: ImageAttachment): void => {
    images.value = images.value.filter((i) => i !== img)
  }
  function addAttachment(p: string): void {
    if (!attachments.value.includes(p)) {
      attachments.value = [...attachments.value, p]
    }
  }
  const removeAttachment = (p: string): void => {
    attachments.value = attachments.value.filter((a) => a !== p)
  }
  /** 添加一条 @ 引用贴片（label 用于显示，token 为发送时注入 prompt 的引用文本）。 */
  function addRef(kind: RefChip['kind'], label: string, token: string, detail?: string): void {
    refs.value = [...refs.value, { key: refKey++, kind, label, token, detail }]
  }
  const removeRef = (key: number): void => {
    refs.value = refs.value.filter((r) => r.key !== key)
  }
  function readImageFile(file: File): void {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(result)
      if (!m) return
      addImage({ mediaType: m[1], data: m[2], name: file.name || '图片' })
    }
    reader.readAsDataURL(file)
  }

  function appendDraft(draft: string | undefined): void {
    text.value = text.value ? text.value + '\n' + (draft ?? '') : draft ?? ''
    focusTick.value++
  }

  /** 新会话清空：只清输入区四项，不动 focusTick 与内部 refKey。 */
  function reset(): void {
    attachments.value = []
    images.value = []
    refs.value = []
    text.value = ''
  }

  return {
    store: {
      text,
      attachments,
      images,
      refs,
      focusTick,
      runSlash,
      pickFile,
      copy,
      cancel,
      addImage,
      removeImage,
      addAttachment,
      removeAttachment,
      addRef,
      removeRef,
      readImageFile,
    },
    appendDraft,
    reset,
  }
}
