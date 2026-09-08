# docs/design/06 · 可复用 Chat 组件化边界

> 目标：把 `webview/chat` 从“VS Code webview + dsh 协议的应用切片”抽出为可交给其它项目使用的标准 chat 组件。
> 本文件只做设计与边界定义，不改行为。阶段与验收见 §7。

## 1 目标与非目标

目标：
- 公开组件 API，可作“受控 / 非受控”组件被其它项目嵌入。
- 宿主无关：不依赖 VS Code webview / dsh 协议。
- 样式可主题、作用域化、可发布（ESM + CSS + 类型）。
- 支持 i18n，基础 a11y。

非目标：
- 不把 dsh 产品逻辑（斜杠、权限、模式、消费）做进核心。
- 富文本内联 chip、虚拟滚动、长会话优化列为独立演进项（Stage3），本文件不展开其实现。
- 本阶段不改 UI 行为。

## 2 现状盘点

结构（现状事实）：
- UI：`webview/chat/components/*.tsx`（htm/preact），组件只读 `createChatStore(host)` 的信号。
- 状态：`webview/chat/core/store/chat.ts`（信号 store）。
- 协议：`webview/chat/core/protocol.ts`（页面与宿主 postMessage 的消息类型单一来源）。
- 触发：`webview/chat/core/trigger/`（useTrigger 骨架 + slash + at）。
- 样式：`webview/chat/styles/chat.css`，全局类 + `--vscode-*` 主题变量 + 固定 DOM id + codicon。

耦合点（作组件库时的障碍）：
- 页面入口 `webview/chat/chat.ts` 调 `acquireVsCodeApi`（VS Code 专有）。
- 协议消息与 dsh 功能强耦合（slashCatalog / atCatalog / slashRun / export…）。
- 消息文本内含 dsh 语义 token（`@rel/path`、`@[label](dsh-session:…)`），UI 直接当字符串展示。
- 样式依赖 VS Code 主题变量与 codicon 字体资源。

## 3 目标公共 API（草案）

### 3.1 受控组件形态
```
<ChatView
  messages={Message[]}      // 中立会话消息
  busy={boolean}
  features={FeatureFlags}   // 需要的能力位（如 references）
  theme="light | dark"
  locale="zh-CN"
  onSend={(parts) => void}  // 文本 + 结构化引用
  onCancel / onCopy / onRegenerate / onPickFile
/>
```
- 缺省提供一个内存 `ChatClient`，脱离宿主也能跑/预览/测试。
- 需更强控制时可用 `useChat()`（headless）驱动组件，组件本身只做渲染。

### 3.2 中立消息 schema
```
Message { id, role: 'user' | 'assistant', blocks: Block[], meta? }
Block   = TextBlock | FileRefBlock | SessionRefBlock | ImageBlock | NoticeBlock
```
- 文件/会话引用是结构化 Block（含 label、相对路径/sessionId、mention token 由 adapter 生成），
  渲染层决定 chip / 高亮 / 气泡样式，UI 不再认知 dsh token 字符串。
- 历史恢复、用量/用时等 dsh 专属数据走 `meta`/扩展字段，不进核心模型。

### 3.3 输入触发器（/ 与 @）
- 作为可选 input-plugin：核心暴露“文本前缀命中 → 请求候选 → 选中插入”的通用接口；
  slash/at 只是两个默认 plugin 实例（数据源由宿主 adapter 注入）。现 useTrigger/slash/at 结构可直接平移。

## 4 边界与适配

- `ChatClient` 接口：输入=中立消息/状态，输出=用户操作（send/cancel/copy/regen/pick…）。
  - 页面侧 `host.ts` 雏形提升为 `ChatClient`。
  - VS Code/dsh adapter 放扩展侧（如 `src/chatHost/`），负责 dsh 协议 → 中立 schema 双向翻译；
    dsh 协议永不进入组件源码。
- store：抽成 headless 状态机（useChat），组件薄壳只做 DOM；便于测试与复用。
- 与 dsh 深耦合功能（审批/提问/export/消费/模式/权限）在核心之外按 feature 位裁剪，需要时经插槽/adapter 暴露，缺省不内建。

## 5 样式策略

- 设计 token：统一 CSS 变量命名空间 `--chat-*`（色/间距/圆角/字号/阴影），
  现用 `--vscode-*` 全部改为读 token（默认值仍可由 VS Code 主题映射提供，但组件不直用主题变量）。
- 作用域：类名前缀 `chat-`（或 CSS Modules）；布局不再依赖固定全局 id；
  弹窗/浮层/贴片这些近期“魔法值”视觉(absolute top/left、max-width、text-indent)统一收进 token/作用域。
- 图标：自备图标集（内联 SVG 或随包字体），不依赖 codicon。
- 主题：`data-theme` 切换浅/深；缺省跟随宿主时由 adapter 传主题色值进 token。

## 6 i18n / a11y / 打包

- 文案：现状硬编码中文收进 `locales/zh`（含 en）；组件文案均可覆盖。
- a11y：菜单已有 listbox/option/aria-selected 雏形；补齐焦点管理、Esc/方向键、可用性标注。
- 打包：独立包产 ESM 入口 + 独立 CSS + .d.ts；图标/功能位可 tree-shake。

## 7 迁移阶段与验收

| 阶段 | 内容 | 行为 | 验收 |
|---|---|---|---|
| 0 | 收口基线：真机验证 @/技能/export/plan/goal 等未提交项并 commit | 不变 | 关键路径可用 |
| 1 | 公开接口 + ChatClient adapter + tokens 前缀化/作用域（尽量不改视觉） | 不变 | 仍能跑 dsh；脱离宿主可用内存 client 渲染示例 |
| 2 | i18n / 主题 / 图标集 / 打包产物 | 不变 | 另一项目可按包引入跑示例 |
| 3 | 可选专项：富文本内联 + 虚拟滚动 + 长会话 | 有变化 | 单独评审 |

每阶段独立分支、逐步合并；任一阶段可回退，避免一次性大爆炸。

## 8 风险

- 消息 schema 中立化需把现有“字符串含 token”的展示与 dsh 语义重映射，历史消息展示可能回归。
- scoped/tokens 化可能造成细微视觉偏差。
- 与 dsh 深度功能剪裁边界需明确（审批/提问/export/消费）。
- 改动面积大：建议在 Stage0 收口后开独立工作分支推进。

## 更新记录

| 日期 | 插件 | 变更 |
|---|---|---|
| 2026-09-07 | 0.1.6 | 新增： Chat 组件化边界设计（目标/公共 API/样式策略/阶段） |
