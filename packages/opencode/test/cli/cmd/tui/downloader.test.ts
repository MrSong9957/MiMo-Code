import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, rm } from "fs/promises"
import { downloadPlugin, type DownloadDeps } from "../../../../src/plugin-marketplace/downloader"

// 把 / 分隔的预期路径转成当前平台分隔符，便于跨平台断言
function p(file: string): string {
  return file.split("/").join(path.sep)
}

// no-op 锁，测试不涉及并发
const noopLock = async (_key: string) => ({ [Symbol.asyncDispose]: async () => {} })
// no-op 删除，测试不验证清理逻辑的用例用
const noopRemove = async (_dir: string) => {}
// no-op git，relative 型测试不走 git
const noopGit = async (_args: string[], _opts: { cwd: string }) => ({ ok: true, stderr: "" })

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
        const s = url.toString()
        fetched.push(s)
        if (s.includes("/git/trees/")) return Response.json(tree)
        return new Response("content")
      }) as unknown as DownloadDeps["fetch"],
      write: async (file) => {
        wrote.push(file)
      },
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: noopRemove,
      git: noopGit,
    }

    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dir).toBe(p("/tmp/plugins/foo"))
    expect(result.skipped).toBe(false)
    // trees API 调用 1 次 + 2 个 blob 下载 = 3 次 fetch
    expect(fetched).toHaveLength(3)
    // 落盘路径剥离仓库前缀：只保留插件内部相对路径（skills/foo/SKILL.md, README.md）
    expect(wrote).toEqual([
      p("/tmp/plugins/foo/skills/foo/SKILL.md"),
      p("/tmp/plugins/foo/README.md"),
    ])
  })

  test("skips download when target dir already exists", async () => {
    const fetched: string[] = []
    const wrote: string[] = []
    const deps: DownloadDeps = {
      fetch: (async () => {
        throw new Error("should not fetch")
      }) as unknown as DownloadDeps["fetch"],
      write: async () => {
        throw new Error("should not write")
      },
      exists: async (file) => file === p("/tmp/plugins/foo"),
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: noopRemove,
      git: noopGit,
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
      }) as unknown as DownloadDeps["fetch"],
      write: async () => {},
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: noopRemove,
      git: noopGit,
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
      }) as unknown as DownloadDeps["fetch"],
      write: async () => {},
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: noopRemove,
      git: noopGit,
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
      }) as unknown as DownloadDeps["fetch"],
      write: async () => {},
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: noopRemove,
      git: noopGit,
    }

    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("file_download_failed")
  })

  test("returns file_download_failed when write rejects (no unhandled rejection)", async () => {
    const tree = {
      tree: [{ path: "plugins/foo/SKILL.md", type: "blob" }],
    }
    const deps: DownloadDeps = {
      fetch: (async (url: string | URL | Request) => {
        const s = url.toString()
        if (s.includes("/git/trees/")) return Response.json(tree)
        return new Response("content")
      }) as unknown as DownloadDeps["fetch"],
      write: async () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
      },
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: noopRemove,
      git: noopGit,
    }

    // 必须返回 { ok:false } 而非 reject——否则会逃逸成未处理的 Promise 拒绝
    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("file_download_failed")
  })

  test("cleans up partial download on failure so retry does not falsely skip", async () => {
    const tree = {
      tree: [
        { path: "plugins/foo/SKILL.md", type: "blob" },
        { path: "plugins/foo/README.md", type: "blob" },
      ],
    }
    // 第一个文件成功，第二个文件持续 ECONNRESET（重试也救不回来）
    const removed: string[] = []
    const deps: DownloadDeps = {
      fetch: (async (url: string | URL | Request) => {
        const s = url.toString()
        if (s.includes("/git/trees/")) return Response.json(tree)
        // README.md 的所有请求都失败（含重试）
        if (s.endsWith("README.md")) {
          throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })
        }
        return new Response("content")
      }) as unknown as DownloadDeps["fetch"],
      write: async () => {},
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: async (dir) => {
        removed.push(dir)
      },
      git: noopGit,
    }

    // 重试耗尽后失败，且清理了半成品目录（SKILL.md 已写但 README.md 失败）
    const r1 = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)
    expect(r1.ok).toBe(false)
    if (r1.ok) return
    expect(r1.code).toBe("file_download_failed")
    // 失败后必须清理半成品目录
    expect(removed).toEqual([p("/tmp/plugins/foo")])
  })

  test("retries transient failure and succeeds", async () => {
    const tree = {
      tree: [{ path: "plugins/foo/SKILL.md", type: "blob" }],
    }
    // 第一次 ECONNRESET，重试后成功
    let rawCall = 0
    const deps: DownloadDeps = {
      fetch: (async (url: string | URL | Request) => {
        const s = url.toString()
        if (s.includes("/git/trees/")) return Response.json(tree)
        rawCall++
        if (rawCall === 1) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })
        return new Response("content")
      }) as unknown as DownloadDeps["fetch"],
      write: async () => {},
      exists: async () => false,
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: noopRemove,
      git: noopGit,
    }

    const result = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)
    expect(result.ok).toBe(true)
    // 第一次失败 + 一次重试成功 = 2 次 raw 调用
    expect(rawCall).toBe(2)
  })
})

describe("downloadPlugin (git sources)", () => {
  // 记录 git 调用参数 + 创建假的 tmp 目录让 rename 能成功。remove 用真实的 rm 清理。
  function mockGit(recorded: string[][], pluginsDir: string, name: string) {
    return async (args: string[], _opts: { cwd: string }) => {
      recorded.push(args)
      if (args[0] === "clone") {
        await mkdir(path.join(pluginsDir, `${name}.tmp`), { recursive: true })
      }
      return { ok: true, stderr: "" }
    }
  }
  const realRemove = (dir: string) => rm(dir, { recursive: true, force: true })

  test("url source clones full repo and checks out sha", async () => {
    const gitCalls: string[][] = []
    const pluginsDir = p("/tmp/plugins")
    const deps: DownloadDeps = {
      fetch: async () => new Response(""),
      write: async () => {},
      exists: async () => false,
      remove: realRemove,
      git: mockGit(gitCalls, pluginsDir, "agentforce-adlc"),
      pluginsDir,
      lock: noopLock,
    }

    const result = await downloadPlugin(
      "agentforce-adlc",
      { kind: "url", url: "https://github.com/x/y.git", sha: "772aaa20" },
      deps,
    )
    expect(result.ok).toBe(true)
    expect(gitCalls[0]).toContain("clone")
    expect(gitCalls[0]).toContain("https://github.com/x/y.git")
    expect(gitCalls.some((a) => a[0] === "fetch" && a.includes("772aaa20"))).toBe(true)
    expect(gitCalls.some((a) => a[0] === "checkout" && a.includes("772aaa20"))).toBe(true)
  })

  test("git-subdir source uses sparse-checkout for subdir", async () => {
    const gitCalls: string[][] = []
    const pluginsDir = p("/tmp/plugins")
    const deps: DownloadDeps = {
      fetch: async () => new Response(""),
      write: async () => {},
      exists: async () => false,
      remove: realRemove,
      git: mockGit(gitCalls, pluginsDir, "adobe"),
      pluginsDir,
      lock: noopLock,
    }
    const result = await downloadPlugin(
      "adobe",
      { kind: "git-subdir", url: "https://github.com/adobe/skills.git", path: "plugins/cc/adobe", sha: "17ef6fb5" },
      deps,
    )
    expect(result.ok).toBe(true)
    expect(gitCalls[0]).toContain("--sparse")
    const sc = gitCalls.find((a) => a[0] === "sparse-checkout")
    expect(sc).toBeDefined()
    expect(sc![1]).toBe("set")
    expect(sc).toContain("plugins/cc/adobe")
  })

  test("github source builds url from repo", async () => {
    const gitCalls: string[][] = []
    const pluginsDir = p("/tmp/plugins")
    const deps: DownloadDeps = {
      fetch: async () => new Response(""),
      write: async () => {},
      exists: async () => false,
      remove: realRemove,
      git: mockGit(gitCalls, pluginsDir, "fullstory"),
      pluginsDir,
      lock: noopLock,
    }
    const result = await downloadPlugin(
      "fullstory",
      { kind: "github", repo: "fullstorydev/fullstory-skills", sha: "b20614e2" },
      deps,
    )
    expect(result.ok).toBe(true)
    expect(gitCalls[0]).toContain("https://github.com/fullstorydev/fullstory-skills")
  })

  test("returns git_failed when clone fails", async () => {
    const deps: DownloadDeps = {
      fetch: async () => new Response(""),
      write: async () => {},
      exists: async () => false,
      remove: realRemove,
      git: async () => ({ ok: false, stderr: "fatal: repository not found" }),
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
    }
    const result = await downloadPlugin("bad", { kind: "url", url: "https://github.com/x/nonexistent.git" }, deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("git_failed")
  })
})
