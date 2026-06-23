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
