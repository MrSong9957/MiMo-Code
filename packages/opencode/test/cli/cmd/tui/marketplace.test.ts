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
