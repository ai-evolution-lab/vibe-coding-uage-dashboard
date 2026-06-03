import type {
  DashboardData,
  LoadProgress,
  MergedSession,
  RequestSample,
  TokenSample,
  TokenUsage,
  VirtualFileEntry,
} from '../types'
import {
  createEmptyUsage,
  createFingerprint,
  getString,
  parseEventTimestamp,
  takeTextFromMessageContent,
} from './codex'

function asNumber(value: unknown) {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function addUsage(target: TokenUsage, raw: Record<string, unknown> | null) {
  if (!raw) {
    return
  }
  target.inputTokens += asNumber(raw.input_tokens)
  target.cachedInputTokens +=
    asNumber(raw.cache_read_input_tokens) + asNumber(raw.cache_creation_input_tokens)
  target.outputTokens += asNumber(raw.output_tokens)
  target.reasoningOutputTokens += asNumber(raw.reasoning_output_tokens)
  target.totalTokens +=
    asNumber(raw.input_tokens) +
    asNumber(raw.cache_read_input_tokens) +
    asNumber(raw.cache_creation_input_tokens) +
    asNumber(raw.output_tokens) +
    asNumber(raw.reasoning_output_tokens)
}

function getMessageText(message: Record<string, unknown> | null) {
  if (!message) {
    return ''
  }
  const content = message.content
  if (typeof content === 'string') {
    return content.trim()
  }
  return takeTextFromMessageContent(content)
}

function makeProjectFromPath(path: string) {
  const parts = path.split('/')
  const projectIndex = parts.indexOf('projects')
  if (projectIndex >= 0 && parts[projectIndex + 1]) {
    return parts[projectIndex + 1].replaceAll('-', '/')
  }
  return ''
}

export async function parseClaudeSessionFile(entry: VirtualFileEntry): Promise<MergedSession | null> {
  const text = await entry.file.text()
  const lines = text.split('\n')
  const usage = createEmptyUsage()
  const tokenSamples: TokenSample[] = []
  const requestSamples: RequestSample[] = []
  const toolBreakdown: Record<string, number> = {}
  let malformedLines = 0
  let eventCount = 0
  let id = ''
  let cwd = ''
  let model = ''
  let title = ''
  let preview = ''
  let firstUserMessage = ''
  let firstEventAtMs = 0
  let lastEventAtMs = 0
  let userMessageCount = 0
  let assistantMessageCount = 0
  let toolCallCount = 0

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

    id = getString(parsed.sessionId) || id
    cwd = getString(parsed.cwd) || cwd
    const timestampMs = parseEventTimestamp(parsed.timestamp)
    if (timestampMs > 0) {
      firstEventAtMs = firstEventAtMs ? Math.min(firstEventAtMs, timestampMs) : timestampMs
      lastEventAtMs = Math.max(lastEventAtMs, timestampMs)
    }

    const type = getString(parsed.type)
    const message = asRecord(parsed.message)
    const role = getString(message?.role) || type

    if (message?.model) {
      model = getString(message.model) || model
    }

    if (role === 'user' || type === 'user') {
      userMessageCount += 1
      requestSamples.push({ timestampMs, kind: 'user' })
      const messageText = getMessageText(message)
      if (!firstUserMessage && messageText) {
        firstUserMessage = messageText
        title = messageText.slice(0, 48)
      }
    }

    if (role === 'assistant' || type === 'assistant') {
      assistantMessageCount += 1
      requestSamples.push({ timestampMs, kind: 'assistant' })
      const rawUsage = asRecord(message?.usage)
      addUsage(usage, rawUsage)
      if (rawUsage && timestampMs > 0) {
        tokenSamples.push({
          timestampMs,
          totalTokens:
            asNumber(rawUsage.input_tokens) +
            asNumber(rawUsage.cache_read_input_tokens) +
            asNumber(rawUsage.cache_creation_input_tokens) +
            asNumber(rawUsage.output_tokens) +
            asNumber(rawUsage.reasoning_output_tokens),
          inputTokens: asNumber(rawUsage.input_tokens),
          cachedInputTokens:
            asNumber(rawUsage.cache_read_input_tokens) +
            asNumber(rawUsage.cache_creation_input_tokens),
          outputTokens: asNumber(rawUsage.output_tokens),
        })
      }
      const messageText = getMessageText(message)
      if (!preview && messageText) {
        preview = messageText.slice(0, 120)
      }

      const content = message?.content
      if (Array.isArray(content)) {
        for (const item of content) {
          const block = asRecord(item)
          if (getString(block?.type) === 'tool_use') {
            const toolName = getString(block?.name) || 'unknown'
            toolCallCount += 1
            toolBreakdown[toolName] = (toolBreakdown[toolName] ?? 0) + 1
            requestSamples.push({ timestampMs, kind: 'tool', toolName })
          }
        }
      }

      const serverToolUse = asRecord(rawUsage?.server_tool_use)
      if (serverToolUse) {
        for (const [toolName, count] of Object.entries(serverToolUse)) {
          const numericCount = asNumber(count)
          if (numericCount > 0) {
            toolCallCount += numericCount
            toolBreakdown[toolName] = (toolBreakdown[toolName] ?? 0) + numericCount
            requestSamples.push({ timestampMs, kind: 'tool', toolName })
          }
        }
      }
    }
  }

  id = id || entry.path.split('/').pop()?.replace('.jsonl', '') || entry.path
  const createdAtMs = firstEventAtMs || lastEventAtMs || entry.file.lastModified
  const updatedAtMs = lastEventAtMs || createdAtMs
  const resolvedCwd = cwd || makeProjectFromPath(entry.path) || 'unknown'
  const totalTokens =
    usage.totalTokens ||
    usage.inputTokens + usage.cachedInputTokens + usage.outputTokens + usage.reasoningOutputTokens

  if (!id) {
    return null
  }

  return {
    id,
    rolloutPath: '',
    sessionFilePath: entry.path,
    cwd: resolvedCwd,
    title: title || firstUserMessage || 'Untitled Claude Session',
    preview: preview || firstUserMessage,
    model: model || 'unknown',
    modelProvider: 'anthropic',
    threadSource: 'claude-code',
    createdAtMs,
    updatedAtMs,
    firstEventAtMs: createdAtMs,
    lastEventAtMs: updatedAtMs,
    archived: false,
    cliVersion: '',
    usage: {
      ...usage,
      totalTokens,
    },
    threadTokensUsed: 0,
    resolvedTotalTokens: totalTokens,
    userMessageCount,
    assistantMessageCount,
    interactionTurns: Math.max(userMessageCount, assistantMessageCount),
    toolCallCount,
    toolBreakdown,
    tokenSamples,
    requestSamples,
    malformedLines,
    eventCount,
    durationMs: Math.max(0, updatedAtMs - createdAtMs),
    usageConflict: false,
  }
}

export async function parseClaudeEntries(
  entries: VirtualFileEntry[],
  sourceType: DashboardData['sourceSummary']['sourceType'],
  detectedPath = '',
  onProgress?: (progress: LoadProgress) => void,
): Promise<DashboardData> {
  const sessionFiles = entries.filter(
    (entry) => entry.path.startsWith('projects/') && entry.path.endsWith('.jsonl'),
  )
  if (sessionFiles.length === 0) {
    throw new Error('没有找到 projects/**/*.jsonl，请确认选择的是完整的 .claude 目录。')
  }

  const sessions: MergedSession[] = []
  for (const [index, entry] of sessionFiles.entries()) {
    onProgress?.({
      phase: '正在解析 Claude Code jsonl',
      processed: index + 1,
      total: sessionFiles.length,
    })
    const session = await parseClaudeSessionFile(entry)
    if (session) {
      sessions.push(session)
    }
  }

  sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs)

  return {
    sessions,
    sourceSummary: {
      parsedAtMs: Date.now(),
      fingerprint: createFingerprint(entries),
      fileCount: entries.length,
      sessionFileCount: sessionFiles.length,
      sessionCount: sessions.length,
      threadCount: 0,
      sourceType,
      provider: 'claude',
      sourceName: 'Claude Code',
      detectedPath,
    },
  }
}

export async function readClaudeEntriesFromFileList(fileList: FileList) {
  const entries: VirtualFileEntry[] = []
  for (const file of Array.from(fileList)) {
    const relativePath = file.webkitRelativePath || file.name
    const projectIndex = relativePath.indexOf('projects/')
    const normalizedPath = projectIndex >= 0 ? relativePath.slice(projectIndex) : relativePath
    if (normalizedPath.startsWith('projects/') && normalizedPath.endsWith('.jsonl')) {
      entries.push({ path: normalizedPath, file })
    }
  }
  return entries
}

export async function readClaudeEntriesFromHandle(handle: FileSystemDirectoryHandle) {
  const entries: VirtualFileEntry[] = []

  async function walk(directory: FileSystemDirectoryHandle, prefix = '') {
    for await (const [name, entry] of directory.entries()) {
      const nextPath = prefix ? `${prefix}/${name}` : name
      if (entry.kind === 'directory') {
        await walk(entry, nextPath)
        continue
      }
      if (nextPath.startsWith('projects/') && nextPath.endsWith('.jsonl')) {
        entries.push({ path: nextPath, file: await entry.getFile() })
      }
    }
  }

  await walk(handle)
  return entries
}
