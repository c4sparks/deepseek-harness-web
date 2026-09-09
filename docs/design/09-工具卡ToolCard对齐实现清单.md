# 09 · 工具卡（ToolCard / Terminal 等）对齐实现清单（待办）

> 目标：工具行展开后与官方 dsh 一致（Pwsh → Terminal 卡；read → Read 卡；web/search → 对应卡）。
> 铁律：**不自行翻译、不自己定义展示**——文案/结构一律取自官方（`ui-conversation` 字典、`terminal.*`/`tool.title.*`）或原文透传；拿不准的先问。

## 现状（已完成/半程）
- tool/result **输出文本**已透传：live(`stream.ts`) + 历史(`session.ts`) → store `ChainItem.tool.output`；ToolRow 展开显示“真实输出 + 原始参数 pretty JSON”。
- 已删自造中文键名翻译（`TOOL_ARG_LABEL/toolArgEntries`）。
- ToolRow 结构已 Disclosure：收起单行(标题+摘要+状态)、展开看内容。
- ✅ **本轮已做（Terminal 卡主）**：工具变体分类、exitCode/signal 解析透传、Terminal 卡 UI 复刻（见下文勾选）。
- ✅ **上下文注入行（非工具卡，同属 UI 对齐）**：宿主捕获非用户 source 的 `user/message`（系统提示词/技能/召回）→ `ChatRow.kind:'context'` → `message/ContextInjectionRow.ts` 按官方渲染。记录见 `docs/details/upgrade/09` §5.2。

## 待办（对齐官方，按序）
### 1 数据补齐（官方字段）
- [x] 解析 **exitCode / signal**：官方不是独立 JSON 字段，而是 `tool/result` 输出末尾 marker（`\n[exit code: N]` / `\n[killed by signal: X]`，由 shell render 追加）。已在 **截断前**解析并剥 marker，live(`stream.ts`)+history(`session.ts`) → store `ChainItem.tool.exitCode/signal`。解析器：宿主 `src/dsh/official/exit-status.ts`（stream/session 共用）+ webview `core/terminal.ts parseExitStatus`（UI 兜底）。
- [x] 解析 **cwd**（工作目录）与 command：从 `tool/call` 的 `arguments` 字段取，`command` 必填（非空才算标准 shell 调用）、`workdir`/`cwd` 读为工作目录。**不猜**，字段名照官方 `shellCall`/`raw-tool-call`。
- [x] 明确各工具“summary/description”的取法：跟随官方 `deriveSummary`（bash 类 description/command → 取首个命中字符串首行），已存在(`deriveToolSummary`)并核对字段名；Terminal 卡展开头行摘要取 `description`。

### 2 分类与图标/标题（官方 TOOL_VARIANTS / 字典）
- [x] 按官方 variant 分类：bash(pwsh…) / read(read_image/web_fetch) / search(grep/glob/web_search) / write / edit… → 图标+标题。分类在 `webview/chat/core/terminal.ts classifyTool`（TOOL_VARIANTS 表，对齐官方）。
- [x] 标题用**官方 i18n**（`conversation` 命名空间 `tool.title.*`，zh 值照抄：Pwsh/Bash/读取/编辑/…）；未知回显 raw name。已存在 `format.ts toolTitle`。
- [x] 文案（terminal: running/done/failed/noOutput/exitCode/signal/expandRest/copy/copied/collapse…）从官方 `ui-conversation` zh 字典**原文抄录**（`terminal.ts terminalLabels`，不自造）。

### 3 Terminal 卡 UI（官方 TerminalBlock 结构复刻，纯 CSS）
- [x] 结构：提示行（**状态点** done绿/ongoing蓝/error红 + cwd 提示标签(promptLabel 简化~) + **命令原文**等宽 pre）→ **状态 Pill**（exitCode/signal 非 0 才显示）→ **复制按钮** → **输出区**（剥 marker 原样）→ 无输出显示官方 noOutput。
- [x] 长输出：按官方 `DEFAULT_TERMINAL_MAX_LINES` **折叠中间**（首/尾各若干行 + “… 其余 n 行”按钮，点击全部展开/收起）；输出区自身内滚（帽 224px），横幅固定。
- [x] cwd/description 的摆放与主次按官方：提示行 cwd 标签、展开头行摘要取 description。
- [x] 视觉数值(padding/margin/字号/圆角/gutter/line-height)复刻官方 `TerminalBlock.module.css`/`bash-sample.module.css`，已登记进 `docs/design/08` §5.4。

### 4 其它工具卡
- [x] **web_fetch / web_search**：按官方 WebRow → WebBlock 复刻（见 `docs/details/upgrade/09` §5.3）。fetch 卡 = URL 超链接（**globe 浏览器图标**、无独立协议格）→ `HTTP {statusCode}` 状态**下一行** → 截断；search 卡显示 answer + 序号来源列表 + noResults/截断。数据来自 `tool/result.data.meta`（宿主补齐捕获），无 meta/畸形回退泛型「输出+raw JSON」。
- [x] **ask_user_question（提问）**：按官方 waterfall 形态——**交互在输入框上方弹窗**（`message/QuestionDialog`：选项/自由输入+回答(选全可提交)/取消/关闭），对话行 ask 行**只做问答记录**（`提问 · {n}/{N} 已回答 / 已取消 / 已中断` + 问题↔回复）；**提问不 fold**（hasFold 排除 ask）。数据=chatQuestion→`store.pendingQuestion` 信号。
- [ ] read/read_image、write/edit、grep/glob 等仍“输出+raw JSON”，后续按官方 ReadRow/GenericToolCard 逐类复刻。
- [ ] 关联观察：官方 **search/read 完成行**在收起行**标题前有绿色状态点**（StateDot done），bash 行收起行**无**（点在卡内）。当前收起行 ok 一律无角标（沿用“成功不打勾”既定规则）；是否给 search/read 收起行补绿点待定（见 §约束，拿不准先问）。

### 5 验收
- [x] 编译：`tsc --noEmit`(src)、`tsc --noEmit -p webview/chat`、`node scripts/build-chat.mjs`、`node esbuild.js` 全绿。
- [ ] 真机 F5：发多工具指令（含 Pwsh + web_fetch + web_search），看 Terminal 卡（命令原文/输出/退出码 Pill/复制/长输出折叠）、其余工具保持“输出+raw JSON”；深浅主题、窄栏(editor tab)走查。
- [ ] 对照官方截图逐点核对（`tmp/pic`：Pwsh 卡状态点 done、命令等宽、输出区、`复制`按钮；网页搜索卡）。

## 约束提醒（写死）
- 中文/标签/文案：一律用官方字典原文；工具字段值：原样透传展示。
- 我不“发明”样式与文案；没有官方依据的视觉点先列出来问，不落地。
