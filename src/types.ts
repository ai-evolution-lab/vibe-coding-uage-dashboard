export type TimeGranularity = 'day' | 'week' | 'month'

export type ProviderType = 'codex' | 'claude'

export type TimeRangeKey = 'today' | '7d' | '30d' | 'custom' | 'all'

export type ArchivedFilter = 'all' | 'active' | 'archived'

export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
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

export interface TokenSample {
  timestampMs: number
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
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

export interface PriceRule {
  model: string
  inputPerMillion: number
  cachedInputPerMillion: number
  outputPerMillion: number
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
  outputTokens: number
  estimatedCost: number
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
  sparklineTokens: number[]
  sparklineSessions: number[]
  sparklineCost: number[]
  sparklineTpm: number[]
}

export interface CacheRecord {
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
