// 生成内置价格快照：拉取 LiteLLM（主）和 models.dev（补充），规范化后写入 src/data/pricing-snapshot.json。
// 离线时看板使用这份快照；在线时页面里的“一键更新价格”会拉取最新数据。
// 用法：npm run update:pricing
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  LITELLM_PRICING_URL,
  MODELS_DEV_URL,
  mergeRules,
  normalizeLiteLLM,
  normalizeModelsDev,
} from '../src/lib/pricingSource.ts'

const outputPath = path.resolve(path.dirname(process.argv[1]), '../src/data/pricing-snapshot.json')

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    throw new Error(`${url} 下载失败：HTTP ${response.status}`)
  }
  return response.json()
}

const litellm = normalizeLiteLLM(await fetchJson(LITELLM_PRICING_URL))
let modelsDev = []
try {
  modelsDev = normalizeModelsDev(await fetchJson(MODELS_DEV_URL))
} catch (error) {
  console.warn(`models.dev 拉取失败，仅使用 LiteLLM：${error.message}`)
}
const rules = mergeRules(litellm, modelsDev).map((rule) =>
  Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== undefined)),
)
await writeFile(
  outputPath,
  `${JSON.stringify({ version: 2, updatedAtMs: Date.now(), source: 'litellm+models.dev', rules })}\n`,
)
console.log(`已写入 ${rules.length} 个模型价格（LiteLLM ${litellm.length} / models.dev ${modelsDev.length}）-> ${outputPath}`)
