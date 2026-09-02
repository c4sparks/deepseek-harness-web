# Change Log

All notable changes to the "deepseek-harness-web" extension will be documented in this file.


## [0.1.1] - 2026-09-03

### 新增

- **通用弹窗组件**（`webview/chat/modal.ts` + `.modal/.btn`）：后续确认/提示弹层统一复用，支持图标(warn/info)、主/危险按钮、风险勾选 `ack`、Esc/遮罩关闭、`prefers-reduced-motion` 降级。
- **危险权限自绘确认**：切 `danger-full-access` 走聊天内自绘弹窗（仿 dsh 中文文案 +「我已了解风险」勾选 +「启用」），不再弹 VS Code 原生框。
- **工作区面板树形化**：每个工作区一行带 ▶/▼ 折叠图标，展开后其下缩进列出该工作区会话（点会话恢复历史），并提供「在此工作区新开会话」；行只显示最后一级路径名。
- **消费记录增强**：usage 按 dsh 返回**原样透传**（含 cacheWrite/totalTokens，缺失显示 `—` 不补 0）；按 今天/昨天/本周/上周/上个月/更早 **自然分组且可折叠**，每组标题带本组汇总；汇总大数缩写（K/M）；顶部注明统计范围。
- **ready 握手**：webview 就绪后扩展才推 `chatInfo`，视图重建/切回不再丢失权限/模型/统计。

### 变更

- 适配 sidex：`engines.vscode` → `^1.110.0`，`@types/vscode` 固定 `1.110.0`。
- 当前工作区改为**读 dsh 持久化数据**（`workspace.list` 的 `updatedAt` 最新，同 `workspace.json`），不再另存、不再被文件夹强制覆盖。
- 权限预设**直列 dsh 返回的英文预设**（去掉本地中文映射与弹层标题）；权限切换改走 **`commands/execute`（斜杠 + `args{agentId,line,images}`）** 执行 `/permission <preset>`（勿用 `session.prompt` 文本）。
- **切模型与切推理等级解耦**：点模型只发 `provider+model`（不带 effort），effort 仅在支持它的模型上单独选；标签完整显示「模型 · 推理等级」（窄面板单行省略、图标固定）。
- `postChatInfo` 先列模型（确保会话）再读投影，首次打开权限不再为空。
- 卸载/停用清理加固：deactivate/dispose 先关本插件 Webview。

### 修复

- 权限命令端点 404（点号 `commands.execute` → 斜杠 `commands/execute`）。
- 切到不支持推理等级的模型报 `does not support reasoning effort`。
- 窄面板下输入行右侧按钮（权限/模型/↑）被挤没。

## [0.1.0] - 2026-09-01

首个正式版本。

### 新增

- **轻量级部分功能支持**：以原生 dsh RPC 集成为主（侧边栏聊天、选中代码处理、文件引用、消费记录），dsh 官方网页可选项开；进程自动拉取与管理。
- **侧边栏聊天面板**
  - 流式输出（打字机效果）
  - 实时显示思考过程与工具活动（步骤 / 工具名）
  - 审批处理（agent 需要授权时显示「允许 / 拒绝」）
  - 文件引用（＋ 按钮 / 拖拽文件 → 附件，随消息发送）
  - 右键把选中代码 @ 进输入框
  - 复制 / 重新生成
  - 底部常驻累计 token 用量
- **消费记录**：每次对话 token 用量持久化存储，「查看消费记录」报告面板展示总览与明细。
- **视图标题栏**：查看模式切换（本地 / 浏览器）、刷新（本地网页打开时显示）、新会话、关闭侧边栏、移动到编辑器。
- **分层架构**：`api/dshApi`（RPC 传输）、`api/dshService`（服务层，UI 唯一依赖）、`ui`（聊天 UI 可替换）。

### 修复

- webview 模块脚本因 `crossorigin` 导致 CORS 加载失败。
- 流式输出取消后残留旧输出。
- `acquireVsCodeApi` 重复调用报错。
- 多面板重复创建。
