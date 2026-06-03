import { deleteDB, openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { CacheRecord, DashboardData, PriceRule, ProviderType } from '../types'

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
    value: PriceRule[]
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
      savedAtMs: Date.now(),
      dataset,
    },
    providerKey(provider, 'latest'),
  )
}

export async function loadCache(provider: ProviderType) {
  const db = await getDb()
  return db.get('cache', providerKey(provider, 'latest'))
}

export async function savePriceRules(priceRules: PriceRule[]) {
  const db = await getDb()
  await db.put('settings', priceRules, 'price-rules')
}

export async function loadPriceRules() {
  const db = await getDb()
  return db.get('settings', 'price-rules')
}

export async function clearStoredState() {
  await deleteDB('vibe-coding-usage-dashboard')
  dbPromise = null
}
