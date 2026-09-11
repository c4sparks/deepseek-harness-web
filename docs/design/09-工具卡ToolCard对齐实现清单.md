# 09 · 工具卡（ToolCard / Terminal 等）对齐实现清单（待办）

> 目标：工具行展开后与上游 dsh 一致（Pwsh → Terminal 卡；read → Read 卡；web/search → 对应卡）。
> 铁律：**不自行翻译、不自己定义展示**——文案/结构一律取自上游（`ui-conversation` 字典、`terminal.*`/`tool.title.*`）或原文透传；拿不准的先问。

## 现状（已完成/半程）
- tool/result **输出文本**已透传：live(`stream.ts`) + 历史(`session.ts`) → store `DshTurnProcessItem.tool.output`。通用卡展开体为 ioCard：**「输入」(调用参数 pretty JSON) + 「输出」(调用结果)** 两个带标签分区。
  【v0.1.7 · dsh 0.1.2-rc.1】修正了此处的两个读取错误：内容在 `message.content[0].content`（此前读顶层）、配对 id 在 `message.source.callId`（此前读顶层 `callId`，取不到导致 `toolDone` 与工具行配不上）。解包器 `src/dsh/official/result-text.ts readToolResult()`，兼容迁移前的旧格式。
- 已删自造中文键名翻译（`TOOL_ARG_LABEL/toolArgEntries`）。
- ToolRow 结构已 Disclosure：收起单行(标题+摘要+状态)、展开看内容。
- ✅ **本轮已做（Terminal 卡主）**：工具变体分类、exitCode/signal 解析透传、Terminal 卡 UI 复刻（见下文勾选）。
- ✅ **上下文注入行（非工具卡，同属 UI 对齐）**：宿主捕获非用户 source 的 `user/message`（系统提示词/技能/召回）→ `ChatRow.kind:'context'` → `message/ContextInjectionRow.ts` 按上游渲染。

## 待办（对齐上游，按序）
### 1 数据补齐（上游字段）
- [x] 解析 **exitCode / signal**：上游不是独立 JSON 字段，而是 `tool/result` 输出末尾 marker（`\n[exit code: N]` / `\n[killed by signal: X]`，由 shell render 追加）。已在 **截断前**解析并剥 marker，live(`stream.ts`)+history(`session.ts`) → store `DshTurnProcessItem.tool.exitCode/signal`。解析器：宿主 `src/dsh/official/exit-status.ts`（stream/session 共用）+ webview `core/terminal.ts parseExitStatus`（UI 兜底）。
- [x] 解析 **cwd**（工作目录）与 command：从 `tool/call` 的 `arguments` 字段取，`command` 必填（非空才算标准 shell 调用）、`workdir`/`cwd` 读为工作目录。**不猜**，字段名照上游 `shellCall`/`raw-tool-call`。
- [x] **cwd 完整解析**（【v0.1.7 · dsh 0.1.2-rc.1】）：按 `resolveTerminalCwd` 的三个分支与两个辅助函数实现：
  - 调用未带 `workdir` → 用会话工作区根。工具调用通常不带，此前插件一律显示 `$`。链路：`dshService.currentWorkspacePath()`（**只读，不新建工作区**）→ `chatInfo.cwd` → store `sessionCwd` → `terminalCardModel(item, sessionCwd)`
    - **`chatInfo.cwd` 必须是"作者写法"原样，不能是归一化值**（【v0.1.7 修】）：它是**显示用的相对根**，同时喂给收起行摘要、读卡横幅的 `relativizeToCwd`。此前 `currentWorkspacePath()` 走了 `normalizePath`（**小写化 + 反斜杠转正斜杠**），于是：① 工具给的 `C:\...\system_report.md` 与根 `c:/users/...` 前缀对不上 → **相对化静默失效、整条绝对路径被画到收起行上**（真机踩到）；② 路径末段会被小写化（`MyProject` → `myproject`）。归属比较仍在宿主用 `normalizePath`，`currentWorkspacePath()` 只去尾部分隔符后原样返回。
    - **`relativizeToCwd` 对 Windows 路径放宽比较**：盘符/UNC 路径**不分大小写、`/` 与 `\` 等价**（`samePath`），按长度切前缀、按 `samePath` 判，切出的偏移仍正确；POSIX 路径维持字节严格比较（那里大小写确实是不同路径）。这样工具给的任一种写法都能对上工作区根。
  - 相对 `workdir` → 先 `resolveWorkspacePath` 拼到工作区根下，再折叠 `.`/`..`。不折叠会把点号当目录名：`workdir: ".."` 配工作区 `/w/app` 实际跑在 `/w`，标签该显示 `w` 而非 `..`
  - 无工作区根 → 退化为只折叠 `workdir`
  - 实现逐一移植（`util-workspace-path` 的 `resolveWorkspacePath` + `terminal-card-model` 的 `normalizeSegments`/`collapse`）：`. `/空段丢弃、`..` 弹上一段、**有根**时越过根的 `..` 丢弃、**无根**时保留开头 `..`、UNC 的 server/share 视作根不许翻出共享、分隔符沿用原文。见 `webview/chat/core/terminal.ts`
- [x] **工具行终态判定**（【v0.1.7 修正】）：主依据是 `isError`，**不是「有没有 `error.code`」**。code 是开放集合，其中 `interrupted`（回合被打断）上游判 **`stopped`**（琥珀、非失败），不是 error；`ask_user_question` 的 `ASK_CANCELLED` 上游判 **`ok`**（用户自己取消，无任何错误标记）、`ASK_ABORTED` 判 **`stopped`**——两者由展示层覆盖（上游 `AskQuestionRow`，本插件 `webview/chat/core/ask-card.ts`）。通用判定一份实现：宿主 `src/dsh/official/tool-status.ts`，实时 `stream.ts` 与历史 `session.ts` 共用。**此前按「有码即失败」判，导致取消/被打断的调用显示成红色 + ⚠ 三角 + 裸错误码**。
- [x] 明确各工具“summary/description”的取法：跟随上游 `deriveSummary`（bash 类 description/command → 取首个命中字符串首行），已存在(`deriveToolSummary`)并核对字段名；Terminal 卡展开头行摘要取 `description`。

### 2 分类与图标/标题（上游 TOOL_VARIANTS / 字典）
- [x] 按上游 variant 分类：bash(pwsh…) / read(read_image/web_fetch) / search(grep/glob/web_search) / write / edit… → 图标+标题。分类在 `webview/chat/core/terminal.ts classifyTool`（TOOL_VARIANTS 表，对齐上游）。
- [x] 标题用 **i18n 字典**（`tool.title.*`，zh 值照抄：Pwsh/Bash/读取/编辑/…）；未知工具回通用标题「工具调用」，真实工具名由摘要承载（`get_goal · {}`）。`format.ts toolTitle`。
- [x] 文案（terminal: running/done/failed/noOutput/exitCode/signal/expandRest/copy/copied/collapse…）从上游 `ui-conversation` zh 字典**原文抄录**（`terminal.ts terminalLabels`，不自造）。
- [x] **行状态标记与错误语义**（【v0.1.7】按上游对齐，分两批做）。**改动点 ↔ 文件对照**（全部在 webview 侧，**不动宿主、不动协议**）：

  | 点 | 改什么 | 文件 |
  |---|---|---|
  | ④ | shell 失败 → 整行 error | `core/terminal.ts`（`TermCard.state`：ok 且 failed → error）；`components/chain/ToolRow.ts`（`rowState = ask?.state ?? terminal?.state ?? item.status`，行与卡内点/文案取**同一个值**） |
  | ⑤ | 失败行收起摘要 = **结果文本首行**（上游 `failureLine ?? description ?? summary`），按错误色显示；**只认 isError 判出的 error**，非零退出那类仍显描述 | `components/chain/ToolRow.ts`（`failureLine`/`headSummary`、`is-error` 类）；`core/format.ts`（`resultFirstLine`）；`styles/chain.css`（`.chain-row-preview.is-error`）；`docs/design/08` §5.2 |
  | ⑥ | 文件类工具（write/edit/read…）收起摘要 = **相对工作区根**的路径（**跟上游**；工作区外的文件显示全路径，不做 basename） | `components/chain/ToolRow.ts`（`relativizeToCwd(item.summary ?? terminal.description, cwd)`）；`core/terminal.ts`（`relativizeToCwd`） |
  | ① | leading 二选一（error→红点 / stopped→琥珀点 / 其余→变体图标）；**去掉行尾状态角标** | `components/chain/ToolRow.ts`（head 结构：`dotState` 取代 `stIcon`）；`styles/chain.css`（新增 `.chain-tool-dot` 与 `.is-error`/`.is-warning`，删除 `.chain-tool-status` 全部 6 处规则）；`docs/design/08` §5.2 |
  | ② | running 由「行尾转圈」改为**行上掠光带** | `components/chain/ToolRow.ts`（**head 按钮**加 `data-state=${rowState}`）；`styles/chain.css`（`.chain-row-head` 加 `position relative`，新增 `[data-state='running']::after` + `@keyframes chain-row-sweep` + `prefers-reduced-motion` 关断） |
  | ③ | 无障碍：视觉隐藏的 `运行中/失败/已停止` 文字 | `core/states.ts`（新增 `toolStateLabel()`，文案取自上游 `row.running/failed/stopped`）；`components/chain/ToolRow.ts`（head 内加 `<span class="chain-row-state">`）；`styles/chain.css`（新增 `.chain-row-state` 视觉隐藏类） |

  语义细节：
  - **④ shell 失败的整行覆盖**：上游 `GenericToolCard` 里 `state = model.state === 'ok' && terminalFailed(terminal) ? 'error' : model.state`；`terminalFailed = !running && (exitCode !== 0 || signal !== undefined)`。**非零退出/被信号终止的 shell 调用，调用本身 `isError: false`**（退出状态是结果数据，不是调用失败），所以行状态得靠这条覆盖才红。插件原先没有这条 → 这类行不进红色体系。
    - **【v0.1.7 补】覆盖从 ToolRow 移进 `terminalCardModel`，落成 `TermCard.state`，行与卡内状态点/文案取同一值**（原来行按 `item.status` + 覆盖、卡只按退出码，两处各判一次）。同时补上一个原先漏掉的情形：**调用真失败（isError，没有退出码）** —— 卡内按「没有退出码 = 干净退出」判，显示成「已完成 + 绿点」，与行上的红点自相矛盾。上游遇 isError 不出终端卡（退回通用卡），所以上游没有这个问题；本插件既然有意留用终端卡（见 §3），失败态就得由卡自己如实表达：`error` → 失败 + 红点，`stopped` → 已停止 + 琥珀点。**退出状态那类（非零退出 / 被信号终止）行为不变**：它仍是 `isError: false` 的「结果数据」，只有展示层按 `terminalFailed` 标红。
  - **⑤ 失败行的收起摘要（v0.1.7 定稿：回到上游口径）**：上游 `ToolRow.tsx:137`/`bash-sample.tsx:70` 是
    ```
    errorSummary = state === 'error' && output !== null ? firstLine(output) : null   // output 为空串视作「无结果」
    failureLine  = state === 'error' ? errorSummary : null
    summaryText  = failureLine ?? terminal?.description ?? summary                    // 注释原话：A failure must replace, not supplement
    ```
    渲染时该行摘要加 `.errorSummary` 色（错误色）。**插件现在照此实现**：`failureLine = item.status === 'error' ? resultFirstLine(item.output) : null`。
    - **关键分界（一度搞错）**：`state === 'error'` 是**宿主按 isError 判出的终态**，**不是**展示层那条 `terminalFailed` 覆盖出来的红。**非零退出/被信号终止的 shell 调用 `isError: false`**（退出状态是结果数据，不是调用失败）→ 它的 `failureLine` 是 null → **摘要位仍是模型写的 `description`**（上游亦然；「失败」由行首红点 + 卡内退出码 Pill 表达）。只有**真失败（isError）**才把摘要位换成结果首行。
    - **曾经的偏离（已撤销，留档防回退）**：插件一度自定「失败行也显描述，不做上游取代」，理由是实测一条**退出码 1** 的 pwsh 描述被 `OS:()` 顶掉、信息量更低。该理由只对**退出状态**那类成立，而那一类上游本来就不取代——把两类混为一谈才导致真失败行看不到模型返回的内容。**裸错误码**（`chain-tool-err`，插件自造）保持删除：上游从不显示错误码。
    - **提问行不换**：上游 `AskQuestionRow` 调 `ToolRow` 时**不传 `errorSummary`**（`ask-question-row.tsx`），所以提问行永远保留自己的摘要。我们的 head 是共用的，故以 `ask === null` 为条件把提问行排除在外。
    - **首行取法**：`firstLine` 切到第一个换行符为止、**不 trim**（上游同）；结果为空串 → 落回描述，首行为空行（`''`）→ 摘要位整体不显示。`resultFirstLine()` 在 `webview/chat/core/format.ts`。
  - **⑥ 文件类工具的收起摘要 = 相对工作区根的路径（跟上游）**：上游 `tool-call-model.ts:243` 给的是 `abbreviateHomePath(relativizeToCwd(deriveSummary(...), cwd), home)`。**Windows 上 `abbreviateHomePath` 是空操作**（`util-workspace-path/src/index.ts`：`isWindowsStylePath(path) || isWindowsStylePath(home) → 原样返回`，只缩 POSIX 家目录），所以两侧等价于 `relativizeToCwd`：**工作区内的文件 → 相对路径；工作区外的 → 原路径全显**。
    - **不做 basename**：曾按「收起行只显文件名」改过一版（理由：完整路径展开卡里看得到；上游先例是产出文件 chips 的 `basename` + `title` 全路径），**已回退**——口径统一为跟上游，因为同一规则要覆盖「工作区外/子目录/同名文件」三类，而 `abbreviateHomePath` 只在 POSIX 家目录下才进一步缩短。
    - **只涉及收起行，卡片内部路径不动**（逐类核过上游，见 §4）：读卡横幅 = `relativizeToCwd(meta.path, 工作区根)`（上游 `read-card-model.ts:92` 同）、差异卡文件头 = 工具给的**原路径**（`DiffBlock.tsx:15` 明确 verbatim）、搜索卡文件路径 = 原样（上游不 relativize）。**上游任何工具卡都不缩成文件名**，basename 只出现在产出文件 chips（我们没实现该功能）。
    - **只改收起行，卡片内部路径不动**（已逐类核过上游，见 §4）：读卡横幅 = `relativizeToCwd(meta.path, 工作区根)`（上游 `read-card-model.ts:92` 同，Windows 上 `abbreviateHomePath` 本就是空操作）、差异卡文件头 = 工具给的**原路径**（`DiffBlock.tsx:15` 明确 verbatim）、搜索卡文件路径 = 原样（上游不 relativize）。**上游任何工具卡都不缩成文件名**，basename 只出现在产出文件 chips（我们没实现该功能）。
  - **① leading 二选一**：上游行里只有**一个** leading 位，`leadingFor(state, icon)` 决定放什么——`error` → `StateDot state="error"`（红点）、`stopped` → `StateDot state="warning"`（琥珀点）、**其余（含 running/ok）→ 变体图标**；**行尾没有状态标记**。插件原先「行首恒显图标 + 行尾角标（转圈/⚠/空心圆/ok 无）」是自造结构。
  - **② running 的表示**：上游是**行上的一道掠光带**（`.root[data-state='running'] .row::after` + `dsh-tool-row-sweep 2.6s ease-out infinite`），不是转圈。
  - **③ 无障碍文字**：点与掠光都是 colour-only 对 AT 不可见，上游另配视觉隐藏的 `row.running`/`row.failed`/`row.stopped` 文字（运行中/失败/已停止）供播报。
  - **不做**：换图标集。上游 leading 用内联 SVG（`IconSearchOutline16`/`IconApiOutline14`…），插件全用 codicon；换图标集是**全局**的独立工作（需引图标资源），不属本次。
- [x] **折叠头（外层过程折叠）的计数与触发条件**（【v0.1.7】）：
  - **三项计数**（顺序即上游 `TurnProcessNodeView`）：`{n} 次工具调用` / `{n} 条消息` / `{n} 个 subagent`，分隔 ` · `；**三项全为 0 兜底「已思考」**。`subagentCount` 此前**完全缺失**——宿主按上游口径把 subagent 排除出 `toolCallCount` 却没单独计数，导致纯 subagent 回合显示成「已思考」，且进行中/定稿文案会在「1 次工具调用」与「已思考」间跳。现补：宿主 `src/dsh/stream.ts`（实时）与 `session.ts`（历史）各自统计 → `DshTurnCounts`/`HistoryCounts` → 协议 `TurnCounts` → `components/chain/Chain.ts` 的 `foldLabel`。两项计数**互斥**，合起来是本回合全部工具调用
  - **纯思考也出折叠头**：上游 `foldable` 对「本回合有过程成员」成立，推理行本身即过程成员——所以纯思考**照常出折叠头**并用「已思考」兜底，定稿后思考行收进明细；**不是**平铺。插件 `Chain.ts` 的 `hasFold` 原先漏了 reasoning 分支。**仅当链里只剩提问行**时才平铺（提问不参与过程折叠，`docs/design/10` §2.3）
  - **波及**：`Chain.ts`（`hasFold` + `foldLabel`）、`format.ts`（`write`/`edit` 摘要归类，此前被误归 others 加了 `工具名 · ` 前缀）；文档 `docs/design/10` §1/§2.1、`11-术语表` §3

### 3 Terminal 卡 UI（上游 TerminalBlock 结构复刻，纯 CSS）
- [x] 结构：提示行（**状态点** done绿/ongoing蓝/error红 + cwd 提示标签(promptLabel 简化~) + **命令原文**等宽 pre）→ **状态 Pill**（exitCode/signal 非 0 才显示）→ **复制按钮** → **输出区**（剥 marker 原样）→ 无输出显示 noOutput。
- [x] 输出区：**上限 224px + 纵向内滚**，超宽折行（不横滚）。**不做行折叠**——上游另有 16 行折中段 + 「… 其余 n 行」，本插件不跟（内滚已够查看，不必叠两层）。命令横幅仍固定高度（150 内滚）。【v0.1.7：一度改为「自适应宽高、不限高」，真机看过太长，已改回上限+内滚】
- [x] cwd/description 的摆放与主次按上游：提示行 cwd 标签、展开头行摘要取 description。
- [x] 视觉数值(padding/margin/字号/圆角/gutter/line-height)复刻上游 `TerminalBlock.module.css`/`bash-sample.module.css`，已登记进 `docs/design/08` §5.4。

### 4 其它工具卡
- [x] **web_fetch / web_search**：按上游 WebRow → WebBlock 复刻。fetch 卡 = URL 超链接（**globe 浏览器图标**、无独立协议格）→ `HTTP {statusCode}` 状态**下一行** → 截断；search 卡显示 answer + 序号来源列表 + noResults/截断。数据来自 `tool/result.data.meta`（宿主补齐捕获），无 meta/畸形回退通用卡（输入/输出两分区）。
- [x] **ask_user_question（提问）**：按上游 waterfall 形态——**交互在输入框上方弹窗**（`message/QuestionDialog`：选项/自由输入+回答(选全可提交)/取消/关闭），对话行 ask 行**只做问答记录**（`提问 · {n}/{N} 已回答 / 已取消 / 已中断` + 问题↔回复）；**提问不 fold**（hasFold 排除 ask）。数据=chatQuestion→`store.pendingQuestion` 信号。
- [x] **差异卡 / 读文件卡 / 搜索卡**（【v0.1.7 · dsh 0.1.2-rc.1】）：按上游 `DiffBlock` / `ReadBlock` / `SearchBlock` 逐类复刻三张专属卡，`ToolRow` 分派顺序改为上游瀑布 `提问 → 终端 → 差异 → 读文件 → 搜索 → web → 通用`。数据来源与回退：
  - **差异卡**（`write`/`edit`/`str_replace_editor`）：优先用结果 `meta.diffs`；`write` 在 meta 缺失/空时**回退参数推导的整文件差异**（故 `write` 不依赖 meta，必出卡）；`edit` 依赖 `meta.diffs`，缺失即回退通用卡；`str_replace_editor` 定稿不出卡。模型 `webview/chat/core/diff-card.ts`，组件 `components/chain/DiffCard.ts`
  - **读文件卡**（**只认 `read`**，`read_image`/`readTextFile` 不给——上游同）：行号与内容来自 `meta.{path,totalLines,lines[{number,text}],lang}`；结果文本只用于校验上游的「read 信封」正则（`<path>…</path>\n<type>file</type>\n<content>\n…\n</content>`），正文不进卡。模型 `core/read-card.ts`，组件 `components/chain/ReadCard.ts`
  - **搜索卡**（`grep`/`glob`）：`meta.{shape,truncated,total,files[{path,matches[{lineNumber,line}]}]}` / `meta.paths`；截断时把结果文本作为兜底定位符附在卡下。模型 `core/search-card.ts`，组件 `components/chain/SearchCard.ts`
  - **三张卡共同**：都只在终态 `ok`（差异卡另有 running）出卡，形状不符一律 `null` 回退通用「输入/输出」卡（**零回归**）；**长内容按上游 8 行上限折叠中间**（首尾各半 + 「… 其余 n 行」按钮，共用 `webview/chat/core/fold.ts`）——对话行是摘要面，全量铺开会冲垮消息流，这与上游 `CHAT_*_MAX_LINES = 8` 同口径。**终端卡不在此列**：它的输出为「224px 上限 + 纵向内滚、不折叠行」，见 `08` §5.4
  - **搜索卡两层折叠**（与上游一致）：整体 8 行上限 + **文件头是按钮**，点它收起/展开该文件的匹配
  - 读文件卡的行保留 `white-space: pre` + 横向滚动：代码折行会破坏缩进对齐（差异/搜索卡是折行）
  - **未做**：收起行文件路径可点击打开（需新增 webview→宿主 `openFile` 通道 + `vscode.open`，本次未做，路径为纯文本）；读文件卡的 `~` 家目录缩写（插件无 home 数据）
- [x] **修 `write`/`edit` 摘要归类**：`deriveToolSummary` 原按 `isCmd/isRead/isSearch/others` 分支，`write`/`edit` 落进 others 被加了 `工具名 · ` 前缀；上游它们是独立变体（`SUMMARY_KEYS` = `['path','file_path']`，**不带前缀**），已补 `isWrite` 分支。
- [ ] 关联观察：上游 **search/read 完成行**在收起行**标题前有绿色状态点**（StateDot done），bash 行收起行**无**（点在卡内）。当前收起行 ok 一律无角标（沿用“成功不打勾”既定规则）。**本条并入 §2 的 ① 一起裁决**：上游 `leadingFor` 对 `ok`/`running` 返回的是**变体图标**（不是绿点），绿点只在个别卡里出现——做 ① 时按上游源码定，不按截图猜。

### 5 验收
- [x] 编译：`tsc --noEmit`(src)、`tsc --noEmit -p webview/chat`、`node scripts/build-chat.mjs`、`node esbuild.js` 全绿。
- [ ] 真机 F5：发多工具指令（含 Pwsh + web_fetch + web_search），看 Terminal 卡（命令原文/输出/退出码 Pill/复制/输出上限224px+内滚）、其余工具走通用卡（输入/输出两分区）；深浅主题、窄栏(editor tab)走查。
- [ ] **行状态五类走查**（§2 的行状态标记做完后）：各跑一次并核对收起行——① 正常 ok（行首显变体图标，摘要 = 描述）；② running（行上掠光带）；③ **非零退出的 shell**（应整行红：④ 覆盖生效；摘要**仍是描述**——⑤ 只对 isError 生效）；④ 真失败（红点；摘要位换成**结果文本首行**并按错误色显示，**不显示裸错误码**）；⑤ 被打断 stopped（琥珀点）。另核对无障碍：读屏能播报 运行中/失败/已停止。
- [ ] 对照上游截图逐点核对：Pwsh 卡状态点 done、命令等宽、输出区、`复制`按钮；网页搜索卡。

## 约束提醒（写死）
- 中文/标签/文案：一律用上游字典原文；工具字段值：原样透传展示。
- 我不“发明”样式与文案；没有上游依据的视觉点先列出来问，不落地。

## 更新记录

| 日期时间 | 插件版本 | 变更 | 维护者 |
|---|---|---|---|
| 2026-09-10 | 0.1.7 | §1 第 1 条「输出文本已透传」此前名不副实：宿主只取 `text` 块，结构化结果被丢弃；已按 `resultText()` 补齐（非 text 块序列化为 pretty JSON），宿主新增 `src/dsh/official/result-text.ts`。类型名 `ChainItem` 改称 `DshTurnProcessItem`。见 `11-术语表` | 插件维护者 |
| 2026-09-10 | 0.1.7 | **更正上一条**：仅改 `resultText` 不够且会把包装块序列化成 JSON（表现为「展开只有一段 JSON」）。真正的两个错误是**读错载荷层级**——内容在 `message.content[0].content`、配对 id 在 `message.source.callId`（顶层无 `callId`，导致 `toolDone` 与工具行配不上、输出永远落不进去）。现新增 `readToolResult()` 解包（兼容旧格式），§2 标题改用通用标题「工具调用」，§4 通用卡展开体改为 ioCard 的「输入/输出」两分区 | 插件维护者 |
| 2026-09-10 | 0.1.7 | §2 新增「行状态标记与错误语义」条目：五处改动点（①leading 二选一 ②running 掠光带 ③读屏文字 ④shell 失败整行覆盖 ⑤失败行摘要=结果首行）**逐点列出对应文件**。分两批实现，已全部落地（纯 webview 侧改动，不动宿主与协议）。§4 的「关联观察（绿点）」并入 ① 一并裁决；§5 新增五类行走查清单 | 插件维护者 |
| 2026-09-10 | 0.1.7 | §4 新增 read/diff/search 三张专属卡（数据来源 meta + 回退条件 + 三卡 8 行折叠 + 搜索卡文件组折叠），并修 `write`/`edit` 摘要被误加前缀的归类问题 | 插件维护者 |
| 2026-09-10 | 0.1.7 | **终端卡内状态点/文案改为取 `TermCard.state`**（= 工具行 rowState，值同源）：修「调用真失败（isError，无退出码）时卡内显示『已完成 + 绿点』、与行上红点矛盾」；顺带补 `stopped` 态（已停止 + 琥珀点，`TermCard`/`terminalLabels.stopped` 取上游 `row.stopped` 原文、`.term-dot[data-state='warning']` 复用行首点的 charts-yellow）。**退出状态类（非零退出/信号）显示不变**：仍为行/卡标红 + 退出码 Pill + 输出区原样显示模型返回的文本。§2 ④ 同步改写 | 插件维护者 |
| 2026-09-10 | 0.1.7 | **修「工作区内的文件却显示整条绝对路径」**：`currentWorkspacePath()` 此前把工作区根**归一化**（小写 + 正斜杠）后当 `chatInfo.cwd` 发给 webview，而这个值在 webview 是**显示用的相对根**——工具给的 `C:\...` 与它对不上前缀，`relativizeToCwd` 静默失效。改为**原样返回作者写法**（只去尾部分隔符），并给 `relativizeToCwd` 加 Windows 路径的**大小写/分隔符容忍比较**（`samePath`；POSIX 维持严格）。影响面：收起行摘要、读卡横幅、终端卡 cwd 标签。见 §1「cwd 完整解析」两条子项 | 插件维护者 |
| 2026-09-10 | 0.1.7 | §2 新增 ⑥：文件类工具收起摘要 = **相对工作区根**的路径，**跟上游**（工作区外显示全路径）。**同日曾改成「只显文件名」并已回退**——回退理由与上游出处写在 §2 ⑥ 下；`core/terminal.ts` 的 `fileNameOf()`、`ToolRow` 的 `FILE_PATH_TOOLS` 随之删除。另：`stripAnsi` 补剥 **OSC 与其它非 CSI 转义**（上游 `ansi.ts:73-84` 的覆盖面）——此前只剥 CSI，pwsh 提示符写的 OSC 133（`ESC ] 133;D;N BEL`）会以 `]133;D;0` 残留在输出里、把不折行的行撑宽 | 插件维护者 |
| 2026-09-10 | 0.1.7 | **§2 ⑤ 撤销偏离、回到上游口径**：失败行（只认 `item.status === 'error'`，即 isError）收起摘要 = **结果文本首行**并以错误色显示（上游 `failureLine ?? description ?? summary`；新增 `format.ts resultFirstLine`、`styles/chain.css .chain-row-preview.is-error`）。**非零退出/被信号终止那类不变**（`isError: false` → 摘要仍是模型写的 `description`）。原偏离理由是拿「退出码 1 的 pwsh（`OS:()` 顶掉描述）」当反例，但那类上游本来就不取代——两类混同才让**真失败行看不到模型返回的内容**（本轮用户指出「pwsh 标题那里」）。 | 插件维护者 |
| 2026-09-10 | 0.1.7 | §2 新增「折叠头计数与触发条件」：补 `subagentCount`（三项计数互斥，全 0 兜底「已思考」）；`hasFold` 计入 reasoning（**纯思考也出折叠头**，此前误做成平铺）。触及 `Chain.ts`/`format.ts` 与 `10`/`11` 号文档 | 插件维护者 |
| 2026-09-10 | 0.1.7 | §4 **字段级样式修正**（此前只登记了容器、漏了字段）：`.is-del`/`.is-add` 符号与**整行正文同时着色**；`.read-banner`/`.search-header` 补独立底色 + 顶部圆角；三卡行改回 `white-space: pre` 不折行 + body 横滚；字段字号分化（`.count`/`.copyButton`/`.summary` 13px，`.label`/`.lang` 12px/18px）。详见 `docs/design/08` §5.4b 与其中的更新记录 | 插件维护者 |
| 2026-09-10 | 0.1.7 | §3 终端卡输出体：一度改为「自适应宽高、不限高」，真机看过太长，**改回 `max-height 224` + 纵向内滚**；仍不做行折叠。另 §2 行首状态点按上游 `StateDot` 改为**两层结构**（halo opacity .1 + inset 20% 实心内核）并补 `warning` 态 | 插件维护者 |
