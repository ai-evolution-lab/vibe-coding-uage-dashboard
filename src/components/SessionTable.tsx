import { FolderOpen, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { MergedSession } from '../types'
import { compactPath, formatCompact, formatCurrency, formatDateTime, formatDuration, trimText } from '../lib/format'

interface SessionTableProps {
  sessions: MergedSession[]
  searchValue: string
  onSearchChange: (value: string) => void
  onSelectSession?: (session: MergedSession) => void
  activeProject?: string
  onClearProject?: () => void
}

type SortKey = 'updatedAtMs' | 'resolvedTotalTokens' | 'rangeCost' | 'toolCallCount' | 'durationMs'

function getProjectLeaf(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path || '-'
}

function getDisplayTokens(session: MergedSession) {
  return session.rangeTotalTokens ?? session.resolvedTotalTokens
}

export function SessionTable({
  sessions,
  searchValue,
  onSearchChange,
  onSelectSession,
  activeProject,
  onClearProject,
}: SessionTableProps) {
  const [page, setPage] = useState(1)
  const [sortKey, setSortKey] = useState<SortKey>('updatedAtMs')
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc')

  const pageSize = 12

  const sortedSessions = useMemo(() => {
    const next = [...sessions]
    next.sort((left, right) => {
      const multiplier = sortDirection === 'desc' ? -1 : 1
      const leftValue = sortKey === 'resolvedTotalTokens' ? getDisplayTokens(left) : (left[sortKey] ?? 0)
      const rightValue = sortKey === 'resolvedTotalTokens' ? getDisplayTokens(right) : (right[sortKey] ?? 0)
      return leftValue > rightValue ? multiplier : leftValue < rightValue ? -multiplier : 0
    })
    return next
  }, [sessions, sortDirection, sortKey])

  const pageCount = Math.max(1, Math.ceil(sortedSessions.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const visible = sortedSessions.slice((safePage - 1) * pageSize, safePage * pageSize)

  function changeSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'))
      return
    }
    setSortKey(nextKey)
    setSortDirection('desc')
  }

  return (
    <section className="rounded-2xl border border-white/8 bg-[#11141b] shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
      <header className="flex items-center justify-between border-b border-white/8 px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white">会话明细</h3>
          <p className="mt-1 text-xs text-slate-400">支持标题模糊搜索、排序、分页和点击查看详情。</p>
          {activeProject ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-[#4f7cff]/30 bg-[#4f7cff]/10 px-3 py-1 text-xs text-[#b6c8ff]"
                title={activeProject}
              >
                <FolderOpen size={13} className="shrink-0" />
                <span className="truncate">当前项目：{getProjectLeaf(activeProject)}</span>
              </span>
              {onClearProject ? (
                <button
                  type="button"
                  onClick={onClearProject}
                  className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 transition hover:bg-white/10"
                >
                  <X size={13} />
                  返回全部项目
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="text-xs text-slate-500">
          共 {sortedSessions.length} 条 / 第 {safePage} 页
        </p>
      </header>
      <div className="border-b border-white/8 px-5 py-4">
        <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#0d1016] px-4 py-3 text-sm text-slate-300">
          <Search size={16} className="shrink-0 text-slate-500" />
          <input
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="标题模糊搜索，也支持 title: project: model: tool: id:"
            className="w-full bg-transparent outline-none placeholder:text-slate-600"
          />
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="bg-white/[0.02] text-slate-400">
            <tr>
              <th className="px-5 py-3 font-medium">会话</th>
              <th className="px-5 py-3 font-medium">模型</th>
              <th className="px-5 py-3 font-medium">项目</th>
              <th className="px-5 py-3 font-medium">
                <button type="button" onClick={() => changeSort('updatedAtMs')} className="cursor-pointer">
                  最近活跃
                </button>
              </th>
              <th className="px-5 py-3 font-medium">
                <button
                  type="button"
                  onClick={() => changeSort('resolvedTotalTokens')}
                  className="cursor-pointer"
                >
                  Tokens
                </button>
              </th>
              <th className="px-5 py-3 font-medium">
                <button type="button" onClick={() => changeSort('rangeCost')} className="cursor-pointer">
                  费用
                </button>
              </th>
              <th className="px-5 py-3 font-medium">
                <button type="button" onClick={() => changeSort('toolCallCount')} className="cursor-pointer">
                  工具调用
                </button>
              </th>
              <th className="px-5 py-3 font-medium">
                <button type="button" onClick={() => changeSort('durationMs')} className="cursor-pointer">
                  时长
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((session) => (
              <tr
                key={session.id}
                className="cursor-pointer border-t border-white/6 text-slate-200 transition hover:bg-white/[0.03]"
                onClick={() => onSelectSession?.(session)}
              >
                <td className="px-5 py-4 align-top">
                  <div className="max-w-[320px]">
                    <p className="font-medium text-white">{trimText(session.title, 42)}</p>
                    <p className="mt-1 text-xs text-slate-500">{trimText(session.preview, 72) || session.id}</p>
                    <p className="mt-2 text-[11px] text-slate-600">{session.id}</p>
                  </div>
                </td>
                <td className="px-5 py-4 align-top text-slate-300">
                  {session.model}
                  {session.isSubagent ? <span className="ml-1.5 rounded bg-white/6 px-1.5 py-0.5 text-[11px] text-slate-400">子代理</span> : null}
                </td>
                <td className="px-5 py-4 align-top text-slate-400" title={session.cwd || '-'}>
                  <div className="max-w-[360px] text-xs leading-5 text-slate-400">
                    {compactPath(session.cwd || '-', 72)}
                  </div>
                </td>
                <td className="px-5 py-4 align-top text-slate-300">{formatDateTime(session.updatedAtMs)}</td>
                <td className="px-5 py-4 align-top text-white">{formatCompact(getDisplayTokens(session), 2)}</td>
                <td className="px-5 py-4 align-top text-slate-300">{formatCurrency(session.rangeCost ?? 0)}</td>
                <td className="px-5 py-4 align-top text-slate-300">{session.toolCallCount}</td>
                <td className="px-5 py-4 align-top text-slate-300">{formatDuration(session.durationMs)}</td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-sm text-slate-500">
                  当前筛选条件下没有数据。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <footer className="flex items-center justify-between border-t border-white/8 px-5 py-4 text-xs text-slate-500">
        <span>点击表头排序</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-full border border-white/10 px-3 py-1 text-slate-300 disabled:opacity-40"
            disabled={safePage <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            上一页
          </button>
          <button
            type="button"
            className="rounded-full border border-white/10 px-3 py-1 text-slate-300 disabled:opacity-40"
            disabled={safePage >= pageCount}
            onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
          >
            下一页
          </button>
        </div>
      </footer>
    </section>
  )
}
