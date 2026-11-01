import type {
  DashboardData,
  LoadProgress,
  MergedSession,
  RequestSample,
  TokenSample,
  TokenUsage,
  VirtualFileEntry,
} from '../types'
import { createFingerprint, getString, parseEventTimestamp, takeTextFromMessageContent } from './codex'
import { addUsage, asNumber, createEmptyQuality, createEmptyUsage, sumUsageParts } from './usage'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Claude Code 的 usage 字段：input_tokens 只含未缓存输入，cache_read / cache_creation 单独计。
 * cache_creation.ephemeral_1h_input_tokens 是 1 小时缓存写入，价格高于 5 分钟缓存。
 */
export function normalizeClaudeUsage(raw: Record<string, unknown>): TokenUsage {
  const cacheCreation = asRecord(raw.cache_creation)
  const usage: TokenUsage = {
    inputTokens: asNumber(raw.input_tokens),
    cachedInputTokens: asNumber(raw.cache_read_input_tokens),
    cacheWriteTokens: asNumber(raw.cache_creation_input_tokens),
    cacheWrite1hTokens: asNumber(cacheCreation?.ephemeral_1h_input_tokens),
    outputTokens: asNumber(raw.output_tokens),
    reasoningOutputTokens: 0,
    totalTokens: 0,
  }
  usage.totalTokens = sumUsageParts(usage)
  return usage
}

/** 同一条回复在流式写入时会产生多行，按 message.id + requestId 去重（与 ccusage 一致）。 */
export function getClaudeDedupKey(parsed: Record<string, unknown>, message: Record<string, unknown> | null) {
  const messageId = getString(message?.id)
  if (!messageId) {
    return ''
  }
  const requestId = getString(parsed.requestId)
  return requestId ? `${messageId}:${requestId}` : messageId
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

export async function parseClaudeSessionFile(
  entry: VirtualFileEntry,
  seenKeys: Set<string> = new Set(),
): Promise<MergedSession | null> {
  const text = await entry.file.text()
  return parseClaudeSessionText(text, entry.path, entry.file.lastModified, seenKeys)
}

export function parseClaudeSessionText(
  text: string,
  entryPath: string,
  lastModifiedMs: number,
  seenKeys: Set<string>,
): MergedSession | null {
  const lines = text.split('\n')
  const usage = createEmptyUsage()
  const quality = createEmptyQuality()
  const isSubagent = entryPath.includes('/subagents/')
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

    // <synthetic> 是 Claude Code 本地生成的占位消息（如中断提示），没有真实用量。
    const messageModel = getString(message?.model)
    if (messageModel && messageModel !== '<synthetic>') {
      model = messageModel
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
      const rawUsage = asRecord(message?.usage)
      let isDuplicate = false
      if (rawUsage) {
        const sampleUsage = normalizeClaudeUsage(rawUsage)
        quality.rawUsageRecords += 1
        const dedupKey = getClaudeDedupKey(parsed, message)
        isDuplicate = Boolean(dedupKey) && seenKeys.has(dedupKey)
        if (isDuplicate) {
          quality.duplicateRecords += 1
          quality.duplicateTokens += sampleUsage.totalTokens
        } else {
          if (dedupKey) {
            seenKeys.add(dedupKey)
          }
          quality.countedUsageRecords += 1
          if (sampleUsage.cacheWrite1hTokens > sampleUsage.cacheWriteTokens) {
            quality.invariantViolations += 1
          }
          addUsage(usage, sampleUsage)
          if (timestampMs > 0 && sampleUsage.totalTokens > 0) {
            tokenSamples.push({
              ...sampleUsage,
              timestampMs,
              contextTokens: sampleUsage.inputTokens + sampleUsage.cachedInputTokens + sampleUsage.cacheWriteTokens,
              model: messageModel,
            })
          }
        }
      }
      if (!isDuplicate) {
        assistantMessageCount += 1
        requestSamples.push({ timestampMs, kind: 'assistant' })
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

      const serverToolUse = isDuplicate ? null : asRecord(rawUsage?.server_tool_use)
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

  const fileId = entryPath.split('/').pop()?.replace('.jsonl', '') || entryPath
  // 子代理文件与父会话共用 sessionId，用文件名区分，避免会话被合并。
  id = isSubagent ? `${id || 'subagent'}:${fileId}` : id || fileId
  const createdAtMs = firstEventAtMs || lastEventAtMs || lastModifiedMs
  const updatedAtMs = lastEventAtMs || createdAtMs
  const resolvedCwd = cwd || makeProjectFromPath(entryPath) || 'unknown'
  const totalTokens = usage.totalTokens

  if (!id) {
    return null
  }

  return {
    id,
    rolloutPath: '',
    sessionFilePath: entryPath,
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
    usage,
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
    quality,
    isSubagent,
  }
}

/** 主会话先于子代理解析，重复记录归属到主会话。 */
export function sortClaudeEntries<T extends { path: string }>(entries: T[]) {
  return entries.sort((left, right) => {
    const leftSub = left.path.includes('/subagents/') ? 1 : 0
    const rightSub = right.path.includes('/subagents/') ? 1 : 0
    return leftSub - rightSub || left.path.localeCompare(right.path)
  })
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
  const seenKeys = new Set<string>()
  sortClaudeEntries(sessionFiles)
  for (const [index, entry] of sessionFiles.entries()) {
    onProgress?.({
      phase: '正在解析 Claude Code jsonl',
      processed: index + 1,
      total: sessionFiles.length,
    })
    const session = await parseClaudeSessionFile(entry, seenKeys)
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
