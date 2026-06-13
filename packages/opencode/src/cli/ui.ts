import z from "zod"
import { EOL } from "os"
import { NamedError } from "@mimo-ai/shared/util/error"
import { logo as glyphs } from "./logo"

const wordmark = [
  `⠀                                       `,
  `█▀▄▀█ █ █▄ ▄█ █▀▀█ █▀▀ █▀▀█ █▀▀▄ █▀▀▀`,
  `█ ▀ █ █ █ ▀ █ █  █ █   █  █ █  █ █▀▀ `,
  `▀   ▀ ▀ ▀   ▀ ▀▀▀▀ ▀▀▀ ▀▀▀▀ ▀▀▀  ▀▀▀▀`,
]

export const CancelledError = NamedError.create("UICancelledError", z.void())

export const Style = {
  TEXT_HIGHLIGHT: "\x1b[96m",
  TEXT_HIGHLIGHT_BOLD: "\x1b[96m\x1b[1m",
  TEXT_DIM: "\x1b[90m",
  TEXT_DIM_BOLD: "\x1b[90m\x1b[1m",
  TEXT_NORMAL: "\x1b[0m",
  TEXT_NORMAL_BOLD: "\x1b[1m",
  TEXT_WARNING: "\x1b[93m",
  TEXT_WARNING_BOLD: "\x1b[93m\x1b[1m",
  TEXT_DANGER: "\x1b[91m",
  TEXT_DANGER_BOLD: "\x1b[91m\x1b[1m",
  TEXT_SUCCESS: "\x1b[92m",
  TEXT_SUCCESS_BOLD: "\x1b[92m\x1b[1m",
  TEXT_INFO: "\x1b[94m",
  TEXT_INFO_BOLD: "\x1b[94m\x1b[1m",
}

export function println(...message: string[]) {
  print(...message)
  process.stderr.write(EOL)
}

export function print(...message: string[]) {
  blank = false
  process.stderr.write(message.join(" "))
}

let blank = false
export function empty() {
  if (blank) return
  println("" + Style.TEXT_NORMAL)
  blank = true
}

export function logo(pad?: string) {
  if (!process.stdout.isTTY && !process.stderr.isTTY) {
    const result = []
    for (const row of wordmark) {
      if (pad) result.push(pad)
      result.push(row)
      result.push(EOL)
    }
    return result.join("").trimEnd()
  }

  const result: string[] = []
  const reset = "\x1b[0m"
  const left = {
    fg: "\x1b[90m",
    shadow: "\x1b[38;5;235m",
    bg: "\x1b[48;5;235m",
  }
  const right = {
    fg: reset,
    shadow: "\x1b[38;5;238m",
    bg: "\x1b[48;5;238m",
  }
  const gap = "  "
  const draw = (line: string, fg: string, shadow: string, bg: string) => {
    const parts: string[] = []
    for (const char of line) {
      if (char === "_") {
        parts.push(bg, " ", reset)
        continue
      }
      if (char === "^") {
        parts.push(fg, bg, "▀", reset)
        continue
      }
      if (char === "~") {
        parts.push(shadow, "▀", reset)
        continue
      }
      if (char === " ") {
        parts.push(" ")
        continue
      }
      parts.push(fg, char, reset)
    }
    return parts.join("")
  }
  glyphs.left.forEach((row, index) => {
    if (pad) result.push(pad)
    result.push(draw(row, left.fg, left.shadow, left.bg))
    result.push(gap)
    const other = glyphs.right[index] ?? ""
    result.push(draw(other, right.fg, right.shadow, right.bg))
    result.push(EOL)
  })
  return result.join("").trimEnd()
}

export async function input(prompt: string): Promise<string> {
  const readline = require("readline")
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export function error(message: string) {
  if (message.startsWith("Error: ")) {
    message = message.slice("Error: ".length)
  }
  println(Style.TEXT_DANGER_BOLD + "Error: " + Style.TEXT_NORMAL + message)
}

export function markdown(text: string): string {
  const lines = text.split("\n")
  const result: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    // Fenced code blocks
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        result.push(Style.TEXT_NORMAL)
        inCodeBlock = false
      } else {
        result.push(Style.TEXT_DIM)
        inCodeBlock = true
      }
      continue
    }
    if (inCodeBlock) {
      result.push(line)
      continue
    }

    // Headings: # / ## / ### → bold cyan
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      result.push(Style.TEXT_HIGHLIGHT_BOLD + headingMatch[2] + Style.TEXT_NORMAL)
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      result.push(Style.TEXT_DIM + "─".repeat(40) + Style.TEXT_NORMAL)
      continue
    }

    // List items: - / * / 1. → bullet
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/)
    if (listMatch) {
      const indent = listMatch[1]
      const bullet = listMatch[2] === "-" || listMatch[2] === "*" ? "•" : listMatch[2]
      const content = inlineFormat(listMatch[3])
      result.push(indent + Style.TEXT_HIGHLIGHT + bullet + Style.TEXT_NORMAL + " " + content)
      continue
    }

    // Regular line with inline formatting
    result.push(inlineFormat(line))
  }

  return result.join(EOL)
}

function inlineFormat(text: string): string {
  return text
    // Bold: **text** → bold
    .replace(/\*\*(.+?)\*\*/g, Style.TEXT_NORMAL_BOLD + "$1" + Style.TEXT_NORMAL)
    // Italic: *text* → dim italic (ANSI 3 = italic)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "\x1b[3m$1\x1b[23m")
    // Inline code: `text` → highlight
    .replace(/`([^`]+)`/g, Style.TEXT_HIGHLIGHT + "$1" + Style.TEXT_NORMAL)
    // Links: [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, Style.TEXT_HIGHLIGHT + "$1" + Style.TEXT_NORMAL + " ($2)")
    // Bare URLs: http(s)://... → highlight
    .replace(/(https?:\/\/[^\s<>()`"']+)/g, Style.TEXT_HIGHLIGHT + "$1" + Style.TEXT_NORMAL)
}

export * as UI from "./ui"
