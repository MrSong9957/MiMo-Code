# 插件市场视图（MarketplaceView）设计

**日期**：2026-06-24
**状态**：已确认（待 review）
**关联**：`2026-06-23-plugin-marketplace-phase1.md`（Phase 1 计划，本设计是其 TUI 部分 Task 1 的细化）

---

## 目标

把 `plugins.tsx` 里 `plugins.marketplace` 命令的占位 toast，替换成真实的"插件市场"视图：复用现有 Plugins 界面布局（上面搜索栏 + 下面插件列表），数据来自 `anthropics/claude-plugins-official`，首次下载到本地缓存，后续自动后台检查更新。

## 已确认的设计决策（全部锁定）

| 维度 | 决策 |
|------|------|
| 视图代码位置 | 写在 `plugins.tsx` 里（新增 MarketplaceView 组件，不动现有 npm 插件逻辑） |
| UI 布局 | 复用 `DialogSelect`（自带搜索框 + fuzzy 过滤 + category 分组） |
| 列表范围 | 全部插件（可装 + 已装），已装标 ✓ |
| 列表项信息 | 名称 + description（截断）+ footer 类型标记 |
| footer 标记 | 纯 SKILL→`[SKILL]`、纯 MCP→`[MCP]`、两者都有→`[SKILL+MCP]` |
| 数据来源 | 实时从 `anthropics/claude-plugins-official` 的 `.claude-plugin/marketplace.json` 拉取 |
| 缓存策略 | 首次下载到 `Global.Path.cache`，后续自动后台检查（ETag 比对，304 则不动，200 静默替换） |
| 首次加载 | 全屏 spinner "Loading marketplace..." |
| 后台检查 | 静默，不闪屏，失败用本地缓存兜底 |
| 回车 | 直接安装（已装则提示） |
| d 键 | 卸载选中插件（仅已装项有效） |
| r 键 | 手动强制刷新目录 |
| 安装/卸载反馈 | toast 绿/红 |

## 架构与数据流

**复用至上**：视图零新 UI 组件——完全复用 `DialogSelect`（自带搜索框 + fuzzy 过滤 + 分组），和现有 `plugins.tsx` 的 `View` 组件同构。唯一新造的是"取数 + 缓存"逻辑。

```
GitHub (anthropics/claude-plugins-official)
   ↓ 首次 fetch .claude-plugin/marketplace.json
本地缓存 Global.Path.cache/marketplace-claude-plugins-official.json
   ↓ 读缓存（秒开）+ 后台静默比对 ETag 检查更新
MarketplaceView (DialogSelect options)
   ↓ onSelect(回车) / d 键 / r 键
install/uninstall（后端核心逻辑）
```

### 缓存策略（自动后台检查）

- **首次**：本地无缓存 → 全屏 spinner "Loading marketplace..." → fetch raw URL → 存缓存（含 ETag）→ 渲染列表
- **后续**：本地有缓存 → 立即渲染列表（秒开）→ 后台静默发 `If-None-Match: <ETag>` 请求 → 304 则不动；200 则静默替换缓存 + 列表数据（不闪屏）
- **网络断**：首次失败 → 错误提示 + r 键重试；后台检查失败 → 静默忽略，继续用本地缓存

## 列表项设计

```
┌─ Plugin Marketplace ────────────────────────────────┐
│ 🔍 search...                                         │  ← DialogSelect 自带搜索框
├──────────────────────────────────────────────────────┤
│ Development                                          │  ← category 分组标题（accent色）
│   ✓ frontend-design   Build distinctive UI  [SKILL]  │  ← title + description(截断) + footer
│     pdf-tools         PDF generation toolkit [SKILL] │
│ Security                                             │
│   ✓ 42crunch          API security scanning  [MCP]   │
│   mixed-tool          Does many things    [SKILL+MCP]│
└──────────────────────────────────────────────────────┘
  [enter] install   [d] uninstall   [r] refresh        ← 底部快捷键栏
```

### 字段映射（MarketplaceRow → DialogSelectOption）

| DialogSelectOption 字段 | 来源 | 说明 |
|------------------------|------|------|
| `title` | `✓ ${name}`（已装）/ `${name}`（未装） | 已装前缀 ✓ |
| `description` | marketplace.json 的 `description` | 截断到约 55 字符（灰色 textMuted） |
| `category` | marketplace.json 的 `category` | DialogSelect 自动分组（Development/Security/...） |
| `footer` | `[SKILL]`/`[MCP]`/`[SKILL+MCP]` | 从 source 路径或已装记录推断内容类型 |
| `value` | `name` | 身份标识 |
| `disabled` | 否 | 全部可选 |

### footer 类型推断逻辑

marketplace.json 的 `source` 字段有两种形态：
- 字符串（`"./plugins/xxx"`）→ 市场内相对路径，需下载后检测
- 对象（`git-subdir`/`url`/`github`）→ 带 type 信息

**推断规则**（优先级）：
1. 若插件已装 → 读已装记录的 `hasSkill`/`hasMcp`（准确）
2. 若未装 → 默认标 `[SKILL]`（claude-plugins-official 多为 skill 类），或从 source 对象的已知 type 推断

**渐进校正说明**：同一插件的 footer 标记会在安装前后变化——装前显示 `[SKILL]`（默认推测），装后刷新为实际类型（可能是 `[MCP]` 或 `[SKILL+MCP]`）。这是有意的渐进校正：未装时无法预知内容，装完才准确。列表刷新（`r` 键或安装后自动）会更新标记。

## 操作设计

| 操作 | 触发 | 行为 |
|------|------|------|
| **安装** | 回车（onSelect） | busy 锁 → `installContentPlugin(name)` → toast → 刷新 rows（标 ✓）→ 解锁 |
| **卸载** | d 键 | 仅已装项有效；busy 锁 → `uninstallContentPlugin(name)` → toast → 刷新 rows（去 ✓）→ 解锁 |
| **刷新目录** | r 键 | busy 锁 → 强制 fetch（忽略缓存）→ 替换 rows → 解锁 |

**busy 锁**：任何操作进行中（busy=true）时，忽略新的安装/卸载/刷新请求，底部快捷键栏显示 "working..."。

## 状态与边界处理

| 场景 | 处理 |
|------|------|
| 首次打开，无缓存 | 全屏 spinner "Loading marketplace..."，拉完渲染 |
| 有缓存 | 秒开列表，后台静默检查更新 |
| 网络断（首次失败） | spinner → 错误提示 "Failed to load marketplace, check network"，底部 r 键重试 |
| 网络断（后台检查失败） | 静默忽略，继续用本地缓存列表（用户无感） |
| 安装中（busy） | busy 信号锁，忽略新请求，底部显示 "working..." |
| 安装成功 | toast 绿色 "Installed xxx"，列表该项刷新为 ✓ |
| 安装失败 | toast 红色，显示原因（找不到/下载失败/空内容等） |
| 卸载成功 | toast "Removed xxx"，列表该项去掉 ✓ |
| 列表空（某 category 无插件） | DialogSelect 自动不显示空分组 |

## 代码组织

**唯一改动文件**：`packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`

新增（不动现有 npm 插件逻辑，约 +120 行）：

```
plugins.tsx（修改）
├── MarketplaceRow 类型（新）— { name, description, category, installed, type: "skill"|"mcp"|"both" }
├── 缓存读写（新）
│   ├── marketplaceCachePath() → Global.Path.cache/marketplace-claude-plugins-official.json
│   ├── readMarketplaceCache() → { plugins, etag } | undefined
│   ├── writeMarketplaceCache(json, etag?)
│   └── fetchMarketplaceIndex(force?) → { plugins, updated } | { plugins, cached }
├── MarketplaceView 组件（新）— DialogSelect + signal（rows/cur/busy/error）
├── doInstall / doUninstall / doRefresh（新）— 调后端 + toast + 刷新
├── showMarketplace(api)（新）— dialog.replace
└── plugins.marketplace 命令 onSelect（改）— toast 占位 → showMarketplace(api)
```

## 复用轮子清单（不重复造）

| 轮子 | 位置 | 用途 |
|------|------|------|
| `DialogSelect` | `tui/ui/dialog-select.tsx` | 搜索框 + 列表 + fuzzy + 分组（核心 UI） |
| `DialogSelectOption` | 同上 | 列表项结构（title/description/footer/category） |
| `Keybind.parse` | `@/util` | 快捷键定义（d/r） |
| `api.ui.toast` | TuiPluginApi | 成功/失败反馈 |
| `api.ui.dialog.replace` | TuiPluginApi | 视图切换 |
| `useLanguage().t` | context/language | i18n（已加 marketplace key） |
| 后端 `installContentPlugin`/`uninstallContentPlugin`/`readInstalled` | plugin-marketplace/（计划 Task 3/7） | 安装/卸载/读已装 |
| `Global.Path.cache` | global/ | 缓存目录 |

## 路线 A 决策：只做前端视图骨架（已确认）

本次实现**只做前端视图骨架**：搜索、列表、分组、缓存拉取、刷新全部为真实可用功能；**安装/卸载按钮先放 toast 占位**（"安装功能开发中"），后端 `installContentPlugin` 等就绪后再接通。

### 骨架阶段的行为边界（诚实骨架原则）

由于不接后端，依赖后端数据的部分按以下规则简化，**保证视图不误导用户**：

| 功能 | 骨架阶段行为 | 真实数据可用后 |
|------|-------------|---------------|
| 搜索 / fuzzy 过滤 | ✅ 真实可用（DialogSelect 自带） | 不变 |
| 列表展示（name/description/category） | ✅ 真实（来自 marketplace.json） | 不变 |
| category 分组 | ✅ 真实（来自 marketplace.json） | 不变 |
| 缓存拉取 + 后台 ETag 检查 | ✅ 真实可用 | 不变 |
| r 键刷新 | ✅ 真实可用 | 不变 |
| **已装标记 ✓** | ⚠️ 骨架阶段全部显示"未装"（无 ✓），因 `readInstalled` 未实现 | 接通后端后显示真实已装状态 |
| **footer 类型标记** `[SKILL]`/`[MCP]`/`[SKILL+MCP]` | ⚠️ 骨架阶段**不显示 footer**（无法预知内容类型） | 接通后端后显示 |
| **回车安装** | ⚠️ toast 占位 "安装功能开发中" | 接通后端后真实安装 |
| **d 键卸载** | ⚠️ 隐藏或不绑定（无已装项可卸载） | 接通后端后真实卸载 |

**原则**：骨架展示的每一项都是"真实的"，不展示的部分（已装标记/footer/安装卸载）诚实地留空或占位，而非伪造数据。用户看到的是"能浏览、能搜索的市场目录，安装功能待开"。

## 风险

- **200+ 插件性能**：DialogSelect 已有 fuzzy 搜索，渲染无压力
- **自动后台检查的 ETag**：GitHub raw 支持，标准省流量做法
- **网络断首次拉取**：降级显示错误 + r 键重试
- **footer 类型推断不准**：未装插件无法预知内容类型，Phase 1 简化为默认 `[SKILL]`，装完校正
