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
import { asPermissionHandle } from './filesystem'

let sqlPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: () => wasmUrl,
    })
  }
  return sqlPromise
}

function asNumber(value: unknown) {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function normalizeTokenUsage(raw: Record<string, unknown> | undefined | null): TokenUsage {
  return {
    inputTokens: asNumber(raw?.input_tokens),
    cachedInputTokens: asNumber(raw?.cached_input_tokens),
    outputTokens: asNumber(raw?.output_tokens),
    reasoningOutputTokens: asNumber(raw?.reasoning_output_tokens),
    totalTokens: asNumber(raw?.total_tokens),
  }
}

export function createEmptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  }
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

export function summarizeCodexSessionJsonl(text: string, sessionFilePath: string): SessionEventSummary | null {
  const lines = text.split('\n')
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
  let lastTokenUsage: TokenUsage | null = null
  const toolBreakdown: Record<string, number> = {}
  const tokenSamples: TokenSample[] = []
  const requestSamples: SessionEventSummary['requestSamples'] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    eventCount += 1
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
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
      metaId = getString(payload.id)
      metaTimestampMs = parseEventTimestamp(payload.timestamp)
      cwd = getString(payload.cwd)
      source = getString(payload.source)
      threadSource = getString(payload.thread_source)
      modelProvider = getString(payload.model_provider)
      cliVersion = getString(payload.cli_version)
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

      if (payloadType === 'function_call') {
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
        const totalUsage =
          info?.total_token_usage && typeof info.total_token_usage === 'object'
            ? (info.total_token_usage as Record<string, unknown>)
            : null
        const lastUsage =
          info?.last_token_usage && typeof info.last_token_usage === 'object'
            ? (info.last_token_usage as Record<string, unknown>)
            : null
        lastTokenUsage = normalizeTokenUsage(totalUsage ?? lastUsage)
        if (timestampMs > 0) {
          tokenSamples.push({
            timestampMs,
            totalTokens: asNumber(lastUsage?.total_tokens ?? totalUsage?.total_tokens),
            inputTokens: asNumber(lastUsage?.input_tokens ?? totalUsage?.input_tokens),
            cachedInputTokens: asNumber(
              lastUsage?.cached_input_tokens ?? totalUsage?.cached_input_tokens,
            ),
            outputTokens: asNumber(lastUsage?.output_tokens ?? totalUsage?.output_tokens),
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

  const id = metaId || sessionFilePath.split('/').pop()?.replace('.jsonl', '') || sessionFilePath
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
    lastTokenUsage,
    tokenSamples,
    requestSamples,
    malformedLines,
    eventCount,
  }
}

export function mergeCodexThreadsAndSessions(threads: ThreadSummary[], sessions: SessionEventSummary[]) {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]))
  const threadByRolloutPath = new Map(
    threads.filter((thread) => thread.rolloutPath).map((thread) => [thread.rolloutPath, thread]),
  )
  const merged = new Map<string, MergedSession>()

  for (const session of sessions) {
    const thread =
      threadById.get(session.id) ??
      threadByRolloutPath.get(session.sessionFilePath.replace('/sessions/', '/')) ??
      threadByRolloutPath.get(session.sessionFilePath)

    const usage = session.lastTokenUsage ?? createEmptyUsage()
    const threadTokensUsed = thread?.tokensUsed ?? 0
    const resolvedTotalTokens = usage.totalTokens > 0 ? usage.totalTokens : threadTokensUsed
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
      usageConflict: usage.totalTokens > 0 && threadTokensUsed > 0 && usage.totalTokens !== threadTokensUsed,
    })
  }

  for (const thread of threads) {
    if (merged.has(thread.id)) {
      continue
    }

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
    if (nextPath === 'state_5.sqlite' || (nextPath.startsWith('sessions/') && nextPath.endsWith('.jsonl'))) {
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
      normalizedPath === 'state_5.sqlite' ||
      (normalizedPath.startsWith('sessions/') && normalizedPath.endsWith('.jsonl'))
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

  const sessionFiles = entries.filter((entry) => entry.path.startsWith('sessions/') && entry.path.endsWith('.jsonl'))
  const threads = await parseCodexThreadFile(stateFile.file)
  const sessions: SessionEventSummary[] = []

  for (const [index, entry] of sessionFiles.entries()) {
    onProgress?.({
      phase: '正在解析 sessions jsonl',
      processed: index + 1,
      total: sessionFiles.length,
    })

    const text = await entry.file.text()
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
