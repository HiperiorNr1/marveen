#!/usr/bin/env bun
// NAV invoice line-items (tetelsorok) -- fetch full invoice content via
// queryInvoiceData, store per-line for product/category analysis, and fill the
// SIMPLIFIED invoice gross the digest omits. Plan: docs/plans/nav-line-items-2026-06-16.md.
//
// Run modes:
//   - imported: nav-sync.ts calls runLineFetch() incrementally (INBOUND, capped)
//     after the digest sync.
//   - standalone (bun run scripts/nav-line-items.ts): the resumable, rate-limited
//     historical backfill (env: NAV_LINES_DIRECTIONS, NAV_LINES_CAP,
//     NAV_LINES_DELAY_MS, NAV_LINES_HORIZON_DAYS).
//
// Every operation's lines are fetched (CREATE/MODIFY/STORNO -- no op filter).
// A STORNO carries its own invoice_number with NEGATIVE-signed amounts (verified
// live), so the product views net it with a plain SUM.

import { SQL } from 'bun'
import { NavClient } from '../vendor/nav-online-invoice-mcp/dist/nav-client.js'
import { buildNavClient, openDb } from './nav-common.js'
import {
  type Direction, type LineRow,
  decodeInvoiceData, extractInvoiceLines, extractInvoiceGrossHuf, mapInvoiceLine,
} from '../src/nav-line-mapping.js'

// --- I/O layer ---------------------------------------------------------------

interface PendingInvoice {
  direction: Direction
  invoice_number: string
  partner_tax_number: string | null
  gross_amount_huf: number | null
}

async function upsertLine(sql: SQL, r: LineRow): Promise<void> {
  await sql`
    INSERT INTO invoice_lines (
      direction, invoice_number, line_number, line_nature, description,
      product_codes, quantity, unit_of_measure, unit_price_huf, net_amount_huf,
      vat_rate, vat_amount_huf, gross_amount_huf
    ) VALUES (
      ${r.direction}, ${r.invoice_number}, ${r.line_number}, ${r.line_nature}, ${r.description},
      ${r.product_codes}, ${r.quantity}, ${r.unit_of_measure}, ${r.unit_price_huf}, ${r.net_amount_huf},
      ${r.vat_rate}, ${r.vat_amount_huf}, ${r.gross_amount_huf}
    )
    ON CONFLICT (direction, invoice_number, line_number) DO UPDATE SET
      line_nature = EXCLUDED.line_nature, description = EXCLUDED.description,
      product_codes = EXCLUDED.product_codes, quantity = EXCLUDED.quantity,
      unit_of_measure = EXCLUDED.unit_of_measure, unit_price_huf = EXCLUDED.unit_price_huf,
      net_amount_huf = EXCLUDED.net_amount_huf, vat_rate = EXCLUDED.vat_rate,
      vat_amount_huf = EXCLUDED.vat_amount_huf, gross_amount_huf = EXCLUDED.gross_amount_huf,
      synced_at = now()
  `
}

// Fetch + store one invoice's lines. Throws on a NAV error so the caller can
// decide (retry / backoff); leaves lines_fetched_at untouched on throw.
async function fetchAndStoreLines(sql: SQL, nav: NavClient, inv: PendingInvoice): Promise<number> {
  // supplierTaxNumber is ONLY accepted on the customer-side (INBOUND) query;
  // passing it on OUTBOUND makes NAV reject with BAD_QUERY_PARAM (verified).
  const supplierTax = inv.direction === 'INBOUND' ? (inv.partner_tax_number ?? undefined) : undefined
  const r = await nav.queryInvoiceData(inv.invoice_number, inv.direction, undefined, supplierTax)
  if (r.result?.funcCode !== 'OK') {
    throw new Error(`queryInvoiceData ${inv.direction} ${inv.invoice_number}: ${r.result?.errorCode ?? ''} ${r.result?.message ?? ''}`)
  }
  const parsed = decodeInvoiceData(r.data?.invoiceDataResult as any)
  const lines = extractInvoiceLines(parsed)
  for (const line of lines) {
    await upsertLine(sql, mapInvoiceLine(line, inv.direction, inv.invoice_number))
  }
  // Fill the SIMPLIFIED gross the digest omitted (only when currently NULL).
  if (inv.gross_amount_huf == null) {
    const gross = extractInvoiceGrossHuf(parsed)
    if (gross != null) {
      await sql`UPDATE invoices SET gross_amount_huf = ${gross}
                WHERE direction = ${inv.direction} AND invoice_number = ${inv.invoice_number} AND gross_amount_huf IS NULL`
    }
  }
  await sql`UPDATE invoices SET lines_fetched_at = now()
            WHERE direction = ${inv.direction} AND invoice_number = ${inv.invoice_number}`
  return lines.length
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

export interface LineFetchOpts {
  directions: Direction[]
  cap: number          // max invoices per run
  delayMs: number      // pause between NAV calls (rate-limit)
  horizonDays?: number // only invoices with ins_date within this horizon (null = all)
}

// Process up to `cap` pending invoices (lines_fetched_at IS NULL). Resumable
// (the flag persists) and rate-limited. Per-invoice errors are isolated (the
// row stays pending and retries); after several CONSECUTIVE errors we stop the
// run (likely NAV throttling/outage) -- the flag makes a re-run safe.
export async function runLineFetch(sql: SQL, nav: NavClient, opts: LineFetchOpts): Promise<number> {
  // Direction filter as two booleans -- Bun.SQL does not serialize a JS array
  // for `= ANY($1)` (malformed array literal), and directions is a small fixed
  // set. Null horizon interval = no time bound (all pending).
  const wantInbound = opts.directions.includes('INBOUND')
  const wantOutbound = opts.directions.includes('OUTBOUND')
  const horizonInterval = opts.horizonDays ? `${opts.horizonDays} days` : null
  const pending = await sql`
    SELECT direction, invoice_number, partner_tax_number, gross_amount_huf
    FROM invoices
    WHERE lines_fetched_at IS NULL
      AND ((${wantInbound} AND direction = 'INBOUND') OR (${wantOutbound} AND direction = 'OUTBOUND'))
      AND (${horizonInterval}::interval IS NULL OR ins_date >= now() - ${horizonInterval}::interval)
    ORDER BY ins_date DESC
    LIMIT ${opts.cap}
  ` as PendingInvoice[]

  let done = 0
  let consecutiveErrors = 0
  for (const inv of pending) {
    try {
      await fetchAndStoreLines(sql, nav, inv)
      done++
      consecutiveErrors = 0
    } catch (err) {
      consecutiveErrors++
      console.error(`[nav-lines] ${inv.direction} ${inv.invoice_number} failed: ${err instanceof Error ? err.message : String(err)}`)
      if (consecutiveErrors >= 5) {
        console.error('[nav-lines] 5 consecutive failures -- stopping run (likely NAV throttling); resumable on next run')
        break
      }
    }
    await delay(opts.delayMs)
  }
  return done
}

// Standalone backfill entry point.
async function main(): Promise<void> {
  const nav = buildNavClient()
  const sql = openDb()
  try {
    const directions = (process.env.NAV_LINES_DIRECTIONS ?? 'INBOUND')
      .split(',').map(s => s.trim()).filter(Boolean) as Direction[]
    const horizonRaw = process.env.NAV_LINES_HORIZON_DAYS
    const n = await runLineFetch(sql, nav, {
      directions,
      cap: Number(process.env.NAV_LINES_CAP ?? '300'),
      delayMs: Number(process.env.NAV_LINES_DELAY_MS ?? '400'),
      horizonDays: horizonRaw ? Number(horizonRaw) : undefined,
    })
    const wantIn = directions.includes('INBOUND'); const wantOut = directions.includes('OUTBOUND')
    const remaining = await sql`SELECT count(*) c FROM invoices WHERE lines_fetched_at IS NULL AND ((${wantIn} AND direction='INBOUND') OR (${wantOut} AND direction='OUTBOUND'))`
    console.log(`[nav-lines] backfill: ${n} invoices fetched this run; ${remaining[0]?.c ?? '?'} still pending (${directions.join(',')})`)
  } finally {
    await sql.end().catch(() => { /* ignore */ })
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`[nav-lines] fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
