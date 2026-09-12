# 04 · dsh 协议耦合与升级

> 阶段：开发/耦合 · 维护者：插件维护者
> 代码事实源：`src/dsh/`（协议层，认证、RPC、mux、会话、流、事件、网页代理等子模块与门面均在此目录内）、`src/api/dshService.ts`；上层统一经 `src/dsh/` 门面引用。

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
  内嵌面板不能直接 iframe `/?token=`（Webview 无法携带 cookie），插件在扩展进程起本地认证代理（`src/dsh/`）：只监听 127.0.0.1，转发 HTTP/WS 时替上游附加 cookie；外部浏览器用 authUrl 直开。
- 文件流下载（rc.1 `/export` 会话日志 ZIP）：`GET /api/session.export?sessionId=…&includeDescendants=true`，非信封直连；宿主在 `src/dsh/` 的会话导出模块取回后经保存对话框写文件。

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

客户端与官方页面同时接管这条可重连流，二者谁先应答即生效，重复结果在服务端幂等。

## 事件 / usage / 错误码
事件（`DSH_EVENT_TYPES`）：user/message、assistant/message(+usage)、step/start·end、tool/call·result、turn/start·end、request/header·context。

**助手流式增量的载体**【v0.1.9 · dsh 0.1.5-rc.2】上游 `feat(session)!: embed assistant streams` 把增量从独立事件挪走，实时与历史各换一处；插件改动落在 `src/dsh/` 的流式与会话处理：
| 场景 | 0.1.2-rc.1 | 0.1.5-rc.2 | 插件读法 |
|---|---|---|---|
| 实时增量 | 事件 `assistant/chunk`（`data.chunk`） | **帧** `{ type:'assistant-stream', frame }`，`frame.type` 为 start/chunk/end，增量在 `frame.chunk` | 改为按帧解析 |
| 同上（开关） | 无需开关 | `session/follow` 请求**必须**带 `assistantStream: true`；不带则服务端一帧都不下发 | 两处 follow 请求（实时与快照）都带 |
| 历史增量 | 持久事件 `assistant/chunk`，加 `{ type:'chunks' }` packing 行（带 `seq0`） | 内嵌进结算事件 `assistant/message` / `assistant/attempt` 的 `data.stream`（**无 `seq0`**） | 历史展开后归一为内部标签 `assistant/chunk` |

- `assistant/chunk` 在 0.1.2-rc.1 是 wire 事件、0.1.5 起已不是（故上面的事件清单不含它），但插件内部仍把它当**统一标签**用（历史展开后合成，供计时统计与文本累加共用）。若照旧读作 wire 事件名，会误判为无需改动，表现为「不流式，整段出现」。
- `assistant/live-chunk` 是上游 **TypeScript 客户端的内存表示**（定义处注释写明 Client-only），**wire 上没有这个事件**，不要照它改。
- 会话日志格式 v0 升至 v3 属 identity 迁移（只改 header 的 version），事件信封不变，插件不受影响。
- 已知缺口【v0.1.9】：打开一个正在生成的会话时，快照基线里已生成但未结算的助手增量不会回放，从接入时刻起续上。影响面仅限「打开时恰在流式」这一场景，待真机验证后决定是否补。

**`tool/result` 载荷层级**（【v0.1.7 · dsh 0.1.2-rc.1】查明并修正，此前读错导致工具输出为空）：
| 要取的东西 | 位置 | 说明 |
|---|---|---|
| 展示内容 | `data.message.content[0].content` | `content[0]` 是 `tool-result` 包装块（含 `toolCallId`/`isError`），真正的 `ContentBlock[]` 在**它的** `content` 里。读 `data.message.content` 顶层拿到的是包装块本身 |
| 配对 id | `data.message.source.callId` | **顶层没有 `callId`**。读 `data.callId` 恒取到 undefined，`toolDone` 与工具行配不上，输出永远落不进去 |
| 失败标记 | `data.message.content[0].isError`、`data.error{name,code}` | |
| 卡片数据 | `data.meta` | web 卡的 statusCode/sources/answer/truncated 等 |
| 历史遗留格式 | 顶层 `callId` + 扁平 `content` | 迁移前的老格式，解包器仍兼容 |

usage：uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens[/totalTokens]（原样透传、缺失不补 0）。
投影 fields：sessionStats/tokenUsage/permissions/modelSelection/agentPreset（v0.1.4 新增）/title/goal/todos。
错误码：arguments-invalid 查参数名；internal 重试/看日志；401/403 需鉴权；404 换斜杠；非 JSON=端口非 dsh。

## 插件功能 ↔ dsh 对接
F1 聊天(session/prompt+follow+事件)、F2 模型(modelCatalog/selectModel)、F3 权限(permissions+commands/execute)、F4 工作区(workspace/follow+session)、F5 右键(共享会话)、F6 消费记录(usage)、F7 网页(内嵌=本地认证代理同源地址；外部浏览器=authUrl)、F8 启动(dsh CLI/probe)、F9 会话模式(agentPresets/list+select，v0.1.4 · dsh 0.1.2-rc.1)、审批提问($events 流 + $events/result 聊天内应答)。升级时按此定位改 dsh/ 与投影。
- F10 输入触发：`/` 菜单 = `commands/list`（指令）+ `skills/list`（技能，payload 仅 request）；`@` 引用 = `fileReferences/list`（文件/目录）+ `sessionReferenceResolver/candidates`（会话，条目带 mention）；`/export` 真实下载 = GET `/api/session.export`。【2026-09-08】

## 升级 dsh / 插件
1. 隔离 `DSH_HOME` + `dsh web --no-open --port 0` + `?token=` 登录。
2. 逐端点实测刷新上表与事件/字段。
3. 全命中无需动插件；漂移则把对应项记为一条跟随需求并排期。跟随需求状态机：待评估，需动作则待做、进行中、已完成、已随版本发布；终态后不改行。

## 已知限制 / 后续
待办/增强统一在待办清单维护，不在此文档列出。

## 更新记录

### 0.1.0（2026-08-30）
- 新增：初始版本

### 0.1.2（2026-09-03）
- 新增：dsh 协议耦合与升级文档（含鉴权代理与 Remote Event 交互流章节）

### 0.1.3（2026-09-05）
- 修改：无 dsh 协议契约变化，协议层沿用 0.1.2-rc.1

### 0.1.4（2026-09-05）
- 新增：对接 `agentPresets/list`、`agentPresets/select`；投影字段补 `agentPreset`

### next（2026-09-11）
- 修改：修正 `session/selectModel` 备注，并补记上游投影机制

### 0.1.9（2026-09-12）
- 新增：事件章节补「助手流式增量的载体」表；上游适配追踪表补增量载体变更一行
- 修改：事件清单删去已非 wire 事件的 `assistant/chunk`；基线由 `0.1.2-rc.1` 上移至 `0.1.5-rc.2`
