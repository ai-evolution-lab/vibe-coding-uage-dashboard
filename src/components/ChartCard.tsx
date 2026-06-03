import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'

interface ChartClickParams {
  componentType?: string
  dataIndex?: number
  name?: string
  value?: unknown
}

interface ChartCardProps {
  title: string
  subtitle?: string
  option: EChartsOption
  height?: number
  headerActions?: ReactNode
  onChartClick?: (params: ChartClickParams) => void
}

export function ChartCard({
  title,
  subtitle,
  option,
  height = 320,
  headerActions,
  onChartClick,
}: ChartCardProps) {
  const chartRef = useRef<HTMLDivElement | null>(null)

  const mergedOption = useMemo<EChartsOption>(
    () => ({
      backgroundColor: 'transparent',
      textStyle: {
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      },
      tooltip: {
        backgroundColor: '#14161d',
        borderColor: '#2c3240',
        textStyle: {
          color: '#f5f7fb',
        },
      },
      animationDuration: 400,
      ...option,
    }),
    [option],
  )

  useEffect(() => {
    if (!chartRef.current) {
      return
    }

    const instance = echarts.init(chartRef.current, undefined, {
      renderer: 'canvas',
    })
    instance.setOption(mergedOption)
    if (onChartClick) {
      instance.on('click', onChartClick)
    }

    const resizeObserver = new ResizeObserver(() => {
      instance.resize()
    })
    resizeObserver.observe(chartRef.current)

    return () => {
      resizeObserver.disconnect()
      instance.dispose()
    }
  }, [mergedOption, onChartClick])

  return (
    <section className="overflow-hidden rounded-2xl border border-white/8 bg-[#11141b] shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
      <header className="flex items-center justify-between border-b border-white/8 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold tracking-normal text-white">{title}</h3>
          {subtitle ? <p className="mt-1 text-xs text-slate-400">{subtitle}</p> : null}
        </div>
        {headerActions ? <div className="shrink-0">{headerActions}</div> : null}
      </header>
      <div ref={chartRef} style={{ height }} className="w-full overflow-hidden px-3 py-3" />
    </section>
  )
}
