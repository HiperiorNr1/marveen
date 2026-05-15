import type { RouteContext } from './types.js'
import { json } from '../http-helpers.js'
import { getDb } from '../../db.js'
import { getSecret } from '../vault.js'
import { getAdminSnapshot } from '../anthropic-admin.js'

interface MarveenDailyRow {
  date: string
  agent_id: string
  calls: number
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  total_cost_usd: number
}

interface TokenBucket {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_usd: number
}

interface MarveenAgentBucket extends TokenBucket {
  calls: number
}

interface MarveenDayBucket extends TokenBucket {
  calls: number
  by_agent: Record<string, MarveenAgentBucket>
}

function parseDayBoundary(raw: string | null, fallback: number): number {
  if (!raw) return fallback
  if (/^\d+$/.test(raw)) return Number(raw)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ts = Date.parse(`${raw}T00:00:00`)
    if (!Number.isNaN(ts)) return Math.floor(ts / 1000)
  }
  return fallback
}

function emptyBucket(): TokenBucket {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
  }
}

function subtractBucket(a: TokenBucket, b: TokenBucket): TokenBucket {
  return {
    input_tokens: Math.max(0, a.input_tokens - b.input_tokens),
    output_tokens: Math.max(0, a.output_tokens - b.output_tokens),
    cache_creation_input_tokens: Math.max(0, a.cache_creation_input_tokens - b.cache_creation_input_tokens),
    cache_read_input_tokens: Math.max(0, a.cache_read_input_tokens - b.cache_read_input_tokens),
    cost_usd: Math.max(0, a.cost_usd - b.cost_usd),
  }
}

export async function tryHandleUsage(ctx: RouteContext): Promise<boolean> {
  const { path, method, url, res } = ctx
  if (path !== '/api/usage/daily' || method !== 'GET') return false

  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60
  const from = parseDayBoundary(url.searchParams.get('from'), thirtyDaysAgo)
  const to = parseDayBoundary(url.searchParams.get('to'), now)
  const agentFilter = url.searchParams.get('agent')

  // --- marveen source (local SDK logging) ---

  let sql = `
    SELECT
      date(ts, 'unixepoch', 'localtime') AS date,
      agent_id,
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
    FROM token_usage
    WHERE ts BETWEEN ? AND ?
  `
  const params: (number | string)[] = [from, to]
  if (agentFilter) {
    sql += ' AND agent_id = ?'
    params.push(agentFilter)
  }
  sql += `
    GROUP BY date, agent_id
    ORDER BY date ASC, agent_id ASC
  `

  const rows = getDb().prepare(sql).all(...params) as MarveenDailyRow[]

  const marveenByDate = new Map<string, MarveenDayBucket>()
  for (const row of rows) {
    let day = marveenByDate.get(row.date)
    if (!day) {
      day = { ...emptyBucket(), calls: 0, by_agent: {} }
      marveenByDate.set(row.date, day)
    }
    day.input_tokens += row.input_tokens
    day.output_tokens += row.output_tokens
    day.cache_creation_input_tokens += row.cache_creation_input_tokens
    day.cache_read_input_tokens += row.cache_read_input_tokens
    day.cost_usd += row.total_cost_usd
    day.calls += row.calls
    day.by_agent[row.agent_id] = {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
      cache_read_input_tokens: row.cache_read_input_tokens,
      cost_usd: row.total_cost_usd,
      calls: row.calls,
    }
  }

  // --- account source (Anthropic Admin API) ---

  const accountByDate = new Map<string, TokenBucket>()
  let adminError: string | null = null
  // Skip the Admin API entirely when the caller filters to a Marveen agent.
  // The Admin API knows nothing about our internal agent labels, so a
  // filtered query against it would be misleading.
  const wantAccount = !agentFilter
  if (wantAccount) {
    const adminKey = getSecret('anthropic_admin_key')
    if (!adminKey) {
      adminError = 'anthropic_admin_key not in vault'
    } else {
      const snap = await getAdminSnapshot(adminKey, from, to)
      if (snap.error) {
        adminError = snap.error
      } else {
        for (const u of snap.usage) {
          let day = accountByDate.get(u.date)
          if (!day) {
            day = emptyBucket()
            accountByDate.set(u.date, day)
          }
          day.input_tokens += u.input_tokens
          day.output_tokens += u.output_tokens
          day.cache_creation_input_tokens += u.cache_creation_input_tokens
          day.cache_read_input_tokens += u.cache_read_input_tokens
        }
        for (const c of snap.cost) {
          let day = accountByDate.get(c.date)
          if (!day) {
            day = emptyBucket()
            accountByDate.set(c.date, day)
          }
          day.cost_usd += c.cost_usd
        }
      }
    }
  } else {
    adminError = 'account source skipped: agent filter is Marveen-only'
  }

  // --- merge into days[] ---

  const allDates = new Set<string>([...marveenByDate.keys(), ...accountByDate.keys()])
  const days = [...allDates].sort().map((date) => {
    const marveen = marveenByDate.get(date) ?? { ...emptyBucket(), calls: 0, by_agent: {} }
    const account = accountByDate.get(date) ?? null
    const other = account ? subtractBucket(account, marveen) : null
    return { date, marveen, account, other }
  })

  json(res, {
    from,
    to,
    agent: agentFilter ?? null,
    admin_api_error: adminError,
    days,
  })
  return true
}
