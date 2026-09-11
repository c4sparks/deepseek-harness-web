# 04 · dsh 协议耦合与升级

> 阶段：开发/耦合 · 维护者：插件维护者
> 代码事实源：`src/dsh/`（auth/rpc/mux/session/stream/legacy/events/webProxy；api.ts 与 index.ts 为门面）、`src/api/dshService.ts`；上层统一经 `src/dsh/` 门面引用。

## 三层耦合（升级影响）
| 层 | 依赖 | 升级影响 |
|---|---|---|
| 页面面(apps/web/React) | 不依赖（自绘聊天不碰） | 零 |
| 协议面(信封/方法/事件/WS/端口/鉴权) | 唯一依赖，集中 `src/dsh/` | 改 dsh/ 对应子模块 |
| 数据面(投影字段/usage) | 读取字段名 | 改投影渲染 |

## 传输与信封
- 普通调用 `POST http://127.0.0.1:PORT/api/<namespace/method>`；流式 remote 走 `WS /api/remote.mux`（open/item/error/end）；`Content-Type: application/json`。
- 请求：`{"type":"client-request","rpcId":"<uuid>","method":"session/prompt","payload":{"args":{...}}}`。
- 响应：`{"type":"server-response","rpcId":"<uuid>","result":{"ok":true,"value":{...}}}`；失败 `ok=false` + `error{code,message,details}`。
- 鉴权：`?token=` 登录拿 `dsh-auth-*` cookie（HttpOnly + SameSite=Strict）；仅回环不放行。
  内嵌面板不能直接 iframe `/?token=`（Webview 无法携带 cookie），插件在扩展进程起本地认证代理
  `dsh/webProxy.ts`：只监听 127.0.0.1，转发 HTTP/WS 时替上游附加 cookie；外部浏览器用 authUrl 直开。
- 文件流下载（rc.1 `/export` 会话日志 ZIP）：`GET /api/session.export?sessionId=…&includeDescendants=true`，非信封直连，宿主经 `src/dsh/sessionExport.ts` 取回 → 保存对话框写文件。

## 方法契约（斜杠 + args，点号 404）
> 命名约定（详见 00 §4.3）：导出函数名不携带 dsh 版本前缀；方法适配的版本与上游接口写在其 JSDoc。

| wire 方法 | args 形参 | 插件使用 | 备注 |
|---|---|---|---|
| session/list | _request | 探测 | |
| session/create · session/prompt | request | createSession / 发消息(queue) | |
| session/rename · session/cancel | request | 改名 / 停止 | |
| session/selectModel · session/modelCatalog | request / {} | 选模型 / 列模型 | 切模型带该模型 `reasoning.defaultEffort`；无则**不带** effort（上游按提供方默认解析，UI 显示 `Default`）。不传时投影 `modelSelection.next` 也没有该字段（上游 `pending` 原样存提交值） |
| session/page · session/follow | request | 分页冷读 / 热流订阅 | rc1 无 session.history |
| workspace/create · workspace/follow | request | 建工作区 / 枚举 | follow 走 mux |
| commands/execute | {agentId,line,images} | 斜杠命令(/permission) | 点号 404 |
| commands/list | {agentId} | `/` 指令目录 | 与 commands/execute 同 args 信封 |
| skills/list | {request:{sessionId}} | `/` 技能目录 | **args 不接受 agentId**（描述符拒，实测 `unexpected "agentId"`）；只放 `{request:{sessionId}}`。勿用旧 `skill.list`（点号不存在）【2026-09-08 实测修正】 |
| fileReferences/list | {agentId,query} | `@` 文件/目录候选 | 返回 `{path,kind}`，path 为工作区相对 |
| sessionReferenceResolver/candidates | {agentId,query} | `@` 会话候选 | 条目含 `mention`=应插入正文的 token【2026-09-08】 |
| agentPresets/list · agentPresets/select | {} / {agentId,agentPreset} | 列 agent 模式 / 空白会话切换模式【v0.1.4 · dsh 0.1.2-rc.1 新增】 | 已开始会话切换会被拒绝 |
| $events（流） | 空 args | 审批/提问等 Remote Event 下发 | open 走 /api/remote.mux |
| $events/result | {clientId,eventId,outcome} | 本地应答审批/提问 | outcome 形状见下节 |

## Remote Event 交互流（rc.1）
旧 `/api/respond` 已移除。rc.1 的审批/提问经逻辑流 `$events`（同一 `/api/remote.mux`）投递：
- open：`$events`，payload `{ args: {} }`。
- ready：`{ type:"ready", clientId, host }`，clientId 是本次流的应答身份。
- waterfall：`{ type:"waterfall", event:"approval/request"|"user-questions/request", eventId, agentId, request }`。
- cancel：`{ type:"cancel", eventId }`，宿主侧已结束该等待。
- 应答：unary `$events/result`，payload `{ args:{ clientId, eventId, outcome } }`；
  outcome 为 `{ kind:"next" }`、`{ kind:"result", value }` 或 `{ kind:"rejected", error }`。
- 审批 value：`"allowed-once" | "rejected"`；提问 value：`{ answers:[{id,selected[],custom?}] }`；
  提问取消以 `UserQuestionError` / `ASK_CANCELLED` rejected 表达。

`src/dsh/events.ts` 维护这条可重连流并按会话投递；聊天层应答后由它回传结果。上游页面同样实现该链路，二者谁先应答即生效，重复结果在服务端幂等。

## 事件 / usage / 错误码
事件（`DSH_EVENT_TYPES`）：user/message、assistant/message(+usage)、assistant/chunk(text-delta/reasoning-delta/finish)、step/start·end、tool/call·result、turn/start·end、request/header·context。

**`tool/result` 载荷层级**（【v0.1.7 · dsh 0.1.2-rc.1】查明并修正，此前读错导致工具输出为空）：
| 要取的东西 | 位置 | 说明 |
|---|---|---|
| 展示内容 | `data.message.content[0].content` | `content[0]` 是 `tool-result` 包装块（含 `toolCallId`/`isError`），真正的 `ContentBlock[]` 在**它的** `content` 里。读 `data.message.content` 顶层拿到的是包装块本身 |
| 配对 id | `data.message.source.callId` | **顶层没有 `callId`**。读 `data.callId` 恒取到 undefined，`toolDone` 与工具行配不上，输出永远落不进去 |
| 失败标记 | `data.message.content[0].isError`、`data.error{name,code}` | |
| 卡片数据 | `data.meta` | web 卡的 statusCode/sources/answer/truncated 等 |
| 历史遗留格式 | 顶层 `callId` + 扁平 `content` | 迁移前的老格式，解包器仍兼容 |

解包统一走 `src/dsh/official/result-text.ts` 的 `readToolResult()`（两种格式都认），展平走同文件的 `resultText()`；`stream.ts`（实时）与 `session.ts`（历史）共用。

usage：uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens[/totalTokens]（原样透传、缺失不补 0）。
投影 fields：sessionStats/tokenUsage/permissions/modelSelection/agentPreset（v0.1.4 新增）/title/goal/todos。
错误码：arguments-invalid 查参数名；internal 重试/看日志；401/403 需鉴权；404 换斜杠；非 JSON=端口非 dsh。

## 插件功能 ↔ dsh 对接
F1 聊天(session/prompt+follow+事件)、F2 模型(modelCatalog/selectModel)、F3 权限(permissions+commands/execute)、F4 工作区(workspace/follow+session)、F5 右键(共享会话)、F6 消费记录(usage)、F7 网页(内嵌=dsh/webProxy 同源地址；外部浏览器=authUrl)、F8 启动(dsh CLI/probe)、F9 会话模式(agentPresets/list+select，v0.1.4 · dsh 0.1.2-rc.1)、审批提问($events 流 + $events/result 聊天内应答)。升级时按此定位改 dsh/ 与投影。
- F10 输入触发：`/` 菜单 = `commands/list`（指令）+ `skills/list`（技能，payload 仅 request）；`@` 引用 = `fileReferences/list`（文件/目录）+ `sessionReferenceResolver/candidates`（会话，条目带 mention）；`/export` 真实下载 = GET `/api/session.export`。【2026-09-08】

## 升级 dsh / 插件
1. 隔离 `DSH_HOME` + `dsh web --no-open --port 0` + `?token=` 登录。
2. 逐端点实测刷新上表与事件/字段。
3. 全命中无需动插件；漂移则把对应项记入"上游适配追踪表"（见下方）并排期。

## 上游适配追踪表（dsh 每次变更 = 一条跟随需求）
状态机：待评估 →(无动作) 或 (待做 → 进行中 → 已完成 → 已随版本发布)；终态后不改行。
| dsh 版本 | 变更点 | 插件影响面 | 派生需求 | 优先级 | 状态 | 随插件版本 | 备注 |
|---|---|---|---|---|---|---|---|
| alpha.3→rc.1 | 斜杠+args；history→page+follow；workspace.list→follow；respond→$events；需 cookie | dsh/；dshService | F1/F3/F4 | 高 | 已随版本发布 | 0.1.2 | rc1 适配历史 |

## 历史协议差异（alpha.3 及更早，仅参考）
当前代码只按 rc.1 实现，不再同时兼容旧世代；需要旧版 dsh 时请使用当时配套的旧插件包。
| 项 | alpha.3 及更早 | rc.1 当前 |
|---|---|---|
| RPC 路径 | 点号（session.list） | 斜杠（session/list） |
| 载荷 | 平铺 payload | `{ args:{...} }` |
| 会话历史 | session.history | session/page + session/follow |
| 工作区 | workspace.list | workspace/follow |
| 事件载体 | /api/events.mux | /api/remote.mux |
| 审批/提问应答 | /api/respond | $events + $events/result |
| 鉴权 | 回环直连 | `?token=` → `dsh-auth-*` cookie |

落地：建议抽 `scripts/dsh-contracts.json` + `check-coupling.mjs` 契约断言（当前人工核对）；关键契约变化纳入 CI。

## 已知限制 / 后续
待办/增强统一在待办清单维护，不在此文档列出。

## 更新记录

### 0.1.0（2026-08-30）
- 新增：
  - 初始版本

### 0.1.2（2026-09-03）
- 新增：
  - dsh 协议耦合与升级文档
- 修改：
  - 鉴权说明：`?token=` 换取 HttpOnly + SameSite=Strict cookie，内嵌页经 `dsh/webProxy.ts` 认证代理转发
  - F7 映射为内嵌代理同源地址 / 外部浏览器 authUrl
  - 方法契约处补充命名约定引用（导出函数不携带 dsh 版本前缀）
  - 新增 Remote Event 交互流章节（$events / $events/result）
  - 历史协议差异单独成章，与 rc.1 当前契约分开
  - 代码事实源与路径改为 `src/dsh/`（api/events/webProxy + index 门面）
  - `src/dsh/` 进一步细拆为 auth/rpc/mux/session/stream/legacy

### 0.1.3（2026-09-05）
- 修改：
  - 无 dsh 协议契约变化；本轮只涉及 UI 会话投递与命名策略（协议层沿用 0.1.2-rc.1）

### 0.1.4（2026-09-05）
- 新增：
  - 对接 `agentPresets/list`、`agentPresets/select`；投影字段补 `agentPreset`

### next（2026-09-11）
- 修改：
  - `session/selectModel` 备注修正（原写「切模型不带 effort」，不准）：切模型带该模型 `reasoning.defaultEffort`；无则**不带** effort，由上游按提供方默认解析，UI 显示 `Default`
  - 补记上游投影机制：`modelSelection.next = pending ?? lastUsed`，而 `pending` **原样存客户端提交的 selection**（`model-selection-projection.ts:65`）——所以不传 effort 时投影 `next` 也没有该字段，UI 读不到「上游实际解析出的等级」，要等下次请求后 `lastUsed`（来自 `request/header`）才有
