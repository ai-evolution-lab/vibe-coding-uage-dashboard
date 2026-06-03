import type {
  DashboardData,
  LoadProgress,
  LocalApiDetectResult,
  LocalApiFileEntry,
  LocalApiFileListResult,
  MergedSession,
  ProviderType,
  SessionEventSummary,
  VirtualFileEntry,
} from '../types'
import { parseClaudeEntries, parseClaudeSessionFile } from './claude'
import {
  mergeCodexThreadsAndSessions,
  parseCodexEntries,
  parseCodexThreadFile,
  summarizeCodexSessionJsonl,
} from './codex'

function getApiBase() {
  const apiPort = import.meta.env.VITE_LOCAL_API_PORT
  return apiPort ? `http://127.0.0.1:${apiPort}` : ''
}

export function hasLocalApi() {
  return Boolean(import.meta.env.VITE_LOCAL_API_PORT)
}

function ensureLocalApiAvailable() {
  if (!hasLocalApi()) {
    throw new Error('自动识别仅支持通过 npm run start:local、open.command 或 open.bat 启动')
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  ensureLocalApiAvailable()
  const response = await fetch(`${getApiBase()}${url}`)
  if (!response.ok) {
    throw new Error(`本地自动识别服务不可用：HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

async function fetchLocalFile(provider: ProviderType, entry: LocalApiFileEntry) {
  ensureLocalApiAvailable()
  const response = await fetch(
    `${getApiBase()}/api/file?provider=${provider}&path=${encodeURIComponent(entry.path)}`,
  )
  if (!response.ok) {
    throw new Error(`读取 ${entry.path} 失败：HTTP ${response.status}`)
  }
  const blob = await response.blob()
  return new File([blob], entry.path.split('/').pop() || entry.path, {
    lastModified: entry.lastModifiedMs,
  })
}

export async function detectLocalSource(provider: ProviderType) {
  const result = await fetchJson<LocalApiDetectResult>(`/api/detect?provider=${provider}`)
  if (!result.ok) {
    throw new Error(result.message || '没有自动识别到本地数据目录。')
  }
  return result
}

async function loadFileList(
  provider: ProviderType,
  pageSize: number,
  onProgress?: (progress: LoadProgress) => void,
) {
  const allFiles: LocalApiFileEntry[] = []
  let cursor: number | null = 0
  let lastResult: LocalApiFileListResult | null = null

  while (cursor !== null) {
    const pageResult: LocalApiFileListResult = await fetchJson<LocalApiFileListResult>(
      `/api/files?provider=${provider}&cursor=${cursor}&limit=${pageSize}`,
    )
    if (!pageResult.ok) {
      throw new Error(pageResult.message || '自动读取本地文件清单失败。')
    }
    lastResult = pageResult
    allFiles.push(...pageResult.files)
    onProgress?.({
      phase: `正在扫描文件清单 ${allFiles.length}/${pageResult.total}`,
      processed: allFiles.length,
      total: pageResult.total,
    })
    cursor = pageResult.nextCursor
  }

  if (!lastResult) {
    throw new Error('没有读取到本地文件清单。')
  }

  return { result: lastResult, files: allFiles }
}

function fingerprintFromLocalFiles(files: LocalApiFileEntry[]) {
  return files
    .map((entry) => `${entry.path}:${entry.size}:${entry.lastModifiedMs}`)
    .sort()
    .join('|')
}

async function loadCodexDataset(
  files: LocalApiFileEntry[],
  rootPath: string,
  onProgress?: (progress: LoadProgress) => void,
): Promise<DashboardData> {
  const stateEntry = files.find((entry) => entry.path === 'state_5.sqlite')
  if (!stateEntry) {
    throw new Error('没有找到 state_5.sqlite，请确认本机 .codex 目录完整。')
  }

  onProgress?.({ phase: '正在读取 Codex sqlite', processed: 0, total: 1 })
  const stateFile = await fetchLocalFile('codex', stateEntry)
  const threads = await parseCodexThreadFile(stateFile)
  const sessionEntries = files.filter(
    (entry) => entry.path.startsWith('sessions/') && entry.path.endsWith('.jsonl'),
  )
  const sessions: SessionEventSummary[] = []

  for (const [index, entry] of sessionEntries.entries()) {
    onProgress?.({
      phase: `正在分批解析 Codex 会话 ${index + 1}/${sessionEntries.length}`,
      processed: index + 1,
      total: sessionEntries.length,
    })
    const file = await fetchLocalFile('codex', entry)
    const summary = summarizeCodexSessionJsonl(await file.text(), entry.path)
    if (summary) {
      sessions.push(summary)
    }
  }

  const mergedSessions = mergeCodexThreadsAndSessions(threads, sessions)
  return {
    sessions: mergedSessions,
    sourceSummary: {
      parsedAtMs: Date.now(),
      fingerprint: fingerprintFromLocalFiles(files),
      fileCount: files.length,
      sessionFileCount: sessionEntries.length,
      sessionCount: mergedSessions.length,
      threadCount: threads.length,
      sourceType: 'local-api',
      provider: 'codex',
      sourceName: 'Codex',
      detectedPath: rootPath,
    },
  }
}

async function loadClaudeDataset(
  files: LocalApiFileEntry[],
  rootPath: string,
  onProgress?: (progress: LoadProgress) => void,
): Promise<DashboardData> {
  const sessionEntries = files.filter(
    (entry) => entry.path.startsWith('projects/') && entry.path.endsWith('.jsonl'),
  )
  const sessions: MergedSession[] = []

  for (const [index, entry] of sessionEntries.entries()) {
    onProgress?.({
      phase: `正在分批解析 Claude Code 会话 ${index + 1}/${sessionEntries.length}`,
      processed: index + 1,
      total: sessionEntries.length,
    })
    const file = await fetchLocalFile('claude', entry)
    const session = await parseClaudeSessionFile({ path: entry.path, file })
    if (session) {
      sessions.push(session)
    }
  }

  sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs)
  return {
    sessions,
    sourceSummary: {
      parsedAtMs: Date.now(),
      fingerprint: fingerprintFromLocalFiles(files),
      fileCount: files.length,
      sessionFileCount: sessionEntries.length,
      sessionCount: sessions.length,
      threadCount: 0,
      sourceType: 'local-api',
      provider: 'claude',
      sourceName: 'Claude Code',
      detectedPath: rootPath,
    },
  }
}

export async function loadLocalApiDataset(
  provider: ProviderType,
  onProgress?: (progress: LoadProgress) => void,
): Promise<DashboardData> {
  ensureLocalApiAvailable()
  onProgress?.({ phase: '正在调用本地自动识别服务', processed: 0, total: 1 })
  const detected = await detectLocalSource(provider)
  const pageSize = provider === 'claude' ? 50 : 20
  const { files } = await loadFileList(provider, pageSize, onProgress)

  if (provider === 'claude') {
    return loadClaudeDataset(files, detected.rootPath, onProgress)
  }
  return loadCodexDataset(files, detected.rootPath, onProgress)
}

export async function loadLocalApiDatasetCompat(
  provider: ProviderType,
  entries: VirtualFileEntry[],
  rootPath: string,
  onProgress?: (progress: LoadProgress) => void,
) {
  if (provider === 'claude') {
    return parseClaudeEntries(entries, 'local-api', rootPath, onProgress)
  }
  return parseCodexEntries(entries, 'local-api', rootPath, onProgress)
}
