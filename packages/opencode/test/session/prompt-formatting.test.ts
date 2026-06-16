import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const promptDir = join(__dirname, "../../src/session/prompt")

function readPrompt(name: string): string {
  return readFileSync(join(promptDir, name), "utf-8")
}

describe("prompt formatting instructions", () => {
  const defaultTxt = readPrompt("default.txt")
  const anthropicTxt = readPrompt("anthropic.txt")

  describe("default.txt", () => {
    test("uses 'ALWAYS' for formatting instruction, not 'can use'", () => {
      expect(defaultTxt).toContain("ALWAYS structure")
      expect(defaultTxt).not.toMatch(/\bcan use\b.*markdown/i)
    })

    test("contains heading format requirement", () => {
      expect(defaultTxt).toContain("**bold text**")
      expect(defaultTxt).toContain("section headers")
    })

    test("contains bullet list format requirement", () => {
      expect(defaultTxt).toContain("bullet lists")
      expect(defaultTxt).toContain("`-`")
    })

    test("contains code block format requirement", () => {
      expect(defaultTxt).toContain("fenced code blocks")
      expect(defaultTxt).toContain("language tags")
    })

    test("contains inline code format requirement", () => {
      expect(defaultTxt).toContain("inline code")
      expect(defaultTxt).toContain("commands")
      expect(defaultTxt).toContain("paths")
    })

    test("contains blank line separation requirement", () => {
      expect(defaultTxt).toContain("blank line")
    })

    test("formatting instruction does not contradict conciseness constraint", () => {
      // The formatting section should explicitly state formatting works within the line limit
      expect(defaultTxt).toMatch(/formatting.*WITHIN.*line limit|WITHIN.*line limit.*formatting/i)
    })

    test("still contains conciseness constraint", () => {
      expect(defaultTxt).toContain("fewer than 4 lines")
    })
  })

  describe("anthropic.txt", () => {
    test("contains formatting instruction", () => {
      expect(anthropicTxt).toContain("ALWAYS structure")
    })

    test("contains same heading format as default.txt", () => {
      expect(anthropicTxt).toContain("**bold text**")
      expect(anthropicTxt).toContain("section headers")
    })

    test("contains same bullet list format as default.txt", () => {
      expect(anthropicTxt).toContain("bullet lists")
    })

    test("contains same code block format as default.txt", () => {
      expect(anthropicTxt).toContain("fenced code blocks")
    })

    test("contains same inline code format as default.txt", () => {
      expect(anthropicTxt).toContain("inline code")
    })

    test("contains same blank line requirement as default.txt", () => {
      expect(anthropicTxt).toContain("blank line")
    })
  })
})
