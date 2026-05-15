// Anthropic Admin API client for the /api/usage/daily endpoint's
// account-level source. Read-only; no key creation, no rate-limit poking.
//
// Two endpoints are queried per snapshot:
//   1. /v1/organizations/usage_report/messages -- token counts per day
//   2. /v1/organizations/cost_report           -- USD spend per day
//
// Both require an Admin API key (`sk-ant-admin-...`) that the operator
// provisions in Console -> Settings -> Admin keys. The key is stored in
// the Marveen vault under the id `anthropic_admin_key` and retrieved
// via getSecret(). If the key is absent or rejected by Anthropic, the
// route degrades gracefully -- the marveen source still returns,
// account+other come back null with an error string.
//
// IMPORTANT: the Admin API is unavailable for individual accounts. An
// operator on a personal Pro/Max subscription must first convert their
// account to an organization (Console -> Settings -> Organization) for
// these endpoints to authenticate. We document this in the route.

import { logger } from '../logger.js'

const USAGE_URL = 'https://api.anthropic.com/v1/organizations/usage_report/messages'
const COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report'
const ANTHROPIC_VERSION = '2023-06-01'
const USER_AGENT = 'marveen-token-tracker/1.0'
const PAGE_SAFETY_CAP = 50
const CACHE_TTL_SEC = 60 * 60

export interface UsageDay {
  date: string
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

export interface CostDay {
  date: string
  cost_usd: number
}

export interface AdminSnapshot {
  fetchedAt: number
  usage: UsageDay[]
  cost: CostDay[]
  error?: string
}

const snapshotCache = new Map<string, AdminSnapshot>()

function cacheKey(fromIso: string, toIso: string): string {
  return `${fromIso}|${toIso}`
}

function bucketDate(starting_at: string | undefined): string | null {
  if (!starting_at || typeof starting_at !== 'string') return null
  const head = starting_at.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null
}

function parseAmount(raw: unknown): number {
  if (raw === undefined || raw === null) return 0
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string') return 0
  // The cost API documents amounts as "decimal strings in lowest units
  // (cents)". Be defensive: accept either a dotted USD value (`"0.12"`)
  // or an integer cent value (`"12"`) and normalise to USD.
  const trimmed = raw.trim()
  if (!trimmed) return 0
  if (trimmed.includes('.')) {
    const v = Number(trimmed)
    return Number.isFinite(v) ? v : 0
  }
  const v = Number(trimmed)
  return Number.isFinite(v) ? v / 100 : 0
}

async function fetchAllPages<T>(
  baseUrl: string,
  apiKey: string,
  visit: (bucket: unknown) => void,
): Promise<void> {
  let pageToken: string | undefined
  for (let i = 0; i < PAGE_SAFETY_CAP; i++) {
    const url = new URL(baseUrl)
    if (pageToken) url.searchParams.set('page', pageToken)
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': apiKey,
        'User-Agent': USER_AGENT,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Anthropic Admin API ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      data?: unknown[]
      has_more?: boolean
      next_page?: string | null
    }
    for (const bucket of data.data ?? []) visit(bucket)
    if (!data.has_more) return
    pageToken = data.next_page ?? undefined
    if (!pageToken) return
  }
  throw new Error('Anthropic Admin API: pagination safety cap reached')
}

async function fetchUsage(apiKey: string, fromIso: string, toIso: string): Promise<UsageDay[]> {
  const days: UsageDay[] = []
  const base = new URL(USAGE_URL)
  base.searchParams.set('starting_at', fromIso)
  base.searchParams.set('ending_at', toIso)
  base.searchParams.set('bucket_width', '1d')
  await fetchAllPages(base.toString(), apiKey, (bucket) => {
    const b = bucket as { starting_at?: string; results?: Array<Record<string, number | string>> }
    const date = bucketDate(b.starting_at)
    if (!date) return
    // The API returns a `results` array; for a plain 1d bucket without
    // group_by we get a single entry with the aggregate counts.
    let input = 0
    let cacheCreate = 0
    let cacheRead = 0
    let output = 0
    for (const r of b.results ?? []) {
      input += Number(r.uncached_input_tokens ?? 0)
      cacheCreate += Number(r.cache_creation_input_tokens ?? 0)
      cacheRead += Number(r.cache_read_input_tokens ?? 0)
      output += Number(r.output_tokens ?? 0)
    }
    days.push({
      date,
      input_tokens: input,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead,
      output_tokens: output,
    })
  })
  return days
}

async function fetchCost(apiKey: string, fromIso: string, toIso: string): Promise<CostDay[]> {
  const byDate = new Map<string, number>()
  const base = new URL(COST_URL)
  base.searchParams.set('starting_at', fromIso)
  base.searchParams.set('ending_at', toIso)
  await fetchAllPages(base.toString(), apiKey, (bucket) => {
    const b = bucket as { starting_at?: string; results?: Array<{ amount?: unknown }> }
    const date = bucketDate(b.starting_at)
    if (!date) return
    let sum = byDate.get(date) ?? 0
    for (const r of b.results ?? []) sum += parseAmount(r.amount)
    byDate.set(date, sum)
  })
  const out: CostDay[] = []
  for (const [date, cost_usd] of byDate.entries()) {
    out.push({ date, cost_usd })
  }
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
}

export async function getAdminSnapshot(
  apiKey: string,
  fromUnix: number,
  toUnix: number,
): Promise<AdminSnapshot> {
  const fromIso = new Date(fromUnix * 1000).toISOString()
  const toIso = new Date(toUnix * 1000).toISOString()
  const ckey = cacheKey(fromIso, toIso)
  const nowSec = Math.floor(Date.now() / 1000)

  const cached = snapshotCache.get(ckey)
  if (cached && !cached.error && nowSec - cached.fetchedAt < CACHE_TTL_SEC) {
    return cached
  }

  try {
    const [usage, cost] = await Promise.all([
      fetchUsage(apiKey, fromIso, toIso),
      fetchCost(apiKey, fromIso, toIso),
    ])
    const snap: AdminSnapshot = { fetchedAt: nowSec, usage, cost }
    snapshotCache.set(ckey, snap)
    return snap
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.warn({ err: errMsg, from: fromIso, to: toIso }, 'Anthropic Admin API fetch failed')
    // Cache the failure briefly so repeated dashboard polls don't hammer
    // the API (and our error log) while the operator is fixing the key.
    const snap: AdminSnapshot = { fetchedAt: nowSec, usage: [], cost: [], error: errMsg }
    snapshotCache.set(ckey, snap)
    return snap
  }
}
