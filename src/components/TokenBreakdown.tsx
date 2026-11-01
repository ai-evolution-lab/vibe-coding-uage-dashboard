import type { CostBreakdown } from '../types'
import { formatCompact, formatCurrency, formatPercent } from '../lib/format'

interface TokenBreakdownProps {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  cost: CostBreakdown
}

const SEGMENTS = [
  { key: 'input', label: '输入（未缓存）', color: '#3987e5' },
  { key: 'cachedInput', label: '缓存读取', color: '#199e70' },
  { key: 'cacheWrite', label: '缓存写入', color: '#c98500' },
  { key: 'output', label: '输出（含推理）', color: '#d55181' },
] as const

export function TokenBreakdown({ inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, cost }: TokenBreakdownProps) {
  const tokens = { input: inputTokens, cachedInput: cachedInputTokens, cacheWrite: cacheWriteTokens, output: outputTokens }
  const total = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
  const totalCost = cost.input + cost.cachedInput + cost.cacheWrite + cost.output

  return (
    <section className="rounded-2xl border border-white/8 bg-[#11141b] px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Tokens 与费用构成</h2>
        <p className="text-xs text-slate-500">四段互不重叠，相加等于总 Tokens；每段按各自单价计费</p>
      </div>
      <div className="mt-4 flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-white/5">
        {SEGMENTS.map((segment) => {
          const share = total > 0 ? tokens[segment.key] / total : 0
          return share > 0 ? (
            <div
              key={segment.key}
              title={`${segment.label} ${formatPercent(share)}`}
              style={{ width: `${share * 100}%`, backgroundColor: segment.color }}
            />
          ) : null
        })}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SEGMENTS.map((segment) => {
          const share = total > 0 ? tokens[segment.key] / total : 0
          const costShare = totalCost > 0 ? cost[segment.key] / totalCost : 0
          return (
            <div key={segment.key} className="rounded-xl border border-white/6 bg-white/[0.02] px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: segment.color }} />
                {segment.label}
              </div>
              <p className="mt-2 text-lg font-semibold text-white">{formatCompact(tokens[segment.key], 2)}</p>
              <p className="mt-1 text-xs text-slate-500">
                占 Tokens {formatPercent(share)} · 费用 {formatCurrency(cost[segment.key])}（{formatPercent(costShare)}）
              </p>
            </div>
          )
        })}
      </div>
    </section>
  )
}
