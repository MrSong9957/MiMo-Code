# 插件市场视图骨架（MarketplaceView）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `plugins.tsx` 里 `plugins.marketplace` 命令的占位 toast，替换成真实的"插件市场"视图骨架：搜索栏 + 插件列表（200+ 个来自 anthropics/claude-plugins-official），首次下载缓存、后续后台静默检查更新；安装/卸载按钮先放 toast 占位（路线 A，后端就绪后接通）。

**Architecture:** 视图零新 UI 组件，完全复用现有 `DialogSelect`（自带搜索框 + fuzzy 过滤 + category 分组）。缓存逻辑抽成独立纯函数模块（无 SolidJS 依赖，可单测）。视图组件用 SolidJS signal 驱动 options 动态更新。骨架阶段"诚实原则"：能真实展示的（搜索/列表/分组/缓存/刷新）全为真；依赖后端的（已装标记/footer类型/安装卸载）诚实留空或占位。

**Tech Stack:** TypeScript, Bun (`bun:test`), SolidJS, @opentui/solid, fetch (Bun 全局), jsonc/json

**关联 spec**：`docs/superpowers/specs/2026-06-24-plugin-marketplace-tui-view-design.md`

---

## 全局约束

- **测试框架**：`bun:test`，从 `packages/opencode/` 运行（仓库根有 `do-not-run-tests-from-root` 守卫）
- **类型检查**：`bun typecheck`（从 `packages/opencode`）
- **缓存路径**：`Global.Path.cache`（XDG 缓存目录，`~/.cache/mimocode/`）
- **不改现有 npm 插件逻辑**：现有 `View`/`Install`/`show`/`showInstall`/命令注册一律不动
- **诚实骨架**：骨架阶段全部插件显示为"未装"，不伪造已装标记；footer 类型标记骨架阶段不显示

---

## 📖 骨架阶段行为边界（诚实骨架原则）

| 功能 | 骨架阶段 | 后端就绪后 |
|------|---------|-----------|
| 搜索 / fuzzy 过滤 | ✅ 真实（DialogSelect 自带） | 不变 |
| 列表（name/description/category） | ✅ 真实（marketplace.json） | 不变 |
| category 分组 | ✅ 真实 | 不变 |
| 缓存拉取 + ETag 检查 | ✅ 真实可用 | 不变 |
| r 键刷新 | ✅ 真实可用 | 不变 |
| 已装标记 ✓ | ⚠️ 全部"未装" | 接后端后真实 |
| footer `[SKILL]`/`[MCP]` | ⚠️ 不显示 | 接后端后显示 |
| 回车安装 | ⚠️ toast 占位 | 接后端后真实 |
| d 键卸载 | ⚠️ 不绑定 | 接后端后真实 |

---

## 文件结构

| 文件 | 职责 | 类型 |
|------|------|------|
| `src/cli/cmd/tui/feature-plugins/system/marketplace-cache.ts` | 缓存读写 + fetch marketplace.json + ETag 检查（纯函数，无 SolidJS） | 新建 |
| `src/cli/cmd/tui/feature-plugins/system/plugins.tsx` | 新增 MarketplaceView 组件 + showMarketplace + 改 plugins.marketplace 命令 onSelect | 修改 |
| `test/cli/cmd/tui/marketplace-cache.test.ts` | 缓存逻辑单测（mock fetch + 临时目录） | 新建 |

**为什么缓存逻辑抽独立文件**：plugins.tsx 已 275+ 行，缓存逻辑（fetch/ETag/读写文件）与 UI 无关、可独立单测，抽出后两边都更聚焦。

---

## 轮子复用清单（不重复造）

| 物理动作 | 复用轮子 | 位置 |
|---------|---------|------|
| 搜索框 + fuzzy 列表 | `DialogSelect`（自带搜索/过滤/分组） | `tui/ui/dialog-select.tsx` |
| 列表项结构 | `DialogSelectOption`（title/description/category/value） | 同上 |
| 快捷键定义 | `Keybind.parse` | `@/util` |
| 成功/失败反馈 | `api.ui.toast` | TuiPluginApi |
| 视图切换 | `api.ui.dialog.replace` | TuiPluginApi |
| i18n | `useLanguage().t`（marketplace key 已加） | context/language |
| 缓存目录 | `Global.Path.cache` | global |
| 文件读写 | `Filesystem.readText`/`Filesystem.write` | `@/util` |
| 全局 fetch | Bun 内置 `fetch` | 全局 |

---

## 阶段排序（由表及里）

```
Task 1：缓存逻辑模块（marketplace-cache.ts，纯函数可测）
   ↓ 提供数据 ↓
Task 2：MarketplaceView 视图组件 + 接通命令（plugins.tsx）
```

Task 1 是数据层（纯函数），Task 2 是展示层（消费 Task 1）。先做 Task 1 因为它能独立单测、无 UI 依赖。

---

## Task 1：缓存逻辑模块（marketplace-cache.ts）

### 📖 任务手册：缓存逻辑

#### 1. 前端交互流程与物理认知

- **前端交互**：用户无感知。视图打开时调这里取数：首次从 GitHub 下载商品目录存本地，下次直接读本地，后台静默问一句"有更新吗"。
- **物理本质**：一个带记忆的快递员。第一次去仓库取货并记下货的单号（ETag）；之后每次先翻自家存货（缓存），同时悄悄问仓库"这单号之后有新货吗"（If-None-Match），有就悄悄换上新货。
- **防御边界**：仓库关门（网络断）→ 首次报错、后续用存货兜底；存货坏了（缓存文件损坏）→ 当没存货，重新取货；单号丢了（无 ETag）→ 每次都全量取。

#### 2. 轮子复用审查

- **可复用**：全局 `fetch`（Bun 内置，支持 `If-None-Match` 请求头、返回 `Response` 带 `status`/`headers`）、`Filesystem.readText`/`write`、`Global.Path.cache`
- **本次仅需新造**：缓存文件路径拼接、读缓存（含 ETag）、写缓存（含 ETag）、fetch 逻辑（带缓存优先 + 后台检查）

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace-cache.ts`（**新建**）

```text
// [基础 Import：路径；全局路径；文件系统工具]

// ── 常量 ──
const MARKETPLACE_REPO = "anthropics/claude-plugins-official"
// raw URL = https://raw.githubusercontent.com/{repo}/main/.claude-plugin/marketplace.json

// ── 出参类型：从 marketplace.json 解析出的单个插件 ──
export type MarketplacePlugin = {
  name: string
  description: string
  category?: string
  source: unknown       // 透传，骨架阶段不解析
}

// ── 出参类型：市场目录（解析后的）──
export type MarketplaceIndex = {
  plugins: MarketplacePlugin[]
  etag?: string          // 用于下次检查更新
}

// ── 缓存文件路径 ──
// 入参：无
// 出参：string（缓存文件绝对路径）
export function marketplaceCachePath(): string {
    // 1. 拼接：全局缓存目录 + "marketplace-" + 仓库名(斜杠转横线) + ".json"
    // 2. 交付：绝对路径字符串
}

// ── 读本地缓存 ──
// 入参：无
// 出参：Promise<MarketplaceIndex | undefined>（无缓存/损坏 → undefined）
export async function readMarketplaceCache(): Promise<MarketplaceIndex | undefined> {
    // 1. 物理状态：缓存文件不存在 → 交付 undefined
    // 2. 读缓存文件原文，解析为 JSON
    //    - 解析失败（损坏）→ 交付 undefined（防御：当没存货）
    // 3. 物理状态：解析结果有 plugins 数组？
    //    - 有 → 交付 { plugins, etag }（etag 可选，从缓存元数据取）
    //    - 无 → 交付 undefined
}

// ── 写本地缓存 ──
// 入参：插件数组、可选 etag
// 出参：Promise<void>
export async function writeMarketplaceCache(plugins: MarketplacePlugin[], etag?: string): Promise<void> {
    // 1. 拼缓存对象：{ plugins, etag, cachedAt: 当前时间戳 }
    // 2. 序列化为 JSON 字符串
    // 3. 写到缓存文件路径
    // 4. 交付：无（写入完成）
}

// ── 从仓库取货（首次或强制刷新）──
// 入参：可选 etag（用于检查更新）
// 出参：取货结果
//   - { status: "fresh", plugins, etag? }  拿到新货
//   - { status: "not_modified" }            没更新（ETag 命中 304）
//   - { status: "error", message }          取货失败
export type FetchResult =
  | { status: "fresh"; plugins: MarketplacePlugin[]; etag?: string }
  | { status: "not_modified" }
  | { status: "error"; message: string }

export async function fetchMarketplace(etag?: string): Promise<FetchResult> {
    // 1. 拼 raw URL
    // 2. 发请求：
    //    - 若有 etag → 带上 If-None-Match 请求头
    // 3. 物理状态分派（按响应）：
    //    - 状态 304（没更新）→ 交付 { status: "not_modified" }
    //    - 状态 200（拿到新货）：
    //        解析 JSON，校验有 plugins 数组
    //        提取新 etag（从响应头）
    //        交付 { status: "fresh", plugins, etag }
    //    - 其他状态/网络抛错 → 交付 { status: "error", message: 错误描述 }
}

// ── 主取数函数（缓存优先 + 后台检查）──
// 入参：options（可配 force 强制全量刷新）
// 出参：Promise<{ plugins; fromCache: boolean }>
//   - fromCache=true 表示用的是本地缓存（视图据此决定是否后台检查）
export async function loadMarketplace(options?: { force?: boolean }): Promise<{ plugins: MarketplacePlugin[]; fromCache: boolean }> {
    // 1. 物理状态：强制刷新（force=true）？
    //    - 是：调 fetchMarketplace()（不带 etag，全量取）
    //      - fresh → 写缓存，交付 { plugins, fromCache: false }
    //      - error → 抛错（让视图处理）
    // 2. 非强制：先读本地缓存
    //    - 有缓存 → 交付 { plugins: 缓存的, fromCache: true }（视图拿到后可后台检查）
    //    - 无缓存 → 调 fetchMarketplace()（首次全量取）
    //      - fresh → 写缓存，交付 { plugins, fromCache: false }
    //      - error → 抛错
}

// ── 后台检查更新（视图有缓存时调）──
// 入参：当前 etag
// 出参：Promise<{ updated: boolean; plugins?: MarketplacePlugin[] }>
export async function checkMarketplaceUpdate(etag?: string): Promise<{ updated: boolean; plugins?: MarketplacePlugin[] }> {
    // 1. 调 fetchMarketplace(etag) 带上当前 etag
    // 2. 物理状态：
    //    - not_modified → 交付 { updated: false }（没更新，静默）
    //    - fresh → 写新缓存，交付 { updated: true, plugins }（有更新）
    //    - error → 交付 { updated: false }（静默忽略，继续用本地）
}
```

### 实现步骤

- [ ] **Step 1.1：写失败测试**
  **【新建】** `test/cli/cmd/tui/marketplace-cache.test.ts`，用 `mock.module` 或全局 `fetch` mock + 临时目录（重定向 `Global.Path.cache` 或用 `fs` 直接读写临时路径）。

  ```typescript
  import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"

  // mock fetch：按 If-None-Match 返回不同结果
  //   - 无 If-None-Match → 200 + 一组 plugins + ETag "abc"
  //   - If-None-Match: "abc" → 304
  //   - If-None-Match: "old" → 200 + 新 plugins + ETag "def"

  describe("marketplace-cache", () => {
    test("marketplaceCachePath 返回全局缓存目录下的路径")

    describe("readMarketplaceCache", () => {
      test("无缓存文件 → undefined")
      test("缓存损坏(非法JSON) → undefined")
      test("有效缓存 → 返回 { plugins, etag }")
    })

    describe("fetchMarketplace", () => {
      test("首次(无etag) → status fresh + plugins + etag")
      test("etag 命中 → status not_modified")
      test("etag 过期 → status fresh + 新 plugins + 新 etag")
      test("网络错误 → status error + message")
    })

    describe("loadMarketplace", () => {
      test("无缓存 → fetch 全量，写缓存，fromCache=false")
      test("有缓存 → 直接返回缓存，fromCache=true（不 fetch）")
      test("force=true → 忽略缓存，强制 fetch")
    })

    describe("checkMarketplaceUpdate", () => {
      test("not_modified → { updated: false }")
      test("fresh → { updated: true, plugins } 并写新缓存")
      test("error → { updated: false }（静默）")
    })

    describe("writeMarketplaceCache + readMarketplaceCache 往返", () => {
      test("写入后能读回相同 plugins + etag")
    })
  })
  ```

- [ ] **Step 1.2：运行确认失败**
  Run: `cd packages/opencode && bun test test/cli/cmd/tui/marketplace-cache.test.ts`
  Expected: FAIL（模块不存在）

- [ ] **Step 1.3：实现 marketplace-cache.ts**（用蓝图，注意 `Global.Path.cache` 在测试里通过设置 `XDG_CACHE_HOME` 或直接 mock 路径函数隔离）

- [ ] **Step 1.4：运行确认通过**
  Run: `cd packages/opencode && bun test test/cli/cmd/tui/marketplace-cache.test.ts`
  Expected: PASS

- [ ] **Step 1.5：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 1.6：Commit**
  ```bash
  git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace-cache.ts \
          packages/opencode/test/cli/cmd/tui/marketplace-cache.test.ts
  git commit -m "feat: add marketplace cache module with ETag-based update check"
  ```

---

## Task 2：MarketplaceView 视图组件 + 接通命令

### 📖 任务手册：MarketplaceView 视图

#### 1. 前端交互流程与物理认知

- **前端交互**：
  - 用户在命令面板选"插件市场" → 弹出全屏对话框
  - **首次（无缓存）**：显示 spinner "Loading marketplace..." → 拉取完 → 渲染列表
  - **有缓存**：立即显示列表（秒开） → 右下角静默检查更新（用户无感，有更新才悄悄换数据）
  - 列表里：上面搜索框（DialogSelect 自带），下面按 category 分组的插件（Development/Security/...），每行 = 插件名 + description
  - 输入文字 → 实时 fuzzy 过滤
  - 回车选中插件 → toast "安装功能开发中"（骨架占位）
  - 按 `r` → 强制刷新目录（忽略缓存重拉）

- **物理本质**：一个 SolidJS 组件。挂载时调 Task 1 的取数函数拿到插件数组，塞进会响的标记（signal），驱动 DialogSelect 的 options。options 是响应式的——signal 一变，列表自动刷新。

- **防御边界**：
  - **首次拉取失败**：spinner → 显示错误提示 + 提示按 r 重试
  - **操作进行中（busy）**：busy 标记锁，忽略新的操作请求
  - **后台检查失败**：静默忽略，继续用本地列表
  - **空目录**：显示 "No plugins available"

#### 2. 轮子复用审查

- **可复用（零新造 UI）**：
  - `DialogSelect`（搜索框+fuzzy+分组，核心 UI 全靠它）
  - `DialogSelectOption`（title/description/category/value）
  - `Keybind.parse`（r 键）
  - `api.ui.toast`（反馈）、`api.ui.dialog.replace`（切换）、`api.theme.current`（配色）
  - Task 1 的 `loadMarketplace`/`checkMarketplaceUpdate`/`MarketplacePlugin` 类型
  - 现有 `View` 组件的 size 自适应写法（第 162-173 行，照搬）
- **本次仅需新造**：`MarketplaceView` 组件（signal + 取数 + options 映射）、`showMarketplace`、改命令 onSelect

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`（**修改**，新增内容，不动现有 npm 插件逻辑）

```text
// [基础 Import：SolidJS 的会响标记/记忆值/条件渲染/For；选择框轮子；提示泡；
//  终端尺寸；主题；i18n；Task 1 的取数函数和类型]
import { loadMarketplace, checkMarketplaceUpdate, type MarketplacePlugin } from "./marketplace-cache"

// ── 出参类型：列表里一行数据 ──
type MarketplaceRow = {
  name: string
  description: string
  category?: string
}

// ── 纯函数：插件数组 → DialogSelect 选项数组（可单测）──
// 入参：插件数组
// 出参：DialogSelectOption<string>[]
function toMarketplaceOptions(plugins: MarketplacePlugin[], theme: Theme): DialogSelectOption<string>[] {
    // 1. 遍历每个插件，转成选项对象：
    //    - title: 插件名（骨架阶段无 ✓ 前缀，全部未装）
    //    - value: 插件名（身份标识）
    //    - description: 插件描述截断到约 55 字符（灰色 textMuted）
    //    - category: 插件的 category（Development/Security/...，DialogSelect 据此分组）
    //    - 骨架阶段不设 footer（类型标记待后端）
    // 2. 排序：按 category 分组内再按 name（DialogSelect 会按 category 分组，组内顺序由这里定）
    // 3. 交付：选项数组
}

// ── MarketplaceView 组件 ──
function MarketplaceView(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const [rows, setRows] = createSignal<MarketplaceRow[]>([])
  const [cur, setCur] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | undefined>()

  // 1. 对话框尺寸自适应（照搬现有 View 第 162-173 行）
  createEffect(() => {
    if (size().width >= 128) props.api.ui.dialog.setSize("xlarge")
    else if (size().width >= 96) props.api.ui.dialog.setSize("large")
    else props.api.ui.dialog.setSize("medium")
  })

  // 2. options 记忆值（rows 变 → options 变 → DialogSelect 自动刷新）
  const options = createMemo(() => toMarketplaceOptions(rows().map(r => ({ name: r.name, description: r.description, category: r.category })), theme()))

  // 3. 加载数据（挂载即触发）
  async function loadData(force = false) {
    setBusy(true); setError(undefined)
    if (force || rows().length === 0) setLoading(true)
    try {
      // 3a. 调 Task 1 loadMarketplace({ force })
      const { plugins, fromCache } = await loadMarketplace({ force })
      // 3b. 塞进 rows signal（驱动列表渲染）
      setRows(plugins)
      setLoading(false)
      // 3c. 若来自缓存 → 后台静默检查更新（不阻塞 UI）
      if (fromCache) {
        checkMarketplaceUpdate(/* etag */).then((result) => {
          if (result.updated && result.plugins) {
            setRows(result.plugins)   // 静默替换，不闪屏
          }
        }).catch(() => {})            // 静默忽略错误
      }
    } catch (e) {
      setLoading(false)
      setError("Failed to load marketplace, check network")
    } finally {
      setBusy(false)
    }
  }
  void loadData()   // 组件挂载即加载

  // 4. r 键：强制刷新
  async function doRefresh() {
    if (busy()) return
    await loadData(true)
    props.api.ui.toast({ variant: "info", message: "已刷新插件目录" })
  }

  // 5. 回车（onSelect）：骨架占位
  function doSelect(item) {
    if (busy()) return
    props.api.ui.toast({ variant: "info", message: "安装功能开发中" })
  }

  // 6. 渲染：
  //    - loading 且无数据 → 全屏 spinner "Loading marketplace..."
  //    - error 且无数据 → 错误提示 + 提示按 r
  //    - 有数据 → DialogSelect（title="Plugin Marketplace", options, onSelect=doSelect, keybind=[r=刷新]）
  return (
    <Show when={!loading() || rows().length > 0} fallback={<加载中提示/>}>
      <Show when={!error() || rows().length > 0} fallback={<错误提示/>}>
        <DialogSelect
          title="Plugin Marketplace"
          placeholder="Search plugins..."
          options={options()}
          current={cur()}
          onMove={(item) => setCur(item.value)}
          onSelect={(item) => doSelect(item)}
          keybind={[
            { title: busy() ? "working..." : "refresh", keybind: Keybind.parse("r").at(0), disabled: busy(), onTrigger: () => doRefresh() },
          ]}
        />
      </Show>
    </Show>
  )
}

// ── 弹出市场视图 ──
function showMarketplace(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <MarketplaceView api={api} />)
}

// ── 修改 plugins.marketplace 命令的 onSelect ──
// （在现有命令数组里，把 plugins.marketplace 项的 onSelect 从 toast 改为 showMarketplace(api)）
{
  title: t("tui.command.plugins.marketplace.title"),
  value: "plugins.marketplace",
  category: "system",
  onSelect() {
    showMarketplace(api)   // ← 从 toast 占位改为弹出视图
  },
},
```

### 实现步骤

- [ ] **Step 2.1：写失败测试**
  **【新建】** `test/cli/cmd/tui/marketplace-view.test.ts`，只测纯函数 `toMarketplaceOptions`（数据映射逻辑），不测 SolidJS 渲染。
  - 插件数组 → 选项数组：title/value/description(截断)/category 正确映射
  - description 超过 55 字符 → 截断
  - category 为 undefined → 归到空分组
  - 排序：组内按 name 字母序

- [ ] **Step 2.2：运行确认失败**：`cd packages/opencode && bun test test/cli/cmd/tui/marketplace-view.test.ts`

- [ ] **Step 2.3：在 plugins.tsx 实现 MarketplaceView + toMarketplaceOptions + showMarketplace**（用蓝图，import Task 1 的取数函数）

- [ ] **Step 2.4：改 plugins.marketplace 命令的 onSelect**（从 toast 占位改为 `showMarketplace(api)`）

- [ ] **Step 2.5：运行确认通过**：`cd packages/opencode && bun test test/cli/cmd/tui/marketplace-view.test.ts`

- [ ] **Step 2.6：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 2.7：手动 smoke test**（需联网）
  ```bash
  cd packages/opencode
  bun run --conditions=browser ./src/index.ts
  # TUI 启动后：: → 选 "Plugin Marketplace"（或中文"插件市场"）
  # 期望：首次 spinner → 列表出现（200+ 插件按 category 分组）
  # 输入文字 → fuzzy 过滤
  # 回车 → toast "安装功能开发中"
  # r 键 → 刷新
  # 重新打开 → 秒开（用缓存）
  ```

- [ ] **Step 2.8：Commit**
  ```bash
  git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx \
          packages/opencode/test/cli/cmd/tui/marketplace-view.test.ts
  git commit -m "feat: add marketplace view skeleton with search, caching, refresh"
  ```

---

## 最终验证

- [ ] **全量测试**：`cd packages/opencode && bun test test/cli/cmd/tui/marketplace-cache.test.ts test/cli/cmd/tui/marketplace-view.test.ts`
- [ ] **类型检查**：`cd packages/opencode && bun typecheck`
- [ ] **回归检查**：现有 npm 插件管理器（命令面板的 Plugins / Install plugin）不受影响
- [ ] **i18n 回归**：切换语言（zh/ja/ru），市场视图标题跟着变

---

## Self-Review 自检结果

### 1. Spec 覆盖度（对照 spec 的骨架阶段行为边界表）
- ✅ 搜索 / fuzzy 过滤 → Task 2（复用 DialogSelect）
- ✅ 列表（name/description/category）→ Task 2 toMarketplaceOptions
- ✅ category 分组 → Task 2（DialogSelect 自动）
- ✅ 缓存拉取 + ETag 检查 → Task 1（loadMarketplace + checkMarketplaceUpdate）
- ✅ r 键刷新 → Task 2 doRefresh（调 loadMarketplace force）
- ✅ 已装标记 ✓ → 骨架阶段不显示（诚实留空，Task 2 不设 ✓ 前缀）
- ✅ footer 类型标记 → 骨架阶段不显示（Task 2 toMarketplaceOptions 不设 footer）
- ✅ 回车安装 → 骨架占位 toast（Task 2 doSelect）
- ✅ d 键卸载 → 骨架阶段不绑定（Task 2 keybind 只有 r）
- ✅ 首次 spinner → Task 2 loading signal
- ✅ 后台静默检查 → Task 2 checkMarketplaceUpdate 后台调
- ✅ 网络断首次 → Task 2 error signal + r 重试

### 2. 占位符扫描
- 无 TBD/TODO/"implement later"
- 每个骨架有代码化伪代码 + 明确入参出参类型
- 测试有具体断言点
- 骨架阶段的 toast 占位（"安装功能开发中"）是**有意的诚实占位**，非计划缺陷

### 3. 类型一致性核对
- `MarketplacePlugin`（Task 1 定义）→ Task 2 import 消费，字段（name/description/category/source）对齐
- `MarketplaceIndex`（Task 1）→ Task 1 内部 readMarketplaceCache 返回
- `FetchResult`（Task 1）→ Task 1 内部 fetchMarketplace 返回，3 种 status 字面量（fresh/not_modified/error）
- `loadMarketplace` 出参 `{ plugins, fromCache }`（Task 1）→ Task 2 MarketplaceView.loadData 消费
- `checkMarketplaceUpdate` 出参 `{ updated, plugins? }`（Task 1）→ Task 2 后台检查消费
- `MarketplaceRow`（Task 2）→ toMarketplaceOptions 消费
- i18n key `tui.command.plugins.marketplace.title`（已存在于 7 个 i18n 文件）→ Task 2 命令注册消费

### 4. 路线 A 边界核对
- 骨架阶段不 import 任何后端 `installContentPlugin`/`uninstallContentPlugin`/`readInstalled`（它们尚未实现）
- 所有"真实可用"功能（搜索/列表/缓存/刷新）不依赖后端
- 所有"占位"功能（安装/卸载/已装标记/footer）诚实标注为骨架行为
