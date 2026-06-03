import type { LucideIcon } from 'lucide-react'
import { formatCompact } from '../lib/format'

interface StatCardProps {
  title: string
  valuePrimary: string
  valueUnit?: string
  valuePrefix?: string
  valueSuffix?: string
  hint: string
  icon: LucideIcon
  accentClass: string
  trend: number[]
}

function TinySparkline({ values }: { values: number[] }) {
  const normalized = values.filter((value) => Number.isFinite(value))
  if (normalized.length === 0) {
    return <div className="h-12 w-28 rounded-full bg-white/5" />
  }

  const width = 96
  const height = 40
  const max = Math.max(...normalized, 1)
  const min = Math.min(...normalized, 0)
  const range = max - min || 1
  const points = normalized
    .map((value, index) => {
      const x = (index / Math.max(normalized.length - 1, 1)) * width
      const y = height - ((value - min) / range) * (height - 6) - 3
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-hidden">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  )
}

export function StatCard({
  title,
  valuePrimary,
  valueUnit,
  valuePrefix,
  valueSuffix,
  hint,
  icon: Icon,
  accentClass,
  trend,
}: StatCardProps) {
  return (
    <section className="overflow-hidden rounded-2xl border border-white/8 bg-[#11141b] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white ${accentClass}`}
          >
            <Icon size={22} />
          </div>
          <div className="min-w-0">
            <p className="text-sm text-slate-400">{title}</p>
          </div>
        </div>
        <div className="w-24 shrink-0 overflow-hidden text-slate-300">
          <TinySparkline values={trend} />
          <p className="mt-1 text-right text-[11px] text-slate-500">
            最近 {formatCompact(trend[trend.length - 1] ?? 0, 1)}
          </p>
        </div>
      </div>
      <div className="mt-4 min-w-0">
        <div className="flex min-w-0 items-end gap-1 whitespace-nowrap">
          {valuePrefix ? <span className="pb-1 text-lg font-semibold text-slate-300">{valuePrefix}</span> : null}
          <span className="text-[1.9rem] font-semibold leading-none tracking-normal text-white">{valuePrimary}</span>
          {valueUnit ? <span className="pb-1 text-sm font-medium text-slate-300">{valueUnit}</span> : null}
          {valueSuffix ? <span className="pb-1 text-sm font-medium text-slate-400">{valueSuffix}</span> : null}
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">{hint}</p>
      </div>
    </section>
  )
}
