import path from "path"
import { rm } from "fs/promises"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { Flock } from "@mimo-ai/shared/util/flock"

const MARKETPLACE_OWNER = "anthropics"
const MARKETPLACE_REPO = "claude-plugins-official"
const MARKETPLACE_REF = "main"

const FETCH_TIMEOUT_MS = 30_000
const MAX_RETRIES = 3

export type DownloadDeps = {
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
  write: (file: string, data: Uint8Array) => Promise<void>
  exists: (file: string) => Promise<boolean>
  remove: (dir: string) => Promise<void>
  pluginsDir: string
  lock: (key: string) => Promise<AsyncDisposable>
}

export type DownloadResult =
  | { ok: true; dir: string; skipped: boolean }
  | { ok: false; code: "tree_fetch_failed" | "no_files" | "file_download_failed"; error?: unknown }

const defaultDeps: DownloadDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  write: (file, data) => Filesystem.write(file, data),
  exists: (file) => Filesystem.exists(file),
  remove: (dir) => rm(dir, { recursive: true, force: true }),
  pluginsDir: path.join(Global.Path.data, "plugins"),
  lock: (key) => Flock.acquire(`plugin-install:${key}`),
}

interface TreeEntry {
  path: string
  type: string
}

interface TreeResponse {
  tree: TreeEntry[]
}

// 单文件 fetch，网络抖动（ECONNRESET）时指数退避重试。4xx 不重试，5xx 才重试。
async function fetchWithRetry(url: string, dep: DownloadDeps): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await Bun.sleep(500 * 2 ** (attempt - 1))
    try {
      const resp = await dep.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (resp.status < 500) return resp
      lastError = new Error(`HTTP ${resp.status}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

// 下载相对路径型插件到 pluginsDir/<name>/。跳过式幂等，失败时清理半成品。
export async function downloadPlugin(
  name: string,
  source: { kind: "relative"; path: string },
  dep: DownloadDeps = defaultDeps,
): Promise<DownloadResult> {
  const dir = path.join(dep.pluginsDir, name)
  try {
    await using _ = await dep.lock(name)
    const result = await runDownload(source, dir, dep)
    if (!result.ok) await dep.remove(dir).catch(() => {})
    return result
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }
}

async function runDownload(
  source: { kind: "relative"; path: string },
  dir: string,
  dep: DownloadDeps,
): Promise<DownloadResult> {
  // 持锁后复查：等锁期间可能已被其他进程装好
  if (await dep.exists(dir)) return { ok: true, dir, skipped: true }

  // source.path 形如 "./plugins/foo"，去掉 "./" 得到仓库内相对路径用于 tree 过滤
  const prefix = source.path.replace(/^\.\//, "")
  const blobs = await fetchTree(prefix, dep)
  if ("ok" in blobs) return blobs

  for (const entry of blobs) {
    const rawUrl = `https://raw.githubusercontent.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/${MARKETPLACE_REF}/${entry.path}`
    let buf: Uint8Array
    try {
      buf = new Uint8Array(await (await fetchWithRetry(rawUrl, dep)).arrayBuffer())
    } catch (error) {
      return { ok: false, code: "file_download_failed", error }
    }
    // entry.path 是仓库内完整路径（plugins/foo/skills/x/SKILL.md），
    // 剥离 prefix 后写盘，避免 dir 已含 <name> 再嵌套一层
    try {
      await dep.write(path.join(dir, entry.path.slice(prefix.length + 1)), buf)
    } catch (error) {
      return { ok: false, code: "file_download_failed", error }
    }
  }
  return { ok: true, dir, skipped: false }
}

// 拉取仓库文件树，过滤出插件目录下的 blob
async function fetchTree(
  prefix: string,
  dep: DownloadDeps,
): Promise<TreeEntry[] | DownloadResult> {
  const treesUrl = `https://api.github.com/repos/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/git/trees/${MARKETPLACE_REF}?recursive=1`
  let resp: Response
  try {
    resp = await fetchWithRetry(treesUrl, dep)
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }
  if (!resp.ok) return { ok: false, code: "tree_fetch_failed", error: new Error(`trees API HTTP ${resp.status}`) }

  let tree: TreeEntry[]
  try {
    tree = ((await resp.json()) as TreeResponse).tree ?? []
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }

  const blobs = tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix + "/"))
  return blobs.length ? blobs : { ok: false, code: "no_files" }
}
