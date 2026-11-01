export type TimeGranularity = 'hour' | 'day' | 'week' | 'month'

export type ProviderType = 'codex' | 'claude'

export type TimeRangeKey = 'today' | '7d' | '30d' | 'custom' | 'all'

export type ArchivedFilter = 'all' | 'active' | 'archived'

/**
 * Normalized usage, identical semantics for every provider:
 * - inputTokens: uncached input only (billed at full input price)
 * - cachedInputTokens: cache reads (billed at cache-read price)
 * - cacheWriteTokens: cache creation / writes (billed at cache-write price)
 * - outputTokens: all output, reasoning included
 * - reasoningOutputTokens: informational subset of outputTokens
 * - totalTokens: input + cached + cacheWrite + output
 */
export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export interface QualityStats {
  rawUsageRecords: number
  countedUsageRecords: number
  duplicateRecords: number
  duplicateTokens: number
  invariantViolations: number
  compressedFiles: number
  /** Tokens known only as a session total (no input/output breakdown, cannot be priced). */
  totalOnlyTokens: number
}

export interface ThreadSummary {
  id: string
  rolloutPath: string
  createdAtMs: number
  updatedAtMs: number
  source: string
  modelProvider: string
  cwd: string
  title: string
  sandboxPolicy: string
  approvalMode: string
  tokensUsed: number
  hasUserEvent: boolean
  archived: boolean
  archivedAtMs: number | null
  cliVersion: string
  firstUserMessage: string
  preview: string
  model: string
  reasoningEffort: string
  threadSource: string
}

export interface TokenSample extends TokenUsage {
  timestampMs: number
  /** Request context size (input + cache read + cache write) used for tiered pricing. */
  contextTokens: number
  /** Per-request model; falls back to the session model when empty. */
  model?: string
}

export interface RequestSample {
  timestampMs: number
  kind: 'user' | 'assistant' | 'tool'
  toolName?: string
}

export interface SessionEventSummary {
  id: string
  sessionFilePath: string
  sessionTimestampMs: number
  cwd: string
  source: string
  threadSource: string
  modelProvider: string
  cliVersion: string
  model: string
  title: string
  firstUserMessage: string
  preview: string
  firstEventAtMs: number
  lastEventAtMs: number
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number
  interactionTurns: number
  toolBreakdown: Record<string, number>
  lastTokenUsage: TokenUsage | null
  tokenSamples: TokenSample[]
  requestSamples: RequestSample[]
  malformedLines: number
  eventCount: number
  quality: QualityStats
  forkedFromId: string
  isSubagent: boolean
}

export interface MergedSession {
  id: string
  rolloutPath: string
  sessionFilePath: string
  cwd: string
  title: string
  preview: string
  model: string
  modelProvider: string
  threadSource: string
  createdAtMs: number
  updatedAtMs: number
  firstEventAtMs: number
  lastEventAtMs: number
  archived: boolean
  cliVersion: string
  usage: TokenUsage
  threadTokensUsed: number
  resolvedTotalTokens: number
  rangeUsage?: TokenUsage
  rangeTotalTokens?: number
  rangeCost?: number
  userMessageCount: number
  assistantMessageCount: number
  interactionTurns: number
  toolCallCount: number
  toolBreakdown: Record<string, number>
  tokenSamples: TokenSample[]
  requestSamples: RequestSample[]
  malformedLines: number
  eventCount: number
  durationMs: number
  usageConflict: boolean
  quality: QualityStats
  isSubagent: boolean
}

export interface SourceSummary {
  parsedAtMs: number
  fingerprint: string
  fileCount: number
  sessionFileCount: number
  sessionCount: number
  threadCount: number
  sourceType: 'directory-handle' | 'file-list' | 'local-api'
  provider: ProviderType
  sourceName: string
  detectedPath: string
}

export interface DashboardData {
  sessions: MergedSession[]
  sourceSummary: SourceSummary
}

export interface PriceTier {
  /** Applies when request context exceeds this many tokens. */
  thresholdTokens: number
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
}

export interface PriceRule {
  model: string
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  cacheWrite1hPerMillion?: number
  outputPerMillion: number
  tier?: PriceTier
  source?: 'builtin' | 'litellm' | 'models.dev' | 'custom'
}

export interface PricingCatalog {
  version: 2
  updatedAtMs: number
  source: string
  rules: PriceRule[]
  /** Model names the user edited by hand; never overwritten by sync. */
  overrides: PriceRule[]
}

export interface FilterState {
  provider: ProviderType
  timeRange: TimeRangeKey
  customStartDate: string
  customEndDate: string
  granularity: TimeGranularity
  model: string
  cwd: string
  archived: ArchivedFilter
  search: string
}

export interface TrendPoint {
  bucket: string
  bucketLabel: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  sessionCount: number
  toolCallCount: number
  estimatedCost: number
  byModel: Record<string, number>
}

export interface RankedValue {
  key: string
  label: string
  sessions: number
  totalTokens: number
  estimatedCost: number
  avgTokens: number
}

export interface ToolRank {
  name: string
  count: number
}

export interface HourBucket {
  hour: string
  totalTokens: number
  sessions: number
}

export interface WeekdayBucket {
  weekday: string
  totalTokens: number
  sessions: number
}

export interface DistributionBucket {
  label: string
  sessions: number
}

export interface MetricSnapshot {
  filters: FilterState
  filteredSessions: MergedSession[]
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  estimatedCost: number
  costBreakdown: CostBreakdown
  unpricedTokens: number
  unpricedModels: string[]
  tieredRequests: number
  quality: QualityStats
  sessionCount: number
  interactionTurns: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  activeDays: number
  avgSessionTokens: number
  avgSessionDurationMs: number
  avgToolCalls: number
  avgRpm: number
  avgTpm: number
  peakDay: { label: string; totalTokens: number } | null
  peakHour: { label: string; totalTokens: number } | null
  trend: TrendPoint[]
  hourly: HourBucket[]
  weekdays: WeekdayBucket[]
  modelRanks: RankedValue[]
  projectRanks: RankedValue[]
  toolRanks: ToolRank[]
  distribution: DistributionBucket[]
  topSessions: MergedSession[]
}

export interface CostBreakdown {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
}

export interface DailyActivity {
  day: string
  totalTokens: number
  estimatedCost: number
  sessions: number
  requests: number
}

export interface CacheRecord {
  schemaVersion?: number
  savedAtMs: number
  dataset: DashboardData
}

export interface LoadProgress {
  phase: string
  processed: number
  total: number
}

export interface VirtualFileEntry {
  path: string
  file: File
}

export interface LocalApiFileEntry {
  path: string
  size: number
  lastModifiedMs: number
}

export interface LocalApiDetectResult {
  ok: boolean
  provider: ProviderType
  rootPath: string
  fileCount: number
  sessionFileCount: number
  totalBytes: number
  message?: string
}

export interface LocalApiFileListResult extends LocalApiDetectResult {
  files: LocalApiFileEntry[]
  nextCursor: number | null
  total: number
}
