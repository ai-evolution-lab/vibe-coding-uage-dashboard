import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react'
import type { MetricSnapshot } from '../types'
import { formatCompact, formatNumber, formatPercent } from '../lib/format'

interface DataQualityPanelProps {
  snapshot: MetricSnapshot
}

type Level = 'ok' | 'warn'

function Row({ level, label, value, hint }: { level: Level; label: string; value: string; hint: string }) {
  const Icon = level === 'ok' ? CheckCircle2 : AlertTriangle
  return (
    <div className="flex items-start gap-3 border-t border-white/6 py-3 first:border-t-0">
      <Icon size={16} className={`mt-0.5 shrink-0 ${level === 'ok' ? 'text-[#0ca30c]' : 'text-[#fab219]'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-slate-200">{label}</span>
          <span className="shrink-0 text-sm text-white">{value}</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>
      </div>
    </div>
  )
}

export function DataQualityPanel({ snapshot }: DataQualityPanelProps) {
  const { quality } = snapshot
  const duplicateShare = quality.rawUsageRecords > 0 ? quality.duplicateRecords / quality.rawUsageRecords : 0
  const inputSide = snapshot.inputTokens + snapshot.cachedInputTokens + snapshot.cacheWriteTokens
  const cacheShare = inputSide > 0 ? snapshot.cachedInputTokens / inputSide : 0
  const naiveTotal = snapshot.totalTokens + quality.duplicateTokens

  return (
    <section className="rounded-2xl border border-white/8 bg-[#11141b] px-5 py-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#0ca30c]/15 text-[#5fd35f]">
          <ShieldCheck size={18} />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">数据质量</h2>
          <p className="mt-1 text-xs text-slate-400">判断统计是否可信，以及和其他工具对不上的原因。</p>
        </div>
      </div>

      <div className="mt-4">
        <Row
          level="ok"
          label="去重"
          value={`剔除 ${formatNumber(quality.duplicateRecords)} 条 / ${formatPercent(duplicateShare)}`}
          hint={`原始记录 ${formatNumber(quality.rawUsageRecords)} 条，计入 ${formatNumber(quality.countedUsageRecords)} 条。不去重时总量会是 ${formatCompact(naiveTotal, 2)}，多出 ${formatCompact(quality.duplicateTokens, 2)}（流式分块、重复事件、子代理继承的父线程历史）。`}
        />
        <Row
          level={quality.invariantViolations === 0 ? 'ok' : 'warn'}
          label="字段一致性"
          value={quality.invariantViolations === 0 ? '通过' : `${formatNumber(quality.invariantViolations)} 条异常`}
          hint="检查 缓存 ≤ 输入、推理 ≤ 输出、1 小时缓存 ≤ 缓存写入。异常说明日志格式变了，需要更新解析规则。"
        />
        <Row
          level={snapshot.unpricedModels.length === 0 ? 'ok' : 'warn'}
          label="价格覆盖"
          value={snapshot.unpricedModels.length === 0 ? '全部模型有价格' : `${snapshot.unpricedModels.length} 个模型无价格`}
          hint={
            snapshot.unpricedModels.length === 0
              ? '所有请求都匹配到了价格。'
              : `${snapshot.unpricedModels.join('、')} 共 ${formatCompact(snapshot.unpricedTokens, 2)} tokens 未计入费用。可在价格表里点“更新价格”或手动添加。`
          }
        />
        {quality.totalOnlyTokens > 0 ? (
          <Row
            level="warn"
            label="仅有总数的会话"
            value={formatCompact(quality.totalOnlyTokens, 2)}
            hint="这些会话只在 sqlite 里有总数，没有找到会话文件，无法拆分输入输出，也不计入费用。"
          />
        ) : null}
        <Row
          level="ok"
          label="缓存读取占输入"
          value={formatPercent(cacheShare)}
          hint="编程场景通常在 80%–95%。别的工具算出来的总量和这里差很多时，先看对方是否把缓存读取算进了总数。"
        />
        <Row
          level="ok"
          label="长上下文分档"
          value={`${formatNumber(snapshot.tieredRequests)} 次请求`}
          hint="单次请求上下文超过模型分档阈值（如 GPT 272k）时，整次请求按高档价计费。"
        />
        {quality.compressedFiles > 0 ? (
          <Row
            level="ok"
            label="压缩会话文件"
            value={`${formatNumber(quality.compressedFiles)} 个`}
            hint="Codex 会把旧会话压缩成 .jsonl.zst，已在本地解压后统计。"
          />
        ) : null}
      </div>
    </section>
  )
}
