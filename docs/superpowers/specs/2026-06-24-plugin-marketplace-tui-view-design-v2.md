# 插件市场视图（MarketplaceView）设计 v2

**日期**：2026-06-24
**状态**：已确认
**性质**：推倒重来。取代 v1（`2026-06-24-plugin-marketplace-tui-view-design.md`）。

---

## 背景：为什么推倒重来

v1 设计在打开视图时同步 `fetch` GitHub marketplace.json，无超时保护，网络一卡就把整个 TUI 拖死（实际死机事故）。v1 还引入了缓存模块、ETag 后台检查、安装/卸载等复杂度。

v2 的核心转变：**先用纯静态示例数据把视图 UI 做对，完全不联网**。从根上消除卡死风险，把数据源、安装后端等问题留到以后。

## 目标

把 `plugins.tsx` 里 `plugins.marketplace` 命令的占位 toast（"开发中"），替换成一个可浏览、可搜索的插件目录视图。数据是写死的静态示例。

## 已确认的设计决策

| 维度 | 决策 |
|------|------|
| 数据来源 | **纯静态示例数据**（`const` 数组内联），零联网，不可能卡死 |
| 视图操作 | **纯浏览**，无安装/卸载 |
| 列表项信息 | 名称 + 描述 + 类型标记（`[SKILL]`/`[MCP]`/`[SKILL+MCP]`） |
| 布局 | **纯平铺**，不分组 |
| UI 组件 | 复用 `DialogSelect`（自带搜索框 + fuzzy 过滤） |
| 视图入口 | 复用现有 `plugins.marketplace` 命令（改 `onSelect`） |
| i18n | 先英文写死，后补多语言 |
| 改动文件 | **仅 `plugins.tsx` 一个** |

## 架构

复用至上：视图零新 UI 组件，零文件 IO。完全复用 `DialogSelect`，和现有 `View`（npm 插件列表）同构。

```
MARKETPLACE_PLUGINS（const 数组，内联）
   ↓ .map() → DialogSelectOption[]
MarketplaceView (DialogSelect, flat 平铺)
   ↑ plugins.marketplace 命令 onSelect → showMarketplace(api)
```

无异步、无缓存、无网络、无错误态。

## 数据结构

```ts
type PluginType = "skill" | "mcp" | "both"

const TYPE_FOOTER: Record<PluginType, string> = {
  skill: "[SKILL]",
  mcp: "[MCP]",
  both: "[SKILL+MCP]",
}

interface MarketplaceEntry {
  name: string
  description: string
  type: PluginType
}
```

`type` 字段直接映射 footer，不需要运行时推断内容类型（v1 的痛点之一）。

## 示例数据

约 12 条，覆盖三种类型：

```ts
const MARKETPLACE_PLUGINS: MarketplaceEntry[] = [
  { name: "frontend-design",       description: "Build distinctive UI with intentional design",   type: "skill" },
  { name: "pdf",                    description: "Generate and process PDF documents",            type: "skill" },
  { name: "brainstorming",          description: "Turn ideas into validated designs",              type: "skill" },
  { name: "rust-analyzer-lsp",      description: "Rust language server integration",               type: "both"  },
  { name: "git-workflow",           description: "Automate git operations and PRs",                type: "skill" },
  { name: "42crunch",               description: "API security scanning and audit",                type: "mcp"   },
  { name: "playwright",             description: "Browser automation and E2E testing",             type: "mcp"   },
  { name: "context7",               description: "Look up library docs in real-time",              type: "mcp"   },
  { name: "sequential-thinking",    description: "Structured multi-step reasoning",                type: "both"  },
  { name: "docx",                   description: "Create and edit Word documents",                 type: "skill" },
  { name: "mcp-builder",            description: "Build MCP servers for new capabilities",         type: "both"  },
  { name: "airtable",               description: "Interact with Airtable bases",                   type: "mcp"   },
]
```

描述控制在约 45 字符内，适配 `DialogSelect` 的 `Locale.truncate(title, 61)` 行为。

## 视图组件

```tsx
function MarketplaceView(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()

  createEffect(() => {
    const w = size().width
    props.api.ui.dialog.setSize(w >= 128 ? "xlarge" : w >= 96 ? "large" : "medium")
  })

  const rows = createMemo(() =>
    MARKETPLACE_PLUGINS.map((p) => ({
      title: p.name,
      value: p.name,
      description: p.description,
      footer: TYPE_FOOTER[p.type],
      // category 留空 → DialogSelect 不渲染分组标题，纯平铺
    })),
  )

  return (
    <DialogSelect
      title="Plugin Marketplace"
      flat
      options={rows()}
      keybind={[]}
    />
  )
}
```

### 布局效果

```
┌─ Plugin Marketplace ────────────────────────────────┐
│ (type to filter...)                                 │  ← 搜索框（DialogSelect 自带）
├─────────────────────────────────────────────────────┤
│   frontend-design    Build distinctive UI..  [SKILL] │
│   pdf                Generate and process..  [SKILL] │
│   rust-analyzer-lsp  Rust language server.. [SKILL+MCP]│
│   42crunch           API security scanning    [MCP] │
│   ...                                               │  ← scrollbox，可滚动
└─────────────────────────────────────────────────────┘
```

- 搜索：DialogSelect 自带 `fuzzysort`，匹配 `title`（category 为空不参与）。
- footer：`DialogSelect` 的 `Option` 组件把 footer `flexShrink={0}` 右对齐，类型标记整齐靠右。
- 底部快捷键栏：`keybind={[]}` 为空，`DialogSelect` 渲染 `<box flexShrink={0} />` 空白占位（`dialog-select.tsx:369`），不会显示多余快捷键。

## 入口接通

新增 `showMarketplace`：

```tsx
function showMarketplace(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <MarketplaceView api={api} />)
}
```

`plugins.marketplace` 命令的 `onSelect`（`plugins.tsx:269`）从 toast 改为：

```tsx
onSelect() {
  showMarketplace(api)
},
```

## i18n 处理

- 视图标题 `title="Plugin Marketplace"` 英文写死。
- 搜索框 placeholder 用 `DialogSelect` 默认值 `t("tui.dialog.select.placeholder")`，无需新 key。
- 现有 `tui.command.plugins.marketplace.placeholder`（"开发中"）改完后不再被引用，**保留不删**（避免改动 7 个 i18n 文件，符合精准修改原则），变为无害的未使用 key。

## 文件变更清单

仅 `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`：

| 位置 | 改动 | 行数 |
|------|------|------|
| `source()` 函数附近 | 新增 `PluginType` / `TYPE_FOOTER` / `MarketplaceEntry` / `MARKETPLACE_PLUGINS` | +25 |
| `View` 组件之后 | 新增 `MarketplaceView` 组件 | +25 |
| `show()` 之后 | 新增 `showMarketplace()` | +3 |
| `plugins.marketplace` 命令 `onSelect` | toast → `showMarketplace(api)` | ±1 |

合计约 +54 行。

## 不在本轮范围

- 真实数据源（GitHub marketplace.json 拉取 / 本地打包清单）— 以后接，届时必须带超时保护
- 安装/卸载功能 — 以后接后端
- 已装标记（✓）— 依赖安装后端
- 多语言文案 — 先英文，后补
- 缓存 / ETag / 后台更新检查 — v1 的复杂度，本轮不需要

## 复用轮子清单

| 轮子 | 位置 | 用途 |
|------|------|------|
| `DialogSelect` | `tui/ui/dialog-select.tsx` | 搜索框 + 平铺列表 + fuzzy（核心 UI） |
| `DialogSelectOption` | 同上 | 列表项结构 |
| `api.ui.dialog.replace` | TuiPluginApi | 视图切换 |
| `api.ui.dialog.setSize` | TuiPluginApi | 响应式尺寸 |
| `useTerminalDimensions` | `@opentui/solid` | 终端宽度 |
| `createMemo` / `createEffect` | `solid-js` | 响应式 |
