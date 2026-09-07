// "/" 斜杠命令触发器：行首 "/" 唤起，候选 = dsh host 命令目录 + 会话技能 + 插件本地动作。
// 数据源与官方 ui-commands/ui-skill 同名(commands/list、skill.list)。
import type { TriggerDef, TriggerRow } from './useTrigger'
import type { ChatStore } from '../store/chat'

export function slashTrigger(store: ChatStore): TriggerDef {
  return {
    id: 'slash',
    // 仅行首(输入框开头或换行后)的 "/" 命中
    match(text, caret) {
      const prefix = text.slice(0, caret)
      const lineStart = prefix.lastIndexOf('\n') + 1
      const line = prefix.slice(lineStart)
      if (!line.startsWith('/')) return null
      // 已在「/命令 参数…」阶段：名称已带一个完整 token + 空格 → 不再弹菜单，把参数留在输入框
      // （避免插入了 "/name " 后菜单残留/随击键再冒出来）
      if (/^\S+[\s　]/.test(line.slice(1))) return null
      // 目录缺失时触发拉取（store 内部去重，成功后信号更新自动重渲）
      if (!store.slashCatalog.value) store.requestSlashList()
      return { query: line.slice(1), start: lineStart }
    },
    rows(): TriggerRow[] {
      const rows: TriggerRow[] = []
      const cat = store.slashCatalog.value
      // 分组展示(同官方)：指令 → 技能 → 本地；组内按名称排序
      const commands = (cat?.commands ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
      for (const c of commands) {
        rows.push({ kind: 'command', group: 'command', groupLabel: '命令', prefix: '/', name: c.name, description: c.description, hint: c.input?.hint })
      }
      const skills = (cat?.skills ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
      for (const s of skills) {
        rows.push({ kind: 'skill', group: 'skill', groupLabel: '技能', prefix: '/', name: s.name, description: s.description })
      }
      // 本地动作：模型官方并非 host 命令(官方为客户端弹窗贡献)，插件以本地项提供
      rows.push({ kind: 'local', group: 'local', groupLabel: '本地', prefix: '/', name: 'model', description: '选择模型与推理等级' })
      return rows
    },
    pick(row, helpers) {
      if (row.kind === 'local' && row.name === 'model') {
        helpers.clear()
        // /model：打开「仅模型列表的可搜索弹窗」(与模型按钮的完整弹窗不同)
        store.markSlashPick('model')
        store.openModelSearch()
        return
      }
      if (row.kind === 'command' && row.name === 'permission') {
        // 权限预设是可选项而非自由文本：打开插件权限弹窗选预设，
        // 选中后由 chatSelectPermission → dsh setPermissionPreset → 刷新，权限标签/状态随之更新
        helpers.clear()
        store.closePopups()
        store.markSlashPick('permission')
        if (store.openPopup.value !== 'perm') store.togglePopup('perm')
        return
      }
      if (row.kind === 'command' && !row.hint) {
        // 无参 host 命令：清掉 token，立即执行（走 commands/execute，不进聊天气泡）
        helpers.clear()
        store.runSlash('/' + row.name)
        return
      }
      // 带参命令 / 技能：插入 "/name " 保留光标，继续输参后回车（命令走宿主执行、技能走正常发送）
      helpers.replace('/' + row.name + ' ')
    },
  }
}
