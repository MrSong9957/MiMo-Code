import { describe, expect, test } from "bun:test"
import { UI } from "../../src/cli/ui"

describe("UI.markdown()", () => {
  describe("headings", () => {
    test("renders h1 as bold cyan", () => {
      const result = UI.markdown("# Hello")
      expect(result).toContain("Hello")
      expect(result).toContain(UI.Style.TEXT_HIGHLIGHT_BOLD)
    })

    test("renders h2 as bold cyan", () => {
      const result = UI.markdown("## World")
      expect(result).toContain("World")
      expect(result).toContain(UI.Style.TEXT_HIGHLIGHT_BOLD)
    })

    test("renders h3 as bold cyan", () => {
      const result = UI.markdown("### Section")
      expect(result).toContain("Section")
      expect(result).toContain(UI.Style.TEXT_HIGHLIGHT_BOLD)
    })
  })

  describe("inline formatting", () => {
    test("renders bold text", () => {
      const result = UI.markdown("**bold**")
      expect(result).toContain("bold")
      expect(result).toContain(UI.Style.TEXT_NORMAL_BOLD)
    })

    test("renders italic text", () => {
      const result = UI.markdown("*italic*")
      expect(result).toContain("italic")
      // ANSI italic: \x1b[3m ... \x1b[23m
      expect(result).toContain("\x1b[3m")
    })

    test("renders inline code", () => {
      const result = UI.markdown("`code`")
      expect(result).toContain("code")
      expect(result).toContain(UI.Style.TEXT_HIGHLIGHT)
    })

    test("renders links", () => {
      const result = UI.markdown("[text](https://example.com)")
      expect(result).toContain("text")
      expect(result).toContain("https://example.com")
    })

    test("renders bare URLs", () => {
      const result = UI.markdown("Visit https://example.com now")
      expect(result).toContain("https://example.com")
      expect(result).toContain(UI.Style.TEXT_HIGHLIGHT)
    })
  })

  describe("code blocks", () => {
    test("renders fenced code blocks with dim style", () => {
      const input = "```js\nconsole.log('hi')\n```"
      const result = UI.markdown(input)
      expect(result).toContain("console.log('hi')")
      expect(result).toContain(UI.Style.TEXT_DIM)
    })

    test("renders code block content without additional formatting", () => {
      const input = "```js\nconst x = **bold**\n```"
      const result = UI.markdown(input)
      // Inside code block, ** should not be rendered as bold
      expect(result).toContain("**bold**")
    })
  })

  describe("lists", () => {
    test("renders unordered list with bullet", () => {
      const result = UI.markdown("- item one\n- item two")
      expect(result).toContain("•")
      expect(result).toContain("item one")
      expect(result).toContain("item two")
    })

    test("renders ordered list with number", () => {
      const result = UI.markdown("1. first\n2. second")
      expect(result).toContain("1.")
      expect(result).toContain("first")
    })

    test("preserves indentation for nested items", () => {
      const result = UI.markdown("- item\n  - nested")
      expect(result).toContain("  ")
      expect(result).toContain("nested")
    })
  })

  describe("horizontal rules", () => {
    test("renders --- as horizontal line", () => {
      const result = UI.markdown("---")
      expect(result).toContain("─")
    })

    test("renders *** as horizontal line", () => {
      const result = UI.markdown("***")
      expect(result).toContain("─")
    })
  })

  describe("edge cases", () => {
    test("empty input returns empty string", () => {
      expect(UI.markdown("")).toBe("")
    })

    test("plain text passes through without ANSI", () => {
      const result = UI.markdown("hello world")
      expect(result).toContain("hello world")
    })

    test("mixed content renders each part correctly", () => {
      const input = "# Title\n\nSome **bold** and `code` text.\n\n- item one\n- item two"
      const result = UI.markdown(input)
      expect(result).toContain("Title")
      expect(result).toContain(UI.Style.TEXT_HIGHLIGHT_BOLD)
      expect(result).toContain("bold")
      expect(result).toContain("code")
      expect(result).toContain("•")
      expect(result).toContain("item one")
    })
  })
})
