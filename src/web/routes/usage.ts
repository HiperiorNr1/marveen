import type { RouteContext } from './types.js'
import { json } from '../http-helpers.js'
import { getDb } from '../../db.js'

interface DailyRow {
  date: string
  agent_id: string
  calls: number
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  total_cost_usd: number
}

function parseDayBoundary(raw: string | null, fallback: number): number {
  if (!raw) return fallback
  // Accept either a unix-seconds integer or a YYYY-MM-DD date. We do not
  // accept arbitrary ISO strings; that opens timezone-mismatch foot-guns
  // without much upside for an observability endpoint.
  if (/^\d+$/.test(raw)) return Number(raw)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ts = Date.parse(`${raw}T00:00:00`)
    if (!Number.isNaN(ts)) return Math.floor(ts / 1000)
  }
  return fallback
}

export async function tryHandleUsage(ctx: RouteContext): Promise<boolean> {
  const { path, method, url, res } = ctx
  if (path !== '/api/usage/daily' || method !== 'GET') return false

  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60
  const from = parseDayBoundary(url.searchParams.get('from'), thirtyDaysAgo)
  const to = parseDayBoundary(url.searchParams.get('to'), now)
  const agent = url.searchParams.get('agent')

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
  if (agent) {
    sql += ' AND agent_id = ?'
    params.push(agent)
  }
  sql += `
    GROUP BY date, agent_id
    ORDER BY date DESC, agent_id ASC
  `

  const rows = getDb().prepare(sql).all(...params) as DailyRow[]
  json(res, {
    from,
    to,
    agent: agent ?? null,
    rows,
  })
  return true
}
