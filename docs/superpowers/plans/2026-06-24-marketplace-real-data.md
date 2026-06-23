# Marketplace Real-Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static sample data in `MarketplaceView` with live data fetched from `anthropics/claude-plugins-official`'s `marketplace.json`, with file caching, ETag-based background updates, and a 3-state UI (loading / ready / error) that never hangs the TUI.

**Architecture:** A new pure-logic module `marketplace.ts` owns fetch (with `AbortSignal.timeout`), file caching (raw JSON + separate `.etag`), and JSON parsing/mapping. `MarketplaceView` in `plugins.tsx` becomes a 3-state component driven by SolidJS signals: `onMount` triggers async load (cache-first → instant render, then background ETag check), `r` forces a refresh, error state offers retry. Install is a placeholder toast.

**Tech Stack:** TypeScript, SolidJS (`solid-js`: `createSignal`/`createMemo`/`createEffect`/`onMount`/`Show`), `@opentui/solid` (`useKeyboard`/`useTerminalDimensions`), `DialogSelect` from `@tui/ui/dialog-select`, `Filesystem` from `@/util`, `Global.Path.cache` from `@/global`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-24-marketplace-real-data-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts` | Fetch (timeout), cache read/write (raw JSON + etag), `parseMarketplaceJson` pure parser, `loadMarketplace` orchestrator. No SolidJS. | Create |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx` | `MarketplaceView` 3-state component, `showMarketplace`, command wiring. Remove old static `MARKETPLACE_PLUGINS`/`marketplaceOption`/`TYPE_FOOTER`/`PluginType`/`MarketplaceEntry`. | Modify |
| `packages/opencode/test/cli/cmd/tui/marketplace.test.ts` | Unit tests for `parseMarketplaceJson` (replaces old static-data tests). | Rewrite |

**Key utility references (already in codebase, do NOT recreate):**
- `Filesystem.write(p, content)` — auto-creates parent dirs on ENOENT (`util/filesystem.ts:59`)
- `Filesystem.readText(p)` — throws on missing file, so `.catch(() => undefined)` for cache miss (`util/filesystem.ts:38`)
- `Global.Path.cache` — cache directory string (`global/index.ts:19`, exported via `export * as Global from "."` at `:54`)
- `Keybind.parse("r").at(0)` — keybind definition (already imported in `plugins.tsx:10`)

---

## Task 1: `parseMarketplaceJson` pure function + tests (TDD)

**Files:**
- Create: `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts`
- Test: `packages/opencode/test/cli/cmd/tui/marketplace.test.ts` (rewrite — old tests for deleted static data)

This task creates the module file with ONLY the pure parser and types. Fetch/cache/loadMarketplace come in Task 2. This keeps the testable core isolated and testable first.

- [ ] **Step 1: Rewrite the test file (delete old static-data tests, add parser tests)**

Overwrite `packages/opencode/test/cli/cmd/tui/marketplace.test.ts` with:

```ts
import { describe, expect, test } from "bun:test"
import { parseMarketplaceJson } from "../../../../src/cli/cmd/tui/feature-plugins/system/marketplace"

describe("parseMarketplaceJson", () => {
  test("maps entries to name + description", () => {
    const raw = JSON.stringify({
      name: "claude-plugins-official",
      plugins: [
        { name: "frontend-design", description: "Build distinctive UI" },
        { name: "pdf", description: "Generate PDF documents" },
      ],
    })
    expect(parseMarketplaceJson(raw)).toEqual([
      { name: "frontend-design", description: "Build distinctive UI" },
      { name: "pdf", description: "Generate PDF documents" },
    ])
  })

  test("defaults missing description to empty string", () => {
    const raw = JSON.stringify({ plugins: [{ name: "no-desc" }] })
    expect(parseMarketplaceJson(raw)).toEqual([{ name: "no-desc", description: "" }])
  })

  test("filters out entries without a name", () => {
    const raw = JSON.stringify({
      plugins: [
        { description: "has no name field" },
        { name: "valid", description: "ok" },
      ],
    })
    expect(parseMarketplaceJson(raw)).toEqual([{ name: "valid", description: "ok" }])
  })

  test("returns empty array when plugins array is empty", () => {
    const raw = JSON.stringify({ plugins: [] })
    expect(parseMarketplaceJson(raw)).toEqual([])
  })

  test("throws on invalid JSON", () => {
    expect(() => parseMarketplaceJson("not json")).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/opencode`):
```bash
bun test test/cli/cmd/tui/marketplace.test.ts
```
Expected: FAIL — import error (`parseMarketplaceJson` not found; module file does not exist yet).

- [ ] **Step 3: Create marketplace.ts with types + parser only**

Create `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts`:

```ts
// marketplace.json 原始条目（只声明用到的字段，其余忽略）
interface RawMarketplaceEntry {
  name: string
  description?: string
}

// 映射后给视图用的条目
export interface MarketplacePlugin {
  name: string
  description: string
}

// 解析 marketplace.json 文本 → MarketplacePlugin[]
// description 缺失兜底空字符串；无 name 的条目过滤掉。
export function parseMarketplaceJson(raw: string): MarketplacePlugin[] {
  const data = JSON.parse(raw) as { plugins?: RawMarketplaceEntry[] }
  const entries = data.plugins ?? []
  return entries
    .filter((entry): entry is RawMarketplaceEntry & { name: string } => typeof entry.name === "string" && entry.name.length > 0)
    .map((entry) => ({
      name: entry.name,
      description: entry.description ?? "",
    }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/opencode`):
```bash
bun test test/cli/cmd/tui/marketplace.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Run typecheck**

Run (from `packages/opencode`):
```bash
bun typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd E:\Files\GitHub\MiMo-Code
git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts packages/opencode/test/cli/cmd/tui/marketplace.test.ts
git commit -m "feat: add parseMarketplaceJson pure parser with unit tests

Parses claude-plugins-official marketplace.json: maps name+description,
defaults missing description to empty, filters nameless entries.
First part of marketplace.ts module; fetch/cache come next."
```

---

## Task 2: Cache + fetch + loadMarketplace (IO layer)

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts` (add cache + fetch + loadMarketplace)

Adds the IO layer on top of Task 1's parser. These functions need real network/filesystem so they are NOT unit-tested here (would need mocks, which AGENTS.md discourages); they are verified by typecheck now and manual test in Task 3.

- [ ] **Step 1: Add constants, cache functions, fetch, and loadMarketplace**

In `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts`, add imports at the top (above existing code) and new functions at the bottom (below `parseMarketplaceJson`).

Add these imports at the very top of the file:

```ts
import { Global } from "@/global"
import { Filesystem } from "@/util"
import path from "path"
```

Add `LoadResult` type after the `MarketplacePlugin` interface:

```ts
export type LoadResult =
  | { status: "ready"; plugins: MarketplacePlugin[] }
  | { status: "error"; message: string }
```

Add these constants and functions at the bottom of the file (after `parseMarketplaceJson`):

```ts
const MARKETPLACE_URL =
  "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json"
const FETCH_TIMEOUT_MS = 15_000

function cachePath() {
  return path.join(Global.Path.cache, "marketplace.json")
}

function etagPath() {
  return path.join(Global.Path.cache, "marketplace.json.etag")
}

async function readCache(): Promise<{ raw: string; etag?: string } | undefined> {
  const raw = await Filesystem.readText(cachePath()).catch(() => undefined)
  if (!raw) return undefined
  const etag = await Filesystem.readText(etagPath()).catch(() => undefined)
  return { raw, etag: etag || undefined }
}

async function writeCache(raw: string, etag?: string): Promise<void> {
  await Filesystem.write(cachePath(), raw)
  if (etag) await Filesystem.write(etagPath(), etag)
}

// 加载市场数据。
// force=false：有缓存先返回缓存（调用方可再后台静默 force 检查更新）。
// force=true：忽略缓存，强制重新 fetch。
export async function loadMarketplace(options?: { force?: boolean }): Promise<LoadResult> {
  const cache = !options?.force ? await readCache() : undefined

  // 有缓存且非强制：立即返回缓存数据
  if (cache) {
    try {
      return { status: "ready", plugins: parseMarketplaceJson(cache.raw) }
    } catch {
      // 缓存损坏，当作无缓存继续 fetch
    }
  }

  const headers: Record<string, string> = {}
  if (cache?.etag) headers["If-None-Match"] = cache.etag

  try {
    const response = await fetch(MARKETPLACE_URL, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (response.status === 304 && cache) {
      return { status: "ready", plugins: parseMarketplaceJson(cache.raw) }
    }

    if (!response.ok) {
      return { status: "error", message: `HTTP ${response.status}` }
    }

    const raw = await response.text()
    const etag = response.headers.get("etag") ?? undefined
    const plugins = parseMarketplaceJson(raw)
    await writeCache(raw, etag).catch(() => {})
    return { status: "ready", plugins }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { status: "error", message }
  }
}
```

- [ ] **Step 2: Run typecheck**

Run (from `packages/opencode`):
```bash
bun typecheck
```
Expected: no errors.

- [ ] **Step 3: Run parser tests (unchanged, should still pass)**

Run (from `packages/opencode`):
```bash
bun test test/cli/cmd/tui/marketplace.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
cd E:\Files\GitHub\MiMo-Code
git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts
git commit -m "feat: add marketplace cache + fetch + loadMarketplace

File cache (raw JSON + .etag), fetch with AbortSignal.timeout(15s),
ETag conditional request, cache-first with force option. Verified by
typecheck; manual verification in next task."
```

---

## Task 3: Rewrite MarketplaceView to 3-state + wire up + remove static data

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`

Removes the static sample data (added in the previous iteration), rewrites `MarketplaceView` to use `loadMarketplace` with loading/ready/error states, adds `r`-key refresh, and adds install placeholder toast.

- [ ] **Step 1: Remove static data block**

In `plugins.tsx`, delete the entire block that was added for the static view. Find and remove these lines (located after `meta()` function, before `function Install`):

```ts
// --- Marketplace (static sample data) ---

export type PluginType = "skill" | "mcp" | "both"

export const TYPE_FOOTER: Record<PluginType, string> = {
  skill: "[SKILL]",
  mcp: "[MCP]",
  both: "[SKILL+MCP]",
}

export interface MarketplaceEntry {
  name: string
  description: string
  type: PluginType
}

export const MARKETPLACE_PLUGINS: MarketplaceEntry[] = [
  { name: "frontend-design", description: "Build distinctive UI with intentional design", type: "skill" },
  { name: "pdf", description: "Generate and process PDF documents", type: "skill" },
  { name: "brainstorming", description: "Turn ideas into validated designs", type: "skill" },
  { name: "rust-analyzer-lsp", description: "Rust language server integration", type: "both" },
  { name: "git-workflow", description: "Automate git operations and PRs", type: "skill" },
  { name: "42crunch", description: "API security scanning and audit", type: "mcp" },
  { name: "playwright", description: "Browser automation and E2E testing", type: "mcp" },
  { name: "context7", description: "Look up library docs in real-time", type: "mcp" },
  { name: "sequential-thinking", description: "Structured multi-step reasoning", type: "both" },
  { name: "docx", description: "Create and edit Word documents", type: "skill" },
  { name: "mcp-builder", description: "Build MCP servers for new capabilities", type: "both" },
  { name: "airtable", description: "Interact with Airtable bases", type: "mcp" },
]

export function marketplaceOption(entry: MarketplaceEntry): DialogSelectOption<string> {
  return {
    title: entry.name,
    value: entry.name,
    description: entry.description,
    footer: TYPE_FOOTER[entry.type],
  }
}
```

Remove all of the above (the block from `// --- Marketplace` comment through the closing brace of `marketplaceOption`).

- [ ] **Step 2: Add imports**

In `plugins.tsx`, update the imports. Find the existing solid-js import line:

```ts
import { Show, createEffect, createMemo, createSignal } from "solid-js"
```

Replace with (add `onMount`):

```ts
import { Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
```

Then add a new import line after the existing `useLanguage` import (line 7). Add:

```ts
import { loadMarketplace, type MarketplacePlugin } from "./marketplace"
```

- [ ] **Step 3: Rewrite MarketplaceView**

In `plugins.tsx`, find the current static `MarketplaceView` component (between `show(api)` and `showMarketplace`). Replace the entire `MarketplaceView` function with this 3-state version:

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
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  async function applyResult(result: Awaited<ReturnType<typeof loadMarketplace>>) {
    if (result.status === "ready") {
      setState({ status: "ready", plugins: result.plugins })
    } else {
      setState({ status: "error", message: result.message })
    }
  }

  onMount(async () => {
    const result = await loadMarketplace()
    await applyResult(result)

    // 有缓存时，后台静默检查更新（不阻塞、不闪屏、失败忽略）
    if (result.status === "ready") {
      const updated = await loadMarketplace({ force: true }).catch(() => undefined)
      if (updated?.status === "ready") setState({ status: "ready", plugins: updated.plugins })
    }
  })

  // r 键刷新（error 态也可用）
  useKeyboard((evt) => {
    if (state().status === "error" && evt.name === "r") {
      evt.preventDefault()
      evt.stopPropagation()
      setState({ status: "loading" })
      void loadMarketplace({ force: true }).then(applyResult)
    }
  })

  async function doRefresh() {
    setState({ status: "loading" })
    await applyResult(await loadMarketplace({ force: true }))
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
            <text fg={props.api.theme.current.error}>Failed to load marketplace</text>
            <text fg={props.api.theme.current.textMuted}>Check network, press r to retry</text>
          </Show>
        </box>
      }
    >
      <DialogSelect
        title="Plugin Marketplace"
        flat
        options={rows()}
        onSelect={() =>
          props.api.ui.toast({ variant: "info", message: "Install coming soon" })
        }
        keybind={[
          { title: "refresh", keybind: Keybind.parse("r").at(0), onTrigger: doRefresh },
        ]}
      />
    </Show>
  )
}
```

- [ ] **Step 4: Run typecheck**

Run (from `packages/opencode`):
```bash
bun typecheck
```
Expected: no errors. (This catches: removed exports no longer referenced, `onMount`/`Show` imports correct, `MarketplacePlugin` type imported, `DialogSelectOption` import may become unused — if typecheck flags it, remove `type DialogSelectOption` from the import on line 5 if nothing else uses it.)

- [ ] **Step 5: Run the full tui test suite**

Run (from `packages/opencode`):
```bash
bun test test/cli/cmd/tui/
```
Expected: all tests PASS (marketplace.test.ts 5 parser tests + prompt-part.test.ts 2 tests = 7 total).

- [ ] **Step 6: Commit**

```bash
cd E:\Files\GitHub\MiMo-Code
git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx
git commit -m "feat(tui): marketplace view with live data, 3-state UI

Rewrite MarketplaceView to fetch real marketplace.json via
loadMarketplace(): loading → ready/error states, cache-first render,
background ETag check, r-key refresh, install placeholder toast.
Removes static sample data (replaced by live data)."
```

---

## Verification Checklist (after all tasks)

- [ ] `bun typecheck` from `packages/opencode` — no errors
- [ ] `bun test test/cli/cmd/tui/` from `packages/opencode` — all pass
- [ ] `git log --oneline -4` shows three new commits
- [ ] No static `MARKETPLACE_PLUGINS` / `TYPE_FOOTER` / `marketplaceOption` left in `plugins.tsx`:

```bash
cd E:\Files\GitHub\MiMo-Code
grep -n "MARKETPLACE_PLUGINS\|TYPE_FOOTER\|marketplaceOption\|PluginType" packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx
```
Expected: no matches.

- [ ] `marketplace.ts` exists and exports `parseMarketplaceJson`, `loadMarketplace`, `MarketplacePlugin`, `LoadResult`:

```bash
grep -n "export" packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts
```
Expected: matches for all four exports.

- [ ] Every `fetch` in `marketplace.ts` has `AbortSignal.timeout`:

```bash
grep -n "fetch\|AbortSignal" packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts
```
Expected: one `fetch(` and one `AbortSignal.timeout(FETCH_TIMEOUT_MS)`.

- [ ] **Manual smoke test**: run `bun run dev` from `packages/opencode`, open command palette, select "Plugin Marketplace":
  - First open: shows "Loading marketplace..." then ~200 real plugins
  - Search works (type a plugin name)
  - `r` refreshes (brief loading then list returns)
  - Enter shows "Install coming soon" toast
  - Close and reopen: list appears instantly (from cache), background update is silent
