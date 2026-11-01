import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface SparkPoint {
  label: string
  value: number
}

interface StatCardProps {
  title: string
  valuePrimary: string
  valueUnit?: string
  valuePrefix?: string
  hint: string
  icon: LucideIcon
  accentClass: string
  /** 迷你图：固定为最近 N 天，每天一个点，没有用量的日子为 0。 */
  trend: SparkPoint[]
  trendLabel: string
  formatValue: (value: number) => string
}

const WIDTH = 120
const HEIGHT = 36

function Sparkline({
  points,
  formatValue,
  trendLabel,
}: {
  points: SparkPoint[]
  formatValue: (value: number) => string
  trendLabel: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...points.map((point) => point.value), 0)
  if (points.length === 0) {
    return null
  }
  const step = points.length > 1 ? WIDTH / (points.length - 1) : 0
  const y = (value: number) => (max > 0 ? HEIGHT - 3 - (value / max) * (HEIGHT - 6) : HEIGHT - 3)
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${index * step},${y(point.value)}`).join(' ')
  const area = `${path} L${(points.length - 1) * step},${HEIGHT} L0,${HEIGHT} Z`
  const active = hover ?? points.length - 1
  const activePoint = points[active]

  return (
    <div className="w-[120px] shrink-0">
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="overflow-visible text-[#86b6ef]"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = (event.clientX - rect.left) / rect.width
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))))
        }}
      >
        <line x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke="rgba(255,255,255,0.08)" />
        <path d={area} fill="currentColor" opacity="0.12" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={active * step} cy={y(activePoint.value)} r="3.5" fill="currentColor" stroke="#11141b" strokeWidth="2" />
      </svg>
      <p className="mt-1 truncate text-right text-[11px] text-slate-500">
        {hover === null ? trendLabel : activePoint.label}：<span className="text-slate-300">{formatValue(activePoint.value)}</span>
      </p>
    </div>
  )
}

export function StatCard({
  title,
  valuePrimary,
  valueUnit,
  valuePrefix,
  hint,
  icon: Icon,
  accentClass,
  trend,
  trendLabel,
  formatValue,
}: StatCardProps) {
  return (
    <section className="overflow-hidden rounded-2xl border border-white/8 bg-[#11141b] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white ${accentClass}`}>
            <Icon size={18} />
          </div>
          <p className="text-sm text-slate-400">{title}</p>
        </div>
        <Sparkline points={trend} formatValue={formatValue} trendLabel={trendLabel} />
      </div>
      <div className="mt-3 min-w-0">
        <div className="flex min-w-0 items-end gap-1 whitespace-nowrap">
          {valuePrefix ? <span className="pb-1 text-lg font-semibold text-slate-300">{valuePrefix}</span> : null}
          <span className="text-[1.9rem] font-semibold leading-none text-white">{valuePrimary}</span>
          {valueUnit ? <span className="pb-1 text-sm font-medium text-slate-300">{valueUnit}</span> : null}
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">{hint}</p>
      </div>
    </section>
  )
}
