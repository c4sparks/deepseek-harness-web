# docs/design · 设计文档

> 说明：本目录记录设计结论与要点，保持自包含。
> 规则：禁止本机绝对路径；UTF-8 无 BOM；成对信息用表格；不用装饰符号。

## 文档地图
| 文档 | 阶段 | 维护触发 |
|---|---|---|
| [00-工程流程与规范](00-工程流程与规范.md) | 总则 | 改任何文档 |
| [01-产品需求与功能](01-产品需求与功能.md) | 需求 | 加功能/改配置 |
| [02-架构设计与动态识别](02-架构设计与动态识别.md) | 设计 | 改结构/连接受 |
| [03-界面交互与用户手册](03-界面交互与用户手册.md) | 交互 | 改 UI |
| [04-dsh协议耦合与升级](04-dsh协议耦合与升级.md) | 协议 | dsh 升级 |
| [05-测试发布与工程](05-测试发布与工程.md) | 发布 | 发版/迭代 |
| [07-对话区组件划分与状态体系](07-对话区组件划分与状态体系.md) | 设计 | 改前端结构 / 加行类型 / 状态 |
| [08-像素级UI规格](08-像素级UI规格.md) | 设计 | 改样式 / 调间距字号圆角 |
| [09-工具卡ToolCard对齐实现清单](09-工具卡ToolCard对齐实现清单.md) | 设计 | 工具展开卡(Terminal等)对齐官方（待办清单） |
| [10-对话区信息块显示模型与规则](10-对话区信息块显示模型与规则.md) | 设计 | 信息块「在哪/何时/如何显示」唯一基准（改前必读）；过程折叠/进行中-定稿/瀑布流交互/动作条时机 |

代码结构简览：`src/extension.ts`（装配）、`src/dshPanel.ts`（官方网页 UI）、`src/api/dshService.ts`（dsh 编排）、`src/dsh/`（协议层，api.ts+index.ts 门面）。

## 更新记录

### 0.1.0（2026-08-30）
- 新增：初始版本

### 0.1.2（2026-09-03）
- 修改：更新

### 0.1.3（2026-09-05）
- 修改：版本基线升至 0.1.3

### 0.1.4（2026-09-05）
- 修改：移除头部版本基线，版本信息以正文行内标注 + 更新记录维护

### 0.1.5（2026-09-06）
- 修改：UI更新；标题栏双实现（原生 view/title / 页内自绘 `#titlebar`，`TITLEBAR_MODE` 默认 `nativeTitle`、不猜宿主），后续看sidex的兼容情况；

### next（2026-09-09）
- 修改：对话区 UI 组件化 + 官方过程折叠对齐：消息行按类型拆 `components/message|chain`；assistant 行改扁平 chain（思考/工具交错）；`core/states` 状态体系接线（生成态/工具状态点/Spinner 动词/过渡 busy）；CSS 模块化起步（`styles/chain.css`/`state.css`，`chat.css` 入口 @import）。详细实现记录见 `docs/details/upgrade/09`，组件/状态结构见本文档 07。
- 修改：上下文注入/plan-mode 行对齐官方 `ContextInjectionRow`：宿主捕获非用户 source 的 `user/message`（系统提示词/技能/召回）→ `ChatRow.kind:'context'` → `message/ContextInjectionRow.ts` 渲染（收起行 + 按 form 展开）；文案照官方字典（`message.context*`）。记录见 `docs/details/upgrade/09` §5.2。
- 修改：对齐剩余工具卡——web_fetch/web_search 按官方 WebRow→WebBlock 复刻（`HTTP {statusCode}` 状态最左 + 协议 + URL 超链接 / answer + 来源列表，数据来自 `tool/result.data.meta`，宿主补齐捕获）；ask_user_question 合并成官方「提问」行（待答交互 + 已答/已取消/已中断 摘要 + 问答记录），删独立「需要你确认」卡。记录见 `docs/details/upgrade/09` §5.3。
- 修改：会话级「系统提示词」左上角常驻入口（`message/SystemPromptEntry.ts`，数据=宿主 `getSystemPrompt` 取当前会话 agent-instructions）；system prompt 不再逐轮重复进 assistant 链（Chain.ts 过滤 instructions form），链里只留技能/召回等其它注入。记录见 `docs/details/upgrade/09` §5.2 后注。
- 修改：会话名/工作区归属对齐 0.1.2-rc.1 —— durable title 读官方列表 item 顶层 `title` 字段（`dshService.durableTitleOf`，原读 `projections.values.title` 读不到）；`findReusableBlank` 不再跨工作区复用当前空白会话，修复切工作区/新建后会话归错工作区。记录见 `docs/details/upgrade/07` §9。

### next（2026-09-10）
- 修改：会话归属硬约束，杜绝「未分组」—— `newSession()` 不再以无参 `createSession({})` 回退；取不到工作区（无 dsh 工作区且无当前文件夹）抛 `DshNoWorkspaceError`，交互入口（＋新会话/发消息/切模型模式权限/斜杠）提示选工作区并弹工作区面板，`listModels()` 不再为列模型强建会话。另删死代码 `stream.ts` 的 `ask()`（裸 `createSession()`）。记录：`docs/design/01` F4/字段要点、`02` 关键设计点、`03` 用户手册第 14 条。
