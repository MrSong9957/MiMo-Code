# 插件市场真实数据接通设计

**日期**：2026-06-24
**状态**：已确认
**前置**：`2026-06-24-plugin-marketplace-tui-view-design-v2.md`（静态视图骨架，已完成并验证）
**关联**：`2026-06-22-mimo-plugin-marketplace-design.md`（总体设计，含仓库格式分析）

---

## 背景

上一轮（v2）完成了插件市场的**静态骨架视图**——12 条写死的示例数据，可浏览可搜索，零联网。本次把数据源换成真实的 `anthropics/claude-plugins-official` 仓库（Claude Code 官方插件市场，~200 个插件）。

**历史教训**：更早的 v1 实现因"打开视图即同步 `fetch`、无超时保护"导致 TUI 死机。本次设计将防卡死作为首要约束。

## 目标

把 `MarketplaceView` 的静态示例数据替换为从 GitHub 实时拉取（带缓存）的真实 marketplace.json。安装功能仍不实现（加占位）。

## 防卡死三原则（贯穿全设计）

1. **异步触发**：`MarketplaceView` 在 `onMount` 时异步调 `loadMarketplace()`，不阻塞组件首次渲染。视图先显示 loading 态，数据到了再切换。
2. **强制超时**：所有 `fetch` 调用必带 `AbortSignal.timeout(15_000)`（15 秒），超时自动 abort，转错误态。
3. **失败降级**：网络失败 → 显示错误提示 + r 键重试，绝不卡死或崩溃。

## 已确认的设计决策

| 维度 | 决策 |
|------|------|
| 数据来源 | `anthropics/claude-plugins-official` 的 `.claude-plugin/marketplace.json` |
| 拉取端点 | `raw.githubusercontent.com` 直接 fetch |
| 下载时机 | 首次打开视图时异步 fetch（onMount 触发） |
| 缓存策略 | 本地文件缓存 + ETag 后台检查更新 |
| 超时 | `AbortSignal.timeout(15_000)` 强制 15 秒 |
| 字段映射 | name + description，纯平铺不分组，无 footer 类型标记 |
| 加载态 | 简单 loading 文本 |
| 错误处理 | 错误提示 + r 键重试 |
| 代码组织 | 新建 `marketplace.ts`（纯逻辑）+ 改造 `plugins.tsx`（三态视图） |
| 异步加载 | 纯 SolidJS signals + onMount（方案 A） |
| 安装功能 | 回车 toast 占位 "Install coming soon"，真实安装后续实现 |
| i18n | 先英文写死，后续补 |

## 数据源

**仓库**：`anthropics/claude-plugins-official`（默认分支 `main`）

**marketplace.json 位置**：`.claude-plugin/marketplace.json`（~200 个插件条目）

**raw URL**：
```
https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json
```

**插件条目字段**（实际存在的）：
- `name`（必有）、`description`（可选）、`category`（可选）、`source`（可选，4 种形态）、`author`（可选）、`homepage`（可选）

**本次只取**：`name` + `description`。`category`/`source`/`author` 等字段暂不使用（平铺无分组、无类型标记）。

**source 字段 4 种形态**（本次不处理，记录供后续安装功能参考）：
- 相对路径字符串（`"./plugins/xxx"`）
- `{source:"git-subdir", url, path, ref, sha}`
- `{source:"url", url, sha}`
- `{source:"github", repo, commit, sha}`

## 架构与数据流

```
首次打开视图
  onMount → loadMarketplace()
    → readCache() 无缓存
    → fetch raw URL（带 If-None-Match: <etag>，带 AbortSignal.timeout）
      → 200：parseMarketplaceJson() → writeCache() → 返回 ready
      → 304：用缓存数据 → 返回 ready
      → 异常/超时：无缓存 → 返回 error
    → 视图 loading → ready / error

后续打开（有缓存）
  onMount → loadMarketplace()
    → readCache() 有缓存 → 立即返回 ready（秒开）
    → 后台静默 loadMarketplace() 检查 ETag → 304 不动 / 200 静默替换

r 键刷新
  → loadMarketplace({ force: true }) → 忽略缓存强制 fetch → 替换列表
```

## 文件结构

### 新建：`marketplace.ts`

路径：`packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts`

职责：marketplace.json 的拉取、缓存、解析、映射。**纯逻辑，无 SolidJS 依赖，可单测。**

```ts
import path from "path"
import { Global } from "@/global"

const MARKETPLACE_URL =
  "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json"
const FETCH_TIMEOUT_MS = 15_000

// marketplace.json 原始条目（只声明用到的字段）
interface RawMarketplaceEntry {
  name: string
  description?: string
}

// 映射后给视图用的条目
export interface MarketplacePlugin {
  name: string
  description: string
}

export type LoadResult =
  | { status: "ready"; plugins: MarketplacePlugin[] }
  | { status: "error"; message: string }

// 缓存文件路径
function cachePath() {
  return path.join(Global.Path.cache, "marketplace.json")
}
function etagPath() {
  return path.join(Global.Path.cache, "marketplace.json.etag")
}

// 解析 marketplace.json 文本 → MarketplacePlugin[]
// 纯函数，可单测。description 缺失兜底空字符串，无 name 的条目过滤掉。
export function parseMarketplaceJson(raw: string): MarketplacePlugin[]

// 读缓存，返回插件列表 + etag（无缓存返回 undefined）
async function readCache(): Promise<{ plugins: MarketplacePlugin[]; etag?: string } | undefined>

// 写缓存（插件 JSON 文本 + etag）
async function writeCache(raw: string, etag?: string): Promise<void>

// 主入口：加载市场数据
// force=false：有缓存先返回缓存，后台静默检查更新
// force=true：忽略缓存，强制重新 fetch
export async function loadMarketplace(options?: { force?: boolean }): Promise<LoadResult>
```

**`loadMarketplace` 内部逻辑**（职责单一：只管"取数据"，不管后台刷新）：
1. `force=false` 且 `readCache()` 有数据 → 返回 `{ status: "ready", plugins: cache.plugins }`
2. 否则（无缓存或 force）→ `fetch(MARKETPLACE_URL, { headers: { If-None-Match: etag }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })`
   - `200`：`response.text()` → `parseMarketplaceJson()` → `writeCache(raw, response.headers.get("etag"))` → 返回 ready
   - `304`：用缓存数据 → 返回 ready
   - `fetch` 抛异常（超时/网络断）：有缓存用缓存兜底返回 ready；无缓存返回 error

**后台静默更新检查**（视图层控制，不耦合 loadMarketplace）：
视图 `onMount` 拿到缓存数据并切到 ready 态后，**额外触发一次** `loadMarketplace({ force: true })`（不显示 loading，失败静默忽略）。拿到新数据则静默替换 `state` 的 plugins（不闪屏）。这让 loadMarketplace 保持单一职责，视图决定是否做后台刷新。

```ts
onMount(async () => {
  const result = await loadMarketplace()
  setState(result.status === "ready" ? { status: "ready", plugins: result.plugins } : { status: "error", message: result.message })

  // 有缓存时，后台静默检查更新（不阻塞、不闪屏、失败忽略）
  if (result.status === "ready") {
    const updated = await loadMarketplace({ force: true }).catch(() => undefined)
    if (updated?.status === "ready") setState({ status: "ready", plugins: updated.plugins })
  }
})
```

**缓存格式**：直接存 marketplace.json 的**原始文本**（不存映射后的数据），这样：
- 缓存就是原始数据，便于调试
- 读取时重新 `parseMarketplaceJson`，映射逻辑单一来源
- ETag 单独存到 `.etag` 文件

### 修改：`plugins.tsx`

**删除**（静态数据，被真实数据取代）：
- `PluginType`、`TYPE_FOOTER`、`MarketplaceEntry`、`MARKETPLACE_PLUGINS`、`marketplaceOption()`

**新增 import**：
- `import { loadMarketplace, type MarketplacePlugin } from "./marketplace"`
- `import { onMount } from "solid-js"`（补充到现有 solid-js 导入）

**改造 `MarketplaceView`**：静态版 → 异步三态版。

## 视图组件：三态状态机

```tsx
function MarketplaceView(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const [state, setState] = createSignal<
    | { status: "loading" }
    | { status: "ready"; plugins: MarketplacePlugin[] }
    | { status: "error"; message: string }
  >({ status: "loading" })

  createEffect(() => {
    const width = size().width
    props.api.ui.dialog.setSize(width >= 128 ? "xlarge" : width >= 96 ? "large" : "medium")
  })

  onMount(async () => {
    const result = await loadMarketplace()
    setState(
      result.status === "ready"
        ? { status: "ready", plugins: result.plugins }
        : { status: "error", message: result.message },
    )
  })

  async function doRefresh() {
    setState({ status: "loading" })
    const result = await loadMarketplace({ force: true })
    setState(
      result.status === "ready"
        ? { status: "ready", plugins: result.plugins }
        : { status: "error", message: result.message },
    )
  }

  const rows = createMemo(() => {
    const s = state()
    if (s.status !== "ready") return []
    return s.plugins.map((p) => ({
      title: p.name,
      value: p.name,
      description: p.description,
    }))
  })

  return (
    <Show
      when={state().status === "ready"}
      fallback={
        <box paddingLeft={4} paddingRight={4} paddingTop={2}>
          <Show
            when={state().status === "error"}
            fallback={<text fg={props.api.theme.current.textMuted}>Loading marketplace...</text>}
          >
            <box flexDirection="row" gap={1}>
              <text fg={props.api.theme.current.error}>Failed to load marketplace</text>
            </box>
            <text fg={props.api.theme.current.textMuted}>Check network, press r to retry</text>
          </Show>
        </box>
      }
    >
      <DialogSelect
        title="Plugin Marketplace"
        flat
        options={rows()}
        onSelect={() => props.api.ui.toast({ variant: "info", message: "Install coming soon" })}
        keybind={[
          { title: "refresh", keybind: Keybind.parse("r").at(0), onTrigger: doRefresh },
        ]}
      />
    </Show>
  )
}
```

**注意**：loading/error 态也需要监听 `r` 键（否则 error 态无法重试）。在外层用 `useKeyboard` 监听：
```ts
useKeyboard((evt) => {
  if (state().status === "error" && evt.name === "r") doRefresh()
})
```
```

**三态布局**：

```
loading:
┌─ Plugin Marketplace ──────────┐
│                               │
│     Loading marketplace...    │   ← textMuted 色，居中
│                               │
└───────────────────────────────┘

ready:
┌─ Plugin Marketplace ────────────────────┐
│ (type to filter...)                     │   ← DialogSelect 搜索框
│   frontend-design    Build distincti..  │
│   pdf                Generate and pr..  │
│   ...                                   │   ← ~200 项，可滚动
└─────────────────────────────────────────┘
  [r] refresh                                 ← 底部快捷键

error:
┌─ Plugin Marketplace ──────────┐
│                               │
│  Failed to load marketplace   │   ← error 色
│  Check network,               │   ← textMuted 色
│  press r to retry             │
│                               │
└───────────────────────────────┘
  [r] retry
```

- **loading/error 态**：`<Show>` 的 fallback 分支，渲染简单文本。error 态用 `useKeyboard` 监听 `r` 键触发 `doRefresh`。
- **ready 态**：`DialogSelect`，`flat` 平铺，`onSelect` 弹安装占位 toast。
- **r 键**：ready 态走 `DialogSelect.keybind`；error 态走 `useKeyboard`。

## 测试策略

| 测试对象 | 内容 | 方式 |
|---------|------|------|
| `parseMarketplaceJson` | 正常解析、description 缺失兜底、无 name 过滤、空数组、非法 JSON | `bun:test` 单测 |
| `loadMarketplace` | fetch/缓存交互 | 不测（需网络+文件系统），手动验证 |
| `MarketplaceView` | 三态渲染 | 不测（需 opentui 运行时），手动验证 |

**单测示例**（marketplace.test.ts）：
```ts
test("parseMarketplaceJson maps entries to name + description", () => {
  const raw = JSON.stringify({
    plugins: [
      { name: "frontend-design", description: "Build UI" },
      { name: "pdf", description: "PDF tools" },
    ],
  })
  expect(parseMarketplaceJson(raw)).toEqual([
    { name: "frontend-design", description: "Build UI" },
    { name: "pdf", description: "PDF tools" },
  ])
})

test("parseMarketplaceJson defaults missing description to empty string", () => {
  const raw = JSON.stringify({ plugins: [{ name: "no-desc" }] })
  expect(parseMarketplaceJson(raw)).toEqual([{ name: "no-desc", description: "" }])
})
```

## 复用轮子清单

| 轮子 | 位置 | 用途 |
|------|------|------|
| `DialogSelect` | `tui/ui/dialog-select.tsx` | 搜索框 + 平铺列表 + fuzzy |
| `Global.Path.cache` | `global/index.ts` | 缓存目录 |
| `Keybind.parse` | `@/util` | r 键绑定 |
| `api.ui.toast` | TuiPluginApi | 安装占位提示 |
| `api.ui.dialog.replace` / `setSize` | TuiPluginApi | 视图切换 / 响应式尺寸 |
| `onMount` / `createSignal` / `createMemo` / `Show` | `solid-js` | 异步状态机 |

## 不在本轮范围

- 安装/卸载真实实现 — 后续（需处理 source 4 种形态的下载）
- 已装标记（✓）— 依赖安装后端
- 多语言文案 — 先英文，后补
- 第三方 marketplace 源（marketplace add/remove）— 后续
- 后台 ETag 检查的 UI 反馈（如"有更新"提示）— 后续

## 风险与对策

| 风险 | 对策 |
|------|------|
| fetch 超时/网络断 | `AbortSignal.timeout(15_000)` + 错误态 + r 键重试 |
| marketplace.json 格式变化 | `parseMarketplaceJson` 只取 name/description，容错缺失字段；非法 JSON 抛错被 loadMarketplace 捕获转 error 态 |
| ~200 插件渲染性能 | DialogSelect 自带 fuzzy + scrollbox，已验证可处理 |
| ETag 后台检查失败 | 静默忽略，继续用缓存（用户无感） |
| 缓存文件损坏 | readCache 解析失败 → 当作无缓存，重新 fetch |
