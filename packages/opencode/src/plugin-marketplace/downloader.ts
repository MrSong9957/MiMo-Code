import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { Flock } from "@mimo-ai/shared/util/flock"

// 本轮硬编码的 marketplace 仓库（多市场支持留后续）
const MARKETPLACE_OWNER = "anthropics"
const MARKETPLACE_REPO = "claude-plugins-official"
const MARKETPLACE_REF = "main"

const FETCH_TIMEOUT_MS = 30_000

export type DownloadDeps = {
  // 只要求可调用签名，不依赖 Bun fetch 的 preconnect 等扩展方法
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
  write: (file: string, data: Uint8Array) => Promise<void>
  exists: (file: string) => Promise<boolean>
  pluginsDir: string
  // 可注入的锁，测试用 no-op；默认用 Flock.acquire（需 Flock global 已初始化）
  lock: (key: string) => Promise<AsyncDisposable>
}

export type DownloadResult =
  | { ok: true; dir: string; skipped: boolean }
  | { ok: false; code: "tree_fetch_failed" | "no_files" | "file_download_failed"; error?: unknown }

const defaultDeps: DownloadDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  write: (file, data) => Filesystem.write(file, data),
  exists: (file) => Filesystem.exists(file),
  pluginsDir: path.join(Global.Path.data, "plugins"),
  lock: (key) => Flock.acquire(`plugin-install:${key}`),
}

// 标准化 source.path（如 "./plugins/foo"）为仓库内相对路径（"plugins/foo"），用于 tree 过滤和 raw URL
function repoRelative(source: { kind: "relative"; path: string }) {
  return source.path.replace(/^\.\//, "")
}

// Git Trees API 返回的条目
interface TreeEntry {
  path: string
  type: string
}

interface TreeResponse {
  tree: TreeEntry[]
  truncated?: boolean
}

// 下载相对路径型插件到 pluginsDir/<name>/。
// 跳过式幂等：目标目录已存在则直接返回成功。
export async function downloadPlugin(
  name: string,
  source: { kind: "relative"; path: string },
  dep: DownloadDeps = defaultDeps,
): Promise<DownloadResult> {
  const dir = path.join(dep.pluginsDir, name)

  // 跳过式幂等
  if (await dep.exists(dir)) {
    return { ok: true, dir, skipped: true }
  }

  return dep.lock(name).then(
    async (lockHandle) => {
      await using _ = lockHandle
      return runDownload(name, source, dir, dep)
    },
    (error: unknown) => ({ ok: false, code: "tree_fetch_failed" as const, error }),
  )
}

async function runDownload(
  name: string,
  source: { kind: "relative"; path: string },
  dir: string,
  dep: DownloadDeps,
): Promise<DownloadResult> {
  const prefix = repoRelative(source)
  const treesUrl = `https://api.github.com/repos/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/git/trees/${MARKETPLACE_REF}?recursive=1`

  let resp: Response
  try {
    resp = await dep.fetch(treesUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }
  if (!resp.ok) {
    return { ok: false, code: "tree_fetch_failed", error: new Error(`trees API HTTP ${resp.status}`) }
  }

  let data: TreeResponse
  try {
    data = (await resp.json()) as TreeResponse
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }

  // 只保留插件目录下的 blob（排除其他插件、排除 tree 节点）
  const blobs = (data.tree ?? []).filter(
    (entry) => entry.type === "blob" && entry.path.startsWith(prefix + "/"),
  )
  if (!blobs.length) {
    return { ok: false, code: "no_files" }
  }

  // 逐文件下载。任一失败立即中止。
  for (const entry of blobs) {
    const rawUrl = `https://raw.githubusercontent.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/${MARKETPLACE_REF}/${entry.path}`
    let fileResp: Response
    try {
      fileResp = await dep.fetch(rawUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (error) {
      return { ok: false, code: "file_download_failed", error }
    }
    if (!fileResp.ok) {
      return {
        ok: false,
        code: "file_download_failed",
        error: new Error(`raw HTTP ${fileResp.status} for ${entry.path}`),
      }
    }
    const buf = new Uint8Array(await fileResp.arrayBuffer())
    // 落盘路径：pluginsDir/<name>/<完整 entry.path>，保留插件在仓库内的目录结构
    await dep.write(path.join(dir, entry.path), buf)
  }

  return { ok: true, dir, skipped: false }
}
