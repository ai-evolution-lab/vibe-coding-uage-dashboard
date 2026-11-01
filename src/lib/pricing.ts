import snapshot from '../data/pricing-snapshot.json'
import type { CostBreakdown, PriceRule, PricingCatalog, TokenUsage } from '../types'
import {
  LITELLM_PRICING_MIRROR_URL,
  LITELLM_PRICING_URL,
  MODELS_DEV_URL,
  mergeRules,
  normalizeLiteLLM,
  normalizeModelsDev,
} from './pricingSource'

/** 价格源里没有、但 Codex 本地会出现的内部模型名，按最接近的公开模型计价。 */
const BUILTIN_ALIASES: Record<string, string> = {
  'codex-auto-review': 'gpt-5.3-codex',
}

/** 1 小时缓存写入价缺失时，按 5 分钟写入价的 1.6 倍估算（Anthropic 官方比例）。 */
const CACHE_WRITE_1H_MULTIPLIER = 1.6

export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

export function getBuiltinCatalog(): PricingCatalog {
  const data = snapshot as unknown as { updatedAtMs: number; source: string; rules: PriceRule[] }
  return {
    version: 2,
    updatedAtMs: data.updatedAtMs,
    source: `内置快照（${data.source}）`,
    rules: data.rules.map((rule) => ({ ...rule, source: rule.source ?? 'builtin' })),
    overrides: [],
  }
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`${new URL(url).host} HTTP ${response.status}`)
  }
  return (await response.json()) as Record<string, unknown>
}

/** 依次尝试多个地址，返回第一个成功的结果。 */
async function fetchFirst(urls: string[], timeoutMs: number) {
  const errors: string[] = []
  for (const url of urls) {
    try {
      return await fetchJsonWithTimeout(url, timeoutMs)
    } catch (error) {
      errors.push(error instanceof Error ? `${new URL(url).host}: ${error.message}` : String(error))
    }
  }
  throw new Error(errors.join('；'))
}

export interface CatalogFetchResult {
  catalog: PricingCatalog
  warnings: string[]
}

export async function fetchLatestCatalog(overrides: PriceRule[]): Promise<CatalogFetchResult> {
  const [litellmResult, modelsDevResult] = await Promise.allSettled([
    fetchFirst([LITELLM_PRICING_URL, LITELLM_PRICING_MIRROR_URL], 20_000),
    fetchFirst([MODELS_DEV_URL], 25_000),
  ])
  const litellm = litellmResult.status === 'fulfilled' ? normalizeLiteLLM(litellmResult.value) : []
  const modelsDev = modelsDevResult.status === 'fulfilled' ? normalizeModelsDev(modelsDevResult.value) : []
  const warnings = [
    litellmResult.status === 'rejected' ? `LiteLLM 获取失败（${String(litellmResult.reason?.message ?? litellmResult.reason)}）` : '',
    modelsDevResult.status === 'rejected' ? `models.dev 获取失败（${String(modelsDevResult.reason?.message ?? modelsDevResult.reason)}）` : '',
  ].filter(Boolean)
  if (litellm.length === 0 && modelsDev.length === 0) {
    throw new Error(`价格更新失败，继续使用当前价格。${warnings.join('；')}`)
  }
  const sources = [litellm.length ? 'LiteLLM' : '', modelsDev.length ? 'models.dev' : ''].filter(Boolean)
  return {
    catalog: {
      version: 2,
      updatedAtMs: Date.now(),
      source: sources.join(' + '),
      rules: mergeRules(litellm, modelsDev),
      overrides,
    },
    warnings,
  }
}

/** 搜索用：把 "Opus 5.5" / "claude-opus-5.5" / "gpt 5.6 sol" 统一成可比较的形式。 */
export function searchKey(value: string) {
  return value.toLowerCase().replace(/[\s._/-]+/g, '')
}

export function searchCatalog(catalog: PricingCatalog, query: string, limit = 30) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map(searchKey).filter(Boolean)
  if (terms.length === 0 || terms.join('').length < 2) {
    return []
  }
  return catalog.rules
    .map((rule) => ({ rule, key: searchKey(rule.model) }))
    .filter(({ key }) => terms.every((term) => key.includes(term)))
    // 官方命名（越短、越接近查询）排前面，避免 anthropic--claude-4-opus 这类转售别名挤到顶部。
    .sort((left, right) => left.key.length - right.key.length || left.rule.model.localeCompare(right.rule.model))
    .slice(0, limit)
    .map(({ rule }) => rule)
}

export type MatchKind = 'custom' | 'exact' | 'normalized' | 'prefix' | 'alias'

export interface ResolvedPrice {
  rule: PriceRule
  matchedBy: MatchKind
  matchedModel: string
}

export interface PricingIndex {
  catalog: PricingCatalog
  rules: Map<string, PriceRule>
  overrides: Map<string, PriceRule>
  cache: Map<string, ResolvedPrice | null>
}

export function createPricingIndex(catalog: PricingCatalog): PricingIndex {
  return {
    catalog,
    rules: new Map(catalog.rules.map((rule) => [rule.model.toLowerCase(), rule])),
    overrides: new Map(catalog.overrides.map((rule) => [rule.model.toLowerCase(), rule])),
    cache: new Map(),
  }
}

/** claude-sonnet-4-5-20250929 / deepseek/deepseek-v4 / claude-opus-4-6[1m] -> 统一的模型名 */
export function normalizeModelName(model: string) {
  return model
    .trim()
    .toLowerCase()
    .split('/')
    .pop()!
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-(20\d{6}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/@.*$/, '')
}

function lookup(name: string, map: Map<string, PriceRule>) {
  return map.get(name) ?? map.get(name.replaceAll('.', '-')) ?? map.get(name.replace(/(\d)-(\d)/g, '$1.$2'))
}

export function resolvePrice(model: string, pricing: PricingIndex): ResolvedPrice | null {
  const key = model || 'unknown'
  if (pricing.cache.has(key)) {
    return pricing.cache.get(key) ?? null
  }
  const result = resolveUncached(key, pricing)
  pricing.cache.set(key, result)
  return result
}

function resolveUncached(model: string, pricing: PricingIndex): ResolvedPrice | null {
  const raw = model.trim().toLowerCase()
  const normalized = normalizeModelName(model)
  const custom = pricing.overrides.get(raw) ?? lookup(normalized, pricing.overrides)
  if (custom) {
    return { rule: custom, matchedBy: 'custom', matchedModel: custom.model }
  }
  const exact = pricing.rules.get(raw)
  if (exact) {
    return { rule: exact, matchedBy: 'exact', matchedModel: exact.model }
  }
  const byName = lookup(normalized, pricing.rules)
  if (byName) {
    return { rule: byName, matchedBy: 'normalized', matchedModel: byName.model }
  }
  const alias = BUILTIN_ALIASES[normalized]
  if (alias) {
    const aliasRule = pricing.rules.get(alias)
    if (aliasRule) {
      return { rule: aliasRule, matchedBy: 'alias', matchedModel: aliasRule.model }
    }
  }
  // 从右往左按 "-" 截断，取最长的已知前缀，例如 deepseek-v4-flash-0731 -> deepseek-v4-flash。
  const parts = normalized.split('-')
  for (let length = parts.length - 1; length >= 2; length -= 1) {
    const prefix = parts.slice(0, length).join('-')
    const rule = pricing.overrides.get(prefix) ?? lookup(prefix, pricing.rules)
    if (rule) {
      return { rule, matchedBy: 'prefix', matchedModel: rule.model }
    }
  }
  return null
}

export function emptyCost(): CostBreakdown {
  return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 }
}

export function totalCost(cost: CostBreakdown) {
  return cost.input + cost.cachedInput + cost.cacheWrite + cost.output
}

export function addCost(target: CostBreakdown, cost: CostBreakdown) {
  target.input += cost.input
  target.cachedInput += cost.cachedInput
  target.cacheWrite += cost.cacheWrite
  target.output += cost.output
}

/**
 * 单次请求计价。上下文（输入 + 缓存读 + 缓存写）超过分档阈值时，整次请求按高档价计算（与 ccusage 一致）。
 */
export function priceUsage(usage: TokenUsage, contextTokens: number, rule: PriceRule): CostBreakdown {
  const tier = rule.tier && contextTokens > rule.tier.thresholdTokens ? rule.tier : null
  const rates = tier ?? rule
  const write1hRate =
    !tier && rule.cacheWrite1hPerMillion !== undefined
      ? rule.cacheWrite1hPerMillion
      : rates.cacheWritePerMillion * CACHE_WRITE_1H_MULTIPLIER
  const write1h = Math.min(usage.cacheWrite1hTokens, usage.cacheWriteTokens)
  return {
    input: (usage.inputTokens / 1e6) * rates.inputPerMillion,
    cachedInput: (usage.cachedInputTokens / 1e6) * rates.cachedInputPerMillion,
    cacheWrite:
      ((usage.cacheWriteTokens - write1h) / 1e6) * rates.cacheWritePerMillion + (write1h / 1e6) * write1hRate,
    output: (usage.outputTokens / 1e6) * rates.outputPerMillion,
  }
}

export function isTiered(contextTokens: number, rule: PriceRule) {
  return Boolean(rule.tier && contextTokens > rule.tier.thresholdTokens)
}
