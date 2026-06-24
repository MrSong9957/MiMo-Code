# 插件市场安装功能设计

**日期**：2026-06-24
**状态**：已确认
**前置**：
- `2026-06-22-mimo-plugin-marketplace-design.md`（总体设计，含 source 4 形态分析）
- `2026-06-24-marketplace-real-data-design.md`（实时拉取，已完成）
- `2026-06-24-marketplace-builtin-design.md`（内置兜底，已完成）

---

## 背景

前序工作已完成 marketplace 的**浏览能力**：TUI 视图可浏览/搜索 ~200 个插件（`plugins.tsx` 的 `MarketplaceView`）、实时拉取 marketplace.json（带缓存+ETag）、构建时内置兜底（离线秒开）。

**当前缺口**：TUI 选中插件时，`onSelect` 只弹 `toast({ message: "Install coming soon" })` 占位（`plugins.tsx:329`）。数据结构 `MarketplacePlugin` 只有 `name + description`，**没有 source 字段**，无法下载。本设计补上"真实安装"这最后一段。

## 目标

让 TUI marketplace 视图的"回车安装"真正生效，跑通完整闭环：

```
TUI 选中插件
  → 用 Git Trees API 列文件树
  → raw 逐文件下载到 ~/.local/share/mimocode/plugins/<name>/
  → Skill 发现扫描该目录
  → 重启后 SKILL.md 注入 system prompt 生效
```

## 范围

### 本轮覆盖

- **相对路径型 source**（51/234 插件，如 frontend-design）：source 是 `"./plugins/<name>"` 字符串，插件目录在 marketplace 仓库内部。
- **仅 TUI 接入**：复用 `MarketplaceView` 的 onSelect。
- **仅 Skill 类插件**：下载后靠 Skill 发现机制生效。

### 不在本轮范围

| 不做项 | 原因 |
|--------|------|
| url / git-subdir / github 型 source | 需 tarball 解压或 git clone，工程量显著增加（181/234 插件），下轮覆盖 |
| `.mcp.json` 合并到 mimocode.jsonc | 需 `ConfigMCP.fromClaude` 转换 + 批量合并编排，独立子任务 |
| `mimo plugin install/uninstall/list` CLI 子命令 | 本轮聚焦 TUI 闭环验证 |
| 卸载 | 需删目录 + 清理 plugin_origins，下轮 |
| 热加载（不重启即生效） | 本轮靠重启触发 discoverSkills 重扫；reload() 机制存在但本轮不接 |
| 已装标记（✓） | 若实现成本极低则附带，否则留后续 |
| 多市场源（marketplace add/remove） | 本轮硬编码 anthropics/claude-plugins-official |
| 插件更新 | 跳过式幂等，需先卸载才能重装 |

## 已确认的设计决策

| 维度 | 决策 |
|------|------|
| source 覆盖范围 | 仅相对路径型（51/234） |
| 接入层 | 仅 TUI（onSelect 改造） |
| Skill 发现方式 | 固定目录扫描（`~/.local/share/mimocode/plugins/`），不写 config |
| 幂等策略 | 跳过式：目标目录已存在 → 直接返回成功（不覆盖） |
| 下载方式 | Git Trees API（`recursive=1`）列树 + raw.githubusercontent.com 逐文件下载 |
| 依赖 | 零新依赖（纯 fetch，不引 tar、不调 git） |
| 部分失败处理 | 任一文件下载失败 → 整体中止，不保留半成品 |
| 配置写入 | 无（靠固定目录扫描，无需声明到 plugin 数组或 skills.paths） |

## 复用轮子清单

调查确认以下现有代码可直接复用，是本设计的基础：

| 轮子 | 位置 | 复用价值 |
|------|------|---------|
| **`InstallDeps.resolve` 依赖注入** | `plugin/install.ts:26-28,259` | 最干净的扩展点：实现 `(spec) => Promise<string>` 下载器注入即可，installPlugin 本体不动 |
| `Flock` 文件锁 | `@mimo-ai/shared/util/flock`、`install.ts:347` | 并发安装保护，照搬 `install.ts` 用法 |
| `scan()` 扫描降级 | `skill/index.ts:118-146` | Skill 发现的扫描原语，支持 scope 降级（只 log 不 die） |
| `fsys.isDir()` | `skill/index.ts` 多处 | 幂等目录检查 |
| `ConfigMarkdown.parse` | `skill/index.ts:79` | SKILL.md frontmatter 解析（已有，下载后自动复用） |
| `marketplace.ts` fetch+缓存 | `marketplace.ts:60-107` | marketplace.json 获取链路已通，本轮只扩展解析 |
| `Global.Path.data` | `shared/global.ts:11,45` | 插件落盘根目录 `~/.local/share/mimocode/` |
| `BUILTIN_MARKETPLACE` 内置兜底 | `marketplace.ts:6` | 离线浏览已有，安装仍需联网（下载插件本体） |

---

## 架构与数据流

```
TUI marketplace 视图（MarketplaceView）
  │
  ├─ loadMarketplace()                          [已有]
  │   → parseMarketplaceJson() 保留 source 字段  [改造：第1节]
  │
  ├─ onSelect(plugin)                           [改造：第4节]
  │   ├─ plugin.source 缺失 → toast "无来源信息"
  │   ├─ source.kind !== "relative" → toast "暂不支持该格式"
  │   └─ relative 型 → doInstall(plugin)
  │        │
  │        └─ installPlugin(name, { resolve: () => downloadPlugin(...) })
  │             │
  │             └─ downloadPlugin(name, source)  [新建：第2节]
  │                  ├─ Flock.acquire("plugin-install:<name>")
  │                  ├─ 目录已存在 → 跳过返回成功
  │                  ├─ GET api.github.com/.../git/trees/main?recursive=1
  │                  ├─ 过滤 tree：path 以 "plugins/<name>/" 开头 + type=="blob"
  │                  ├─ 逐文件 GET raw.githubusercontent.com/.../<path>
  │                  ├─ 写盘到 ~/.local/share/mimocode/plugins/<name>/<相对路径>
  │                  └─ 返回 { ok, dir }
  │
  └─ toast 反馈（成功/失败/已存在）

重启 TUI 后
  → discoverSkills()                            [改造：第3节]
  → 新增 scan 块扫描 plugins/*/skills/**/SKILL.md
  → SKILL.md 注入 system prompt
```

---

## 第 1 节：数据结构改造（source 字段透传）

**文件**：`packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts`

当前 `parseMarketplaceJson`（`marketplace.ts:25-37`）只取 `name + description`，丢弃 source。需保留并解析它。

### 改动

```ts
// marketplace.json 原始条目（现在保留 source）
interface RawMarketplaceEntry {
  name: string
  description?: string
  source?: unknown   // 新增：透传不丢弃
}

// 映射后给视图用的条目（新增 source 字段）
export interface MarketplacePlugin {
  name: string
  description: string
  source: MarketplaceSource | undefined   // 新增
}

// 解析后的来源描述（discriminated union）
// 注意：此类型名为 MarketplaceSource，刻意区别于 shared.ts:36 的 PluginSource（"file"|"npm"）。
// 两者语义不同：shared 的 PluginSource 描述代码插件的安装来源；
// MarketplaceSource 描述 marketplace.json 条目的 source 字段形态。不可混用。
export type MarketplaceSource =
  | { kind: "relative"; path: string }                                  // 本次支持
  | { kind: "url"; url: string; sha?: string }                          // 识别但不支持
  | { kind: "git-subdir"; url: string; path?: string; sha?: string }    // 识别但不支持
  | { kind: "github"; repo: string; sha?: string }                      // 识别但不支持

// 新增纯函数：解析 marketplace.json 的 source 字段为 MarketplaceSource
// 纯函数，可单测。覆盖四种形态 + 无 source / 畸形值兜底 undefined。
export function parsePluginSource(raw: unknown): MarketplaceSource | undefined
```

`parseMarketplaceJson` 在 map 时调用 `parsePluginSource(entry.source)`，结果存入 `MarketplacePlugin.source`。

### source 字段四种形态的判定规则

（依据 `2026-06-22-mimo-plugin-marketplace-design.md:148-189` 对 claude-plugins-official 的真实分析）

| marketplace.json 中的形态 | 判定 | 映射 |
|--------------------------|------|------|
| `"./plugins/foo"`（字符串，以 `./` 开头） | `typeof === "string" && startsWith("./")` | `{ kind: "relative", path: raw }` |
| `{ "source": "url", "url": "..." }` | `isRecord && raw.source === "url"` | `{ kind: "url", url, sha }` |
| `{ "source": "git-subdir", "url", "path", ... }` | `isRecord && raw.source === "git-subdir"` | `{ kind: "git-subdir", ... }` |
| `{ "source": "github", "repo": "..." }` | `isRecord && raw.source === "github"` | `{ kind: "github", repo, ... }` |
| 无 source / 非上述形态 | — | `undefined` |

---

## 第 2 节：下载器（核心模块）

**文件**：`packages/opencode/src/plugin-marketplace/downloader.ts`（新建）

职责单一：给定相对路径型 source，把插件目录下载到本地。

### 下载策略

对 `anthropics/claude-plugins-official` 仓库，source 是相对路径（如 `./plugins/frontend-design`）。

1. **列树**：`GET https://api.github.com/repos/anthropics/claude-plugins-official/git/trees/main?recursive=1`
   - 一个 API 调用拿到全仓库文件树（7MB 上限，远超单个插件目录）。
   - 比 Contents API 的逐目录递归更省 rate limit（后者每目录一次调用）。
2. **过滤**：只保留 `tree[].path` 以 `plugins/<name>/` 开头、`type === "blob"` 的条目。
3. **下载**：对每个 blob，`GET https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/<path>`，写盘到 `~/.local/share/mimocode/plugins/<name>/<相对路径>`。
4. **返回**：落地根目录。

### 接口

```ts
export type DownloadDeps = {
  fetch: typeof fetch
  write: (file: string, data: Uint8Array) => Promise<void>
  exists: (file: string) => Promise<boolean>
  pluginsDir: string          // 默认 path.join(Global.Path.data, "plugins")
}

export type DownloadResult =
  | { ok: true; dir: string }
  | { ok: false; code: "tree_fetch_failed" | "no_files" | "file_download_failed"; error?: unknown }

// 主入口
export async function downloadPlugin(
  name: string,
  source: { kind: "relative"; path: string },
  dep?: DownloadDeps,
): Promise<DownloadResult>
```

### 默认 deps

```ts
const defaultDeps: DownloadDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  write: (file, data) => Filesystem.write(file, data),
  exists: (file) => Filesystem.exists(file),
  pluginsDir: path.join(Global.Path.data, "plugins"),
}
```

### 关键设计点

1. **零新依赖**：纯 `fetch`（Trees API 返回 JSON，raw 下载返回文本/二进制）。不引 `tar`、不调系统 git。
2. **文件锁**：`Flock.acquire(\`plugin-install:${name}\`)` 防并发安装同一插件（照搬 `install.ts:347` 模式）。
3. **跳过式幂等**：目标目录已存在 → 直接返回成功 `{ ok: true, dir }`。配合将来的"卸载删目录"形成正确的装/卸循环；更新不在本轮范围。
4. **强制超时**：每个 fetch 带 `AbortSignal.timeout(30_000)`。
5. **路径解析**：source.path 形如 `./plugins/foo`，标准化去掉 `./` 前缀得到仓库内相对路径 `plugins/foo`，用于 tree 过滤和 raw URL 拼接。
6. **仓库硬编码**：`anthropics/claude-plugins-official`，main 分支。多市场支持留后续。
7. **部分失败**：任一文件下载失败 → 立即中止，返回 `{ ok: false, code: "file_download_failed", error }`。不保留半成品（但不清理已下载部分，YAGNI）。
8. **写盘建目录**：`Filesystem.write` 需能自动建父目录（`Filesystem.write` 内部用 `mkdir -p` 语义，与 `marketplace.ts:53` writeCache 同款）。

---

## 第 3 节：Skill 发现扩展

**文件**：`packages/opencode/src/skill/index.ts`

在 `discoverSkills` 函数（`index.ts:148-218`）内，configDirs 扫描（`index.ts:190-193`）之后、skills.paths（`index.ts:196`）之前，插入一个 scan 块：

```ts
// 新增：marketplace 已安装内容插件
const pluginsRoot = path.join(Global.Path.data, "plugins")
if (yield* fsys.isDir(pluginsRoot)) {
  yield* scan(state, pluginsRoot, "*/skills/**/SKILL.md", { scope: "marketplace" })
}
```

### 扫描模式说明

`*/skills/**/SKILL.md`：
- 第一层 `*` 匹配插件名（`plugins/<plugin-name>/`）
- 锁定 `skills/` 子目录，避免误扫插件根的 README 等
- 插件目录结构：`plugins/<plugin-name>/skills/<skill-name>/SKILL.md`（Claude 标准）

### 为什么放 configDirs 之后

与 compose、external、configDirs 同属"自动发现源"，保持"自动发现在前、用户显式配置在后"的顺序。

### 不加 flag 开关

marketplace 插件是用户**主动安装**的，默认就该发现，不需要禁用开关（compose/external 的 `MIMOCODE_DISABLE_*` flag 是因为那些是被动扫描的外部目录）。若后续需要，再加。

---

## 第 4 节：TUI 接入

**文件**：`packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`

改造 `MarketplaceView` 的 `onSelect`（当前 `plugins.tsx:328-330` 占位）。

### onSelect 三态拦截

`onSelect` 拿到的是 `DialogSelectOption`（只有 `{title, value, description}`），不含 source。需从 `marketState()` 的 ready 分支取完整 plugin。当前 `rows` memo（`plugins.tsx:302-321`）只映射为 option 结构，因此新增一个 `plugins` memo 暴露完整列表：

```tsx
const plugins = createMemo(() => {
  const s = marketState()
  return s.status === "ready" ? s.plugins : []
})
```

`onSelect` 通过 value（即 `plugin.name`）反查：

```tsx
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

### doInstall 流程

```tsx
const [installing, setInstalling] = createSignal<string | undefined>()

async function doInstall(plugin: MarketplacePlugin) {
  if (installing()) return               // 串行化，防重复点击
  setInstalling(plugin.name)
  props.api.ui.toast({ variant: "info", message: `正在安装 ${plugin.name}...` })

  const result = await installPlugin(plugin.name, {
    // 自定义下载器注入 InstallDeps.resolve（install.ts:27）
    // plugin.source 此时已收窄为 relative 型
    resolve: () => downloadPlugin(plugin.name, plugin.source!),
  })

  setInstalling(undefined)

  if (!result.ok) {
    props.api.ui.toast({ variant: "error", message: `安装失败：${result.code}` })
    return
  }
  props.api.ui.toast({ variant: "success", message: `已安装 ${plugin.name}，重启后生效` })
}
```

### 关键点

1. **复用 `installPlugin` 只取 dep 注入骨架**：`installPlugin(mod, dep)`（`install.ts:259`）内部只调 `dep.resolve(spec)`（`install.ts:260`）。我们注入自定义 resolve 返回下载目录。**不调用** `readPluginManifest`/`patchPluginConfig`（那是 `plug.ts` 的编排，内容插件不需要——Skill 靠固定目录扫描，无需写 config）。

2. **`installing` 信号防并发**：同一时间只装一个。

3. **"重启后生效"提示**：本轮 Skill 发现改动需重启 TUI 进程才触发 `discoverSkills` 重扫。`Skill.reload()`（`index.ts:275-278`）机制存在但本轮不接（避免范围蔓延）。如实测能在不重启下热加载，则去掉该提示。

4. **`plugins` memo**：新增一个 `createMemo` 从 `marketState()` 的 ready 分支暴露完整 `MarketplacePlugin[]`（含 source），供 `onSelect` 反查。`rows` memo 保持不变（只负责渲染 option）。

---

## 错误处理矩阵

| 场景 | 处理 | UI 反馈 |
|------|------|---------|
| Trees API 失败（网络/限流/超时） | `DownloadResult.code: "tree_fetch_failed"` | toast error "安装失败：无法获取插件目录" |
| 插件目录在树里无文件 | `code: "no_files"` | toast warning "插件目录为空或路径错误" |
| 单文件 raw 下载失败 | `code: "file_download_failed"` | toast error "安装失败：下载文件失败" |
| 插件已安装（目录存在） | 跳过下载，返回成功 | toast info "已安装（跳过）" |
| 正在安装另一个插件 | `installing()` 守卫拦截 | 无（静默忽略） |
| source 非 relative | 选中时拦截，不进下载器 | toast warning "暂不支持该格式" |
| 无 source 字段 | 选中时拦截 | toast info "无来源信息" |

**原则**：绝不让安装失败导致 TUI 崩溃。所有错误捕获到 `DownloadResult` 的 discriminated union，TUI 只做 toast。

---

## 测试策略

| 测试对象 | 内容 | 方式 |
|---------|------|------|
| `parsePluginSource`（纯函数） | 四种 source 形态 + 无 source 兜底 + 畸形值 | `bun:test` 单测，`marketplace.test.ts` 新增用例 |
| `downloadPlugin`（下载器） | Trees API 解析、文件过滤、幂等跳过 | `bun:test`，用依赖注入 mock `fetch`/`write`/`exists`，不碰真实网络 |
| Skill 发现扩展 | 扫描 `plugins/*/skills/**/SKILL.md` | 依赖 `fsys` mock，验证 matches 含插件 SKILL.md（若现有测试框架支持注入） |
| TUI onSelect 三态 | relative → 触发安装、非 relative → 拦截 | 不测（需 opentui 运行时），手动验证 |
| E2E 闭环 | 真实插件 → 下载 → 重启 → Skill 可用 | 手动验证（跑 TUI，装 frontend-design，确认 Skill 出现） |

### 下载器单测重点（核心可测逻辑）

```ts
test("downloadPlugin filters tree entries by plugin path and downloads blobs", async () => {
  const tree = {
    tree: [
      { path: "plugins/foo/skills/foo/SKILL.md", type: "blob" },
      { path: "plugins/foo/README.md", type: "blob" },
      { path: "plugins/bar/skills/bar/SKILL.md", type: "blob" },  // 其他插件，应过滤掉
      { path: "plugins/foo/sub", type: "tree" },                   // 目录节点，应过滤掉
    ],
  }
  const fetched: string[] = []
  const wrote: string[] = []
  const deps: DownloadDeps = {
    fetch: (async (url: string) => {
      fetched.push(url.toString())
      return new Response(`content`)
    }) as typeof fetch,
    write: async (file, _data) => { wrote.push(file) },
    exists: async () => false,
    pluginsDir: "/tmp/plugins",
  }
  const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)
  assert(result.ok)
  // 只下载了 foo 插件的 2 个 blob，其他插件的被过滤
  assert(fetched.length === 2)
  assert(wrote.includes("/tmp/plugins/foo/skills/foo/SKILL.md".replace(/\//g, path.sep)))
  assert(wrote.includes("/tmp/plugins/foo/README.md".replace(/\//g, path.sep)))
})

test("downloadPlugin skips when target dir already exists", async () => {
  const deps: DownloadDeps = {
    fetch: async () => { throw new Error("should not fetch") },
    write: async () => { throw new Error("should not write") },
    exists: async (file) => file === "/tmp/plugins/foo".replace(/\//g, path.sep),
    pluginsDir: "/tmp/plugins",
  }
  const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)
  assert(result.ok && result.dir.endsWith("foo"))
})
```

---

## 文件变更清单

| 文件 | 改动 | 性质 | 估计行数 |
|------|------|------|---------|
| `cli/cmd/tui/feature-plugins/system/marketplace.ts` | `parseMarketplaceJson` 保留 source + 新增 `parsePluginSource` 纯函数 + `PluginSource` 类型 | 改造 | +40 |
| `plugin-marketplace/downloader.ts` | Trees API 列树 + raw 逐文件下载 + 文件锁 + 跳过式幂等 | 新建 | ~100 |
| `skill/index.ts` | discoverSkills 新增 marketplace 插件 scan 块 | 改造 | +4 |
| `cli/cmd/tui/feature-plugins/system/plugins.tsx` | onSelect 三态拦截 + doInstall + installing 信号 | 改造 | +30 |
| `cli/cmd/tui/feature-plugins/system/marketplace.test.ts` | parsePluginSource 四形态单测 | 新增用例 | +30 |
| `plugin-marketplace/downloader.test.ts` | 下载器树过滤 + 幂等单测 | 新建 | +50 |

**不改**：`plugin/install.ts`（复用 dep 注入）、`plugin/shared.ts`（内容插件不走 resolvePluginTarget，不扩 PluginSource 类型）、`plugin/loader.ts`（内容插件不进代码加载链路）、`build.ts`、`config/`。

---

## 验证标准

- [ ] `bun typecheck`（从 `packages/opencode`）通过
- [ ] `bun test`（marketplace.test.ts + downloader.test.ts）通过
- [ ] E2E 手动：TUI → marketplace → 选 frontend-design → 下载完成 toast → 重启 → frontend-design skill 出现在 available skills
- [ ] E2E 手动：选 url/git-subdir 型插件 → toast "暂不支持"（不崩溃）
- [ ] E2E 手动：网络断开时安装 → toast error（不崩溃）
