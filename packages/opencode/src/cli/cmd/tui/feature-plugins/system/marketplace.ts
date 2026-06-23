// marketplace.json 原始条目（只声明用到的字段，其余忽略）
import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util"

interface RawMarketplaceEntry {
  name: string
  description?: string
}

// 映射后给视图用的条目
export interface MarketplacePlugin {
  name: string
  description: string
}

export type LoadResult =
  | { status: "ready"; plugins: MarketplacePlugin[] }
  | { status: "error"; message: string }

// 解析 marketplace.json 文本 → MarketplacePlugin[]
// 容忍任意 JSON：非数组 plugins 当空；null/无 name 的条目过滤掉；
// description 缺失或非字符串兜底空字符串。
export function parseMarketplaceJson(raw: string): MarketplacePlugin[] {
  const data = JSON.parse(raw) as { plugins?: unknown }
  const entries = Array.isArray(data.plugins) ? data.plugins : []
  return entries
    .filter(
      (entry): entry is RawMarketplaceEntry & { name: string } =>
        entry != null && typeof entry.name === "string" && entry.name.length > 0,
    )
    .map((entry) => ({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
    }))
}

const MARKETPLACE_URL =
  "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json"
const FETCH_TIMEOUT_MS = 15_000

function cachePath() {
  return path.join(Global.Path.cache, "marketplace.json")
}

function etagPath() {
  return path.join(Global.Path.cache, "marketplace.json.etag")
}

async function readCache(): Promise<{ raw: string; etag?: string } | undefined> {
  const raw = await Filesystem.readText(cachePath()).catch(() => undefined)
  if (!raw) return undefined
  const etag = await Filesystem.readText(etagPath()).catch(() => undefined)
  return { raw, etag: etag || undefined }
}

async function writeCache(raw: string, etag?: string): Promise<void> {
  await Filesystem.write(cachePath(), raw)
  if (etag) await Filesystem.write(etagPath(), etag)
}

// 加载市场数据。
// force=false：有缓存先返回缓存（调用方可再后台静默 force 检查更新）。
// force=true：忽略缓存，强制重新 fetch。
export async function loadMarketplace(options?: { force?: boolean }): Promise<LoadResult> {
  const cache = !options?.force ? await readCache() : undefined

  // 有缓存且非强制：立即返回缓存数据
  if (cache) {
    try {
      return { status: "ready", plugins: parseMarketplaceJson(cache.raw) }
    } catch {
      // 缓存损坏，当作无缓存继续 fetch
    }
  }

  const headers: Record<string, string> = {}
  if (cache?.etag) headers["If-None-Match"] = cache.etag

  try {
    const response = await fetch(MARKETPLACE_URL, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (response.status === 304 && cache) {
      return { status: "ready", plugins: parseMarketplaceJson(cache.raw) }
    }

    if (!response.ok) {
      return { status: "error", message: `HTTP ${response.status}` }
    }

    const raw = await response.text()
    const etag = response.headers.get("etag") ?? undefined
    const plugins = parseMarketplaceJson(raw)
    await writeCache(raw, etag).catch(() => {})
    return { status: "ready", plugins }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { status: "error", message }
  }
}
