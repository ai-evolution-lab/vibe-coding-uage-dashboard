import type {
  DashboardData,
  DistributionBucket,
  FilterState,
  HourBucket,
  MetricSnapshot,
  MergedSession,
  PriceRule,
  RankedValue,
  TimeGranularity,
  ToolRank,
  TrendPoint,
  WeekdayBucket,
} from '../types'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date: Date) {
  const result = startOfDay(date)
  result.setDate(result.getDate() + 1)
  result.setMilliseconds(result.getMilliseconds() - 1)
  return result
}

function parseLocalDate(value: string, end = false) {
  if (!value) {
    return end ? Number.POSITIVE_INFINITY : 0
  }
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`)
  const time = date.getTime()
  if (!Number.isFinite(time)) {
    return end ? Number.POSITIVE_INFINITY : 0
  }
  return time
}

function getCalendarDayRange(dayCount: number) {
  const today = new Date()
  const start = startOfDay(today)
  start.setDate(start.getDate() - dayCount + 1)
  return {
    minTime: start.getTime(),
    maxTime: endOfDay(today).getTime(),
  }
}

function startOfWeek(date: Date) {
  const result = startOfDay(date)
  const day = result.getDay()
  result.setDate(result.getDate() - day)
  return result
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function bucketDate(date: Date, granularity: TimeGranularity) {
  if (granularity === 'week') {
    return startOfWeek(date)
  }
  if (granularity === 'month') {
    return startOfMonth(date)
  }
  return startOfDay(date)
}

function formatBucket(date: Date, granularity: TimeGranularity) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (granularity === 'month') {
    return `${year}-${month}`
  }
  return `${year}-${month}-${day}`
}

function getTimeRangeBounds(filters: FilterState) {
  if (filters.timeRange === 'custom') {
    return {
      minTime: parseLocalDate(filters.customStartDate),
      maxTime: parseLocalDate(filters.customEndDate, true),
    }
  }
  const range = filters.timeRange
  if (range === 'all') {
    return { minTime: 0, maxTime: Number.POSITIVE_INFINITY }
  }
  if (range === 'today') {
    return getCalendarDayRange(1)
  }
  const days = range === '7d' ? 7 : 30
  return getCalendarDayRange(days)
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase()
}

function matchesSearch(session: MergedSession, search: string) {
  if (!search) {
    return true
  }

  const fields = {
    title: session.title,
    project: session.cwd,
    cwd: session.cwd,
    model: session.model,
    tool: Object.keys(session.toolBreakdown).join(' '),
    id: session.id,
  }
  const haystack = [
    session.id,
    session.title,
    session.preview,
    session.model,
    session.cwd,
    Object.keys(session.toolBreakdown).join(' '),
  ]
    .join(' ')
    .toLowerCase()

  return search
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => {
      const separatorIndex = term.indexOf(':')
      if (separatorIndex > 0) {
        const key = term.slice(0, separatorIndex) as keyof typeof fields
        const value = term.slice(separatorIndex + 1).toLowerCase()
        if (key in fields) {
          return fields[key].toLowerCase().includes(value)
        }
      }
      return haystack.includes(term)
    })
}

export function getDefaultPriceRules(): PriceRule[] {
  return [
    {
      model: 'gpt-5.5-chat-latest',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 30,
    },
    {
      model: 'gpt-5.5',
      inputPerMillion: 2.5,
      cachedInputPerMillion: 0.25,
      outputPerMillion: 15,
    },
    {
      model: 'gpt-5.5-mini',
      inputPerMillion: 0.75,
      cachedInputPerMillion: 0.075,
      outputPerMillion: 4.5,
    },
    {
      model: 'gpt-5.5-nano',
      inputPerMillion: 0.2,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 1.25,
    },
    {
      model: 'gpt-5.3-codex',
      inputPerMillion: 1.75,
      cachedInputPerMillion: 0.175,
      outputPerMillion: 14,
    },
    {
      model: 'gpt-5.2-chat-latest',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 30,
    },
    {
      model: 'gpt-5.2',
      inputPerMillion: 2.5,
      cachedInputPerMillion: 0.25,
      outputPerMillion: 15,
    },
    {
      model: 'gpt-5.2-mini',
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.04,
      outputPerMillion: 2,
    },
    {
      model: 'gpt-5.2-nano',
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.01,
      outputPerMillion: 0.4,
    },
    {
      model: 'gpt-5.1-chat-latest',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 30,
    },
    {
      model: 'gpt-5.1',
      inputPerMillion: 2,
      cachedInputPerMillion: 0.2,
      outputPerMillion: 8,
    },
    {
      model: 'gpt-5.1-mini',
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.04,
      outputPerMillion: 2,
    },
    {
      model: 'gpt-5.1-nano',
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.01,
      outputPerMillion: 0.4,
    },
    {
      model: 'chat-latest',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 30,
    },
    {
      model: 'gpt-5-chat-latest',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 30,
    },
    {
      model: 'gpt-5',
      inputPerMillion: 1.25,
      cachedInputPerMillion: 0.125,
      outputPerMillion: 10,
    },
    {
      model: 'gpt-5-mini',
      inputPerMillion: 0.25,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 2,
    },
    {
      model: 'gpt-5-nano',
      inputPerMillion: 0.05,
      cachedInputPerMillion: 0.005,
      outputPerMillion: 0.4,
    },
    {
      model: 'gpt-4.1-mini',
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 1.6,
    },
    {
      model: 'gpt-4.1-nano',
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 0.4,
    },
    {
      model: 'gpt-4.1',
      inputPerMillion: 2,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 8,
    },
    {
      model: 'gpt-4o-mini',
      inputPerMillion: 0.15,
      cachedInputPerMillion: 0.075,
      outputPerMillion: 0.6,
    },
    {
      model: 'gpt-4o',
      inputPerMillion: 2.5,
      cachedInputPerMillion: 1.25,
      outputPerMillion: 10,
    },
    {
      model: 'codex-auto-review',
      inputPerMillion: 1.75,
      cachedInputPerMillion: 0.175,
      outputPerMillion: 14,
    },
    {
      model: 'claude-opus-4.8',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
    {
      model: 'claude-opus-4-8',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
    {
      model: 'claude-opus-4.7',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
    {
      model: 'claude-opus-4-7',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
    {
      model: 'claude-opus-4.6',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
    {
      model: 'claude-opus-4-6',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
    {
      model: 'claude-opus-4.5',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
    {
      model: 'claude-opus-4-5',
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
    {
      model: 'claude-opus-4.1',
      inputPerMillion: 15,
      cachedInputPerMillion: 1.5,
      outputPerMillion: 75,
    },
    {
      model: 'claude-opus-4-1',
      inputPerMillion: 15,
      cachedInputPerMillion: 1.5,
      outputPerMillion: 75,
    },
    {
      model: 'claude-opus-4',
      inputPerMillion: 15,
      cachedInputPerMillion: 1.5,
      outputPerMillion: 75,
    },
    {
      model: 'claude-sonnet-4.6',
      inputPerMillion: 3,
      cachedInputPerMillion: 0.3,
      outputPerMillion: 15,
    },
    {
      model: 'claude-sonnet-4-6',
      inputPerMillion: 3,
      cachedInputPerMillion: 0.3,
      outputPerMillion: 15,
    },
    {
      model: 'claude-sonnet-4.5',
      inputPerMillion: 3,
      cachedInputPerMillion: 0.3,
      outputPerMillion: 15,
    },
    {
      model: 'claude-sonnet-4-5',
      inputPerMillion: 3,
      cachedInputPerMillion: 0.3,
      outputPerMillion: 15,
    },
    {
      model: 'claude-sonnet-4',
      inputPerMillion: 3,
      cachedInputPerMillion: 0.3,
      outputPerMillion: 15,
    },
    {
      model: 'claude-haiku-4.5',
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 5,
    },
    {
      model: 'claude-haiku-4-5',
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 5,
    },
    {
      model: 'claude-3-5-haiku',
      inputPerMillion: 0.8,
      cachedInputPerMillion: 0.08,
      outputPerMillion: 4,
    },
    {
      model: 'default',
      inputPerMillion: 0,
      cachedInputPerMillion: 0,
      outputPerMillion: 0,
    },
  ]
}

export function hasExplicitPriceRule(model: string, priceRules: PriceRule[]) {
  return priceRules.some(
    (rule) =>
      rule.model !== 'default' && (rule.model === model || (rule.model && model.startsWith(rule.model))),
  )
}

function findPriceRule(model: string, priceRules: PriceRule[]) {
  return (
    priceRules.find((rule) => rule.model === model) ??
    priceRules.find((rule) => rule.model !== 'default' && model.startsWith(rule.model)) ??
    priceRules.find((rule) => rule.model === 'default') ??
    {
      model: 'default',
      inputPerMillion: 0,
      cachedInputPerMillion: 0,
      outputPerMillion: 0,
    }
  )
}

export function estimateSessionCost(session: MergedSession, priceRules: PriceRule[]) {
  const rule = findPriceRule(session.model, priceRules)
  return (
    (session.usage.inputTokens / 1_000_000) * rule.inputPerMillion +
    (session.usage.cachedInputTokens / 1_000_000) * rule.cachedInputPerMillion +
    (session.usage.outputTokens / 1_000_000) * rule.outputPerMillion
  )
}

export function getFilterDefaults(): FilterState {
  return {
    provider: 'codex',
    timeRange: 'today',
    customStartDate: '',
    customEndDate: '',
    granularity: 'day',
    model: 'all',
    cwd: 'all',
    archived: 'all',
    search: '',
  }
}

export function getAvailableModels(sessions: MergedSession[]) {
  return ['all', ...new Set(sessions.map((session) => session.model).filter(Boolean))].sort()
}

export function getAvailableProjects(sessions: MergedSession[]) {
  return ['all', ...new Set(sessions.map((session) => session.cwd).filter(Boolean))].sort()
}

export function filterSessions(sessions: MergedSession[], filters: FilterState) {
  const search = normalizeSearchText(filters.search)
  const { minTime, maxTime } = getTimeRangeBounds(filters)

  return sessions.filter((session) => {
    if (filters.model !== 'all' && session.model !== filters.model) {
      return false
    }
    if (filters.cwd !== 'all' && session.cwd !== filters.cwd) {
      return false
    }
    if (filters.archived === 'active' && session.archived) {
      return false
    }
    if (filters.archived === 'archived' && !session.archived) {
      return false
    }
    if (minTime > 0 && session.updatedAtMs < minTime) {
      return false
    }
    if (session.updatedAtMs > maxTime) {
      return false
    }
    return matchesSearch(session, search)
  })
}

function buildTrend(
  sessions: MergedSession[],
  granularity: TimeGranularity,
  priceRules: PriceRule[],
): TrendPoint[] {
  const trendMap = new Map<string, TrendPoint>()

  for (const session of sessions) {
    const bucketTime = bucketDate(new Date(session.updatedAtMs), granularity)
    const bucket = formatBucket(bucketTime, granularity)
    const bucketLabel = bucket
    const current =
      trendMap.get(bucket) ??
      {
        bucket,
        bucketLabel,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        sessionCount: 0,
        toolCallCount: 0,
        estimatedCost: 0,
        byModel: {},
      }

    current.totalTokens += session.resolvedTotalTokens
    current.inputTokens += session.usage.inputTokens
    current.outputTokens += session.usage.outputTokens
    current.cachedInputTokens += session.usage.cachedInputTokens
    current.sessionCount += 1
    current.toolCallCount += session.toolCallCount
    current.estimatedCost += estimateSessionCost(session, priceRules)
    current.byModel[session.model] = (current.byModel[session.model] ?? 0) + session.resolvedTotalTokens
    trendMap.set(bucket, current)
  }

  return [...trendMap.values()].sort((left, right) => left.bucket.localeCompare(right.bucket))
}

function buildRankedValues(
  sessions: MergedSession[],
  selector: (session: MergedSession) => string,
  priceRules: PriceRule[],
): RankedValue[] {
  const map = new Map<string, RankedValue>()
  for (const session of sessions) {
    const key = selector(session) || 'unknown'
    const current =
      map.get(key) ??
      {
        key,
        label: key,
        sessions: 0,
        totalTokens: 0,
        estimatedCost: 0,
        avgTokens: 0,
      }
    current.sessions += 1
    current.totalTokens += session.resolvedTotalTokens
    current.estimatedCost += estimateSessionCost(session, priceRules)
    map.set(key, current)
  }

  return [...map.values()]
    .map((item) => ({
      ...item,
      avgTokens: item.sessions > 0 ? item.totalTokens / item.sessions : 0,
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens)
}

function buildToolRanks(sessions: MergedSession[]): ToolRank[] {
  const toolMap = new Map<string, number>()
  for (const session of sessions) {
    for (const [tool, count] of Object.entries(session.toolBreakdown)) {
      toolMap.set(tool, (toolMap.get(tool) ?? 0) + count)
    }
  }

  return [...toolMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
}

function sessionDayKey(timestampMs: number) {
  const date = new Date(timestampMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getAvailableSessionDays(sessions: MergedSession[]) {
  return [...new Set(sessions.map((session) => sessionDayKey(session.updatedAtMs)))]
    .sort((left, right) => right.localeCompare(left))
}

export function buildHourlyBuckets(sessions: MergedSession[], dateKey?: string): HourBucket[] {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, '0'),
    totalTokens: 0,
    sessions: 0,
  }))

  for (const session of sessions) {
    if (dateKey && sessionDayKey(session.updatedAtMs) !== dateKey) {
      continue
    }
    const hour = new Date(session.updatedAtMs).getHours()
    hours[hour].totalTokens += session.resolvedTotalTokens
    hours[hour].sessions += 1
  }

  return hours
}

function buildWeekdays(sessions: MergedSession[]): WeekdayBucket[] {
  const weekdays = WEEKDAYS.map((weekday) => ({
    weekday,
    totalTokens: 0,
    sessions: 0,
  }))

  for (const session of sessions) {
    const weekday = new Date(session.updatedAtMs).getDay()
    weekdays[weekday].totalTokens += session.resolvedTotalTokens
    weekdays[weekday].sessions += 1
  }

  return weekdays
}

function buildDistribution(sessions: MergedSession[]): DistributionBucket[] {
  const buckets = [
    { label: '<10k', min: 0, max: 10_000 },
    { label: '10k-50k', min: 10_000, max: 50_000 },
    { label: '50k-100k', min: 50_000, max: 100_000 },
    { label: '100k-500k', min: 100_000, max: 500_000 },
    { label: '500k-1m', min: 500_000, max: 1_000_000 },
    { label: '1m+', min: 1_000_000, max: Number.POSITIVE_INFINITY },
  ]

  return buckets.map((bucket) => ({
    label: bucket.label,
    sessions: sessions.filter(
      (session) =>
        session.resolvedTotalTokens >= bucket.min && session.resolvedTotalTokens < bucket.max,
    ).length,
  }))
}

function buildPerMinuteStats(sessions: MergedSession[]) {
  const minuteTokens = new Map<string, number>()
  const minuteRequests = new Map<string, number>()

  for (const session of sessions) {
    for (const sample of session.tokenSamples) {
      const bucket = new Date(sample.timestampMs)
      bucket.setSeconds(0, 0)
      const key = bucket.toISOString()
      minuteTokens.set(key, (minuteTokens.get(key) ?? 0) + sample.totalTokens)
    }

    for (const sample of session.requestSamples) {
      if (sample.kind !== 'user') {
        continue
      }
      const bucket = new Date(sample.timestampMs)
      bucket.setSeconds(0, 0)
      const key = bucket.toISOString()
      minuteRequests.set(key, (minuteRequests.get(key) ?? 0) + 1)
    }
  }

  const activeMinuteCount = new Set([...minuteTokens.keys(), ...minuteRequests.keys()]).size || 1
  const totalTokens = [...minuteTokens.values()].reduce((sum, value) => sum + value, 0)
  const totalRequests = [...minuteRequests.values()].reduce((sum, value) => sum + value, 0)

  return {
    avgTpm: totalTokens / activeMinuteCount,
    avgRpm: totalRequests / activeMinuteCount,
    sparklineTpm: [...minuteTokens.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .slice(-12)
      .map(([, value]) => value),
  }
}

export function buildMetricSnapshot(
  dataset: DashboardData,
  filters: FilterState,
  priceRules: PriceRule[],
): MetricSnapshot {
  const filteredSessions = filterSessions(dataset.sessions, filters)
  const trend = buildTrend(filteredSessions, filters.granularity, priceRules)
  const modelRanks = buildRankedValues(filteredSessions, (session) => session.model, priceRules)
  const projectRanks = buildRankedValues(filteredSessions, (session) => session.cwd, priceRules)
  const toolRanks = buildToolRanks(filteredSessions)
  const hourly = buildHourlyBuckets(filteredSessions)
  const weekdays = buildWeekdays(filteredSessions)
  const distribution = buildDistribution(filteredSessions)
  const topSessions = [...filteredSessions]
    .sort((left, right) => right.resolvedTotalTokens - left.resolvedTotalTokens)
    .slice(0, 10)

  const totalTokens = filteredSessions.reduce((sum, session) => sum + session.resolvedTotalTokens, 0)
  const inputTokens = filteredSessions.reduce((sum, session) => sum + session.usage.inputTokens, 0)
  const cachedInputTokens = filteredSessions.reduce(
    (sum, session) => sum + session.usage.cachedInputTokens,
    0,
  )
  const outputTokens = filteredSessions.reduce((sum, session) => sum + session.usage.outputTokens, 0)
  const estimatedCost = filteredSessions.reduce(
    (sum, session) => sum + estimateSessionCost(session, priceRules),
    0,
  )
  const sessionCount = filteredSessions.length
  const interactionTurns = filteredSessions.reduce((sum, session) => sum + session.interactionTurns, 0)
  const userMessages = filteredSessions.reduce((sum, session) => sum + session.userMessageCount, 0)
  const assistantMessages = filteredSessions.reduce(
    (sum, session) => sum + session.assistantMessageCount,
    0,
  )
  const toolCalls = filteredSessions.reduce((sum, session) => sum + session.toolCallCount, 0)
  const activeDays = new Set(
    filteredSessions.map((session) => formatBucket(startOfDay(new Date(session.updatedAtMs)), 'day')),
  ).size
  const avgSessionTokens = sessionCount > 0 ? totalTokens / sessionCount : 0
  const avgSessionDurationMs =
    sessionCount > 0
      ? filteredSessions.reduce((sum, session) => sum + session.durationMs, 0) / sessionCount
      : 0
  const avgToolCalls = sessionCount > 0 ? toolCalls / sessionCount : 0
  const peakDay = trend.reduce<{ label: string; totalTokens: number } | null>(
    (current, item) =>
      !current || item.totalTokens > current.totalTokens
        ? { label: item.bucketLabel, totalTokens: item.totalTokens }
        : current,
    null,
  )
  const peakHour = hourly.reduce<{ label: string; totalTokens: number } | null>(
    (current, item) =>
      !current || item.totalTokens > current.totalTokens
        ? { label: `${item.hour}:00`, totalTokens: item.totalTokens }
        : current,
    null,
  )
  const minuteStats = buildPerMinuteStats(filteredSessions)

  return {
    filters,
    filteredSessions,
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    estimatedCost,
    sessionCount,
    interactionTurns,
    userMessages,
    assistantMessages,
    toolCalls,
    activeDays,
    avgSessionTokens,
    avgSessionDurationMs,
    avgToolCalls,
    avgRpm: minuteStats.avgRpm,
    avgTpm: minuteStats.avgTpm,
    peakDay,
    peakHour,
    trend,
    hourly,
    weekdays,
    modelRanks,
    projectRanks,
    toolRanks,
    distribution,
    topSessions,
    sparklineTokens: trend.slice(-12).map((item) => item.totalTokens),
    sparklineSessions: trend.slice(-12).map((item) => item.sessionCount),
    sparklineCost: trend.slice(-12).map((item) => item.estimatedCost),
    sparklineTpm: minuteStats.sparklineTpm,
  }
}
