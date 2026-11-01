import { X } from 'lucide-react'
import type { MergedSession } from '../types'
import { formatCompact, formatCurrency, formatDateTime, formatDuration, formatNumber } from '../lib/format'

interface SessionDetailDrawerProps {
  session: MergedSession | null
  onClose: () => void
}

function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 break-all text-sm text-slate-100">{value}</p>
    </div>
  )
}

export function SessionDetailDrawer({ session, onClose }: SessionDetailDrawerProps) {
  if (!session) {
    return null
  }

  const tools = Object.entries(session.toolBreakdown).sort((left, right) => right[1] - left[1])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="h-full w-full max-w-[560px] overflow-y-auto border-l border-white/10 bg-[#0f1219] shadow-[0_32px_120px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 z-10 border-b border-white/8 bg-[#0f1219]/95 px-6 py-5 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Session Detail</p>
              <h2 className="mt-2 break-words text-xl font-semibold text-white">{session.title}</h2>
              <p className="mt-2 break-all text-xs text-slate-500">{session.id}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-300 transition hover:bg-white/10"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="space-y-6 px-6 py-6">
          <section>
            <h3 className="text-sm font-semibold text-white">核心指标</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <DetailRow label="总 Tokens" value={formatCompact(session.resolvedTotalTokens, 2)} />
              <DetailRow label="估算费用" value={session.rangeCost !== undefined ? formatCurrency(session.rangeCost) : '-'} />
              <DetailRow label="输入（未缓存）" value={formatCompact(session.usage.inputTokens, 2)} />
              <DetailRow label="缓存读取" value={formatCompact(session.usage.cachedInputTokens, 2)} />
              <DetailRow label="缓存写入" value={formatCompact(session.usage.cacheWriteTokens ?? 0, 2)} />
              <DetailRow label="输出（含推理）" value={formatCompact(session.usage.outputTokens, 2)} />
              <DetailRow label="去重剔除" value={`${formatNumber(session.quality?.duplicateRecords ?? 0)} 条 / ${formatCompact(session.quality?.duplicateTokens ?? 0, 2)}`} />
              <DetailRow label="用户消息" value={formatNumber(session.userMessageCount)} />
              <DetailRow label="助手消息" value={formatNumber(session.assistantMessageCount)} />
              <DetailRow label="交互轮次" value={formatNumber(session.interactionTurns)} />
              <DetailRow label="工具调用" value={formatNumber(session.toolCallCount)} />
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-white">会话信息</h3>
            <div className="mt-3 grid gap-3">
              <DetailRow label="模型" value={session.model || 'unknown'} />
              <DetailRow label="项目路径" value={session.cwd || '-'} />
              <DetailRow label="开始时间" value={formatDateTime(session.firstEventAtMs || session.createdAtMs)} />
              <DetailRow label="结束时间" value={formatDateTime(session.lastEventAtMs || session.updatedAtMs)} />
              <DetailRow label="创建时间" value={formatDateTime(session.createdAtMs)} />
              <DetailRow label="最近活跃" value={formatDateTime(session.updatedAtMs)} />
              <DetailRow label="会话时长" value={formatDuration(session.durationMs)} />
              <DetailRow label="原始事件数" value={formatNumber(session.eventCount)} />
              <DetailRow label="Session 文件" value={session.sessionFilePath || '-'} />
              <DetailRow label="归档状态" value={session.archived ? '已归档' : '未归档'} />
              <DetailRow label="子代理" value={session.isSubagent ? '是' : '否'} />
              <DetailRow label="与 sqlite 总数差异 >5%" value={session.usageConflict ? `是（sqlite ${formatCompact(session.threadTokensUsed, 2)}，含继承的父线程历史）` : '否'} />
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-white">工具调用排行</h3>
            <div className="mt-3 space-y-2">
              {tools.length ? (
                tools.map(([name, count]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between gap-4 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm"
                  >
                    <span className="break-all text-slate-200">{name}</span>
                    <span className="shrink-0 text-slate-400">{formatNumber(count)}</span>
                  </div>
                ))
              ) : (
                <p className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-slate-500">
                  这个会话没有工具调用记录。
                </p>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  )
}
