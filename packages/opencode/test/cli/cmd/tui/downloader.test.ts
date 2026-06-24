import { describe, expect, test } from "bun:test"
import path from "path"
import { downloadPlugin, type DownloadDeps } from "../../../../src/plugin-marketplace/downloader"

// 把 / 分隔的预期路径转成当前平台分隔符，便于跨平台断言
function p(file: string): string {
  return file.split("/").join(path.sep)
}

// no-op 锁，测试不涉及并发
const noopLock = async (_key: string) => ({ [Symbol.asyncDispose]: async () => {} })
// no-op 删除，测试不验证清理逻辑的用例用
const noopRemove = async (_dir: string) => {}

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
    // 第一个文件写成功（创建目录），第二个 fetch 抛 ECONNRESET
    let rawCall = 0
    const removed: string[] = []
    const existsChecks: string[] = []
    const deps: DownloadDeps = {
      fetch: (async (url: string | URL | Request) => {
        const s = url.toString()
        if (s.includes("/git/trees/")) return Response.json(tree)
        rawCall++
        if (rawCall === 2) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })
        return new Response("content")
      }) as unknown as DownloadDeps["fetch"],
      write: async () => {},
      exists: async (file) => {
        existsChecks.push(file)
        // 第一次安装：目录不存在；第二次安装：清理后也不存在
        return false
      },
      pluginsDir: p("/tmp/plugins"),
      lock: noopLock,
      remove: async (dir) => {
        removed.push(dir)
      },
    }

    // 第一次安装：部分成功后失败
    const r1 = await downloadPlugin("foo", { kind: "relative", path: "./plugins/foo" }, deps)
    expect(r1.ok).toBe(false)
    if (r1.ok) return
    expect(r1.code).toBe("file_download_failed")
    // 失败后必须清理半成品目录
    expect(removed).toEqual([p("/tmp/plugins/foo")])
  })
})
