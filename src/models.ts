import { Cursor, type ModelListItem, type ModelParameterValue, type ModelSelection } from "@cursor/sdk"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE_DIR = join(homedir(), ".cache", "opencode-cursor-auth")
const MODELS_CACHE_PATH = join(CACHE_DIR, "models.json")
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MODELS_FETCH_TIMEOUT_MS = 15_000
const MODELS_RETRY_MS = 5 * 60 * 1000

type Variant = { params: ModelParameterValue[]; context?: number }
export type ModelInfo = {
  name: string
  context?: number
  params?: ModelParameterValue[]
  variants?: Record<string, Variant>
  allowed?: Record<string, string[]>
  blocked?: true
}
type ModelsCache = { version: 4; fetchedAt: number; models: Record<string, ModelInfo> }

let catalog: Record<string, ModelInfo> = {}
let fetchedAt = 0

function saveCatalog() {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(MODELS_CACHE_PATH, JSON.stringify({ version: 4, fetchedAt, models: catalog } satisfies ModelsCache))
}

function contextValue(raw?: string): number | undefined {
  const match = raw?.trim().match(/^(\d+)([km]?)$/i)
  if (!match) return undefined
  const unit = match[2].toLowerCase()
  return Number(match[1]) * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1)
}

export function parseContext(m: ModelListItem): number | undefined {
  return contextValue(m.parameters?.find((p) => p.id === "context")?.values[0]?.value)
}

export function buildCatalog(list: ModelListItem[]): Record<string, ModelInfo> {
  const models: Record<string, ModelInfo> = {}
  for (const m of list) {
    const def = m.variants?.find((v) => v.isDefault) ?? m.variants?.[0]
    const ctxOf = (ps?: ModelParameterValue[]) => contextValue(ps?.find((p) => p.id === "context")?.value)
    const context = ctxOf(def?.params) ?? parseContext(m)
    const allowed: Record<string, string[]> = {}
    const allow = (id: string, value: string) => {
      if (!(allowed[id] ??= []).includes(value)) allowed[id].push(value)
    }
    for (const p of m.parameters ?? []) for (const v of p.values) allow(p.id, v.value)
    const variants: Record<string, Variant> = {}
    for (const v of m.variants ?? []) {
      for (const p of v.params) allow(p.id, p.value)
      const name = v.params
        .filter((p) => def?.params.find((d) => d.id === p.id)?.value !== p.value)
        .map((p) => (p.value === "true" ? p.id : p.value === "false" ? `no-${p.id}` : p.value))
        .join("-")
      if (!name || variants[name]) continue
      const vctx = ctxOf(v.params) ?? context
      variants[name] = { params: v.params, ...(vctx ? { context: vctx } : {}) }
    }
    models[m.id === "default" ? "auto" : m.id] = {
      name: m.displayName ?? m.id,
      ...(context ? { context } : {}),
      ...(def ? { params: def.params, allowed } : {}),
      ...(Object.keys(variants).length ? { variants } : {}),
    }
  }
  return models
}

function loadCachedModels(): ModelsCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8")) as ModelsCache
    if (raw?.version === 4 && raw.models && Object.keys(raw.models).length > 0) return raw
  } catch {
    // no cache yet, or unreadable — fall back
  }
  return undefined
}

let refreshing: Promise<void> | undefined
let lastAttempt = 0

function refreshCatalog() {
  lastAttempt = Date.now()
  refreshing ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), MODELS_FETCH_TIMEOUT_MS)
      // never keep `opencode run` alive just for a catalog refresh
      timer.unref?.()
    })
    try {
      const fresh = buildCatalog(await Promise.race([Cursor.models.list(), timeout]))
      for (const [id, m] of Object.entries(catalog)) if (m.blocked && fresh[id]) fresh[id].blocked = true
      catalog = fresh
      fetchedAt = Date.now()
      try {
        saveCatalog()
      } catch {
        // cache dir unwritable — the fresh list still serves this process
      }
    } finally {
      clearTimeout(timer)
    }
  })()
    .catch(() => {})
    .finally(() => (refreshing = undefined))
}

// Live model list from Cursor, cached 24h. A stale cache is served as is and refreshed in the
// background (new models show up on the next start), so opencode's startup never waits on Cursor;
// only a first run with no cache does, for at most MODELS_FETCH_TIMEOUT_MS.
// Offline/logged-out with no cache: just "auto" (Cursor's universal alias).
// Models Cursor has rejected with "Model Blocked" for this account are hidden
// until the cache file is deleted (the catalog itself carries no entitlement info).
export async function currentModels(): Promise<Record<string, ModelInfo>> {
  const cached = loadCachedModels()
  if (cached && cached.fetchedAt >= fetchedAt) {
    catalog = cached.models
    fetchedAt = cached.fetchedAt
  }
  if (Date.now() - fetchedAt > MODELS_CACHE_TTL_MS && Date.now() - lastAttempt > MODELS_RETRY_MS) refreshCatalog()
  if (!Object.keys(catalog).length) await refreshing
  const models: Record<string, ModelInfo> = Object.keys(catalog).length ? catalog : { auto: { name: "Auto" } }
  return Object.fromEntries(Object.entries(models).filter(([, m]) => !m.blocked))
}

function loadCatalog() {
  if (Object.keys(catalog).length) return
  const cached = loadCachedModels()
  catalog = cached?.models ?? {}
  fetchedAt = cached?.fetchedAt ?? 0
}

export function resolveModel(opencodeId: string): ModelSelection | undefined {
  loadCatalog()
  const m = catalog[opencodeId]
  if (!m) return undefined
  return m.params ? { id: opencodeId, params: m.params } : { id: opencodeId }
}

export function resolveVariant(opencodeId: string, params?: unknown): ModelSelection | string | undefined {
  if (!Array.isArray(params)) return resolveModel(opencodeId)
  loadCatalog()
  const allowed = catalog[opencodeId]?.allowed ?? {}
  for (const p of params) {
    if (!allowed[p?.id]?.includes(p?.value)) return `unknown variant param ${p?.id}=${p?.value} for model ${opencodeId}`
  }
  return { id: opencodeId, params: params.map((p) => ({ id: p.id, value: p.value })) }
}

export function markBlocked(opencodeId: string) {
  loadCatalog()
  const m = catalog[opencodeId]
  if (!m || m.blocked) return
  m.blocked = true
  try {
    saveCatalog()
  } catch {
    // cache dir unwritable — the in-memory flag still hides it for this process
  }
}
