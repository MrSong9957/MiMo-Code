# Builtin Marketplace Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bake the claude-plugins-official `marketplace.json` into the binary at build time so the marketplace view opens instantly even with no cache and no network.

**Architecture:** Build script fetches marketplace.json at compile time and injects it via Bun's `define` (same pattern as `OPENCODE_MIGRATIONS`). `loadMarketplace` gains a fallback: cache → builtin → fetch. Dev environment (`bun run dev`, no define) is unaffected — `typeof BUILTIN_MARKETPLACE === "undefined"` falls through to network fetch as today.

**Tech Stack:** TypeScript, Bun (`Bun.build` + `define`), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-24-marketplace-builtin-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `packages/opencode/script/build.ts` | Fetch marketplace.json at build time, inject via `define` | Modify |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts` | Declare `BUILTIN_MARKETPLACE`, add builtin fallback in `loadMarketplace` | Modify |

No new files. No test changes (parser tests unaffected; builtin injection can't be unit-tested since `define` constants aren't settable at runtime).

**Key reference (do NOT recreate):**
- `OPENCODE_MIGRATIONS` pattern: `build.ts` define at line ~236, consumed in `storage/db.ts:19` via `declare const` + `typeof ... !== "undefined"` guard. This is the exact pattern to follow.

---

## Task 1: Add builtin fallback in marketplace.ts

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts`

This task adds the `declare const` and the fallback branch. Without the build.ts change (Task 2), `BUILTIN_MARKETPLACE` is always `undefined` in dev — so this is safe to land first and changes zero behavior until a real build injects the constant.

- [ ] **Step 1: Add the `declare const` after imports**

In `marketplace.ts`, after line 3 (`import { Filesystem } from "@/util"`), before the `interface RawMarketplaceEntry`, add:

```ts
// 构建时注入的内置 marketplace.json（dev 环境为 undefined，走联网 fetch）
declare const BUILTIN_MARKETPLACE: string | undefined
```

- [ ] **Step 2: Add builtin fallback in loadMarketplace**

In `loadMarketplace` (currently lines 57-95), the flow is: read cache → if cache, return it → else fetch. Add the builtin fallback between the cache block and the fetch block.

Find this exact code (the cache block ending + headers start):

```ts
  // 有缓存且非强制：立即返回缓存数据
  if (cache) {
    try {
      return { status: "ready", plugins: parseMarketplaceJson(cache.raw) }
    } catch {
      // 缓存损坏，当作无缓存继续 fetch
    }
  }

  const headers: Record<string, string> = {}
```

Replace with (insert builtin fallback before headers):

```ts
  // 有缓存且非强制：立即返回缓存数据
  if (cache) {
    try {
      return { status: "ready", plugins: parseMarketplaceJson(cache.raw) }
    } catch {
      // 缓存损坏，当作无缓存继续
    }
  }

  // 无缓存：优先用内置版本（构建时注入，离线秒开，不联网）
  if (typeof BUILTIN_MARKETPLACE !== "undefined") {
    try {
      return { status: "ready", plugins: parseMarketplaceJson(BUILTIN_MARKETPLACE) }
    } catch {
      // 内置数据损坏（理论不可能），继续联网 fetch
    }
  }

  const headers: Record<string, string> = {}
```

Note: the cache-block comment changed from "继续 fetch" to "继续" since the next step is now builtin, not directly fetch.

- [ ] **Step 3: Run typecheck**

Run (from `packages/opencode`):
```bash
bun typecheck
```
Expected: no errors. The `declare const` makes `BUILTIN_MARKETPLACE` known to TypeScript; `typeof ... !== "undefined"` is the runtime guard.

- [ ] **Step 4: Run tests to confirm no regression**

Run (from `packages/opencode`):
```bash
bun test test/cli/cmd/tui/
```
Expected: all pass (8 marketplace parser tests + 2 prompt-part tests = 10).

- [ ] **Step 5: Verify dev behavior unchanged (manual)**

In dev (`bun run dev`), `BUILTIN_MARKETPLACE` is undefined → `typeof === "undefined"` is true → builtin block skipped → falls through to fetch. No behavioral change. Confirm by checking the code path logic (no need to run TUI).

- [ ] **Step 6: Commit**

```bash
cd E:\Files\GitHub\MiMo-Code
git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.ts
git commit -m "feat: add builtin marketplace fallback in loadMarketplace

declare BUILTIN_MARKETPLACE (build-time define inject). loadMarketplace
now falls back to builtin version when no cache, before hitting network.
Dev environment unaffected: typeof undefined → skip to fetch as before."
```

---

## Task 2: Build script — fetch and inject marketplace.json at compile time

**Files:**
- Modify: `packages/opencode/script/build.ts`

This makes `BUILTIN_MARKETPLACE` actually defined in production builds. Fetches marketplace.json during build, injects via `define`.

- [ ] **Step 1: Add build-time fetch after migrations loading**

In `build.ts`, after line 50 (`console.log(\`Loaded ${migrations.length} migrations\`)`), before line 52 (`const singleFlag`), add the fetch logic:

```ts
// Fetch builtin marketplace.json to embed in the binary (offline fallback)
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

- [ ] **Step 2: Add define injection in Bun.build**

In the same file, find the `define` block inside `Bun.build({ ... })` (around line 234). It currently looks like:

```ts
    define: {
      MIMOCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MIGRATIONS: JSON.stringify(migrations),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      MIMOCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
    },
```

Add the `BUILTIN_MARKETPLACE` line (after `OPENCODE_MIGRATIONS`):

```ts
    define: {
      MIMOCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MIGRATIONS: JSON.stringify(migrations),
      BUILTIN_MARKETPLACE: builtinMarketplace ? JSON.stringify(builtinMarketplace) : "undefined",
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      MIMOCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
    },
```

Key detail: `JSON.stringify(builtinMarketplace)` double-encodes — the raw JSON string becomes a quoted JS string literal. At runtime `BUILTIN_MARKETPLACE` evaluates to the original JSON text, which `parseMarketplaceJson` parses. When fetch failed, injects literal `undefined` so `typeof BUILTIN_MARKETPLACE === "undefined"` holds.

- [ ] **Step 3: Run typecheck**

Run (from `packages/opencode`):
```bash
bun typecheck
```
Expected: no errors. `build.ts` is covered by typecheck.

- [ ] **Step 4: Commit**

```bash
cd E:\Files\GitHub\MiMo-Code
git add packages/opencode/script/build.ts
git commit -m "build: fetch and inject builtin marketplace.json via define

Build script now fetches claude-plugins-official marketplace.json at
compile time (30s timeout, failure non-blocking) and injects it as
BUILTIN_MARKETPLACE define constant. Same pattern as OPENCODE_MIGRATIONS."
```

---

## Verification Checklist (after both tasks)

- [ ] `bun typecheck` from `packages/opencode` — no errors
- [ ] `bun test test/cli/cmd/tui/` from `packages/opencode` — all pass
- [ ] `git log --oneline -3` shows two new commits
- [ ] `marketplace.ts` has `declare const BUILTIN_MARKETPLACE` and the `typeof !== "undefined"` fallback block
- [ ] `build.ts` has the fetch block + `BUILTIN_MARKETPLACE` in `define`
- [ ] Dev behavior unchanged: `bun run dev` → open marketplace → fetches from network (no builtin in dev)

- [ ] **Production build smoke test** (optional, requires build):
  ```bash
  cd packages/opencode
  bun run build -- --skip-install
  ```
  Then run the built binary, delete cache (`rm ~/.cache/mimocode/marketplace.json*`), open marketplace → should show ~236 plugins **instantly** without network (builtin version).
