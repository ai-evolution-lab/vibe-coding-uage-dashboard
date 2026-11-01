// 纯函数：把 LiteLLM / models.dev 的价格数据规范化为 PriceRule。
// 浏览器在线更新和 scripts/update-pricing-snapshot.mjs 共用这一份逻辑。
import type { PriceRule, PriceTier } from '../types'

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
/** raw.githubusercontent.com 在部分网络下不可达，jsDelivr 作为备用。 */
export const LITELLM_PRICING_MIRROR_URL =
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json'
export const MODELS_DEV_URL = 'https://models.dev/api.json'

// 同名模型在多个 provider 下都有价格时，按此顺序取官方价，避开云厂商区域加价。
const PROVIDER_PRIORITY = ['', 'openai', 'anthropic', 'chatgpt', 'gemini', 'deepseek', 'azure', 'azure_ai']

function providerRank(prefix: string) {
  const index = PROVIDER_PRIORITY.indexOf(prefix)
  return index === -1 ? PROVIDER_PRIORITY.length : index
}

function perMillion(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e6 * 1e6) / 1e6 : undefined
}

function splitModelKey(key: string) {
  const parts = key.split('/')
  const bare = parts.pop() ?? key
  return { bare: bare.toLowerCase(), prefix: parts.join('/').toLowerCase() }
}

function pickTier(entry: Record<string, unknown>, base: Omit<PriceRule, 'model'>): PriceTier | undefined {
  let threshold = Number.POSITIVE_INFINITY
  for (const key of Object.keys(entry)) {
    const match = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key)
    if (match) {
      threshold = Math.min(threshold, Number(match[1]) * 1000)
    }
  }
  if (!Number.isFinite(threshold)) {
    return undefined
  }
  const suffix = `_above_${threshold / 1000}k_tokens`
  const input = perMillion(entry[`input_cost_per_token${suffix}`]) ?? base.inputPerMillion
  return {
    thresholdTokens: threshold,
    inputPerMillion: input,
    cachedInputPerMillion: perMillion(entry[`cache_read_input_token_cost${suffix}`]) ?? base.cachedInputPerMillion,
    cacheWritePerMillion: perMillion(entry[`cache_creation_input_token_cost${suffix}`]) ?? base.cacheWritePerMillion,
    outputPerMillion: perMillion(entry[`output_cost_per_token${suffix}`]) ?? base.outputPerMillion,
  }
}

export function normalizeLiteLLM(raw: Record<string, unknown>): PriceRule[] {
  const best = new Map<string, { rank: number; rule: PriceRule }>()
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || key === 'sample_spec') {
      continue
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.mode === 'string' && !['chat', 'responses', 'completion'].includes(entry.mode)) {
      continue
    }
    const input = perMillion(entry.input_cost_per_token)
    const output = perMillion(entry.output_cost_per_token)
    if (input === undefined || output === undefined) {
      continue
    }
    const { bare, prefix } = splitModelKey(key)
    const rank = providerRank(prefix)
    const current = best.get(bare)
    if (current && current.rank <= rank) {
      continue
    }
    const cachedInput = perMillion(entry.cache_read_input_token_cost) ?? input
    // 没有单独缓存写入价的模型，缓存写入按普通输入计费。
    const cacheWrite = perMillion(entry.cache_creation_input_token_cost) ?? input
    const base = {
      inputPerMillion: input,
      cachedInputPerMillion: cachedInput,
      cacheWritePerMillion: cacheWrite,
      outputPerMillion: output,
    }
    const rule: PriceRule = {
      model: bare,
      ...base,
      cacheWrite1hPerMillion: perMillion(entry.cache_creation_input_token_cost_above_1hr),
      tier: pickTier(entry, base),
      source: 'litellm',
    }
    best.set(bare, { rank, rule })
  }
  return [...best.values()].map((item) => item.rule)
}

interface ModelsDevCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  context_over_200k?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  tiers?: Array<{
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    tier?: { type?: string; size?: number }
  }>
}

export function normalizeModelsDev(raw: Record<string, unknown>): PriceRule[] {
  const best = new Map<string, { rank: number; rule: PriceRule }>()
  for (const [providerId, providerValue] of Object.entries(raw)) {
    const models = (providerValue as { models?: Record<string, { cost?: ModelsDevCost }> })?.models
    if (!models || typeof models !== 'object') {
      continue
    }
    const rank = providerRank(providerId.toLowerCase())
    for (const [modelId, model] of Object.entries(models)) {
      const cost = model?.cost
      // 0 价通常是平台内免费额度（如 duo-chat-*），不是模型标价，不收录。
      if (typeof cost?.input !== 'number' || typeof cost.output !== 'number' || (cost.input === 0 && cost.output === 0)) {
        continue
      }
      const { bare } = splitModelKey(modelId)
      const current = best.get(bare)
      if (current && current.rank <= rank) {
        continue
      }
      const base = {
        inputPerMillion: cost.input,
        cachedInputPerMillion: cost.cache_read ?? cost.input,
        cacheWritePerMillion: cost.cache_write ?? cost.input,
        outputPerMillion: cost.output,
      }
      const contextTier = cost.tiers?.find((tier) => tier.tier?.type === 'context' && tier.tier.size)
      const tierSource = contextTier ?? (cost.context_over_200k ? { ...cost.context_over_200k, tier: { size: 200_000 } } : null)
      const tier: PriceTier | undefined = tierSource
        ? {
            thresholdTokens: tierSource.tier?.size ?? 200_000,
            inputPerMillion: tierSource.input ?? base.inputPerMillion,
            cachedInputPerMillion: tierSource.cache_read ?? base.cachedInputPerMillion,
            cacheWritePerMillion: tierSource.cache_write ?? base.cacheWritePerMillion,
            outputPerMillion: tierSource.output ?? base.outputPerMillion,
          }
        : undefined
      best.set(bare, { rank, rule: { model: bare, ...base, tier, source: 'models.dev' } })
    }
  }
  return [...best.values()].map((item) => item.rule)
}

/** 忽略 . 和 - 的差异：gpt-5-6-sol 与 gpt-5.6-sol 视为同一模型。 */
function looseKey(model: string) {
  return model.replaceAll('.', '-')
}

/** primary 优先，secondary 只补充 primary 缺失的模型（名称只差 . / - 也算已有）。 */
export function mergeRules(primary: PriceRule[], secondary: PriceRule[]) {
  const map = new Map(primary.map((rule) => [rule.model, rule]))
  const known = new Set(primary.map((rule) => looseKey(rule.model)))
  for (const rule of secondary) {
    if (!map.has(rule.model) && !known.has(looseKey(rule.model))) {
      map.set(rule.model, rule)
      known.add(looseKey(rule.model))
    }
  }
  return [...map.values()].sort((left, right) => left.model.localeCompare(right.model))
}
