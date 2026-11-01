import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type {
  DashboardData,
  LoadProgress,
  MergedSession,
  SessionEventSummary,
  ThreadSummary,
  TokenSample,
  TokenUsage,
  VirtualFileEntry,
  ProviderType,
} from '../types'
import { decompress as decompressZstd } from 'fzstd'
import { asPermissionHandle } from './filesystem'
import { addUsage, asNumber, createEmptyQuality, createEmptyUsage, sumUsageParts } from './usage'

export { createEmptyUsage } from './usage'

let sqlPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: () => wasmUrl,
    })
  }
  return sqlPromise
}

/**
 * Codex token_count 语义（与 ccusage 一致）：
 * - input_tokens 包含 cached_input_tokens 和 cache_write_input_tokens
 * - output_tokens 包含 reasoning_output_tokens
 * 这里拆成互不重叠的四段，便于分别计价。
 */
export function normalizeCodexUsage(raw: Record<string, unknown> | undefined | null): TokenUsage {
  const input = asNumber(raw?.input_tokens)
  const cached = Math.min(input, asNumber(raw?.cached_input_tokens))
  const cacheWrite = Math.min(input - cached, asNumber(raw?.cache_write_input_tokens))
  const usage: TokenUsage = {
    inputTokens: input - cached - cacheWrite,
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: 0,
    outputTokens: asNumber(raw?.output_tokens),
    reasoningOutputTokens: asNumber(raw?.reasoning_output_tokens),
    totalTokens: 0,
  }
  usage.totalTokens = sumUsageParts(usage)
  return usage
}

export function isCodexSessionPath(path: string) {
  return path.startsWith('sessions/') && (path.endsWith('.jsonl') || path.endsWith('.jsonl.zst'))
}

/** 读取会话文件文本，.jsonl.zst 在浏览器内解压。 */
export async function readCodexSessionText(file: Blob, path: string) {
  if (!path.endsWith('.zst')) {
    return file.text()
  }
  const bytes = decompressZstd(new Uint8Array(await file.arrayBuffer()))
  return new TextDecoder().decode(bytes)
}

// 这些行体积大且与计量无关，先用行首判断跳过，避免 JSON.parse。
const SKIPPED_PAYLOAD_TYPES = [
  '"type":"function_call_output"',
  '"type":"custom_tool_call_output"',
  '"type":"item_completed"',
  '"type":"reasoning"',
  '"type":"image_generation_call"',
  '"type":"compacted"',
  '"type":"world_state"',
  '"type":"exec_command_output_delta"',
]

function shouldSkipLine(line: string) {
  const head = line.slice(0, 200)
  return SKIPPED_PAYLOAD_TYPES.some((marker) => head.includes(marker))
}

export function getString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function getBoolean(value: unknown) {
  return Boolean(value)
}

function getMillisFromUnix(value: number, valueMs: number) {
  if (valueMs > 0) {
    return valueMs
  }
  return value > 0 ? value * 1000 : 0
}

export async function parseCodexThreadFile(file: File): Promise<ThreadSummary[]> {
  const SQL = await getSql()
  const buffer = await file.arrayBuffer()
  const db = new SQL.Database(new Uint8Array(buffer))

  try {
    const result = db.exec(`
      select
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        tokens_used,
        has_user_event,
        archived,
        archived_at,
        cli_version,
        first_user_message,
        preview,
        coalesce(model, '') as model,
        coalesce(reasoning_effort, '') as reasoning_effort,
        coalesce(thread_source, '') as thread_source,
        coalesce(created_at_ms, 0) as created_at_ms,
        coalesce(updated_at_ms, 0) as updated_at_ms
      from threads
    `)

    if (result.length === 0) {
      return []
    }

    const [{ columns, values }] = result
    return values.map((row: unknown[]) => {
      const raw = Object.fromEntries(
        columns.map((column: string, index: number) => [column, row[index]]),
      )
      return {
        id: getString(raw.id),
        rolloutPath: getString(raw.rollout_path),
        createdAtMs: getMillisFromUnix(asNumber(raw.created_at), asNumber(raw.created_at_ms)),
        updatedAtMs: getMillisFromUnix(asNumber(raw.updated_at), asNumber(raw.updated_at_ms)),
        source: getString(raw.source),
        modelProvider: getString(raw.model_provider),
        cwd: getString(raw.cwd),
        title: getString(raw.title),
        sandboxPolicy: getString(raw.sandbox_policy),
        approvalMode: getString(raw.approval_mode),
        tokensUsed: asNumber(raw.tokens_used),
        hasUserEvent: getBoolean(raw.has_user_event),
        archived: getBoolean(raw.archived),
        archivedAtMs: asNumber(raw.archived_at) > 0 ? asNumber(raw.archived_at) * 1000 : null,
        cliVersion: getString(raw.cli_version),
        firstUserMessage: getString(raw.first_user_message),
        preview: getString(raw.preview),
        model: getString(raw.model),
        reasoningEffort: getString(raw.reasoning_effort),
        threadSource: getString(raw.thread_source),
      }
    })
  } finally {
    db.close()
  }
}

export function parseEventTimestamp(raw: unknown) {
  if (typeof raw !== 'string') {
    return 0
  }
  const value = Date.parse(raw)
  return Number.isFinite(value) ? value : 0
}

export function takeTextFromMessageContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }
  const parts = content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return ''
      }
      if ('text' in item && typeof item.text === 'string') {
        return item.text
      }
      return ''
    })
    .filter(Boolean)
  return parts.join('\n').trim()
}

/**
 * 解析一个 Codex 会话文件。
 * 计量规则：
 * 1. 只看 event_msg / token_count；累计值 total_token_usage 与上一条相同的重复事件跳过。
 * 2. 增量优先用 last_token_usage，缺失时用累计值相减。
 * 3. 子代理 / fork 文件第一条 token_count 带着父线程的累计值且 last=0，
 *    这部分是父线程的历史，只作为基线，不计入。
 */
export function summarizeCodexSessionJsonl(
  text: string,
  sessionFilePath: string,
): SessionEventSummary | null {
  let metaId = ''
  let metaTimestampMs = 0
  let cwd = ''
  let source = ''
  let threadSource = ''
  let modelProvider = ''
  let cliVersion = ''
  let model = ''
  let title = ''
  let preview = ''
  let firstUserMessage = ''
  let firstEventAtMs = 0
  let lastEventAtMs = 0
  let userMessageCount = 0
  let assistantMessageCount = 0
  let toolCallCount = 0
  let malformedLines = 0
  let eventCount = 0
  let forkedFromId = ''
  let isSubagent = false
  let previousTotalKey = ''
  let previousTotal: TokenUsage | null = null
  const usage = createEmptyUsage()
  const quality = createEmptyQuality()
  if (sessionFilePath.endsWith('.zst')) {
    quality.compressedFiles = 1
  }
  const toolBreakdown: Record<string, number> = {}
  const tokenSamples: TokenSample[] = []
  const requestSamples: SessionEventSummary['requestSamples'] = []

  let lineStart = 0
  while (lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd === -1) {
      lineEnd = text.length
    }
    const line = text.slice(lineStart, lineEnd).trim()
    lineStart = lineEnd + 1
    if (!line) {
      continue
    }
    eventCount += 1
    if (shouldSkipLine(line)) {
      continue
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      malformedLines += 1
      continue
    }

    const timestampMs = parseEventTimestamp(parsed.timestamp)
    if (timestampMs > 0) {
      if (!firstEventAtMs || timestampMs < firstEventAtMs) {
        firstEventAtMs = timestampMs
      }
      if (timestampMs > lastEventAtMs) {
        lastEventAtMs = timestampMs
      }
    }

    const type = getString(parsed.type)
    const payload =
      parsed.payload && typeof parsed.payload === 'object'
        ? (parsed.payload as Record<string, unknown>)
        : null

    if (type === 'session_meta' && payload) {
      if (metaId) {
        continue
      }
      metaId = getString(payload.id)
      metaTimestampMs = parseEventTimestamp(payload.timestamp)
      cwd = getString(payload.cwd)
      const rawSource = payload.source
      source = typeof rawSource === 'string' ? rawSource : rawSource ? JSON.stringify(rawSource) : ''
      isSubagent = Boolean(rawSource && typeof rawSource === 'object' && 'subagent' in rawSource)
      threadSource = getString(payload.thread_source)
      modelProvider = getString(payload.model_provider)
      cliVersion = getString(payload.cli_version)
      const historyBase = payload.history_base as Record<string, unknown> | undefined
      forkedFromId = getString(payload.forked_from_id) || getString(historyBase?.thread_id)
      continue
    }

    if (type === 'turn_context' && payload) {
      model = getString(payload.model) || model
      continue
    }

    if (type === 'response_item' && payload) {
      const payloadType = getString(payload.type)
      if (payloadType === 'message') {
        const role = getString(payload.role)
        const messageText = takeTextFromMessageContent(payload.content)
        if (role === 'user') {
          userMessageCount += 1
          requestSamples.push({ timestampMs, kind: 'user' })
          if (!firstUserMessage) {
            firstUserMessage = messageText
          }
          if (!title) {
            title = firstUserMessage.slice(0, 48)
          }
        } else if (role === 'assistant') {
          assistantMessageCount += 1
          requestSamples.push({ timestampMs, kind: 'assistant' })
          if (!preview && messageText) {
            preview = messageText.slice(0, 120)
          }
        }
      }

      if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
        toolCallCount += 1
        const toolName = getString(payload.name) || 'unknown'
        toolBreakdown[toolName] = (toolBreakdown[toolName] ?? 0) + 1
        requestSamples.push({ timestampMs, kind: 'tool', toolName })
      }
      continue
    }

    if (type === 'event_msg' && payload) {
      const payloadType = getString(payload.type)
      if (payloadType === 'token_count') {
        const info =
          payload.info && typeof payload.info === 'object'
            ? (payload.info as Record<string, unknown>)
            : null
        const rawTotal = info?.total_token_usage as Record<string, unknown> | undefined
        const rawLast = info?.last_token_usage as Record<string, unknown> | undefined
        if (!rawTotal && !rawLast) {
          continue
        }
        quality.rawUsageRecords += 1
        const totalKey = rawTotal ? JSON.stringify(rawTotal) : ''
        const last = rawLast ? normalizeCodexUsage(rawLast) : null
        if (totalKey && totalKey === previousTotalKey) {
          quality.duplicateRecords += 1
          quality.duplicateTokens += last?.totalTokens ?? 0
          continue
        }
        const total = rawTotal ? normalizeCodexUsage(rawTotal) : null
        let sample: TokenUsage | null = last && last.totalTokens > 0 ? last : null
        // 只有累计值、没有本轮增量时才相减。文件里第一条累计值若带着 last=0，
        // 说明是从父线程继承的历史（子代理 / fork），只作为基线，不计入。
        if (!sample && total && !rawLast) {
          sample = previousTotal ? subtractUsage(total, previousTotal) : total
        }
        if (!sample && total && !previousTotal && total.totalTokens > 0) {
          quality.duplicateRecords += 1
          quality.duplicateTokens += total.totalTokens
        }
        previousTotalKey = totalKey || previousTotalKey
        previousTotal = total ?? previousTotal

        if (rawLast) {
          const rawInput = asNumber(rawLast.input_tokens)
          if (
            asNumber(rawLast.cached_input_tokens) + asNumber(rawLast.cache_write_input_tokens) > rawInput ||
            asNumber(rawLast.reasoning_output_tokens) > asNumber(rawLast.output_tokens)
          ) {
            quality.invariantViolations += 1
          }
        }
        if (!sample || sample.totalTokens <= 0) {
          continue
        }
        quality.countedUsageRecords += 1
        addUsage(usage, sample)
        if (timestampMs > 0) {
          tokenSamples.push({
            ...sample,
            timestampMs,
            contextTokens: sample.inputTokens + sample.cachedInputTokens + sample.cacheWriteTokens,
            model,
          })
        }
      } else if (payloadType === 'agent_message') {
        const message = getString(payload.message)
        if (!preview && message) {
          preview = message.slice(0, 120)
        }
      }
    }
  }

  // turn_context 之前的 token_count 还不知道模型，用会话里第一次出现的模型补上。
  const firstModel = tokenSamples.find((sample) => sample.model)?.model || model
  for (const sample of tokenSamples) {
    if (!sample.model) {
      sample.model = firstModel
    }
  }

  const fileName = sessionFilePath.split('/').pop() ?? sessionFilePath
  const fileId = fileName.replace(/\.jsonl(\.zst)?$/, '')
  // fork 出来的文件会复用父线程的 session_meta.id，用文件名里的线程 id 区分。
  const fileThreadId = /_([0-9a-f-]{36})$/.exec(fileId)?.[1] ?? ''
  const id = fileThreadId || metaId || fileId
  if (!id) {
    return null
  }

  return {
    id,
    sessionFilePath,
    sessionTimestampMs: metaTimestampMs || firstEventAtMs || lastEventAtMs,
    cwd,
    source,
    threadSource,
    modelProvider,
    cliVersion,
    model,
    title,
    firstUserMessage,
    preview,
    firstEventAtMs,
    lastEventAtMs,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    interactionTurns: Math.max(userMessageCount, assistantMessageCount),
    toolBreakdown,
    lastTokenUsage: usage,
    tokenSamples,
    requestSamples,
    malformedLines,
    eventCount,
    quality,
    forkedFromId: fileThreadId && metaId !== fileThreadId ? metaId : forkedFromId,
    isSubagent,
  }
}

function subtractUsage(current: TokenUsage, previous: TokenUsage): TokenUsage {
  const next: TokenUsage = {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
    cacheWrite1hTokens: 0,
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
    totalTokens: 0,
  }
  next.totalTokens = sumUsageParts(next)
  return next
}

/** sqlite 里是绝对路径且不带 .zst，统一成 sessions/... 相对路径再匹配。 */
function normalizeRolloutKey(path: string) {
  const index = path.lastIndexOf('/sessions/')
  const relative = index >= 0 ? path.slice(index + 1) : path
  return relative.replace(/\.zst$/, '')
}

export function mergeCodexThreadsAndSessions(threads: ThreadSummary[], sessions: SessionEventSummary[]) {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]))
  const threadByRolloutPath = new Map(
    threads.filter((thread) => thread.rolloutPath).map((thread) => [normalizeRolloutKey(thread.rolloutPath), thread]),
  )
  const merged = new Map<string, MergedSession>()
  const matchedThreadIds = new Set<string>()

  for (const session of sessions) {
    const thread =
      threadByRolloutPath.get(normalizeRolloutKey(session.sessionFilePath)) ?? threadById.get(session.id)
    if (thread) {
      matchedThreadIds.add(thread.id)
    }

    const usage = session.lastTokenUsage ?? createEmptyUsage()
    const threadTokensUsed = thread?.tokensUsed ?? 0
    const resolvedTotalTokens = usage.totalTokens > 0 ? usage.totalTokens : threadTokensUsed
    const quality = { ...session.quality }
    if (usage.totalTokens === 0 && threadTokensUsed > 0) {
      quality.totalOnlyTokens += threadTokensUsed
    }
    const createdAtMs =
      thread?.createdAtMs || session.sessionTimestampMs || session.firstEventAtMs || session.lastEventAtMs
    const updatedAtMs = thread?.updatedAtMs || session.lastEventAtMs || createdAtMs
    const durationMs = Math.max(
      0,
      (session.lastEventAtMs || updatedAtMs) - (session.firstEventAtMs || createdAtMs),
    )

    merged.set(session.id, {
      id: session.id,
      rolloutPath: thread?.rolloutPath ?? '',
      sessionFilePath: session.sessionFilePath,
      cwd: thread?.cwd || session.cwd,
      title: thread?.title || session.title || session.firstUserMessage || 'Untitled Session',
      preview: thread?.preview || session.preview || session.firstUserMessage,
      model: thread?.model || session.model || 'unknown',
      modelProvider: thread?.modelProvider || session.modelProvider,
      threadSource: thread?.threadSource || session.threadSource,
      createdAtMs,
      updatedAtMs,
      firstEventAtMs: session.firstEventAtMs || createdAtMs,
      lastEventAtMs: session.lastEventAtMs || updatedAtMs,
      archived: thread?.archived ?? false,
      cliVersion: thread?.cliVersion || session.cliVersion,
      usage,
      threadTokensUsed,
      resolvedTotalTokens,
      userMessageCount: session.userMessageCount,
      assistantMessageCount: session.assistantMessageCount,
      interactionTurns: session.interactionTurns,
      toolCallCount: session.toolCallCount,
      toolBreakdown: session.toolBreakdown,
      tokenSamples: session.tokenSamples,
      requestSamples: session.requestSamples,
      malformedLines: session.malformedLines,
      eventCount: session.eventCount,
      durationMs,
      // sqlite 的 tokens_used 包含 fork/子代理继承的父线程历史，差异超过 5% 才标记。
      usageConflict:
        usage.totalTokens > 0 &&
        threadTokensUsed > 0 &&
        Math.abs(usage.totalTokens - threadTokensUsed) / Math.max(usage.totalTokens, threadTokensUsed) > 0.05,
      quality,
      isSubagent: session.isSubagent,
    })
  }

  for (const thread of threads) {
    if (matchedThreadIds.has(thread.id) || merged.has(thread.id)) {
      continue
    }
    const quality = createEmptyQuality()
    quality.totalOnlyTokens = thread.tokensUsed

    merged.set(thread.id, {
      id: thread.id,
      rolloutPath: thread.rolloutPath,
      sessionFilePath: '',
      cwd: thread.cwd,
      title: thread.title || thread.firstUserMessage || 'Untitled Session',
      preview: thread.preview || thread.firstUserMessage,
      model: thread.model || 'unknown',
      modelProvider: thread.modelProvider,
      threadSource: thread.threadSource,
      createdAtMs: thread.createdAtMs,
      updatedAtMs: thread.updatedAtMs,
      firstEventAtMs: thread.createdAtMs,
      lastEventAtMs: thread.updatedAtMs,
      archived: thread.archived,
      cliVersion: thread.cliVersion,
      usage: createEmptyUsage(),
      threadTokensUsed: thread.tokensUsed,
      resolvedTotalTokens: thread.tokensUsed,
      userMessageCount: thread.hasUserEvent ? 1 : 0,
      assistantMessageCount: 0,
      interactionTurns: thread.hasUserEvent ? 1 : 0,
      toolCallCount: 0,
      toolBreakdown: {},
      tokenSamples: [],
      requestSamples: [],
      malformedLines: 0,
      eventCount: 0,
      durationMs: Math.max(0, thread.updatedAtMs - thread.createdAtMs),
      usageConflict: false,
      quality,
      isSubagent: thread.source.includes('subagent'),
    })
  }

  return [...merged.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs)
}

export async function verifyDirectoryPermission(handle: FileSystemDirectoryHandle) {
  const readMode = { mode: 'read' as const }
  const permissionHandle = asPermissionHandle(handle)
  if (!permissionHandle.queryPermission || !permissionHandle.requestPermission) {
    return true
  }
  const current = await permissionHandle.queryPermission(readMode)
  if (current === 'granted') {
    return true
  }
  const requested = await permissionHandle.requestPermission(readMode)
  return requested === 'granted'
}

export function supportsDirectoryPicker() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

export async function pickCodexDirectory() {
  if (!supportsDirectoryPicker()) {
    throw new Error('当前浏览器不支持目录授权，请改用文件夹回退模式。')
  }
  const picker = window as unknown as Window & {
    showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>
  }
  return picker.showDirectoryPicker()
}

export async function pickDirectory() {
  return pickCodexDirectory()
}

async function listFilesFromHandle(
  handle: FileSystemDirectoryHandle,
  pathPrefix = '',
  entries: VirtualFileEntry[] = [],
) {
  for await (const [name, entry] of handle.entries()) {
    const nextPath = pathPrefix ? `${pathPrefix}/${name}` : name
    if (entry.kind === 'directory') {
      await listFilesFromHandle(entry, nextPath, entries)
      continue
    }
    if (nextPath === 'state_5.sqlite' || isCodexSessionPath(nextPath)) {
      entries.push({
        path: nextPath,
        file: await entry.getFile(),
      })
    }
  }
  return entries
}

export async function readEntriesFromHandle(handle: FileSystemDirectoryHandle) {
  return listFilesFromHandle(handle)
}

export async function readEntriesFromFileList(fileList: FileList) {
  const entries: VirtualFileEntry[] = []
  for (const file of Array.from(fileList)) {
    const relativePath = file.webkitRelativePath || file.name
    const sessionIndex = relativePath.indexOf('sessions/')
    const normalizedPath = relativePath.endsWith('state_5.sqlite')
      ? 'state_5.sqlite'
      : sessionIndex >= 0
        ? relativePath.slice(sessionIndex)
        : relativePath

    if (
      normalizedPath === 'state_5.sqlite' || isCodexSessionPath(normalizedPath)
    ) {
      entries.push({ path: normalizedPath, file })
    }
  }
  return entries
}

export function createFingerprint(entries: VirtualFileEntry[]) {
  return entries
    .map((entry) => `${entry.path}:${entry.file.size}:${entry.file.lastModified}`)
    .sort()
    .join('|')
}

export async function parseCodexEntries(
  entries: VirtualFileEntry[],
  sourceType: DashboardData['sourceSummary']['sourceType'],
  detectedPath = '',
  onProgress?: (progress: LoadProgress) => void,
): Promise<DashboardData> {
  const stateFile = entries.find((entry) => entry.path === 'state_5.sqlite')
  if (!stateFile) {
    throw new Error('没有找到 state_5.sqlite，请确认选择的是完整的 .codex 目录。')
  }

  const sessionFiles = entries.filter((entry) => isCodexSessionPath(entry.path))
  const threads = await parseCodexThreadFile(stateFile.file)
  const sessions: SessionEventSummary[] = []

  for (const [index, entry] of sessionFiles.entries()) {
    onProgress?.({
      phase: '正在解析 Codex 会话',
      processed: index + 1,
      total: sessionFiles.length,
    })

    const text = await readCodexSessionText(entry.file, entry.path)
    const summary = summarizeCodexSessionJsonl(text, entry.path)
    if (summary) {
      sessions.push(summary)
    }
  }

  const mergedSessions = mergeCodexThreadsAndSessions(threads, sessions)
  return {
    sessions: mergedSessions,
    sourceSummary: {
      parsedAtMs: Date.now(),
      fingerprint: createFingerprint(entries),
      fileCount: entries.length,
      sessionFileCount: sessionFiles.length,
      sessionCount: mergedSessions.length,
      threadCount: threads.length,
      sourceType,
      provider: 'codex' satisfies ProviderType,
      sourceName: 'Codex',
      detectedPath,
    },
  }
}
