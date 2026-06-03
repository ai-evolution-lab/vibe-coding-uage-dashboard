import type { MetricSnapshot, MergedSession, ProviderType } from '../types'
import { slugifyDate } from './format'

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function escapeCsv(value: string | number | boolean) {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}

export function exportSessionsCsv(sessions: MergedSession[], provider: ProviderType = 'codex') {
  const headers = [
    'id',
    'title',
    'model',
    'cwd',
    'createdAt',
    'updatedAt',
    'resolvedTotalTokens',
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'toolCallCount',
    'userMessageCount',
    'assistantMessageCount',
    'interactionTurns',
    'durationMs',
    'archived',
  ]
  const lines = [
    headers.join(','),
    ...sessions.map((session) =>
      [
        session.id,
        session.title,
        session.model,
        session.cwd,
        new Date(session.createdAtMs).toISOString(),
        new Date(session.updatedAtMs).toISOString(),
        session.resolvedTotalTokens,
        session.usage.inputTokens,
        session.usage.cachedInputTokens,
        session.usage.outputTokens,
        session.toolCallCount,
        session.userMessageCount,
        session.assistantMessageCount,
        session.interactionTurns,
        session.durationMs,
        session.archived,
      ]
        .map(escapeCsv)
        .join(','),
    ),
  ]

  downloadBlob(
    `vibe-coding-usage-dashboard-${provider}-sessions-${slugifyDate(new Date())}.csv`,
    new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
  )
}

export function exportMetricsJson(snapshot: MetricSnapshot, provider: ProviderType = 'codex') {
  const payload = {
    exportedAt: new Date().toISOString(),
    summary: {
      totalTokens: snapshot.totalTokens,
      estimatedCost: snapshot.estimatedCost,
      sessionCount: snapshot.sessionCount,
      toolCalls: snapshot.toolCalls,
      avgRpm: snapshot.avgRpm,
      avgTpm: snapshot.avgTpm,
    },
    filters: snapshot.filters,
    trend: snapshot.trend,
    modelRanks: snapshot.modelRanks,
    projectRanks: snapshot.projectRanks,
    toolRanks: snapshot.toolRanks,
  }

  downloadBlob(
    `vibe-coding-usage-dashboard-${provider}-metrics-${slugifyDate(new Date())}.json`,
    new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    }),
  )
}
