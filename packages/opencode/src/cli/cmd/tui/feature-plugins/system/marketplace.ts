// marketplace.json 原始条目（只声明用到的字段，其余忽略）
interface RawMarketplaceEntry {
  name: string
  description?: string
}

// 映射后给视图用的条目
export interface MarketplacePlugin {
  name: string
  description: string
}

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
