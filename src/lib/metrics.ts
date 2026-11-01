import type {
  CostBreakdown,
  DailyActivity,
  DashboardData,
  DistributionBucket,
  FilterState,
  HourBucket,
  MetricSnapshot,
  MergedSession,
  RankedValue,
  TimeGranularity,
  TokenUsage,
  ToolRank,
  TrendPoint,
  WeekdayBucket,
} from '../types'
import { addCost, emptyCost, isTiered, priceUsage, resolvePrice, totalCost } from './pricing'
import type { PricingIndex } from './pricing'
import { addQuality, addUsage, createEmptyQuality, createEmptyUsage, usageFromSample } from './usage'

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
  if (granularity === 'hour') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours())
  }
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
  if (granularity === 'hour') {
    return `${year}-${month}-${day} ${String(date.getHours()).padStart(2, '0')}:00`
  }
  return `${year}-${month}-${day}`
}

function nextBucket(date: Date, granularity: TimeGranularity) {
  const next = new Date(date)
  if (granularity === 'hour') next.setHours(next.getHours() + 1)
  else if (granularity === 'day') next.setDate(next.getDate() + 1)
  else if (granularity === 'week') next.setDate(next.getDate() + 7)
  else next.setMonth(next.getMonth() + 1)
  return next
}

function bucketLabel(bucket: string, granularity: TimeGranularity) {
  if (granularity === 'hour') return bucket.slice(5)
  if (granularity === 'week') return `${bucket.slice(5)} 周`
  if (granularity === 'month') return bucket
  return bucket.slice(5)
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

interface CostAccumulator {
  cost: CostBreakdown
  unpricedTokens: number
  unpricedModels: Set<string>
  tieredRequests: number
}

function createCostAccumulator(): CostAccumulator {
  return { cost: emptyCost(), unpricedTokens: 0, unpricedModels: new Set(), tieredRequests: 0 }
}

/** 按单次请求计价：每条样本有自己的模型和上下文大小，分档价才能算准。 */
function priceSample(
  usage: TokenUsage,
  contextTokens: number,
  model: string,
  pricing: PricingIndex,
  accumulator?: CostAccumulator,
) {
  const resolved = resolvePrice(model, pricing)
  if (!resolved) {
    if (accumulator && usage.totalTokens > 0) {
      accumulator.unpricedTokens += usage.totalTokens
      accumulator.unpricedModels.add(model || 'unknown')
    }
    return 0
  }
  const cost = priceUsage(usage, contextTokens, resolved.rule)
  if (accumulator) {
    addCost(accumulator.cost, cost)
    if (isTiered(contextTokens, resolved.rule)) {
      accumulator.tieredRequests += 1
    }
  }
  return totalCost(cost)
}

function sampleModel(session: MergedSession, sampleModelName?: string) {
  return sampleModelName || session.model
}

export function estimateSessionCost(session: MergedSession, pricing: PricingIndex, accumulator?: CostAccumulator) {
  if (session.tokenSamples.length > 0) {
    return session.tokenSamples.reduce(
      (sum, sample) =>
        sum + priceSample(usageFromSample(sample), sample.contextTokens ?? 0, sampleModel(session, sample.model), pricing, accumulator),
      0,
    )
  }
  const usage = getMetricUsage(session)
  return priceSample(usage, 0, session.model, pricing, accumulator)
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

function isInTimeRange(timestampMs: number, minTime: number, maxTime: number) {
  return timestampMs >= minTime && timestampMs <= maxTime
}

function getSessionRangeUsage(session: MergedSession, minTime: number, maxTime: number) {
  if (session.tokenSamples.length > 0) {
    const usage = createEmptyUsage()
    let sampleCount = 0
    for (const sample of session.tokenSamples) {
      if (!isInTimeRange(sample.timestampMs, minTime, maxTime)) {
        continue
      }
      addUsage(usage, usageFromSample(sample))
      sampleCount += 1
    }
    return sampleCount > 0 ? usage : null
  }

  if (!isInTimeRange(session.updatedAtMs, minTime, maxTime)) {
    return null
  }
  return { ...session.usage }
}

function getMetricUsage(session: MergedSession) {
  return session.rangeUsage ?? session.usage
}

function getMetricTotalTokens(session: MergedSession) {
  return session.rangeTotalTokens ?? session.resolvedTotalTokens
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

  return sessions.flatMap((session) => {
    if (filters.model !== 'all' && session.model !== filters.model) {
      return []
    }
    if (filters.cwd !== 'all' && session.cwd !== filters.cwd) {
      return []
    }
    if (filters.archived === 'active' && session.archived) {
      return []
    }
    if (filters.archived === 'archived' && !session.archived) {
      return []
    }
    if (!matchesSearch(session, search)) {
      return []
    }

    const rangeUsage = getSessionRangeUsage(session, minTime, maxTime)
    if (!rangeUsage) {
      return []
    }
    const tokenSamples =
      session.tokenSamples.length > 0
        ? session.tokenSamples.filter((sample) => isInTimeRange(sample.timestampMs, minTime, maxTime))
        : session.tokenSamples
    return [
      {
        ...session,
        tokenSamples,
        rangeUsage,
        rangeTotalTokens: rangeUsage.totalTokens || (session.tokenSamples.length === 0 ? session.resolvedTotalTokens : 0),
      },
    ]
  })
}

function buildTrend(
  sessions: MergedSession[],
  granularity: TimeGranularity,
  pricing: PricingIndex,
  minTime: number,
  maxTime: number,
): TrendPoint[] {
  const trendMap = new Map<string, TrendPoint>()

  function ensureTrendPoint(bucket: string) {
    const current =
      trendMap.get(bucket) ??
      {
        bucket,
        bucketLabel: bucket,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        sessionCount: 0,
        toolCallCount: 0,
        estimatedCost: 0,
        byModel: {},
      }
    trendMap.set(bucket, current)
    return current
  }

  let firstTimestamp = Number.POSITIVE_INFINITY
  for (const session of sessions) {
    const seenBuckets = new Set<string>()
    const addToBucket = (timestampMs: number, usage: TokenUsage, contextTokens: number, model: string) => {
      firstTimestamp = Math.min(firstTimestamp, timestampMs)
      const bucketTime = bucketDate(new Date(timestampMs), granularity)
      const bucket = formatBucket(bucketTime, granularity)
      const current = ensureTrendPoint(bucket)
      const totalTokens = usage.totalTokens
      current.totalTokens += totalTokens
      current.inputTokens += usage.inputTokens
      current.outputTokens += usage.outputTokens
      current.cachedInputTokens += usage.cachedInputTokens
      current.cacheWriteTokens += usage.cacheWriteTokens
      current.estimatedCost += priceSample(usage, contextTokens, model, pricing)
      current.byModel[model] = (current.byModel[model] ?? 0) + totalTokens
      if (!seenBuckets.has(bucket)) {
        current.sessionCount += 1
        current.toolCallCount += session.toolCallCount
        seenBuckets.add(bucket)
      }
    }

    if (session.tokenSamples.length > 0) {
      for (const sample of session.tokenSamples) {
        if (isInTimeRange(sample.timestampMs, minTime, maxTime)) {
          addToBucket(sample.timestampMs, usageFromSample(sample), sample.contextTokens ?? 0, sampleModel(session, sample.model))
        }
      }
      continue
    }

    if (isInTimeRange(session.updatedAtMs, minTime, maxTime)) {
      const usage = getMetricUsage(session)
      addToBucket(session.updatedAtMs, { ...usage, totalTokens: getMetricTotalTokens(session) }, 0, session.model)
    }
  }

  // 补齐没有用量的时间段，让 x 轴连续；范围从第一个有数据的桶到筛选范围终点（最多到当前时间）。
  const filled = [...trendMap.values()].sort((left, right) => left.bucket.localeCompare(right.bucket))
  if (filled.length === 0) {
    return filled
  }
  const firstSampleTime = Math.max(minTime, firstTimestamp)
  const endTime = Math.min(Number.isFinite(maxTime) ? maxTime : Date.now(), Date.now())
  const result: TrendPoint[] = []
  const limit = 2000
  for (
    let cursor = bucketDate(new Date(firstSampleTime), granularity);
    cursor.getTime() <= endTime && result.length < limit;
    cursor = nextBucket(cursor, granularity)
  ) {
    const key = formatBucket(cursor, granularity)
    const point = trendMap.get(key) ?? ensureTrendPoint(key)
    point.bucketLabel = bucketLabel(key, granularity)
    result.push(point)
  }
  return result.length >= limit ? filled : result
}

function buildRankedValues(
  sessions: MergedSession[],
  selector: (session: MergedSession) => string,
  costs: Map<string, number>,
): RankedValue[] {
  const map = new Map<string, RankedValue>()
  for (const session of sessions) {
    if (getMetricTotalTokens(session) <= 0) {
      continue
    }
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
    current.totalTokens += getMetricTotalTokens(session)
    current.estimatedCost += costs.get(session.id) ?? 0
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
  return [
    ...new Set(
      sessions.flatMap((session) =>
        session.tokenSamples.length > 0
          ? session.tokenSamples.map((sample) => sessionDayKey(sample.timestampMs))
          : [sessionDayKey(session.updatedAtMs)],
      ),
    ),
  ]
    .sort((left, right) => right.localeCompare(left))
}

export function buildHourlyBuckets(sessions: MergedSession[], dateKey?: string): HourBucket[] {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, '0'),
    totalTokens: 0,
    sessions: 0,
  }))

  for (const session of sessions) {
    const seenHours = new Set<number>()
    const addSample = (timestampMs: number, totalTokens: number) => {
      if (dateKey && sessionDayKey(timestampMs) !== dateKey) {
        return
      }
      const hour = new Date(timestampMs).getHours()
      hours[hour].totalTokens += totalTokens
      if (!seenHours.has(hour)) {
        hours[hour].sessions += 1
        seenHours.add(hour)
      }
    }

    if (session.tokenSamples.length > 0) {
      for (const sample of session.tokenSamples) {
        addSample(sample.timestampMs, usageFromSample(sample).totalTokens)
      }
      continue
    }
    addSample(session.updatedAtMs, getMetricTotalTokens(session))
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
    const seenWeekdays = new Set<number>()
    const addSample = (timestampMs: number, totalTokens: number) => {
      const weekday = new Date(timestampMs).getDay()
      weekdays[weekday].totalTokens += totalTokens
      if (!seenWeekdays.has(weekday)) {
        weekdays[weekday].sessions += 1
        seenWeekdays.add(weekday)
      }
    }

    if (session.tokenSamples.length > 0) {
      for (const sample of session.tokenSamples) {
        addSample(sample.timestampMs, usageFromSample(sample).totalTokens)
      }
      continue
    }
    addSample(session.updatedAtMs, getMetricTotalTokens(session))
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
        getMetricTotalTokens(session) >= bucket.min && getMetricTotalTokens(session) < bucket.max,
    ).length,
  }))
}

function buildPerMinuteStats(sessions: MergedSession[], minTime: number, maxTime: number) {
  const minuteTokens = new Map<string, number>()
  const minuteRequests = new Map<string, number>()

  for (const session of sessions) {
    for (const sample of session.tokenSamples) {
      if (!isInTimeRange(sample.timestampMs, minTime, maxTime)) {
        continue
      }
      const bucket = new Date(sample.timestampMs)
      bucket.setSeconds(0, 0)
      const key = bucket.toISOString()
      minuteTokens.set(key, (minuteTokens.get(key) ?? 0) + sample.totalTokens)
    }

    for (const sample of session.requestSamples) {
      if (sample.kind !== 'user') {
        continue
      }
      if (!isInTimeRange(sample.timestampMs, minTime, maxTime)) {
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
  }
}

/** 热力图和卡片迷你图用：不受时间筛选影响，按天汇总全部历史（其余筛选条件仍生效）。 */
export function buildDailyActivity(dataset: DashboardData, filters: FilterState, pricing: PricingIndex): DailyActivity[] {
  const allTime = { ...filters, timeRange: 'all' as const }
  const sessions = filterSessions(dataset.sessions, allTime)
  const days = new Map<string, DailyActivity>()
  const ensure = (day: string) => {
    const current = days.get(day) ?? { day, totalTokens: 0, estimatedCost: 0, sessions: 0, requests: 0 }
    days.set(day, current)
    return current
  }
  for (const session of sessions) {
    const seenDays = new Set<string>()
    const add = (timestampMs: number, usage: TokenUsage, contextTokens: number, model: string) => {
      const day = sessionDayKey(timestampMs)
      const current = ensure(day)
      current.totalTokens += usage.totalTokens
      current.estimatedCost += priceSample(usage, contextTokens, model, pricing)
      current.requests += 1
      if (!seenDays.has(day)) {
        current.sessions += 1
        seenDays.add(day)
      }
    }
    if (session.tokenSamples.length > 0) {
      for (const sample of session.tokenSamples) {
        add(sample.timestampMs, usageFromSample(sample), sample.contextTokens ?? 0, sampleModel(session, sample.model))
      }
    } else if (session.updatedAtMs > 0) {
      add(session.updatedAtMs, { ...getMetricUsage(session), totalTokens: getMetricTotalTokens(session) }, 0, session.model)
    }
  }
  return [...days.values()].sort((left, right) => left.day.localeCompare(right.day))
}

/** 截止今天的连续 N 天（没有用量的日子补 0），供卡片迷你图使用。 */
export function lastNDays(daily: DailyActivity[], count: number) {
  const byDay = new Map(daily.map((item) => [item.day, item]))
  const today = startOfDay(new Date())
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today)
    date.setDate(date.getDate() - (count - 1 - index))
    const day = sessionDayKey(date.getTime())
    return byDay.get(day) ?? { day, totalTokens: 0, estimatedCost: 0, sessions: 0, requests: 0 }
  })
}

export function buildMetricSnapshot(
  dataset: DashboardData,
  filters: FilterState,
  pricing: PricingIndex,
): MetricSnapshot {
  const { minTime, maxTime } = getTimeRangeBounds(filters)
  const costAccumulator = createCostAccumulator()
  const filteredSessions = filterSessions(dataset.sessions, filters).map((session) => ({
    ...session,
    rangeCost: estimateSessionCost(session, pricing, costAccumulator),
  }))
  const costs = new Map(filteredSessions.map((session) => [session.id, session.rangeCost]))
  const trend = buildTrend(filteredSessions, filters.granularity, pricing, minTime, maxTime)
  const modelRanks = buildRankedValues(filteredSessions, (session) => session.model, costs)
  const projectRanks = buildRankedValues(filteredSessions, (session) => session.cwd, costs)
  const totalUsage = createEmptyUsage()
  const quality = createEmptyQuality()
  for (const session of filteredSessions) {
    addUsage(totalUsage, getMetricUsage(session))
    addQuality(quality, session.quality)
  }
  const toolRanks = buildToolRanks(filteredSessions)
  const hourly = buildHourlyBuckets(filteredSessions)
  const weekdays = buildWeekdays(filteredSessions)
  const distribution = buildDistribution(filteredSessions)
  const topSessions = [...filteredSessions]
    .sort((left, right) => getMetricTotalTokens(right) - getMetricTotalTokens(left))
    .slice(0, 10)

  const totalTokens = filteredSessions.reduce((sum, session) => sum + getMetricTotalTokens(session), 0)
  const estimatedCost = totalCost(costAccumulator.cost)
  const sessionCount = filteredSessions.length
  const interactionTurns = filteredSessions.reduce((sum, session) => sum + session.interactionTurns, 0)
  const userMessages = filteredSessions.reduce((sum, session) => sum + session.userMessageCount, 0)
  const assistantMessages = filteredSessions.reduce(
    (sum, session) => sum + session.assistantMessageCount,
    0,
  )
  const toolCalls = filteredSessions.reduce((sum, session) => sum + session.toolCallCount, 0)
  const activeDays = new Set(
    filteredSessions.flatMap((session) =>
      session.tokenSamples.length > 0
        ? session.tokenSamples.map((sample) => formatBucket(startOfDay(new Date(sample.timestampMs)), 'day'))
        : [formatBucket(startOfDay(new Date(session.updatedAtMs)), 'day')],
    ),
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
  const minuteStats = buildPerMinuteStats(filteredSessions, minTime, maxTime)

  return {
    filters,
    filteredSessions,
    totalTokens,
    inputTokens: totalUsage.inputTokens,
    cachedInputTokens: totalUsage.cachedInputTokens,
    cacheWriteTokens: totalUsage.cacheWriteTokens,
    outputTokens: totalUsage.outputTokens,
    reasoningOutputTokens: totalUsage.reasoningOutputTokens,
    estimatedCost,
    costBreakdown: costAccumulator.cost,
    unpricedTokens: costAccumulator.unpricedTokens,
    unpricedModels: [...costAccumulator.unpricedModels].sort(),
    tieredRequests: costAccumulator.tieredRequests,
    quality,
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
  }
}
