# Marketplace Static View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `plugins.marketplace` command's placeholder toast with a browseable, searchable plugin directory view backed by hardcoded sample data (zero network, zero hang risk).

**Architecture:** Reuse the existing `DialogSelect` component (same as the current npm-plugins `View`). Add a `MarketplaceView` component that maps a static `MARKETPLACE_PLUGINS` array into `DialogSelectOption[]`, rendered as a flat (ungrouped) list with `[SKILL]`/`[MCP]`/`[SKILL+MCP]` type footers. Only one file changes (`plugins.tsx`). Pure data-logic (type→footer mapping, entry→option mapping) is extracted as top-level exported pure functions so it can be unit-tested without rendering the SolidJS component.

**Tech Stack:** TypeScript, SolidJS (`solid-js`), `@opentui/solid`, `DialogSelect` from `@tui/ui/dialog-select`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-24-plugin-marketplace-tui-view-design-v2.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx` | Marketplace data types, sample data, pure mapping fns, `MarketplaceView` component, `showMarketplace`, command `onSelect` wiring | Modify |
| `packages/opencode/test/cli/cmd/tui/marketplace.test.ts` | Unit tests for pure mapping logic (type→footer, entry→option) | Create |

All other files untouched.

---

## Task 1: Pure data logic — types, sample data, and mapping functions (TDD)

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx` (add near top, after existing helpers)
- Test: `packages/opencode/test/cli/cmd/tui/marketplace.test.ts` (create)

This task adds the testable pure logic: `PluginType`, `MarketplaceEntry`, `TYPE_FOOTER`, `MARKETPLACE_PLUGINS`, and `marketplaceOption()`. No component yet — that's Task 2.

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/cli/cmd/tui/marketplace.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import {
  MARKETPLACE_PLUGINS,
  TYPE_FOOTER,
  marketplaceOption,
} from "../../../../src/cli/cmd/tui/feature-plugins/system/plugins"

describe("marketplace type footer", () => {
  test("maps each plugin type to its footer label", () => {
    expect(TYPE_FOOTER.skill).toBe("[SKILL]")
    expect(TYPE_FOOTER.mcp).toBe("[MCP]")
    expect(TYPE_FOOTER.both).toBe("[SKILL+MCP]")
  })
})

describe("marketplaceOption", () => {
  test("maps an entry to a DialogSelectOption with footer from its type", () => {
    const entry = MARKETPLACE_PLUGINS[0]
    const option = marketplaceOption(entry)

    expect(option.title).toBe(entry.name)
    expect(option.value).toBe(entry.name)
    expect(option.description).toBe(entry.description)
    expect(option.footer).toBe(TYPE_FOOTER[entry.type])
  })

  test("leaves category undefined so the list stays flat", () => {
    const option = marketplaceOption(MARKETPLACE_PLUGINS[0])
    expect(option.category).toBeUndefined()
  })

  test("covers all three plugin types in the sample data", () => {
    const types = new Set(MARKETPLACE_PLUGINS.map((p) => p.type))
    expect(types.has("skill")).toBe(true)
    expect(types.has("mcp")).toBe(true)
    expect(types.has("both")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/opencode`):
```bash
bun test test/cli/cmd/tui/marketplace.test.ts
```
Expected: FAIL — import error (`MARKETPLACE_PLUGINS` / `TYPE_FOOTER` / `marketplaceOption` not exported from `plugins.tsx`).

- [ ] **Step 3: Add the types, data, and mapping function to plugins.tsx**

In `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx`, add the following block **after** the existing `meta()` function (which ends around line 39, before `function Install`) and **before** `function Install`:

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

export function marketplaceOption(entry: MarketplaceEntry) {
  return {
    title: entry.name,
    value: entry.name,
    description: entry.description,
    footer: TYPE_FOOTER[entry.type],
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/opencode`):
```bash
bun test test/cli/cmd/tui/marketplace.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Run typecheck**

Run (from `packages/opencode`):
```bash
bun typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx packages/opencode/test/cli/cmd/tui/marketplace.test.ts
git commit -m "feat: add marketplace sample data and pure mapping logic

Static PluginType/MarketplaceEntry types, 12-entry sample dataset,
TYPE_FOOTER labels, and marketplaceOption() mapper. No network, no IO.
Unit-tested via bun:test."
```

---

## Task 2: MarketplaceView component + showMarketplace + command wiring

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx` (add component after existing `View`/`show`; change command `onSelect`)

This task adds the view component (untestable in isolation — it needs the opentui runtime) and wires it into the existing `plugins.marketplace` command. No new tests; verification is via typecheck + manual structure review.

- [ ] **Step 1: Add the MarketplaceView component and showMarketplace function**

In `plugins.tsx`, add the following **after** the existing `show(api)` function (which ends around line 242, before `const tui: TuiPlugin`) and **before** `const tui: TuiPlugin`:

```tsx
function MarketplaceView(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()

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

  const rows = createMemo(() => MARKETPLACE_PLUGINS.map(marketplaceOption))

  return (
    <DialogSelect
      title="Plugin Marketplace"
      flat
      options={rows()}
      keybind={[]}
    />
  )
}

function showMarketplace(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <MarketplaceView api={api} />)
}
```

- [ ] **Step 2: Wire the command onSelect to open the view**

In `plugins.tsx`, find the `plugins.marketplace` command registration (inside the `tui` function's `api.command.register` callback). Change its `onSelect` from the toast placeholder to `showMarketplace(api)`.

Find this exact block:
```tsx
      {
        title: t("tui.command.plugins.marketplace.title"),
        value: "plugins.marketplace",
        category: "system",
        onSelect() {
          api.ui.toast({
            variant: "info",
            message: t("tui.command.plugins.marketplace.placeholder"),
          })
        },
      },
```

Replace with:
```tsx
      {
        title: t("tui.command.plugins.marketplace.title"),
        value: "plugins.marketplace",
        category: "system",
        onSelect() {
          showMarketplace(api)
        },
      },
```

- [ ] **Step 3: Run typecheck**

Run (from `packages/opencode`):
```bash
bun typecheck
```
Expected: no errors.

- [ ] **Step 4: Run the full test suite to confirm nothing regressed**

Run (from `packages/opencode`):
```bash
bun test test/cli/cmd/tui/
```
Expected: all tests PASS (marketplace.test.ts + prompt-part.test.ts).

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx
git commit -m "feat(tui): add marketplace view with search and flat list

MarketplaceView reuses DialogSelect to render MARKETPLACE_PLUGINS as a
flat, searchable list. plugins.marketplace command now opens the view
instead of showing a placeholder toast. Static data only — no network."
```

---

## Verification Checklist (after both tasks)

- [ ] `bun typecheck` from `packages/opencode` — no errors
- [ ] `bun test test/cli/cmd/tui/` from `packages/opencode` — all pass
- [ ] `git log --oneline -3` shows two new commits
- [ ] `plugins.marketplace` command `onSelect` calls `showMarketplace(api)` (no toast)
- [ ] `MARKETPLACE_PLUGINS` has 12 entries covering skill/mcp/both
- [ ] No `fetch` / network calls anywhere in the new code (grep to confirm):

```bash
grep -n "fetch\|http\|https" packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx
```
Expected: no matches related to the new marketplace code.
