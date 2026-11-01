import { deleteDB, openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { CacheRecord, DashboardData, PricingCatalog, ProviderType } from '../types'

/** 解析规则变化时递增，旧缓存会被丢弃并重新解析。 */
export const CACHE_SCHEMA_VERSION = 3

interface CodexDashboardDB extends DBSchema {
  handles: {
    key: string
    value: FileSystemDirectoryHandle
  }
  cache: {
    key: string
    value: CacheRecord
  }
  settings: {
    key: string
    value: unknown
  }
}

let dbPromise: Promise<IDBPDatabase<CodexDashboardDB>> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<CodexDashboardDB>('vibe-coding-usage-dashboard', 1, {
      upgrade(db) {
        db.createObjectStore('handles')
        db.createObjectStore('cache')
        db.createObjectStore('settings')
      },
    })
  }
  return dbPromise
}

function providerKey(provider: ProviderType, key: string) {
  return `${provider}-${key}`
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle, provider: ProviderType) {
  const db = await getDb()
  await db.put('handles', handle, providerKey(provider, 'root'))
}

export async function loadDirectoryHandle(provider: ProviderType) {
  const db = await getDb()
  return db.get('handles', providerKey(provider, 'root'))
}

export async function saveCache(dataset: DashboardData, provider: ProviderType) {
  const db = await getDb()
  await db.put(
    'cache',
    {
      schemaVersion: CACHE_SCHEMA_VERSION,
      savedAtMs: Date.now(),
      dataset,
    },
    providerKey(provider, 'latest'),
  )
}

export async function loadCache(provider: ProviderType) {
  const db = await getDb()
  const record = await db.get('cache', providerKey(provider, 'latest'))
  return record?.schemaVersion === CACHE_SCHEMA_VERSION ? record : undefined
}

export async function savePricingCatalog(catalog: PricingCatalog) {
  const db = await getDb()
  await db.put('settings', catalog, 'pricing-catalog')
}

export async function loadPricingCatalog() {
  const db = await getDb()
  const value = (await db.get('settings', 'pricing-catalog')) as PricingCatalog | undefined
  return value?.version === 2 && Array.isArray(value.rules) ? value : undefined
}

export async function clearStoredState() {
  await deleteDB('vibe-coding-usage-dashboard')
  dbPromise = null
}
