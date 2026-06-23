# 内置插件市场目录设计

**日期**：2026-06-24
**状态**：已确认
**前置**：`2026-06-24-marketplace-real-data-design.md`（实时拉取，已完成）
**后续关联**：目录统一（问题 1）单独处理

---

## 背景

上一轮实现了从 GitHub 实时拉取 marketplace.json。问题：**首次打开必须联网**，无网络时无法浏览市场。本设计把 marketplace.json 构建时注入二进制，作为离线兜底。

## 目标

把 claude-plugins-official 的 marketplace.json 目录索引（136KB）内置进安装包二进制。用户打开市场永远秒开（内置或缓存），后台自动保持最新，无需手动更新。

## 范围

- **只内置目录索引**（marketplace.json），不内置插件本体（SKILL.md / .mcp.json）。236 个插件大部分内容不在 market 仓库本身，安装时按需从 GitHub 下载。
- **不包含目录统一**（问题 1）。该需求是全项目路径重构，单独处理。

## 已确认的设计决策

| 维度 | 决策 |
|------|------|
| 内置范围 | 只内置 marketplace.json（136KB 目录索引） |
| 注入方式 | 构建时 fetch + `define` 注入（复用 `OPENCODE_MIGRATIONS` 模式） |
| 数据源优先级 | 本地缓存 > 内置版本 > 联网 fetch |
| 自动更新 | 每次打开视图时后台静默 ETag 检查（onMount 已有逻辑，无需新增） |
| r 键 | 保留，作为强制刷新应急手段 |
| 容灾备份 | **不做**。marketplace.json 是公共目录索引，非用户数据；坏了重新 fetch，内置版本兜底 |

## 架构与数据流

```
打开 marketplace 视图
  → loadMarketplace()
    → 有本地缓存？ → 用缓存秒开
    → 无缓存？ → 用内置版本秒开（离线可用，不联网）
    → 都没有（dev 环境无 define）？ → 联网 fetch（当前行为）
    → 后台静默 ETag 检查 → 304 不动 / 200 静默替换缓存

r 键（应急强制刷新）
  → force fetch GitHub 最新版 → 覆盖缓存 → 刷新视图
```

### 三层数据源

| 优先级 | 来源 | 何时使用 |
|--------|------|---------|
| 1（最高） | 本地缓存 `~/.cache/mimocode/marketplace.json` | 用户 r 键更新后 |
| 2 | 内置版本 `BUILTIN_MARKETPLACE`（define 常量） | 无缓存时，离线可用 |
| 3（最低） | GitHub 最新版（联网 fetch） | dev 环境或 r 键触发 |

### 为什么不需要容灾备份

marketplace.json 是 Anthropic 维护的**公共目录索引**（插件名+描述+下载指针），不含用户数据。最坏情况（缓存损坏/误删）：
- 回退到内置版本（永远在二进制里，不可能丢）
- 或重新 fetch（r 键 / 后台自动）
- 用户**不丢失任何东西**——已装插件记录在别处（plugin_origins），不受影响

历史版本轮转为不存在的问题增加复杂度（YAGNI）。

## 实现细节

### 改动 1：build.ts 构建时拉取并注入

在 `packages/opencode/script/build.ts`，migrations 加载之后、`Bun.build` 之前，加构建时 fetch：

```ts
let builtinMarketplace: string | undefined
try {
  console.log("Fetching builtin marketplace.json...")
  const resp = await fetch(
    "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json",
    { signal: AbortSignal.timeout(30_000) },
  )
  if (resp.ok) builtinMarketplace = await resp.text()
} catch (e) {
  console.warn("Failed to fetch builtin marketplace, skipping:", e)
}
```

在 `Bun.build` 的 `define` 里加一行（和 `OPENCODE_MIGRATIONS` 并列）：
```ts
define: {
  // ...existing defines...
  BUILTIN_MARKETPLACE: builtinMarketplace ? JSON.stringify(builtinMarketplace) : "undefined",
},
```

- 构建机联网拉取最新版注入，保证内置版本是发布时的最新
- fetch 失败不阻断构建（注入 `undefined` → 运行时回退联网）
- 超时 30s（构建环境比用户端宽松）

### 改动 2：marketplace.ts 声明并使用内置常量

在 `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts` 顶部加声明（参照 `storage/db.ts` 的 `OPENCODE_MIGRATIONS` 模式）：

```ts
declare const BUILTIN_MARKETPLACE: string | undefined
```

`loadMarketplace` 的无缓存分支改为优先用内置版本。当前逻辑（`marketplace.ts` 现有代码）：

```ts
const cache = !options?.force ? await readCache() : undefined
if (cache) { ... return cache ... }
// ↓ 无缓存时直接进入 fetch 逻辑
```

改为：

```ts
const cache = !options?.force ? await readCache() : undefined
if (cache) { ... return cache ... }

// 无缓存：优先用内置版本（秒开，不联网）
if (typeof BUILTIN_MARKETPLACE !== "undefined") {
  return { status: "ready", plugins: parseMarketplaceJson(BUILTIN_MARKETPLACE) }
}
// 到这里说明既无缓存也无内置（dev 环境）→ 走原来的 fetch 逻辑
```

## dev 环境行为

开发时跑 `bun run dev` 不经过 `build.ts`，`BUILTIN_MARKETPLACE` 是 `undefined`，`typeof === "undefined"` 成立 → 走联网 fetch（当前行为）。**对开发流程零影响**，只影响正式构建的二进制。

## 文件变更清单

| 文件 | 改动 | 行数 |
|------|------|------|
| `packages/opencode/script/build.ts` | 构建时 fetch + define 注入 | +12 |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts` | declare + loadMarketplace 内置兜底分支 | +8 |

**不改**：`plugins.tsx`（视图层接口不变）、`marketplace.test.ts`（parser 测试不变）。

## 测试策略

| 测试对象 | 内容 | 方式 |
|---------|------|------|
| `parseMarketplaceJson` | 现有 8 个测试不变 | `bun:test` |
| 内置兜底分支 | dev 环境（undefined）回退 fetch | typecheck（无法在单测模拟 define） |
| 构建注入 | build.ts 改动 | 手动验证（跑 build 确认注入） |

## 复用轮子清单

| 轮子 | 位置 | 用途 |
|------|------|------|
| `OPENCODE_MIGRATIONS` define 模式 | `build.ts:236` + `storage/db.ts:19` | 编译时注入数据的成熟先例 |
| `loadMarketplace` 现有逻辑 | `marketplace.ts` | 缓存/ETag/r 键已就绪，只加内置兜底分支 |
| `parseMarketplaceJson` | `marketplace.ts` | 解析内置 JSON 字符串复用同一解析器 |

## 不在本轮范围

- 目录统一（问题 1）— 全项目重构，单独 spec
- 插件安装功能 — 后续
- 插件本体内置 — 236 个插件大部分在外部仓库，不现实
- 容灾备份/历史版本轮转 — YAGNI，公共数据不需要
