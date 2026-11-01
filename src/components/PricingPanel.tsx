import { useMemo, useState } from 'react'
import { CloudDownload, Search, Trash2 } from 'lucide-react'
import type { PriceRule, PricingCatalog } from '../types'
import { formatDateTime, formatNumber } from '../lib/format'
import { resolvePrice, searchCatalog } from '../lib/pricing'
import type { MatchKind, PricingIndex } from '../lib/pricing'

interface PricingPanelProps {
  catalog: PricingCatalog
  pricing: PricingIndex
  usedModels: string[]
  updating: boolean
  updateMessage: string
  autoUpdate: boolean
  onAutoUpdateChange: (value: boolean) => void
  onUpdate: () => void
  onOverridesChange: (overrides: PriceRule[]) => void
}

const MATCH_LABELS: Record<MatchKind, string> = {
  custom: '自定义',
  exact: '精确匹配',
  normalized: '名称归一',
  prefix: '前缀匹配',
  alias: '别名',
}

const PRICE_FIELDS: Array<[keyof PriceRule, string]> = [
  ['inputPerMillion', '输入'],
  ['cachedInputPerMillion', '缓存读'],
  ['cacheWritePerMillion', '缓存写'],
  ['outputPerMillion', '输出'],
]

function formatPrice(value: number | undefined) {
  if (value === undefined) return '-'
  return `$${formatNumber(value, value < 1 ? 3 : 2)}`
}

export function PricingPanel({
  catalog,
  pricing,
  usedModels,
  updating,
  updateMessage,
  autoUpdate,
  onAutoUpdateChange,
  onUpdate,
  onOverridesChange,
}: PricingPanelProps) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  const usedRows = useMemo(
    () => usedModels.map((model) => ({ model, resolved: resolvePrice(model, pricing) })),
    [pricing, usedModels],
  )
  const searchRows = useMemo(() => searchCatalog(catalog, query), [catalog, query])

  function upsertOverride(model: string, base: PriceRule | undefined) {
    const existing = catalog.overrides.find((rule) => rule.model === model)
    if (existing) {
      setEditing(model)
      return
    }
    onOverridesChange([
      ...catalog.overrides,
      {
        model,
        inputPerMillion: base?.inputPerMillion ?? 0,
        cachedInputPerMillion: base?.cachedInputPerMillion ?? 0,
        cacheWritePerMillion: base?.cacheWritePerMillion ?? 0,
        outputPerMillion: base?.outputPerMillion ?? 0,
        source: 'custom',
      },
    ])
    setEditing(model)
  }

  function updateOverride(model: string, key: keyof PriceRule, value: number) {
    onOverridesChange(catalog.overrides.map((rule) => (rule.model === model ? { ...rule, [key]: value } : rule)))
  }

  function removeOverride(model: string) {
    onOverridesChange(catalog.overrides.filter((rule) => rule.model !== model))
    setEditing(null)
  }

  return (
    <section className="rounded-2xl border border-white/8 bg-[#11141b]">
      <header className="flex flex-col gap-4 border-b border-white/8 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">价格表</h2>
          <p className="mt-1 text-xs text-slate-400">
            {catalog.source} · {formatNumber(catalog.rules.length)} 个模型 · 更新于 {formatDateTime(catalog.updatedAtMs)}
            {catalog.overrides.length ? ` · ${catalog.overrides.length} 条自定义` : ''}
          </p>
          {updateMessage ? <p className="mt-1 text-xs text-slate-300">{updateMessage}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={autoUpdate} onChange={(event) => onAutoUpdateChange(event.target.checked)} />
            每天自动更新
          </label>
          <button
            type="button"
            onClick={onUpdate}
            disabled={updating}
            className="inline-flex items-center gap-2 rounded-full bg-[#2a78d6] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#3987e5] disabled:opacity-50"
          >
            <CloudDownload size={16} className={updating ? 'animate-pulse' : ''} />
            {updating ? '更新中…' : '一键更新价格'}
          </button>
        </div>
      </header>

      <div className="px-5 py-4">
        <p className="text-xs text-slate-500">
          价格来自 LiteLLM（主）和 models.dev（补充），单位为美元 / 百万 tokens。下表是当前数据里用到的模型；点“覆盖”可手动改价，更新价格时不会覆盖你的修改。
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">本地模型名</th>
                <th className="py-2 pr-4 font-medium">匹配到</th>
                {PRICE_FIELDS.map(([, label]) => (
                  <th key={label} className="py-2 pr-4 text-right font-medium">{label}</th>
                ))}
                <th className="py-2 pr-4 font-medium">长上下文</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {usedRows.map(({ model, resolved }) => {
                const override = catalog.overrides.find((rule) => rule.model === model)
                const isEditing = editing === model && override
                const rule = override ?? resolved?.rule
                return (
                  <tr key={model} className="border-t border-white/6 align-top">
                    <td className="py-2.5 pr-4 text-slate-200">{model}</td>
                    <td className="py-2.5 pr-4 text-xs">
                      {resolved ? (
                        <span className="text-slate-400">
                          {resolved.matchedModel}
                          <span className="ml-1.5 rounded bg-white/6 px-1.5 py-0.5 text-[11px] text-slate-400">
                            {MATCH_LABELS[override ? 'custom' : resolved.matchedBy]}
                          </span>
                        </span>
                      ) : (
                        <span className="text-[#fab219]">未匹配，按 $0 计</span>
                      )}
                    </td>
                    {PRICE_FIELDS.map(([key]) => (
                      <td key={key} className="py-2.5 pr-4 text-right text-slate-200">
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            step="0.001"
                            value={override[key] as number}
                            onChange={(event) => updateOverride(model, key, Number(event.target.value || 0))}
                            className="w-20 rounded-lg border border-white/10 bg-[#0d1016] px-2 py-1 text-right text-sm text-white outline-none"
                          />
                        ) : (
                          formatPrice(rule?.[key] as number | undefined)
                        )}
                      </td>
                    ))}
                    <td className="py-2.5 pr-4 text-xs text-slate-400">
                      {rule?.tier ? `>${formatNumber(rule.tier.thresholdTokens / 1000)}k 输入 ${formatPrice(rule.tier.inputPerMillion)}` : '-'}
                    </td>
                    <td className="py-2.5 text-right">
                      {override ? (
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={() => setEditing(isEditing ? null : model)} className="text-xs text-[#86b6ef] hover:text-white">
                            {isEditing ? '完成' : '编辑'}
                          </button>
                          <button type="button" onClick={() => removeOverride(model)} className="text-slate-500 hover:text-rose-300" title="删除自定义价格">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => upsertOverride(model, resolved?.rule)} className="text-xs text-[#86b6ef] hover:text-white">
                          覆盖
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {usedRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-sm text-slate-500">载入数据后显示用到的模型。</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <label className="mt-5 flex items-center gap-3 rounded-xl border border-white/10 bg-[#0d1016] px-4 py-2.5 text-sm text-slate-300">
          <Search size={15} className="shrink-0 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="在完整价格库里搜索，例如 opus 5.5 / gpt 5.6 sol（不区分大小写、空格和点）"
            className="w-full bg-transparent outline-none placeholder:text-slate-600"
          />
        </label>
        {query.trim().length >= 2 && searchRows.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">价格库里没有匹配的模型。新模型发布后点“一键更新价格”再搜。</p>
        ) : null}
        {searchRows.length ? (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-sm tabular-nums">
              <tbody>
                {searchRows.map((rule) => (
                  <tr key={rule.model} className="border-t border-white/6">
                    <td className="py-2 pr-4 text-slate-200">{rule.model}</td>
                    {PRICE_FIELDS.map(([key]) => (
                      <td key={key} className="py-2 pr-4 text-right text-slate-400">{formatPrice(rule[key] as number)}</td>
                    ))}
                    <td className="py-2 text-xs text-slate-500">{rule.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  )
}
