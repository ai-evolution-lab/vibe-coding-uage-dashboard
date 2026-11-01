import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, InputHTMLAttributes } from 'react'
import type { EChartsOption } from 'echarts'
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Bot,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Database,
  DollarSign,
  FolderOpen,
  Gauge,
  HardDriveDownload,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { ActivityHeatmap } from './components/ActivityHeatmap'
import { ChartCard } from './components/ChartCard'
import { DataQualityPanel } from './components/DataQualityPanel'
import { PricingPanel } from './components/PricingPanel'
import { TokenBreakdown } from './components/TokenBreakdown'
import { SessionDetailDrawer } from './components/SessionDetailDrawer'
import { SessionTable } from './components/SessionTable'
import { StatCard } from './components/StatCard'
import { readClaudeEntriesFromFileList, readClaudeEntriesFromHandle, parseClaudeEntries } from './lib/claude'
import {
  parseCodexEntries,
  pickDirectory,
  readEntriesFromFileList,
  readEntriesFromHandle,
  supportsDirectoryPicker,
  verifyDirectoryPermission,
} from './lib/codex'
import { exportMetricsJson, exportSessionsCsv } from './lib/export'
import { asPermissionHandle } from './lib/filesystem'
import {
  formatCompact,
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatNumber,
  splitDisplayValue,
  trimText,
} from './lib/format'
import { hasLocalApi, loadLocalApiDataset } from './lib/localApi'
import {
  buildDailyActivity,
  buildHourlyBuckets,
  buildMetricSnapshot,
  getAvailableSessionDays,
  getAvailableModels,
  getAvailableProjects,
  getFilterDefaults,
} from './lib/metrics'
import { AUTO_UPDATE_INTERVAL_MS, createPricingIndex, fetchLatestCatalog, getBuiltinCatalog } from './lib/pricing'
import {
  clearStoredState,
  loadCache,
  loadDirectoryHandle,
  loadPricingCatalog,
  saveCache,
  saveDirectoryHandle,
  savePricingCatalog,
} from './lib/storage'
import type { DashboardData, FilterState, LoadProgress, MergedSession, PriceRule, PricingCatalog, ProviderType } from './types'

type ViewTab = 'overview' | 'sessions' | 'pricing' | 'quality'

const viewTabs: Array<{ value: ViewTab; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'sessions', label: '会话' },
  { value: 'pricing', label: '价格表' },
  { value: 'quality', label: '数据质量' },
]

const AUTO_UPDATE_KEY = 'vcud.pricing.autoUpdate'

function readAutoUpdatePreference() {
  try {
    return localStorage.getItem(AUTO_UPDATE_KEY) !== 'off'
  } catch {
    return true
  }
}

interface DirectoryInputProps extends InputHTMLAttributes<HTMLInputElement> {
  webkitdirectory?: string
  directory?: string
}

const directoryInputProps: DirectoryInputProps = {
  webkitdirectory: '',
  directory: '',
}

const providerLabels: Record<ProviderType, { name: string; home: string; files: string; title: string }> = {
  codex: {
    name: 'Codex',
    home: '~/.codex',
    files: 'state_5.sqlite + sessions/**/*.jsonl',
    title: 'Vibe Coding Usage Dashboard · Codex',
  },
  claude: {
    name: 'Claude Code',
    home: '~/.claude',
    files: 'projects/**/*.jsonl',
    title: 'Vibe Coding Usage Dashboard · Claude Code',
  },
}

const timeRangeOptions: Array<{ value: FilterState['timeRange']; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
  { value: 'custom', label: '自定义' },
]

function getLocalDateInputValue(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getSourceTypeLabel(type: DashboardData['sourceSummary']['sourceType']) {
  if (type === 'local-api') {
    return '自动识别'
  }
  if (type === 'directory-handle') {
    return '目录授权'
  }
  return '文件夹回退'
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function getProjectLeaf(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path || '-'
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const sessionSectionRef = useRef<HTMLDivElement | null>(null)
  const [dataset, setDataset] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [error, setError] = useState('')
  const [catalog, setCatalog] = useState<PricingCatalog>(() => getBuiltinCatalog())
  const [catalogReady, setCatalogReady] = useState(false)
  const [pricingUpdating, setPricingUpdating] = useState(false)
  const [pricingMessage, setPricingMessage] = useState('')
  const [autoUpdatePricing, setAutoUpdatePricing] = useState(readAutoUpdatePreference)
  const [activeTab, setActiveTab] = useState<ViewTab>('overview')
  const [filters, setFilters] = useState<FilterState>(getFilterDefaults())
  const [sourceHandle, setSourceHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [rememberedHandle, setRememberedHandle] = useState(false)
  const [lastLoadedFromCache, setLastLoadedFromCache] = useState(false)
  const [browserSupport, setBrowserSupport] = useState({ directoryPicker: false })
  const [selectedSession, setSelectedSession] = useState<MergedSession | null>(null)
  const [hourlyDate, setHourlyDate] = useState<'all' | string>('all')

  const provider = filters.provider
  const providerLabel = providerLabels[provider]
  const localApiAvailable = hasLocalApi()

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const storedCatalog = await loadPricingCatalog()
        if (cancelled) {
          return
        }
        setBrowserSupport({ directoryPicker: supportsDirectoryPicker() })
        const builtin = getBuiltinCatalog()
        // 内置快照比已保存的在线价格更新时（升级了版本），用快照并保留自定义价格。
        if (storedCatalog && storedCatalog.updatedAtMs >= builtin.updatedAtMs) {
          setCatalog(storedCatalog)
        } else if (storedCatalog) {
          setCatalog({ ...builtin, overrides: storedCatalog.overrides })
        }
        setCatalogReady(true)
      } catch (bootstrapError) {
        if (!cancelled) {
          setError(bootstrapError instanceof Error ? bootstrapError.message : '初始化失败，请稍后重试。')
        }
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadProviderState() {
      setError('')
      setSourceHandle(null)
      setRememberedHandle(false)
      setLastLoadedFromCache(false)
      setDataset(null)
      setFilters((current) => ({
        ...current,
        model: 'all',
        cwd: 'all',
        archived: 'all',
        search: '',
      }))
      setHourlyDate('all')

      try {
        const [cacheRecord, storedHandle] = await Promise.all([
          loadCache(provider),
          loadDirectoryHandle(provider).catch(() => null),
        ])
        if (cancelled) {
          return
        }

        if (cacheRecord?.dataset) {
          setDataset(cacheRecord.dataset)
          setLastLoadedFromCache(true)
        }

        if (storedHandle) {
          setRememberedHandle(true)
          setSourceHandle(storedHandle)
          const permissionHandle = asPermissionHandle(storedHandle)
          const permission = permissionHandle.queryPermission
            ? await permissionHandle.queryPermission({ mode: 'read' })
            : 'granted'
          if (permission === 'granted') {
            await refreshFromHandle(storedHandle, { silent: true, persistHandle: false })
          }
        }
      } catch (stateError) {
        if (!cancelled) {
          setError(stateError instanceof Error ? stateError.message : '读取缓存失败')
        }
      }
    }

    void loadProviderState()
    return () => {
      cancelled = true
    }
    // refreshFromHandle is intentionally kept out to avoid re-running provider bootstrap
    // after transient loading state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  useEffect(() => {
    if (catalogReady) {
      void savePricingCatalog(catalog)
    }
  }, [catalog, catalogReady])

  async function handleUpdatePricing(options?: { silent?: boolean }) {
    setPricingUpdating(true)
    if (!options?.silent) {
      setPricingMessage('')
    }
    try {
      const next = await fetchLatestCatalog(catalog.overrides)
      const added = next.rules.length - catalog.rules.length
      setCatalog(next)
      setPricingMessage(`已更新：${next.rules.length} 个模型${added > 0 ? `，新增 ${added} 个` : ''}。`)
    } catch (updateError) {
      if (!options?.silent) {
        setPricingMessage(updateError instanceof Error ? updateError.message : '价格更新失败')
      }
    } finally {
      setPricingUpdating(false)
    }
  }

  useEffect(() => {
    if (!catalogReady || !autoUpdatePricing) {
      return
    }
    if (Date.now() - catalog.updatedAtMs <= AUTO_UPDATE_INTERVAL_MS) {
      return
    }
    const timer = window.setTimeout(() => void handleUpdatePricing({ silent: true }), 1500)
    return () => window.clearTimeout(timer)
    // 只在启动后检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogReady])

  function changeAutoUpdate(value: boolean) {
    setAutoUpdatePricing(value)
    try {
      localStorage.setItem(AUTO_UPDATE_KEY, value ? 'on' : 'off')
    } catch {
      // 浏览器禁用存储时只在本次会话生效
    }
  }

  function changeOverrides(overrides: PriceRule[]) {
    setCatalog((current) => ({ ...current, overrides }))
  }

  async function parseEntriesForProvider(
    entries: Awaited<ReturnType<typeof readEntriesFromHandle>>,
    sourceType: DashboardData['sourceSummary']['sourceType'],
    detectedPath = '',
  ) {
    if (provider === 'claude') {
      return parseClaudeEntries(entries, sourceType, detectedPath, setProgress)
    }
    return parseCodexEntries(entries, sourceType, detectedPath, setProgress)
  }

  async function refreshFromHandle(
    handle: FileSystemDirectoryHandle,
    options?: { silent?: boolean; persistHandle?: boolean },
  ) {
    const { silent = false, persistHandle = true } = options ?? {}
    setError('')
    setLoading(true)
    if (!silent) {
      setProgress({ phase: '正在读取目录权限', processed: 0, total: 1 })
    }

    try {
      const granted = await verifyDirectoryPermission(handle)
      if (!granted) {
        throw new Error('目录授权被拒绝，无法读取本地数据。')
      }

      setProgress({ phase: `正在扫描 ${providerLabel.home} 文件`, processed: 0, total: 1 })
      const entries = provider === 'claude' ? await readClaudeEntriesFromHandle(handle) : await readEntriesFromHandle(handle)
      const nextDataset = await parseEntriesForProvider(entries, 'directory-handle')
      setDataset(nextDataset)
      setSourceHandle(handle)
      setRememberedHandle(true)
      setLastLoadedFromCache(false)
      await saveCache(nextDataset, provider)
      if (persistHandle) {
        await saveDirectoryHandle(handle, provider)
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '刷新失败')
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  async function handleAutoDetect() {
    if (!localApiAvailable) {
      setError('自动识别仅支持通过 npm run start:local、open.command 或 open.bat 启动。当前请手动选择目录。')
      return
    }
    setError('')
    setLoading(true)
    setSourceHandle(null)
    setProgress({ phase: `正在自动识别 ${providerLabel.home}`, processed: 0, total: 1 })
    try {
      const nextDataset = await loadLocalApiDataset(provider, setProgress)
      setDataset(nextDataset)
      setRememberedHandle(false)
      setLastLoadedFromCache(false)
      await saveCache(nextDataset, provider)
    } catch (detectError) {
      setError(
        detectError instanceof Error
          ? detectError.message
          : '自动识别失败，请手动选择目录。',
      )
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  async function handleChooseDirectory() {
    try {
      const handle = await pickDirectory()
      await refreshFromHandle(handle)
    } catch (chooseError) {
      if (chooseError instanceof DOMException && chooseError.name === 'AbortError') {
        return
      }
      setError(chooseError instanceof Error ? chooseError.message : '目录选择失败')
    }
  }

  async function handleFallbackSelect(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files
    if (!files || files.length === 0) {
      return
    }

    setError('')
    setLoading(true)
    setProgress({ phase: '正在读取选择的文件夹', processed: 0, total: 1 })
    try {
      const entries = provider === 'claude' ? await readClaudeEntriesFromFileList(files) : await readEntriesFromFileList(files)
      const nextDataset = await parseEntriesForProvider(entries, 'file-list')
      setDataset(nextDataset)
      setLastLoadedFromCache(false)
      await saveCache(nextDataset, provider)
    } catch (fallbackError) {
      setError(fallbackError instanceof Error ? fallbackError.message : '读取文件夹失败')
    } finally {
      setLoading(false)
      setProgress(null)
      event.target.value = ''
    }
  }

  async function handleRefresh() {
    if (sourceHandle) {
      await refreshFromHandle(sourceHandle, { silent: false, persistHandle: false })
      return
    }
    if (dataset?.sourceSummary.sourceType === 'local-api') {
      await handleAutoDetect()
      return
    }
    fileInputRef.current?.click()
  }

  async function handleClearCache() {
    await clearStoredState()
    setDataset(null)
    setSourceHandle(null)
    setRememberedHandle(false)
    setLastLoadedFromCache(false)
    setCatalog(getBuiltinCatalog())
    setFilters(getFilterDefaults())
  }

  function changeProvider(nextProvider: ProviderType) {
    setFilters((current) => ({ ...current, provider: nextProvider }))
  }

  function changeTimeRange(nextTimeRange: FilterState['timeRange']) {
    setFilters((current) => {
      if (nextTimeRange !== 'custom' || current.customStartDate || current.customEndDate) {
        return { ...current, timeRange: nextTimeRange }
      }
      const today = getLocalDateInputValue()
      return {
        ...current,
        timeRange: nextTimeRange,
        customStartDate: today,
        customEndDate: today,
      }
    })
  }

  function setCustomDateRange(startDate: string, endDate: string) {
    setFilters((current) => ({
      ...current,
      timeRange: 'custom',
      customStartDate: startDate,
      customEndDate: endDate,
    }))
  }

  const models = useMemo(() => (dataset ? getAvailableModels(dataset.sessions) : ['all']), [dataset])
  const projects = useMemo(() => (dataset ? getAvailableProjects(dataset.sessions) : ['all']), [dataset])
  const pricing = useMemo(() => createPricingIndex(catalog), [catalog])
  const snapshot = useMemo(
    () => (dataset ? buildMetricSnapshot(dataset, filters, pricing) : null),
    [dataset, filters, pricing],
  )
  const dailyActivity = useMemo(
    () => (dataset ? buildDailyActivity(dataset, filters, pricing) : []),
    [dataset, filters, pricing],
  )
  const usedModels = useMemo(() => {
    const names = new Set<string>()
    for (const session of dataset?.sessions ?? []) {
      for (const sample of session.tokenSamples) {
        names.add(sample.model || session.model)
      }
      if (session.tokenSamples.length === 0 && session.model) {
        names.add(session.model)
      }
    }
    // unknown 只出现在没有会话文件、只有 sqlite 总数的线程上，这部分本来就无法计价。
    return [...names].filter((name) => name && name !== 'unknown').sort()
  }, [dataset])
  const hourlyDateOptions = useMemo(
    () => (snapshot ? getAvailableSessionDays(snapshot.filteredSessions) : []),
    [snapshot],
  )
  const resolvedHourlyDate =
    hourlyDate === 'all' || hourlyDateOptions.includes(hourlyDate)
      ? hourlyDate
      : (hourlyDateOptions[0] ?? 'all')
  const hourlyData = useMemo(
    () =>
      snapshot
        ? buildHourlyBuckets(
            snapshot.filteredSessions,
            resolvedHourlyDate === 'all' ? undefined : resolvedHourlyDate,
          )
        : [],
    [resolvedHourlyDate, snapshot],
  )
  const hourlyDateIndex =
    resolvedHourlyDate === 'all' ? -1 : hourlyDateOptions.indexOf(resolvedHourlyDate)

  const trendModels = useMemo(
    () =>
      snapshot ? snapshot.modelRanks.map((rank) => rank.key).filter(Boolean).slice(0, 8) : [],
    [snapshot],
  )

  const trendOption = useMemo<EChartsOption>(() => {
    if (!snapshot) {
      return {}
    }
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { type: 'scroll', top: 0, textStyle: { color: '#c8d2e0' } },
      grid: { top: 44, left: 24, right: 16, bottom: 28, containLabel: true },
      xAxis: {
        type: 'category',
        data: snapshot.trend.map((item) => item.bucketLabel),
        axisLine: { lineStyle: { color: '#2e3444' } },
        axisLabel: { color: '#7f8aa3' },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
        axisLabel: { color: '#7f8aa3', formatter: (value: number) => formatCompact(value, 1) },
      },
      series: trendModels.map((model, index) => ({
        name: model,
        type: 'bar',
        stack: 'tokens',
        emphasis: { focus: 'series' },
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: ['#4f7cff', '#1ed6ff', '#ffb020', '#6ee7b7', '#f472b6', '#a78bfa', '#f87171', '#38bdf8'][index % 8],
        },
        data: snapshot.trend.map((item) => item.byModel[model] ?? 0),
      })),
    }
  }, [snapshot, trendModels])

  const modelOption = useMemo<EChartsOption>(() => {
    if (!snapshot) {
      return {}
    }
    const top = snapshot.modelRanks.slice(0, 8).reverse()
    return {
      grid: { top: 18, left: 104, right: 24, bottom: 34, containLabel: true },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }, axisLabel: { color: '#7f8aa3', formatter: (value: number) => formatCompact(value, 1) } },
      yAxis: { type: 'category', data: top.map((item) => trimText(item.label, 24)), axisLabel: { color: '#c8d2e0' } },
      series: [{ type: 'bar', data: top.map((item) => item.totalTokens), itemStyle: { color: '#4f7cff', borderRadius: 6 } }],
    }
  }, [snapshot])

  const hourlyOption = useMemo<EChartsOption>(() => {
    if (!snapshot) {
      return {}
    }
    return {
      grid: { top: 16, left: 24, right: 18, bottom: 58, containLabel: true },
      tooltip: { trigger: 'axis' },
      legend: {
        bottom: 8,
        itemWidth: 18,
        itemHeight: 10,
        textStyle: { color: '#c8d2e0' },
      },
      xAxis: {
        type: 'category',
        data: hourlyData.map((item) => `${item.hour}:00`),
        axisLine: { lineStyle: { color: '#2e3444' } },
        axisLabel: { color: '#7f8aa3', hideOverlap: true },
      },
      yAxis: [
        {
          type: 'value',
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
          axisLabel: {
            color: '#7f8aa3',
            formatter: (value: number) => formatCompact(value, 1),
          },
        },
        {
          type: 'value',
          splitLine: { show: false },
          axisLabel: { color: '#7f8aa3', margin: 12 },
        },
      ],
      series: [
        {
          name: 'Tokens',
          type: 'bar',
          barMaxWidth: 22,
          data: hourlyData.map((item) => item.totalTokens),
          itemStyle: { color: '#ffb020', borderRadius: [6, 6, 0, 0] },
        },
        {
          name: '会话数',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          clip: true,
          symbolSize: 7,
          itemStyle: { color: '#1ed6ff' },
          data: hourlyData.map((item) => item.sessions),
        },
      ],
    }
  }, [hourlyData, snapshot])

  const toolOption = useMemo<EChartsOption>(() => {
    if (!snapshot) {
      return {}
    }
    const top = snapshot.toolRanks.slice(0, 10).reverse()
    return {
      grid: { top: 18, left: 118, right: 24, bottom: 34, containLabel: true },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }, axisLabel: { color: '#7f8aa3', formatter: (value: number) => formatCompact(value, 1) } },
      yAxis: { type: 'category', data: top.map((item) => trimText(item.name, 24)), axisLabel: { color: '#c8d2e0' } },
      series: [{ type: 'bar', data: top.map((item) => item.count), itemStyle: { color: '#f472b6', borderRadius: 6 } }],
    }
  }, [snapshot])

  const projectRows = useMemo(() => {
    if (!snapshot) {
      return []
    }
    const top = snapshot.projectRanks.slice(0, 8).reverse()
    const counts = new Map<string, number>()
    return top.map((rank) => {
      const leaf = getProjectLeaf(rank.label || '-')
      const nextCount = (counts.get(leaf) ?? 0) + 1
      counts.set(leaf, nextCount)
      return {
        rank,
        shortLabel: nextCount > 1 ? `${leaf} #${nextCount}` : leaf,
      }
    })
  }, [snapshot])

  const projectOption = useMemo<EChartsOption>(() => {
    if (!snapshot) {
      return {}
    }
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const item = Array.isArray(params) ? params[0] : params
          const rank = projectRows[item.dataIndex ?? -1]?.rank
          if (!rank) {
            return ''
          }
          return [
            `<strong>${escapeHtml(rank.label)}</strong>`,
            `Tokens: ${formatCompact(rank.totalTokens, 2)}`,
            `会话数: ${formatNumber(rank.sessions)}`,
            `平均 Tokens: ${formatCompact(rank.avgTokens, 2)}`,
            `估算费用: ${formatCurrency(rank.estimatedCost)}`,
          ].join('<br/>')
        },
      },
      grid: { top: 18, left: 138, right: 24, bottom: 42, containLabel: true },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }, axisLabel: { color: '#7f8aa3', formatter: (value: number) => formatCompact(value, 1) } },
      yAxis: {
        type: 'category',
        data: projectRows.map((item) => item.shortLabel),
        axisLabel: { color: '#c8d2e0', width: 128, overflow: 'truncate' },
      },
      series: [{ type: 'bar', data: projectRows.map((item) => item.rank.totalTokens), itemStyle: { color: '#6ee7b7', borderRadius: 6 } }],
    }
  }, [projectRows, snapshot])

  const distributionOption = useMemo<EChartsOption>(() => {
    if (!snapshot) {
      return {}
    }
    return {
      grid: { top: 18, left: 24, right: 24, bottom: 40, containLabel: true },
      xAxis: {
        type: 'category',
        data: snapshot.distribution.map((item) => item.label),
        axisLabel: { color: '#7f8aa3', margin: 12, hideOverlap: true },
        axisLine: { lineStyle: { color: '#2e3444' } },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }, axisLabel: { color: '#7f8aa3', formatter: (value: number) => formatCompact(value, 1) } },
      series: [{ type: 'bar', barMaxWidth: 34, data: snapshot.distribution.map((item) => item.sessions), clip: true, itemStyle: { color: '#a78bfa', borderRadius: [6, 6, 0, 0] } }],
    }
  }, [snapshot])

  const totalTokenValue = snapshot ? splitDisplayValue(formatCompact(snapshot.totalTokens, 2)) : null
  const sessionValue = snapshot ? splitDisplayValue(formatNumber(snapshot.sessionCount)) : null
  const costValue = snapshot ? splitDisplayValue(formatCurrency(snapshot.estimatedCost)) : null
  const tpmValue = snapshot ? splitDisplayValue(`${formatNumber(snapshot.avgTpm, 1)} TPM`) : null

  function stepHourlyDate(direction: 'prev' | 'next') {
    if (hourlyDateOptions.length === 0) {
      return
    }
    if (hourlyDate === 'all') {
      setHourlyDate(hourlyDateOptions[0])
      return
    }
    const currentIndex = hourlyDateOptions.indexOf(hourlyDate)
    if (currentIndex < 0) {
      setHourlyDate(hourlyDateOptions[0])
      return
    }
    const nextIndex = direction === 'prev' ? currentIndex + 1 : currentIndex - 1
    if (nextIndex >= 0 && nextIndex < hourlyDateOptions.length) {
      setHourlyDate(hourlyDateOptions[nextIndex])
    }
  }

  function focusProjectFromChart(dataIndex?: number) {
    const target = dataIndex === undefined ? '' : projectRows[dataIndex]?.rank.label ?? ''
    if (!target) {
      return
    }
    setFilters((current) => ({
      ...current,
      cwd: target,
    }))
    setActiveTab('sessions')
    requestAnimationFrame(() => {
      sessionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const cardClass = 'rounded-2xl border border-white/8 bg-[#11141b]'
  const ghostButton =
    'inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50'
  const selectClass = 'rounded-xl border border-white/10 bg-[#0d1016] px-3 py-2 text-sm text-slate-100 outline-none'
  const qualityWarnings = snapshot
    ? (snapshot.unpricedModels.length > 0 ? 1 : 0) + (snapshot.quality.invariantViolations > 0 ? 1 : 0)
    : 0

  return (
    <div className="min-h-screen bg-[#090b11] text-slate-100">
      <input ref={fileInputRef} type="file" multiple onChange={handleFallbackSelect} className="hidden" {...directoryInputProps} />

      <div className="mx-auto flex max-w-[1480px] flex-col gap-5 px-4 py-5 sm:px-6 xl:px-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-white">Vibe Coding Usage</h1>
            <p className="mt-1 text-xs text-slate-500">
              本机读取 {providerLabel.home}，数据不上传。费用为按公开价格的估算，不是官方账单。
              {dataset ? ` · ${getSourceTypeLabel(dataset.sourceSummary.sourceType)} · 解析于 ${formatDateTime(dataset.sourceSummary.parsedAtMs)}${lastLoadedFromCache ? '（缓存）' : ''}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-full border border-white/10 bg-[#0d1016] p-1">
              {(['codex', 'claude'] as ProviderType[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => changeProvider(item)}
                  className={`rounded-full px-4 py-1.5 text-sm transition ${
                    provider === item ? 'bg-[#2a78d6] text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {providerLabels[item].name}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleAutoDetect}
              disabled={loading || !localApiAvailable}
              className="inline-flex items-center gap-2 rounded-full bg-[#2a78d6] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#3987e5] disabled:cursor-not-allowed disabled:opacity-50"
              title={localApiAvailable ? '自动识别本地数据目录' : '请用 npm run start:local、open.command 或 open.bat 启动'}
            >
              <Bot size={16} />
              自动识别
            </button>
            <button type="button" onClick={handleRefresh} disabled={loading || !dataset} className={ghostButton}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              刷新
            </button>
            <details className="relative">
              <summary className={`${ghostButton} cursor-pointer list-none`}>
                <FolderOpen size={16} />
                手动选择
              </summary>
              <div className="absolute right-0 z-20 mt-2 flex w-56 flex-col gap-1 rounded-xl border border-white/10 bg-[#141821] p-2 shadow-xl">
                <button
                  type="button"
                  onClick={handleChooseDirectory}
                  disabled={!browserSupport.directoryPicker || loading}
                  className="rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/6 disabled:opacity-40"
                >
                  授权 {providerLabel.home} 目录
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/6"
                >
                  <HardDriveDownload size={14} />
                  选择文件夹（兼容模式）
                </button>
                <button type="button" onClick={handleClearCache} className="rounded-lg px-3 py-2 text-left text-sm text-slate-400 hover:bg-white/6">
                  清空本地缓存
                </button>
              </div>
            </details>
          </div>
        </header>

        {!localApiAvailable ? (
          <p className="text-xs text-[#fab219]">
            当前不是本地启动模式，自动识别已禁用。请使用 `npm run start:local`、`open.command` 或 `open.bat`。
          </p>
        ) : null}

        {error ? (
          <div className="flex items-start gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/10 px-5 py-4 text-sm text-rose-100">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {loading && progress ? (
          <div className="rounded-2xl border border-[#3987e5]/25 bg-[#3987e5]/8 px-5 py-4 text-sm text-slate-100">
            <div className="flex items-center justify-between gap-4">
              <span>{progress.phase}</span>
              <span>{progress.processed}/{progress.total}</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-[#3987e5] transition-all" style={{ width: `${progress.total > 0 ? (progress.processed / progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        ) : null}

        {snapshot ? (
          <>
            <nav className="flex flex-col gap-3 border-b border-white/8 lg:flex-row lg:items-end lg:justify-between">
              <div className="flex gap-1 overflow-x-auto">
                {viewTabs.map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => setActiveTab(tab.value)}
                    className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition ${
                      activeTab === tab.value ? 'border-[#3987e5] text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                    {tab.value === 'quality' && qualityWarnings > 0 ? (
                      <span className="ml-1.5 rounded-full bg-[#fab219] px-1.5 text-[11px] text-[#0b0b0b]">{qualityWarnings}</span>
                    ) : null}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 pb-2">
                <div className="flex rounded-xl border border-white/10 bg-[#0d1016] p-1">
                  {timeRangeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => changeTimeRange(option.value)}
                      className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs transition ${
                        filters.timeRange === option.value ? 'bg-[#2a78d6] text-white' : 'text-slate-400 hover:text-slate-100'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <select value={filters.model} onChange={(event) => setFilters((current) => ({ ...current, model: event.target.value }))} className={selectClass} aria-label="模型">
                  {models.map((model) => <option key={model} value={model}>{model === 'all' ? '全部模型' : model}</option>)}
                </select>
                <select value={filters.cwd} onChange={(event) => setFilters((current) => ({ ...current, cwd: event.target.value }))} className={`${selectClass} max-w-[220px]`} aria-label="项目">
                  {projects.map((project) => <option key={project} value={project}>{project === 'all' ? '全部项目' : getProjectLeaf(project)}</option>)}
                </select>
                {provider === 'codex' ? (
                  <select value={filters.archived} onChange={(event) => setFilters((current) => ({ ...current, archived: event.target.value as FilterState['archived'] }))} className={selectClass} aria-label="归档状态">
                    <option value="all">全部会话</option>
                    <option value="active">未归档</option>
                    <option value="archived">已归档</option>
                  </select>
                ) : null}
              </div>
            </nav>

            {filters.timeRange === 'custom' ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <CalendarDays size={16} className="text-slate-500" />
                <input type="date" value={filters.customStartDate} onChange={(event) => setFilters((current) => ({ ...current, customStartDate: event.target.value }))} className={selectClass} aria-label="开始日期" />
                <ArrowRight size={14} className="text-slate-500" />
                <input type="date" value={filters.customEndDate} onChange={(event) => setFilters((current) => ({ ...current, customEndDate: event.target.value }))} className={selectClass} aria-label="结束日期" />
                <button type="button" onClick={() => { const today = getLocalDateInputValue(); setCustomDateRange(today, today) }} className={ghostButton}>今天</button>
              </div>
            ) : null}

            {activeTab === 'overview' ? (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <StatCard title="总 Tokens" valuePrimary={totalTokenValue?.primary ?? '0'} valuePrefix={totalTokenValue?.prefix} valueUnit={totalTokenValue?.unit} hint={`缓存读取 ${formatCompact(snapshot.cachedInputTokens, 2)} / 输出 ${formatCompact(snapshot.outputTokens, 2)}`} icon={Sparkles} accentClass="bg-[#2a78d6]" trend={snapshot.sparklineTokens} />
                  <StatCard title="估算费用" valuePrimary={costValue?.primary ?? '0'} valuePrefix={costValue?.prefix} valueUnit={costValue?.unit} hint={snapshot.unpricedModels.length ? `${snapshot.unpricedModels.length} 个模型无价格，见数据质量` : `活跃 ${formatNumber(snapshot.activeDays)} 天，日均 ${formatCurrency(snapshot.activeDays ? snapshot.estimatedCost / snapshot.activeDays : 0)}`} icon={DollarSign} accentClass="bg-[#c98500]" trend={snapshot.sparklineCost} />
                  <StatCard title="会话" valuePrimary={sessionValue?.primary ?? '0'} valuePrefix={sessionValue?.prefix} valueUnit={sessionValue?.unit} hint={`轮次 ${formatNumber(snapshot.interactionTurns)} / 工具调用 ${formatNumber(snapshot.toolCalls)}`} icon={BarChart3} accentClass="bg-[#199e70]" trend={snapshot.sparklineSessions} />
                  <StatCard title="平均 TPM" valuePrimary={tpmValue?.primary ?? '0'} valuePrefix={tpmValue?.prefix} valueUnit={tpmValue?.unit} hint={`平均 RPM ${formatNumber(snapshot.avgRpm, 2)} / 会话平均 ${formatDuration(snapshot.avgSessionDurationMs)}`} icon={Gauge} accentClass="bg-[#6250d6]" trend={snapshot.sparklineTpm} />
                </div>

                <TokenBreakdown
                  inputTokens={snapshot.inputTokens}
                  cachedInputTokens={snapshot.cachedInputTokens}
                  cacheWriteTokens={snapshot.cacheWriteTokens}
                  outputTokens={snapshot.outputTokens}
                  cost={snapshot.costBreakdown}
                />

                <ActivityHeatmap daily={dailyActivity} />

                <div className="grid gap-5 xl:grid-cols-2">
                  <ChartCard
                    title="Tokens 趋势"
                    subtitle="按模型堆叠"
                    option={trendOption}
                    height={320}
                    headerActions={
                      <select value={filters.granularity} onChange={(event) => setFilters((current) => ({ ...current, granularity: event.target.value as FilterState['granularity'] }))} className={selectClass} aria-label="粒度">
                        <option value="day">按天</option>
                        <option value="week">按周</option>
                        <option value="month">按月</option>
                      </select>
                    }
                  />
                  <ChartCard title="模型排行" subtitle="按总 tokens" option={modelOption} height={320} />
                  <ChartCard
                    title="项目排行"
                    subtitle="点击柱子查看该项目的会话"
                    option={projectOption}
                    height={340}
                    onChartClick={(params) => {
                      if (params.componentType === 'series') {
                        focusProjectFromChart(params.dataIndex)
                      }
                    }}
                  />
                  <ChartCard
                    title="小时分布"
                    subtitle={resolvedHourlyDate === 'all' ? '全部日期' : resolvedHourlyDate}
                    option={hourlyOption}
                    height={340}
                    headerActions={
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={() => stepHourlyDate('prev')} disabled={hourlyDateOptions.length === 0 || (hourlyDate !== 'all' && hourlyDateIndex >= hourlyDateOptions.length - 1)} className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 disabled:opacity-40" title="前一天">
                          <ChevronLeft size={16} />
                        </button>
                        <button type="button" onClick={() => stepHourlyDate('next')} disabled={resolvedHourlyDate === 'all' || hourlyDateIndex <= 0} className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 disabled:opacity-40" title="后一天">
                          <ChevronRight size={16} />
                        </button>
                        <button type="button" onClick={() => setHourlyDate('all')} className={`rounded-full border px-3 py-1.5 text-xs ${resolvedHourlyDate === 'all' ? 'border-[#3987e5] text-white' : 'border-white/10 text-slate-300 hover:bg-white/10'}`}>
                          全部
                        </button>
                      </div>
                    }
                  />
                  <ChartCard title="工具调用排行" option={toolOption} height={320} />
                  <ChartCard title="会话规模分布" subtitle="按单会话 tokens 分桶" option={distributionOption} height={320} />
                </div>
              </>
            ) : null}

            {activeTab === 'sessions' ? (
              <div ref={sessionSectionRef} className="flex flex-col gap-3">
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" onClick={() => exportSessionsCsv(snapshot.filteredSessions, provider)} className={ghostButton}>导出 CSV</button>
                  <button type="button" onClick={() => exportMetricsJson(snapshot, provider)} className={ghostButton}>导出 JSON</button>
                </div>
                <SessionTable
                  sessions={snapshot.filteredSessions}
                  searchValue={filters.search}
                  onSearchChange={(value) => setFilters((current) => ({ ...current, search: value }))}
                  onSelectSession={setSelectedSession}
                  activeProject={filters.cwd !== 'all' ? filters.cwd : ''}
                  onClearProject={filters.cwd !== 'all' ? () => setFilters((current) => ({ ...current, cwd: 'all' })) : undefined}
                />
              </div>
            ) : null}

            {activeTab === 'pricing' ? (
              <PricingPanel
                catalog={catalog}
                pricing={pricing}
                usedModels={usedModels}
                updating={pricingUpdating}
                updateMessage={pricingMessage}
                autoUpdate={autoUpdatePricing}
                onAutoUpdateChange={changeAutoUpdate}
                onUpdate={() => void handleUpdatePricing()}
                onOverridesChange={changeOverrides}
              />
            ) : null}

            {activeTab === 'quality' ? (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
                <DataQualityPanel snapshot={snapshot} />
                <section className={`${cardClass} px-5 py-5 text-sm`}>
                  <h2 className="text-sm font-semibold text-white">数据源</h2>
                  <dl className="mt-4 space-y-3">
                    {[
                      ['读取方式', getSourceTypeLabel(dataset?.sourceSummary.sourceType ?? 'file-list')],
                      ['目录授权', sourceHandle ? '已连接' : rememberedHandle ? '已记住，待授权' : '未连接'],
                      ['识别路径', dataset?.sourceSummary.detectedPath || '-'],
                      ['文件数', formatNumber(dataset?.sourceSummary.fileCount ?? 0)],
                      ['会话文件', formatNumber(dataset?.sourceSummary.sessionFileCount ?? 0)],
                      ['会话数', formatNumber(dataset?.sourceSummary.sessionCount ?? 0)],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-4">
                        <dt className="shrink-0 text-slate-400">{label}</dt>
                        <dd className="break-all text-right text-slate-200">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <h3 className="mt-6 text-sm font-semibold text-white">计量规则</h3>
                  <ul className="mt-3 list-disc space-y-2 pl-4 text-xs leading-5 text-slate-400">
                    <li>Claude Code：同一回复的多行记录按 message.id + requestId 去重，跨文件（含子代理）只算一次。</li>
                    <li>Codex：只统计 token_count 事件；累计值没变的重复事件跳过；子代理和 fork 开头继承的父线程历史不计入。</li>
                    <li>Codex 的 input 已包含缓存，output 已包含推理，这里拆成四段互不重叠后分别计价。</li>
                    <li>与 ccusage 等工具对比时，以“总 Tokens”和四段拆分为准；差异通常来自是否去重、是否计入缓存读取。</li>
                  </ul>
                </section>
              </div>
            ) : null}
          </>
        ) : (
          <section className="rounded-2xl border border-dashed border-white/10 bg-[#10131a] px-6 py-12 text-center">
            <div className="mx-auto flex max-w-xl flex-col items-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#2a78d6]/15 text-[#86b6ef]">
                <Database size={24} />
              </div>
              <h2 className="mt-5 text-xl font-semibold text-white">还没有加载 {providerLabel.name} 数据</h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                点“自动识别”读取本机 <code className="rounded bg-white/8 px-1.5 py-0.5 text-slate-200">{providerLabel.home}</code>（{providerLabel.files}）。
                不是用 <code className="rounded bg-white/8 px-1.5 py-0.5 text-slate-200">npm run start:local</code> 启动时，请在“手动选择”里授权目录。
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <button type="button" onClick={handleAutoDetect} disabled={!localApiAvailable} className="rounded-full bg-[#2a78d6] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#3987e5] disabled:opacity-50">
                  自动识别
                </button>
                <button type="button" onClick={handleChooseDirectory} className={ghostButton}>授权目录</button>
                <button type="button" onClick={() => fileInputRef.current?.click()} className={ghostButton}>选择文件夹</button>
              </div>
            </div>
          </section>
        )}
      </div>
      <SessionDetailDrawer session={selectedSession} onClose={() => setSelectedSession(null)} />
    </div>
  )
}

export default App
