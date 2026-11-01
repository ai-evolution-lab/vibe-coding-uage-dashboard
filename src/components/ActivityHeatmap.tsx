import { useMemo } from 'react'
import type { DailyActivity } from '../types'
import { formatCompact, formatCurrency } from '../lib/format'

interface ActivityHeatmapProps {
  daily: DailyActivity[]
  weeks?: number
}

// 单色蓝阶（深色背景），从暗到亮表示用量从低到高。
const STEPS = ['#1e2330', '#184f95', '#256abf', '#3987e5', '#86b6ef']

function dayKey(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function ActivityHeatmap({ daily, weeks = 53 }: ActivityHeatmapProps) {
  const { columns, max, activeDays } = useMemo(() => {
    const byDay = new Map(daily.map((item) => [item.day, item]))
    const today = new Date()
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const start = new Date(end)
    start.setDate(start.getDate() - (weeks * 7 - 1) - end.getDay())
    const cells: Array<{ key: string; item?: DailyActivity; future: boolean }> = []
    for (const cursor = new Date(start); cursor <= end || cursor.getDay() !== 0; cursor.setDate(cursor.getDate() + 1)) {
      const key = dayKey(cursor)
      cells.push({ key, item: byDay.get(key), future: cursor > end })
    }
    const nextColumns: (typeof cells)[] = []
    for (let index = 0; index < cells.length; index += 7) {
      nextColumns.push(cells.slice(index, index + 7))
    }
    const values = cells.map((cell) => cell.item?.totalTokens ?? 0)
    return {
      columns: nextColumns,
      max: Math.max(...values, 1),
      activeDays: values.filter((value) => value > 0).length,
    }
  }, [daily, weeks])

  function stepFor(value: number) {
    if (value <= 0) return STEPS[0]
    const ratio = Math.sqrt(value / max)
    return STEPS[Math.min(STEPS.length - 1, 1 + Math.floor(ratio * (STEPS.length - 1)))]
  }

  return (
    <section className="rounded-2xl border border-white/8 bg-[#11141b] px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">每日活跃</h2>
        <p className="text-xs text-slate-500">
          近一年活跃 {activeDays} 天 · 不受时间筛选影响 · 颜色越亮用量越高
        </p>
      </div>
      <div className="mt-4 overflow-x-auto">
        <div className="flex gap-[3px]">
          {columns.map((column, columnIndex) => (
            <div key={columnIndex} className="flex flex-col gap-[3px]">
              {column.map((cell) => (
                <div
                  key={cell.key}
                  className="h-3 w-3 rounded-[3px]"
                  style={{ backgroundColor: cell.future ? 'transparent' : stepFor(cell.item?.totalTokens ?? 0) }}
                  title={
                    cell.future
                      ? ''
                      : `${cell.key}：${formatCompact(cell.item?.totalTokens ?? 0, 2)} tokens · ${formatCurrency(cell.item?.estimatedCost ?? 0)} · ${cell.item?.sessions ?? 0} 个会话`
                  }
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1 text-[11px] text-slate-500">
        少
        {STEPS.map((color) => (
          <span key={color} className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: color }} />
        ))}
        多
      </div>
    </section>
  )
}
