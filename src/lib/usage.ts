import type { QualityStats, TokenSample, TokenUsage } from '../types'

export function asNumber(value: unknown) {
  const next = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(next) ? next : 0
}

export function createEmptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  }
}

export function createEmptyQuality(): QualityStats {
  return {
    rawUsageRecords: 0,
    countedUsageRecords: 0,
    duplicateRecords: 0,
    duplicateTokens: 0,
    invariantViolations: 0,
    compressedFiles: 0,
    totalOnlyTokens: 0,
  }
}

export function sumUsageParts(usage: Pick<TokenUsage, 'inputTokens' | 'cachedInputTokens' | 'cacheWriteTokens' | 'outputTokens'>) {
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens
}

export function addUsage(target: TokenUsage, usage: TokenUsage) {
  target.inputTokens += usage.inputTokens
  target.cachedInputTokens += usage.cachedInputTokens
  target.cacheWriteTokens += usage.cacheWriteTokens
  target.cacheWrite1hTokens += usage.cacheWrite1hTokens
  target.outputTokens += usage.outputTokens
  target.reasoningOutputTokens += usage.reasoningOutputTokens
  target.totalTokens += usage.totalTokens
}

export function addQuality(target: QualityStats, quality: QualityStats | undefined) {
  if (!quality) {
    return
  }
  target.rawUsageRecords += quality.rawUsageRecords
  target.countedUsageRecords += quality.countedUsageRecords
  target.duplicateRecords += quality.duplicateRecords
  target.duplicateTokens += quality.duplicateTokens
  target.invariantViolations += quality.invariantViolations
  target.compressedFiles += quality.compressedFiles
  target.totalOnlyTokens += quality.totalOnlyTokens
}

export function usageFromSample(sample: TokenSample): TokenUsage {
  return {
    inputTokens: sample.inputTokens,
    cachedInputTokens: sample.cachedInputTokens,
    cacheWriteTokens: sample.cacheWriteTokens ?? 0,
    cacheWrite1hTokens: sample.cacheWrite1hTokens ?? 0,
    outputTokens: sample.outputTokens,
    reasoningOutputTokens: sample.reasoningOutputTokens ?? 0,
    totalTokens: sample.totalTokens,
  }
}
