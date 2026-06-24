# 插件市场安装功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TUI marketplace 视图"回车安装"真正生效，跑通"选中 → 下载 → 落盘 → 重启后 Skill 生效"完整闭环（仅相对路径型 source）。

**Architecture:** TUI `onSelect` 三态拦截 → `downloadPlugin`（Git Trees API 列树 + raw 逐文件下载，注入式下载器）下载到 `~/.local/share/mimocode/plugins/<name>/` → `discoverSkills` 新增扫描块发现 SKILL.md → 重启后注入 system prompt。零新依赖。TUI 直接调 `downloadPlugin`（不经过 `installPlugin` 封装——内容插件不需要它，详见 Task 4 说明）。

**Tech Stack:** TypeScript + Bun + bun:test + effect（仅 skill 发现层已用）。测试框架是 `bun:test`（`describe/expect/test`，见 `test/cli/cmd/tui/marketplace.test.ts:1`）。

**Spec:** `docs/superpowers/specs/2026-06-24-marketplace-install-design.md`

---

## 关键约定（实施前必读）

1. **测试位置**：新建测试放在 `packages/opencode/test/cli/cmd/tui/` 下（与 `marketplace.test.ts` 同级），不要放在 `src` 旁边。导入被测模块用相对路径 `../../../../src/...`（照 `marketplace.test.ts:2` 的层数）。
2. **测试运行**：从 `packages/opencode` 目录跑 `bun test test/cli/cmd/tui/marketplace.test.ts`（AGENTS.md 禁止从 repo root 跑测试）。
3. **类型检查**：从 `packages/opencode` 目录跑 `bun run typecheck`（即 `tsgo --noEmit`）。
4. **Filesystem.write 自动建父目录**：已确认 `util/filesystem.ts:59-78` 在 ENOENT 时 `mkdir recursive`，下载器直接用 `Filesystem.write` 写文件即可，无需先建目录。
5. **Flock 需要全局状态**：`Flock.acquire`（`packages/shared/src/util/flock.ts:310`）内部调 `root()`（`flock.ts:19-21`），未 `setGlobal` 时 throw "Flock global not set"。因此下载器把锁做成可注入依赖，单元测试用 no-op 锁。
6. **现有 marketplace 测试要改**：`test/cli/cmd/tui/marketplace.test.ts` 现有 8 个用例断言 `toEqual([{ name, description }])`。Task 1 给 `MarketplacePlugin` 加 `source` 字段后，`toEqual` 会因多出字段而失败。Task 1 同步更新这些用例（给期望对象补 `source: undefined`，或改用 `toMatchObject`）。
7. **isRecord 工具**：`src/util/record.ts:1` 导出 `isRecord(value)`，用于 source 字段的 record 判定。

---

## File Structure

| 文件 | 责任 | 性质 |
|------|------|------|
| `src/cli/cmd/tui/feature-plugins/system/marketplace.ts` | marketplace.json 解析：保留 source 字段 + `parsePluginSource` 纯函数 + `MarketplaceSource` 类型 | 改造 |
| `src/plugin-marketplace/downloader.ts` | 下载器：Git Trees API 列树 + raw 逐文件下载 + 文件锁 + 跳过式幂等 | 新建 |
| `src/skill/index.ts` | discoverSkills 新增 marketplace 插件 scan 块 | 改造（+4 行） |
| `src/cli/cmd/tui/feature-plugins/system/plugins.tsx` | MarketplaceView：onSelect 三态拦截 + doInstall + installing 信号 + plugins memo | 改造 |
| `test/cli/cmd/tui/marketplace.test.ts` | parsePluginSource 四形态单测 + 更新现有用例 | 改造/新增用例 |
| `test/cli/cmd/tui/downloader.test.ts` | 下载器树过滤 + 幂等 + 错误单测 | 新建 |

**不改**：`plugin/install.ts`（复用 dep 注入）、`plugin/shared.ts`、`plugin/loader.ts`、`build.ts`、`config/`。

---

## Task 1: marketplace.ts 保留 source 字段 + parsePluginSource 纯函数

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts`
- Modify: `packages/opencode/test/cli/cmd/tui/marketplace.test.ts`

**注意**：本 task 会改 `MarketplacePlugin` 类型，导致现有 8 个测试用例失败，必须同步更新。

- [ ] **Step 1: 先更新现有测试（让它反映新结构，此时会失败）**

打开 `packages/opencode/test/cli/cmd/tui/marketplace.test.ts`，做两处改动：

(a) 在文件末尾 `describe("parseMarketplaceJson", ...)` 块内，把所有 `toEqual([{ name, description }])` 的期望对象补上 `source` 字段。具体——把这几处：

```ts
expect(parseMarketplaceJson(raw)).toEqual([
  { name: "frontend-design", description: "Build distinctive UI" },
  { name: "pdf", description: "Generate PDF documents" },
])
```
改为：
```ts
expect(parseMarketplaceJson(raw)).toEqual([
  { name: "frontend-design", description: "Build distinctive UI", source: undefined },
  { name: "pdf", description: "Generate PDF documents", source: undefined },
])
```

同理修改：
- "defaults missing description to empty string" 用例：`{ name: "no-desc", description: "", source: undefined }`
- "filters out entries without a name" 用例：`{ name: "valid", description: "ok", source: undefined }`
- "filters out null entries without throwing" 用例：`{ name: "valid", description: "ok", source: undefined }`
- "defaults non-string description to empty" 用例：`{ name: "x", description: "", source: undefined }`

"returns empty array when plugins array is empty"、"treats non-array plugins as empty"、"throws on invalid JSON" 这三个用例不涉及对象字段，不改。

(b) 在文件末尾新增 `parsePluginSource` 的 describe 块：

```ts
import { parseMarketplaceJson, parsePluginSource } from "../../../../src/cli/cmd/tui/feature-plugins/system/marketplace"

describe("parsePluginSource", () => {
  test("parses relative path string", () => {
    expect(parsePluginSource("./plugins/frontend-design")).toEqual({
      kind: "relative",
      path: "./plugins/frontend-design",
    })
  })

  test("parses url source object", () => {
    const raw = { source: "url", url: "https://github.com/x/y.git", sha: "abc123" }
    expect(parsePluginSource(raw)).toEqual({
      kind: "url",
      url: "https://github.com/x/y.git",
      sha: "abc123",
    })
  })

  test("parses git-subdir source object", () => {
    const raw = {
      source: "git-subdir",
      url: "https://github.com/x/skills.git",
      path: "plugins/airtable",
      ref: "main",
      sha: "295ab93b",
    }
    expect(parsePluginSource(raw)).toEqual({
      kind: "git-subdir",
      url: "https://github.com/x/skills.git",
      path: "plugins/airtable",
      sha: "295ab93b",
    })
  })

  test("parses github source object", () => {
    const raw = { source: "github", repo: "fullstorydev/fullstory-skills", commit: "1ec5865e" }
    expect(parsePluginSource(raw)).toEqual({
      kind: "github",
      repo: "fullstorydev/fullstory-skills",
    })
  })

  test("returns undefined for non-relative string without ./", () => {
    expect(parsePluginSource("https://example.com/foo")).toBeUndefined()
    expect(parsePluginSource("plain-name")).toBeUndefined()
  })

  test("returns undefined for unknown source discriminator", () => {
    expect(parsePluginSource({ source: "unknown", url: "x" })).toBeUndefined()
  })

  test("returns undefined for undefined/null/non-record", () => {
    expect(parsePluginSource(undefined)).toBeUndefined()
    expect(parsePluginSource(null)).toBeUndefined()
    expect(parsePluginSource("")).toBeUndefined()
    expect(parsePluginSource(42)).toBeUndefined()
    expect(parsePluginSource([])).toBeUndefined()
  })
})
```

注意顶部 import 行（`marketplace.test.ts:2`）要从单导入改为同时导入 `parsePluginSource`：
```ts
import { parseMarketplaceJson, parsePluginSource } from "../../../../src/cli/cmd/tui/feature-plugins/system/marketplace"
```

- [ ] **Step 2: 运行测试确认失败**

从 `packages/opencode` 目录运行：
```bash
bun test test/cli/cmd/tui/marketplace.test.ts
```
Expected: FAIL。原因：`parsePluginSource` 未导出（ImportError），且现有用例期望的 `source` 字段不存在。

- [ ] **Step 3: 实现 marketplace.ts 改动**

打开 `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts`。

(a) 在顶部 import 区（`marketplace.ts:1-3` 之后）加 isRecord：
```ts
import { isRecord } from "@/util/record"
```

(b) 把 `RawMarketplaceEntry`（`marketplace.ts:8-11`）改为带 source：
```ts
interface RawMarketplaceEntry {
  name: string
  description?: string
  source?: unknown
}
```

(c) 把 `MarketplacePlugin`（`marketplace.ts:13-16`）改为带 source：
```ts
export interface MarketplacePlugin {
  name: string
  description: string
  source: MarketplaceSource | undefined
}
```

(d) 在 `MarketplacePlugin` 之后、`LoadResult` 之前插入 `MarketplaceSource` 类型和 `parsePluginSource` 函数：
```ts
// 解析后的来源描述（discriminated union）。
// 刻意区别于 shared.ts 的 PluginSource（"file"|"npm"，描述代码插件安装来源）；
// MarketplaceSource 描述 marketplace.json 条目 source 字段的形态，不可混用。
export type MarketplaceSource =
  | { kind: "relative"; path: string }
  | { kind: "url"; url: string; sha?: string }
  | { kind: "git-subdir"; url: string; path?: string; sha?: string }
  | { kind: "github"; repo: string; sha?: string }

// 解析 marketplace.json 条目的 source 字段为 MarketplaceSource。
// 纯函数，可单测。覆盖 4 种形态 + 无 source / 畸形值兜底 undefined。
export function parsePluginSource(raw: unknown): MarketplaceSource | undefined {
  if (typeof raw === "string" && raw.startsWith("./")) {
    return { kind: "relative", path: raw }
  }
  if (!isRecord(raw)) return
  const kind = raw.source
  if (typeof kind !== "string") return

  if (kind === "url") {
    const url = raw.url
    if (typeof url !== "string") return
    const sha = typeof raw.sha === "string" ? raw.sha : undefined
    return { kind: "url", url, sha }
  }
  if (kind === "git-subdir") {
    const url = raw.url
    if (typeof url !== "string") return
    const sub = typeof raw.path === "string" ? raw.path : undefined
    const sha = typeof raw.sha === "string" ? raw.sha : undefined
    return { kind: "git-subdir", url, path: sub, sha }
  }
  if (kind === "github") {
    const repo = raw.repo
    if (typeof repo !== "string") return
    const sha = typeof raw.sha === "string" ? raw.sha : undefined
    return { kind: "github", repo, sha }
  }
}
```

(e) 把 `parseMarketplaceJson` 的 map（`marketplace.ts:33-36`）改为带上 source：
```ts
    .map((entry) => ({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
      source: parsePluginSource(entry.source),
    }))
```

- [ ] **Step 4: 运行测试确认通过**

从 `packages/opencode` 目录运行：
```bash
bun test test/cli/cmd/tui/marketplace.test.ts
```
Expected: PASS，所有用例（含新增的 7 个 parsePluginSource 用例）通过。

- [ ] **Step 5: 类型检查**

从 `packages/opencode` 目录运行：
```bash
bun run typecheck
```
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts packages/opencode/test/cli/cmd/tui/marketplace.test.ts
git commit -m "feat: preserve marketplace source field + parsePluginSource"
```

---

## Task 2: 下载器 downloader.ts

**Files:**
- Create: `packages/opencode/src/plugin-marketplace/downloader.ts`
- Create: `packages/opencode/test/cli/cmd/tui/downloader.test.ts`

下载器是核心模块。依赖注入设计使它完全可单测（mock fetch/write/exists/lock）。

**关键设计**：
- Git Trees API：`GET https://api.github.com/repos/anthropics/claude-plugins-official/git/trees/main?recursive=1`，返回 `{ tree: [{ path, type }, ...] }`。
- 过滤：`path` 以 `<repo-relative-dir>/` 开头且 `type === "blob"`。repo-relative-dir 由 source.path（如 `./plugins/foo`）去掉 `./` 得到 `plugins/foo`。
- 下载：每个 blob 用 `GET https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/<path>`，写盘到 `<pluginsDir>/<name>/<path 去掉前缀>`。
- 幂等：`<pluginsDir>/<name>` 存在 → 跳过返回成功。
- 锁：`DownloadDeps.lock` 注入，默认用 `Flock.withLock`。

- [ ] **Step 1: 写失败测试**

创建 `packages/opencode/test/cli/cmd/tui/downloader.test.ts`：

```ts
import { describe, expect, test } from "bun:test"
import path from "path"
import {
  downloadPlugin,
  type DownloadDeps,
} from "../../../../src/plugin-marketplace/downloader"

// 把 / 分隔的预期路径转成当前平台分隔符，便于跨平台断言
function p(file: string): string {
  return file.split("/").join(path.sep)
}

// no-op 锁，测试不涉及并发
const noopLock = async (_key: string) => ({ [Symbol.asyncDispose]: async () => {} })

describe("downloadPlugin", () => {
  test("filters tree by plugin dir and downloads blobs only", async () => {
    const tree = {
      tree: [
        { path: "plugins/foo/skills/foo/SKILL.md", type: "blob" },
        { path: "plugins/foo/README.md", type: "blob" },
        { path: "plugins/bar/skills/bar/SKILL.md", type: "blob" },
        { path: "plugins/foo/sub", type: "tree" },
      ],
    }
    const fetched: string[] = []
    const wrote: string[] = []
    const deps: DownloadDeps = {
      fetch: (async (url: string | URL | Request) => {
        fetched.push(url.toString())
        return new Response("content")
      }) as typeof fetch,
      write: async (file) => {
        wrote.push(file)
      },
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
    }

    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dir).toBe(p("/tmp/plugins/foo"))
    expect(result.skipped).toBe(false)
    expect(fetched).toHaveLength(2)
    expect(wrote).toEqual([
      p("/tmp/plugins/foo/plugins/foo/skills/foo/SKILL.md"),
      p("/tmp/plugins/foo/plugins/foo/README.md"),
    ])
  })

  test("skips download when target dir already exists", async () => {
    const fetched: string[] = []
    const wrote: string[] = []
    const deps: DownloadDeps = {
      fetch: (async () => {
        throw new Error("should not fetch")
      }) as typeof fetch,
      write: async () => {
        throw new Error("should not write")
      },
      exists: async (file) => file === p("/tmp/plugins/foo"),
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
    }

    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skipped).toBe(true)
    expect(fetched).toHaveLength(0)
    expect(wrote).toHaveLength(0)
  })

  test("returns tree_fetch_failed when trees API errors", async () => {
    const deps: DownloadDeps = {
      fetch: (async () => {
        return new Response("rate limited", { status: 403 })
      }) as typeof fetch,
      write: async () => {},
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
    }

    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("tree_fetch_failed")
  })

  test("returns no_files when plugin dir has no blobs in tree", async () => {
    const tree = {
      tree: [{ path: "plugins/bar/x.md", type: "blob" }],
    }
    const deps: DownloadDeps = {
      fetch: (async (url: string | URL | Request) => {
        const s = url.toString()
        if (s.includes("/git/trees/")) return Response.json(tree)
        return new Response("content")
      }) as typeof fetch,
      write: async () => {},
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
    }

    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("no_files")
  })

  test("returns file_download_failed when a blob fetch errors", async () => {
    const tree = {
      tree: [{ path: "plugins/foo/SKILL.md", type: "blob" }],
    }
    const deps: DownloadDeps = {
      fetch: (async (url: string | URL | Request) => {
        const s = url.toString()
        if (s.includes("/git/trees/")) return Response.json(tree)
        return new Response("err", { status: 500 })
      }) as typeof fetch,
      write: async () => {},
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
    }

    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("file_download_failed")
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

从 `packages/opencode` 目录运行：
```bash
bun test test/cli/cmd/tui/downloader.test.ts
```
Expected: FAIL，模块 `src/plugin-marketplace/downloader` 不存在（ImportError）。

- [ ] **Step 3: 实现 downloader.ts**

创建 `packages/opencode/src/plugin-marketplace/downloader.ts`：

```ts
import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { Flock } from "@mimo-ai/shared/util/flock"
import type { MarketplaceSource } from "@/cli/cmd/tui/feature-plugins/system/marketplace"

// 本轮硬编码的 marketplace 仓库（多市场支持留后续）
const MARKETPLACE_OWNER = "anthropics"
const MARKETPLACE_REPO = "claude-plugins-official"
const MARKETPLACE_REF = "main"

const FETCH_TIMEOUT_MS = 30_000

export type DownloadDeps = {
  fetch: typeof fetch
  write: (file: string, data: Uint8Array) => Promise<void>
  exists: (file: string) => Promise<boolean>
  pluginsDir: string
  // 可注入的锁，测试用 no-op；默认用 Flock.withLock（需 Flock global 已初始化）
  lock: (key: string) => Promise<AsyncDisposable>
}

export type DownloadResult =
  | { ok: true; dir: string; skipped: boolean }
  | { ok: false; code: "tree_fetch_failed" | "no_files" | "file_download_failed"; error?: unknown }

const defaultDeps: DownloadDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  write: (file, data) => Filesystem.write(file, data),
  exists: (file) => Filesystem.exists(file),
  pluginsDir: path.join(Global.Path.data, "plugins"),
  lock: (key) => Flock.acquire(`plugin-install:${key}`),
}

// 标准化 source.path（如 "./plugins/foo"）为仓库内相对路径（"plugins/foo"），用于 tree 过滤和 raw URL
function repoRelative(source: { kind: "relative"; path: string }) {
  return source.path.replace(/^\.\//, "")
}

// Git Trees API 返回的条目
interface TreeEntry {
  path: string
  type: string
}

interface TreeResponse {
  tree: TreeEntry[]
  truncated?: boolean
}

// 下载相对路径型插件到 pluginsDir/<name>/。
// 跳过式幂等：目标目录已存在则直接返回成功。
export async function downloadPlugin(
  name: string,
  source: { kind: "relative"; path: string },
  dep: DownloadDeps = defaultDeps,
): Promise<DownloadResult> {
  const dir = path.join(dep.pluginsDir, name)

  // 跳过式幂等
  if (await dep.exists(dir)) {
    return { ok: true, dir, skipped: true }
  }

  return dep.lock(name).then(
    async (lockHandle) => {
      await using _ = lockHandle
      return runDownload(name, source, dir, dep)
    },
    (error: unknown) => ({ ok: false, code: "tree_fetch_failed" as const, error }),
  )
}

async function runDownload(
  name: string,
  source: { kind: "relative"; path: string },
  dir: string,
  dep: DownloadDeps,
): Promise<DownloadResult> {
  const prefix = repoRelative(source)
  const treesUrl = `https://api.github.com/repos/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/git/trees/${MARKETPLACE_REF}?recursive=1`

  let resp: Response
  try {
    resp = await dep.fetch(treesUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }
  if (!resp.ok) {
    return { ok: false, code: "tree_fetch_failed", error: new Error(`trees API HTTP ${resp.status}`) }
  }

  let data: TreeResponse
  try {
    data = (await resp.json()) as TreeResponse
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }

  // 只保留插件目录下的 blob（排除其他插件、排除 tree 节点）
  const blobs = (data.tree ?? []).filter(
    (entry) => entry.type === "blob" && entry.path.startsWith(prefix + "/"),
  )
  if (!blobs.length) {
    return { ok: false, code: "no_files" }
  }

  // 逐文件下载。任一失败立即中止。
  for (const entry of blobs) {
    const rawUrl = `https://raw.githubusercontent.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/${MARKETPLACE_REF}/${entry.path}`
    let fileResp: Response
    try {
      fileResp = await dep.fetch(rawUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (error) {
      return { ok: false, code: "file_download_failed", error }
    }
    if (!fileResp.ok) {
      return {
        ok: false,
        code: "file_download_failed",
        error: new Error(`raw HTTP ${fileResp.status} for ${entry.path}`),
      }
    }
    const buf = new Uint8Array(await fileResp.arrayBuffer())
    // 落盘路径：pluginsDir/<name>/<完整 entry.path>，保留插件在仓库内的目录结构
    await dep.write(path.join(dir, entry.path), buf)
  }

  return { ok: true, dir, skipped: false }
}
```

- [ ] **Step 4: 运行测试确认通过**

从 `packages/opencode` 目录运行：
```bash
bun test test/cli/cmd/tui/downloader.test.ts
```
Expected: PASS，5 个用例全过。

- [ ] **Step 5: 类型检查**

从 `packages/opencode` 目录运行：
```bash
bun run typecheck
```
Expected: 无错误。注意 `MarketplaceSource` 类型从 marketplace.ts 导入，确认 import 路径解析正常（`@/cli/cmd/tui/feature-plugins/system/marketplace`）。

- [ ] **Step 6: 提交**

```bash
git add packages/opencode/src/plugin-marketplace/downloader.ts packages/opencode/test/cli/cmd/tui/downloader.test.ts
git commit -m "feat: add plugin marketplace downloader (git trees + raw fetch)"
```

---

## Task 3: Skill 发现扩展

**Files:**
- Modify: `packages/opencode/src/skill/index.ts`（在 `discoverSkills` 内 `configDirs` 扫描之后）

这是最小改动（+4 行），无新增测试（依赖 effect 运行时，手动验证）。

- [ ] **Step 1: 改 skill/index.ts**

打开 `packages/opencode/src/skill/index.ts`。定位 `discoverSkills` 函数内 configDirs 扫描块（约 `index.ts:190-193`）：

```ts
  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, MIMOCODE_SKILL_PATTERN)
  }
```

在这块之后、`const cfg = yield* config.get()`（约 `index.ts:195`）之前，插入：

```ts
  // marketplace 已安装内容插件（用户主动安装，默认发现，无禁用开关）
  const pluginsRoot = path.join(Global.Path.data, "plugins")
  if (yield* fsys.isDir(pluginsRoot)) {
    yield* scan(state, pluginsRoot, "*/skills/**/SKILL.md", { scope: "marketplace" })
  }
```

确认 `path` 和 `Global` 已在顶部 import（`index.ts:2-3,11` 已有 `import path` 和 `import { Global }`，无需新增 import）。

- [ ] **Step 2: 类型检查**

从 `packages/opencode` 目录运行：
```bash
bun run typecheck
```
Expected: 无错误。`scan` 签名（`index.ts:118`）接受 `(state, root, pattern, opts?)`，`fsys.isDir` 已在其他地方用，类型匹配。

- [ ] **Step 3: 运行现有 skill 相关测试确认无回归**

从 `packages/opencode` 目录运行：
```bash
bun test test/skill
```
Expected: 现有 skill 测试全过（新增的 scan 块仅在 `pluginsRoot` 目录存在时触发，不影响现有测试环境）。

- [ ] **Step 4: 提交**

```bash
git add packages/opencode/src/skill/index.ts
git commit -m "feat: discover skills from installed marketplace plugins"
```

---

## Task 4: TUI onSelect 接入真实安装

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`

无单测（依赖 opentui 运行时），靠类型检查 + 手动 E2E 验证。

- [ ] **Step 1: 改 plugins.tsx**

打开 `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`。

(a) 在顶部 import 区（`plugins.tsx:1-8`）补一个导入。现有第 8 行：
```ts
import { loadMarketplace, type LoadResult, type MarketplacePlugin } from "./marketplace"
```
保持不变。在其后新增：
```ts
import { downloadPlugin } from "@/plugin-marketplace/downloader"
```

注意：不导入 `installPlugin`。内容插件不需要它——`installPlugin`（`install.ts:259-281`）内部只调 `dep.resolve(spec)` 然后包成 `{ok, target}`，对内容插件（靠固定目录扫描、不写 config、不走代码加载）没有附加价值。直接调 `downloadPlugin` 更直接，且能拿到 `skipped` 标记用于区分 toast。

(b) 在 `MarketplaceView` 函数内（`plugins.tsx:245` 起的函数体），在 `gen` 变量声明（约 `plugins.tsx:256`）之前，新增 `installing` 信号和 `plugins` memo：

定位现有的 `marketState` signal 声明（约 `plugins.tsx:248-252`）：
```ts
  const [marketState, setMarketState] = createSignal<
    | { status: "loading" }
    | { status: "ready"; plugins: MarketplacePlugin[] }
    | { status: "error"; message: string }
  >({ status: "loading" })
```
在其后插入：
```ts
  const [installing, setInstalling] = createSignal<string | undefined>()
  const plugins = createMemo(() => {
    const s = marketState()
    return s.status === "ready" ? s.plugins : []
  })
```

(c) 在 `doRefresh` 函数（约 `plugins.tsx:296-300`）之后，新增 `doInstall`。直接调 `downloadPlugin`，根据 `skipped` 区分 toast：
```ts
  async function doInstall(plugin: MarketplacePlugin) {
    if (installing()) return
    setInstalling(plugin.name)
    props.api.ui.toast({ variant: "info", message: `正在安装 ${plugin.name}...` })

    // source 由 onSelect 保证为 relative（非 relative 已被拦截）
    const source = plugin.source as { kind: "relative"; path: string }
    const result = await downloadPlugin(plugin.name, source)

    setInstalling(undefined)

    if (!result.ok) {
      props.api.ui.toast({ variant: "error", message: `安装失败：${result.code}` })
      return
    }
    if (result.skipped) {
      props.api.ui.toast({ variant: "info", message: `${plugin.name} 已安装，无需重复安装` })
      return
    }
    props.api.ui.toast({ variant: "success", message: `已安装 ${plugin.name}，重启后生效` })
  }
```

(d) 把 `onSelect`（约 `plugins.tsx:328-330`，当前是占位 toast）改为三态拦截：
```ts
      onSelect={(item) => {
        const plugin = plugins().find((p) => p.name === item.value)
        if (!plugin?.source) {
          props.api.ui.toast({ variant: "info", message: "此插件无来源信息" })
          return
        }
        if (plugin.source.kind !== "relative") {
          props.api.ui.toast({
            variant: "warning",
            message: `暂不支持 ${plugin.source.kind} 格式，仅支持 marketplace 内置插件`,
          })
          return
        }
        void doInstall(plugin)
      }}
```

- [ ] **Step 2: 类型检查**

从 `packages/opencode` 目录运行：
```bash
bun run typecheck
```
Expected: 无错误。重点确认：
- `downloadPlugin` 导入路径 `@/plugin-marketplace/downloader` 解析正常。
- `doInstall` 里 `plugin.source as { kind: "relative"; path: string }` 的断言合法（`MarketplaceSource` 的 relative 变体确实是这个形状）。
- `result.skipped` 在 `result.ok` 收窄后可访问（`DownloadResult` 成功分支带 `skipped: boolean`）。
- `createMemo` 已在顶部 import（`plugins.tsx:6` 现有 `import { ... createMemo ... } from "solid-js"`，无需新增）。

- [ ] **Step 3: 手动 E2E 验证（完整闭环）**

这一步需要真实网络和 TUI 运行。从 `packages/opencode` 目录启动 dev：
```bash
bun run dev
```

在 TUI 里：
1. 打开命令面板 → 选 "marketplace"（或对应 i18n 标题）
2. 等待列表加载（ready 态）
3. 选中 `frontend-design`（相对路径型插件）→ 回车
4. 观察 toast：应先 "正在安装..."，后 "已安装 frontend-design，重启后生效"
5. 检查落盘：`~/.local/share/mimocode/plugins/frontend-design/` 目录应存在，含 `plugins/frontend-design/...` 子结构
6. 退出 TUI，重新 `bun run dev`
7. 确认 frontend-design skill 出现在可用 skills 中（可用 `/skill` 命令或在 agent 对话中触发）

同时验证拦截路径：
8. 找一个 url 或 git-subdir 型插件（列表里 description 通常无标记，需从 marketplace.json 确认哪个是 url 型）→ 回车 → 应 toast "暂不支持 ... 格式"

Expected: 步骤 4-7 成功，步骤 8 正确拦截不崩溃。

- [ ] **Step 4: 提交**

```bash
git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx
git commit -m "feat(tui): wire marketplace onSelect to real plugin install"
```

---

## Task 5: 最终验证

- [ ] **Step 1: 全量类型检查**

从 `packages/opencode` 目录运行：
```bash
bun run typecheck
```
Expected: 无错误。

- [ ] **Step 2: 跑本轮新增/改动的测试**

从 `packages/opencode` 目录运行：
```bash
bun test test/cli/cmd/tui/marketplace.test.ts test/cli/cmd/tui/downloader.test.ts
```
Expected: 全过。

- [ ] **Step 3: 跑 skill 相关测试确认无回归**

从 `packages/opencode` 目录运行：
```bash
bun test test/skill
```
Expected: 现有测试全过。

- [ ] **Step 4: 跑 plugin 相关测试确认无回归**

从 `packages/opencode` 目录运行：
```bash
bun test test/cli/tui/plugin-install.test.ts test/cli/tui/plugin-loader.test.ts test/cli/tui/plugin-add.test.ts
```
Expected: 现有测试全过（本轮没改 plugin/install.ts 和 loader.ts，应无影响）。

- [ ] **Step 5: 确认所有改动已提交**

```bash
git status
```
Expected: 工作区干净（或仅剩无关的已有未跟踪文件）。
