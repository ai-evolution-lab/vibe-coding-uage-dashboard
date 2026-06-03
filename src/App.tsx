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
  Wrench,
} from 'lucide-react'
import { ChartCard } from './components/ChartCard'
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
  buildHourlyBuckets,
  buildMetricSnapshot,
  getAvailableSessionDays,
  getAvailableModels,
  getAvailableProjects,
  getDefaultPriceRules,
  getFilterDefaults,
  hasExplicitPriceRule,
} from './lib/metrics'
import {
  clearStoredState,
  loadCache,
  loadDirectoryHandle,
  loadPriceRules,
  saveCache,
  saveDirectoryHandle,
  savePriceRules,
} from './lib/storage'
import type { DashboardData, FilterState, LoadProgress, MergedSession, PriceRule, ProviderType } from './types'

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
  const [priceRules, setPriceRules] = useState<PriceRule[]>(getDefaultPriceRules())
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
        const [storedPriceRules] = await Promise.all([loadPriceRules()])
        if (cancelled) {
          return
        }
        setBrowserSupport({ directoryPicker: supportsDirectoryPicker() })
        if (storedPriceRules?.length) {
          setPriceRules(storedPriceRules)
        }
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
    void savePriceRules(priceRules)
  }, [priceRules])

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
    setPriceRules(getDefaultPriceRules())
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
  const snapshot = useMemo(
    () => (dataset ? buildMetricSnapshot(dataset, filters, priceRules) : null),
    [dataset, filters, priceRules],
  )
  const unmatchedModels = useMemo(() => {
    const sessionModels = new Set((dataset?.sessions ?? []).map((session) => session.model).filter(Boolean))
    return Array.from(sessionModels)
      .filter((model) => !hasExplicitPriceRule(model, priceRules))
      .sort()
  }, [dataset, priceRules])
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
      snapshot
        ? [...new Set(snapshot.trend.flatMap((item) => Object.keys(item.byModel)))].filter(Boolean).slice(0, 8)
        : [],
    [snapshot],
  )

  const trendOption = useMemo<EChartsOption>(() => {
    if (!snapshot) {
      return {}
    }
    return {
      legend: { top: 4, textStyle: { color: '#c8d2e0' } },
      grid: { top: 48, left: 24, right: 16, bottom: 28, containLabel: true },
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
    requestAnimationFrame(() => {
      sessionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  return (
    <div className="min-h-screen bg-[#090b11] text-slate-100">
      <input ref={fileInputRef} type="file" multiple onChange={handleFallbackSelect} className="hidden" {...directoryInputProps} />

      <div className="mx-auto flex max-w-[1720px] flex-col gap-6 px-4 py-5 sm:px-6 xl:px-8 2xl:px-10">
        <header className="rounded-[24px] border border-white/8 bg-[#10131a] px-5 py-5 shadow-[0_32px_80px_rgba(0,0,0,0.35)] lg:px-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="min-w-0">
              <p className="text-sm text-slate-400">{providerLabel.title}</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-normal text-white sm:text-[40px]">Vibe Coding Usage Dashboard</h1>
              <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-400">
                自动或手动读取本机 <code className="rounded bg-white/8 px-1.5 py-0.5 text-slate-200">{providerLabel.home}</code>，
                按全局、项目文件夹、标题、模型、时间和工具调用统计 tokens。数据只在本机处理，不上传。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex rounded-full border border-white/10 bg-[#0d1016] p-1">
                {(['codex', 'claude'] as ProviderType[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => changeProvider(item)}
                    className={`rounded-full px-4 py-2 text-sm transition ${
                      provider === item ? 'bg-[#4f7cff] text-white' : 'text-slate-400 hover:text-white'
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
                className="inline-flex items-center gap-2 rounded-full bg-[#4f7cff] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#648bff] disabled:cursor-not-allowed disabled:opacity-50"
                title={localApiAvailable ? '自动识别本地数据目录' : '请用 npm run start:local、open.command 或 open.bat 启动'}
              >
                <Bot size={18} />
                自动识别
              </button>
              <button
                type="button"
                onClick={handleChooseDirectory}
                disabled={!browserSupport.directoryPicker || loading}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FolderOpen size={18} />
                手动选择 {providerLabel.name}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-white/10"
              >
                <HardDriveDownload size={18} />
                回退选文件夹
              </button>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={loading || !dataset}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                刷新
              </button>
            </div>
          </div>
          {!localApiAvailable ? (
            <p className="mt-3 text-xs text-amber-300">
              当前不是本地启动模式，自动识别已禁用。请使用 `npm run start:local`、`open.command` 或 `open.bat`。
            </p>
          ) : null}
        </header>

        <section className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-6">
            {error ? (
              <div className="flex items-start gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/10 px-5 py-4 text-sm text-rose-100">
                <AlertCircle size={18} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            {loading && progress ? (
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/8 px-5 py-4 text-sm text-cyan-100">
                <div className="flex items-center justify-between gap-4">
                  <span>{progress.phase}</span>
                  <span>{progress.processed}/{progress.total}</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${progress.total > 0 ? (progress.processed / progress.total) * 100 : 0}%` }} />
                </div>
              </div>
            ) : null}

            {snapshot ? (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <StatCard title="总 Tokens" valuePrimary={totalTokenValue?.primary ?? '0'} valuePrefix={totalTokenValue?.prefix} valueUnit={totalTokenValue?.unit} hint={`输入 ${formatCompact(snapshot.inputTokens, 2)} / 输出 ${formatCompact(snapshot.outputTokens, 2)}`} icon={Sparkles} accentClass="bg-[#4f7cff]" trend={snapshot.sparklineTokens} />
                  <StatCard title="会话统计" valuePrimary={sessionValue?.primary ?? '0'} valuePrefix={sessionValue?.prefix} valueUnit={sessionValue?.unit} hint={`轮次 ${formatNumber(snapshot.interactionTurns)} / 工具调用 ${formatNumber(snapshot.toolCalls)}`} icon={BarChart3} accentClass="bg-[#12b981]" trend={snapshot.sparklineSessions} />
                  <StatCard title="估算费用" valuePrimary={costValue?.primary ?? '0'} valuePrefix={costValue?.prefix} valueUnit={costValue?.unit} hint={`缓存输入 ${formatCompact(snapshot.cachedInputTokens, 2)} / 活跃 ${formatNumber(snapshot.activeDays)} 天`} icon={DollarSign} accentClass="bg-[#f59e0b]" trend={snapshot.sparklineCost} />
                  <StatCard title="性能指标" valuePrimary={tpmValue?.primary ?? '0'} valuePrefix={tpmValue?.prefix} valueUnit={tpmValue?.unit} hint={`平均 RPM ${formatNumber(snapshot.avgRpm, 3)} / 平均时长 ${formatDuration(snapshot.avgSessionDurationMs)}`} icon={Gauge} accentClass="bg-[#8b5cf6]" trend={snapshot.sparklineTpm} />
                </div>

                <section className="rounded-2xl border border-white/8 bg-[#11141b] px-5 py-5 shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <h2 className="text-sm font-semibold text-white">筛选、搜索与导出</h2>
                      <p className="mt-1 text-xs text-slate-400">
                        {providerLabel.name} / {getSourceTypeLabel(dataset?.sourceSummary.sourceType ?? 'file-list')}，
                        最后解析 {formatDateTime(dataset?.sourceSummary.parsedAtMs ?? 0)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <button type="button" onClick={() => setPriceRules((current) => [...current, { model: `custom-${current.length + 1}`, inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 }])} className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10">
                        新增规则
                      </button>
                      <button type="button" onClick={() => setPriceRules(getDefaultPriceRules())} className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10">
                        恢复默认价格表
                      </button>
                      <button type="button" onClick={() => exportSessionsCsv(snapshot.filteredSessions, provider)} className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10">
                        导出 CSV
                      </button>
                      <button type="button" onClick={() => exportMetricsJson(snapshot, provider)} className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10">
                        导出 JSON
                      </button>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-3 lg:grid-cols-6">
                    <div className="flex flex-col gap-2 text-xs text-slate-400 lg:col-span-2">
                      时间范围
                      <div className="grid grid-cols-2 gap-1 rounded-2xl border border-white/10 bg-[#0d1016] p-1 sm:grid-cols-5">
                        {timeRangeOptions.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => changeTimeRange(option.value)}
                            className={`min-h-10 whitespace-nowrap rounded-xl px-3 text-xs font-medium transition sm:text-sm ${
                              filters.timeRange === option.value
                                ? 'bg-[#4f7cff] text-white shadow-[0_10px_24px_rgba(79,124,255,0.28)]'
                                : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-100'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="flex flex-col gap-2 text-xs text-slate-400">
                      粒度
                      <select value={filters.granularity} onChange={(event) => setFilters((current) => ({ ...current, granularity: event.target.value as FilterState['granularity'] }))} className="rounded-2xl border border-white/10 bg-[#0d1016] px-4 py-3 text-sm text-slate-100 outline-none">
                        <option value="day">按天</option>
                        <option value="week">按周</option>
                        <option value="month">按月</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-2 text-xs text-slate-400">
                      模型
                      <select value={filters.model} onChange={(event) => setFilters((current) => ({ ...current, model: event.target.value }))} className="rounded-2xl border border-white/10 bg-[#0d1016] px-4 py-3 text-sm text-slate-100 outline-none">
                        {models.map((model) => <option key={model} value={model}>{model === 'all' ? '全部模型' : model}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-2 text-xs text-slate-400">
                      项目目录
                      <select value={filters.cwd} onChange={(event) => setFilters((current) => ({ ...current, cwd: event.target.value }))} className="rounded-2xl border border-white/10 bg-[#0d1016] px-4 py-3 text-sm text-slate-100 outline-none">
                        {projects.map((project) => <option key={project} value={project}>{project === 'all' ? '全部项目' : trimText(project, 48)}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-2 text-xs text-slate-400">
                      归档状态
                      <select value={filters.archived} onChange={(event) => setFilters((current) => ({ ...current, archived: event.target.value as FilterState['archived'] }))} className="rounded-2xl border border-white/10 bg-[#0d1016] px-4 py-3 text-sm text-slate-100 outline-none">
                        <option value="all">全部</option>
                        <option value="active">未归档</option>
                        <option value="archived">已归档</option>
                      </select>
                    </label>
                  </div>

                  {filters.timeRange === 'custom' ? (
                    <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-[#4f7cff]/20 bg-[#0d1016] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
                        <div className="flex items-center gap-2 text-xs font-medium text-[#b6c8ff]">
                          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#4f7cff]/15 text-[#8fb0ff]">
                            <CalendarDays size={16} />
                          </span>
                          自定义日期
                        </div>
                        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
                          <input
                            type="date"
                            value={filters.customStartDate}
                            onChange={(event) => setFilters((current) => ({ ...current, customStartDate: event.target.value }))}
                            className="min-h-10 min-w-0 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-slate-100 outline-none transition focus:border-[#4f7cff]/60"
                            aria-label="开始日期"
                          />
                          <ArrowRight size={16} className="hidden text-slate-500 sm:block" />
                          <input
                            type="date"
                            value={filters.customEndDate}
                            onChange={(event) => setFilters((current) => ({ ...current, customEndDate: event.target.value }))}
                            className="min-h-10 min-w-0 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-slate-100 outline-none transition focus:border-[#4f7cff]/60"
                            aria-label="结束日期"
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const today = getLocalDateInputValue()
                          setCustomDateRange(today, today)
                        }}
                        className="min-h-10 shrink-0 rounded-xl border border-white/10 bg-white/5 px-4 text-sm text-slate-200 transition hover:bg-white/10"
                      >
                        今天
                      </button>
                    </div>
                  ) : null}

                </section>

                <div className="grid gap-6 xl:grid-cols-2">
                  <ChartCard title="Tokens 趋势" subtitle="按筛选粒度分桶，展示模型消耗堆叠分布。" option={trendOption} height={340} />
                  <ChartCard title="模型消耗排行" subtitle="按筛选结果统计各模型总 tokens。" option={modelOption} height={340} />
                  <ChartCard
                    title="小时分布"
                    subtitle={resolvedHourlyDate === 'all' ? '基于当前筛选结果统计全部日期的 24 小时分布。' : `当前日期：${resolvedHourlyDate}`}
                    option={hourlyOption}
                    height={320}
                    headerActions={
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => stepHourlyDate('prev')}
                          disabled={hourlyDateOptions.length === 0 || (hourlyDate !== 'all' && hourlyDateIndex >= hourlyDateOptions.length - 1)}
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-300 transition hover:bg-white/10 disabled:opacity-40"
                          title="前一天"
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <input
                          type="date"
                          value={resolvedHourlyDate === 'all' ? '' : resolvedHourlyDate}
                          onChange={(event) => setHourlyDate(event.target.value || 'all')}
                          className="rounded-xl border border-white/10 bg-[#0d1016] px-3 py-1.5 text-xs text-slate-100 outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => stepHourlyDate('next')}
                          disabled={resolvedHourlyDate === 'all' || hourlyDateIndex <= 0}
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-300 transition hover:bg-white/10 disabled:opacity-40"
                          title="后一天"
                        >
                          <ChevronRight size={16} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setHourlyDate('all')}
                          className={`rounded-full border px-3 py-1.5 text-xs transition ${
                            resolvedHourlyDate === 'all'
                              ? 'border-[#4f7cff] bg-[#4f7cff]/15 text-white'
                              : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                          }`}
                        >
                          全部日期
                        </button>
                      </div>
                    }
                  />
                  <ChartCard title="工具调用排行" subtitle="统计本地记录中的工具调用名称。" option={toolOption} height={320} />
                  <ChartCard
                    title="项目目录排行"
                    subtitle="按 cwd 汇总 tokens、会话数和平均消耗，点击柱子可进入该项目会话。"
                    option={projectOption}
                    height={380}
                    onChartClick={(params) => {
                      if (params.componentType === 'series') {
                        focusProjectFromChart(params.dataIndex)
                      }
                    }}
                  />
                  <ChartCard title="会话规模分布" subtitle="按单会话 tokens 规模分桶，观察长尾会话。" option={distributionOption} height={320} />
                </div>

                <div ref={sessionSectionRef}>
                  <SessionTable
                    sessions={snapshot.filteredSessions}
                    searchValue={filters.search}
                    onSearchChange={(value) => setFilters((current) => ({ ...current, search: value }))}
                    onSelectSession={setSelectedSession}
                    activeProject={filters.cwd !== 'all' ? filters.cwd : ''}
                    onClearProject={
                      filters.cwd !== 'all'
                        ? () => setFilters((current) => ({ ...current, cwd: 'all' }))
                        : undefined
                    }
                  />
                </div>
              </>
            ) : (
              <section className="rounded-[24px] border border-dashed border-white/10 bg-[#10131a] px-6 py-10 text-center shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
                <div className="mx-auto flex max-w-2xl flex-col items-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#4f7cff]/15 text-[#7da2ff]">
                    <Database size={28} />
                  </div>
                  <h2 className="mt-5 text-2xl font-semibold text-white">还没有加载 {providerLabel.name} 数据</h2>
                  <p className="mt-3 text-sm leading-6 text-slate-400">
                    优先点击“自动识别”读取本机 <code className="rounded bg-white/8 px-1.5 py-0.5 text-slate-200">{providerLabel.home}</code>。
                    如果不是通过双击脚本或 <code className="rounded bg-white/8 px-1.5 py-0.5 text-slate-200">npm run start:local</code> 启动，再手动选择目录。
                    数据源：<code className="rounded bg-white/8 px-1.5 py-0.5 text-slate-200">{providerLabel.files}</code>。
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                    <button type="button" onClick={handleAutoDetect} disabled={!localApiAvailable} className="rounded-full bg-[#4f7cff] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-[#648bff] disabled:cursor-not-allowed disabled:opacity-50">
                      自动识别
                    </button>
                    <button type="button" onClick={handleChooseDirectory} className="rounded-full border border-white/10 bg-white/5 px-5 py-2.5 text-sm text-slate-200 transition hover:bg-white/10">
                      手动选择目录
                    </button>
                    <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-full border border-white/10 bg-white/5 px-5 py-2.5 text-sm text-slate-200 transition hover:bg-white/10">
                      文件夹回退模式
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>

          <aside className="flex min-w-0 flex-col gap-6">
            <section className="rounded-2xl border border-white/8 bg-[#11141b] px-5 py-5 shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#4f7cff]/15 text-[#7da2ff]">
                  <Database size={18} />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">数据源状态</h2>
                  <p className="mt-1 text-xs text-slate-400">当前模式、缓存和本地读取状态。</p>
                </div>
              </div>

              <div className="mt-5 space-y-4 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-slate-400">当前工具</span>
                  <span className="text-slate-200">{providerLabel.name}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-slate-400">目录授权</span>
                  <span className="text-slate-200">{sourceHandle ? '已连接' : rememberedHandle ? '已记住，待授权' : '未连接'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-slate-400">目录选择器</span>
                  <span className="text-slate-200">{browserSupport.directoryPicker ? '支持' : '不支持，建议回退模式'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-slate-400">缓存状态</span>
                  <span className="text-slate-200">{lastLoadedFromCache ? '已从缓存恢复' : dataset ? '实时数据' : '暂无数据'}</span>
                </div>
                {dataset ? (
                  <>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-slate-400">读取方式</span>
                      <span className="text-slate-200">{getSourceTypeLabel(dataset.sourceSummary.sourceType)}</span>
                    </div>
                    {dataset.sourceSummary.detectedPath ? (
                      <div>
                        <span className="text-slate-400">识别路径</span>
                        <p className="mt-1 break-all text-xs text-slate-300">{dataset.sourceSummary.detectedPath}</p>
                      </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-slate-400">文件数</span>
                      <span className="text-slate-200">{formatNumber(dataset.sourceSummary.fileCount)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-slate-400">Session 文件</span>
                      <span className="text-slate-200">{formatNumber(dataset.sourceSummary.sessionFileCount)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-slate-400">会话数</span>
                      <span className="text-slate-200">{formatNumber(dataset.sourceSummary.sessionCount)}</span>
                    </div>
                  </>
                ) : null}
              </div>

              <div className="mt-5 rounded-2xl border border-cyan-400/20 bg-cyan-400/8 px-4 py-4 text-xs leading-6 text-cyan-100">
                自动识别依赖本地启动脚本提供的只读 localhost 服务。估算费用、RPM、TPM 都是本地推导值，不是官方账单。
              </div>
            </section>

            <section className="rounded-2xl border border-white/8 bg-[#11141b] px-5 py-5 shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f59e0b]/15 text-[#f7b84c]">
                  <Wrench size={18} />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">价格表设置</h2>
                  <p className="mt-1 text-xs text-slate-400">按每百万 tokens 估算，修改后立即重算。Claude 缓存价格默认按 cache read / hit 近似估算。</p>
                </div>
              </div>

              {unmatchedModels.length > 0 ? (
                <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/8 px-4 py-4 text-xs leading-6 text-amber-100">
                  <p className="font-medium text-amber-50">以下模型当前没有命中任何价格规则：</p>
                  <p className="mt-2 break-words">{unmatchedModels.join('、')}</p>
                </div>
              ) : (
                <div className="mt-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/8 px-4 py-4 text-xs leading-6 text-emerald-100">
                  当前数据中的模型都已命中默认价格表或你的自定义规则。
                </div>
              )}

              <div className="mt-5 space-y-4">
                {priceRules.map((rule, index) => (
                  <div key={`${rule.model}-${index}`} className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
                    <label className="flex flex-col gap-2 text-xs text-slate-400">
                      模型匹配
                      <input value={rule.model} onChange={(event) => setPriceRules((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, model: event.target.value } : item))} className="rounded-xl border border-white/10 bg-[#0d1016] px-3 py-2 text-sm text-white outline-none" />
                    </label>
                    <div className="mt-3 grid gap-3 md:grid-cols-3 2xl:grid-cols-1">
                      {[
                        ['输入', 'inputPerMillion'],
                        ['缓存输入', 'cachedInputPerMillion'],
                        ['输出', 'outputPerMillion'],
                      ].map(([label, key]) => (
                        <label key={key} className="flex flex-col gap-2 text-xs text-slate-400">
                          {label}
                          <input type="number" min="0" step="0.001" value={rule[key as keyof PriceRule] as number} onChange={(event) => setPriceRules((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: Number(event.target.value || 0) } : item))} className="rounded-xl border border-white/10 bg-[#0d1016] px-3 py-2 text-sm text-white outline-none" />
                        </label>
                      ))}
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button type="button" onClick={() => setPriceRules((current) => current.length === 1 ? current : current.filter((_, itemIndex) => itemIndex !== index))} className="text-xs text-rose-300 transition hover:text-rose-200">
                        删除此规则
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-white/8 bg-[#11141b] px-5 py-5 shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#8b5cf6]/15 text-[#baa3ff]">
                  <Gauge size={18} />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">关键摘要</h2>
                  <p className="mt-1 text-xs text-slate-400">定位高消耗模型、项目与会话。</p>
                </div>
              </div>

              {snapshot ? (
                <div className="mt-5 space-y-4 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">峰值日期</span>
                    <span className="text-right text-slate-200">{snapshot.peakDay ? `${snapshot.peakDay.label} / ${formatCompact(snapshot.peakDay.totalTokens, 2)}` : '-'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">峰值小时</span>
                    <span className="text-right text-slate-200">{snapshot.peakHour ? `${snapshot.peakHour.label} / ${formatCompact(snapshot.peakHour.totalTokens, 2)}` : '-'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">平均会话 Tokens</span>
                    <span className="text-slate-200">{formatCompact(snapshot.avgSessionTokens, 2)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">平均工具调用</span>
                    <span className="text-slate-200">{formatNumber(snapshot.avgToolCalls, 2)}</span>
                  </div>
                  <div className="border-t border-white/8 pt-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Top Session</p>
                    {snapshot.topSessions[0] ? (
                      <div className="mt-3">
                        <p className="font-medium text-white">{trimText(snapshot.topSessions[0].title, 42)}</p>
                        <p className="mt-1 text-xs text-slate-500">{snapshot.topSessions[0].model}</p>
                        <p className="mt-2 text-sm text-slate-300">{formatCompact(snapshot.topSessions[0].resolvedTotalTokens, 2)} tokens</p>
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-slate-500">暂无数据</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-5 text-sm text-slate-500">载入数据后显示。</p>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                <button type="button" onClick={handleClearCache} className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10">
                  清空缓存
                </button>
                <a href="https://github.com/lizhiwei" target="_blank" rel="noreferrer" className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10">
                  作者 lizhiwei
                </a>
              </div>
            </section>
          </aside>
        </section>
      </div>
      <SessionDetailDrawer session={selectedSession} onClose={() => setSelectedSession(null)} />
    </div>
  )
}

export default App
