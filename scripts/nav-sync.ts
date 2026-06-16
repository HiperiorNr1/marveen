#!/usr/bin/env bun
// NAV cashflow sync -- zero-LLM, zero-token. Runs as a Marveen type='command'
// scheduled-task (bash -lc bun run scripts/nav-sync.ts). Pulls outgoing+incoming
// invoice digests from the NAV Online Szamla API via the vendored NavClient
// (library reuse, NOT the MCP server) and upserts them into the nav-cashflow
// postgres (ESXi nav-cashflow-db). Incremental by insDate high-water per
// direction. Plan: docs/plans/nav-cashflow-dashboard-2026-06-15.md.
//
// Exit 0 = both directions synced. Exit 1 = at least one direction errored
// (the command-task failThreshold escalates to a Telegram alert).
//
// GATES before this is run live (see plan section 0):
//   - nav-cashflow stack deployed, ESXi:5433 reachable from the Marveen-host.
//   - NAV test creds in vault (nav-test_*), and the tax-number secret id
//     confirmed (NAV_TAXNUMBER_SECRET_ID) -- pending Krisztian (#815).
//   - The digest->row field mapping (mapDigest) is per the NAV OSA 3.0
//     invoiceDigest schema; VERIFY it against the first live NAV_ENV=test
//     response and adjust any key casing/nesting before production.

import { SQL } from 'bun'
import { NavClient } from '../vendor/nav-online-invoice-mcp/dist/nav-client.js'
import { buildNavClient, openDb, NAV_ENV, type Direction } from './nav-common.js'
import { runLineFetch } from './nav-line-items.js'

// NAV insDate query windows are capped (~35 days); chunk longer ranges.
const WINDOW_DAYS = 30
// First-run backfill horizon when there is no high-water yet.
const BACKFILL_DAYS = Number(process.env.NAV_BACKFILL_DAYS ?? '365')

// Split [from, to] into <=WINDOW_DAYS chunks (NAV insDate range cap).
function windows(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = []
  let cur = from
  while (cur < to) {
    const next = new Date(Math.min(cur.getTime() + WINDOW_DAYS * 86400_000, to.getTime()))
    out.push({ from: cur, to: next })
    cur = next
  }
  return out
}

function isoNoMs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// --- digest -> row mapping ---------------------------------------------------
// Field names per the NAV OSA 3.0 invoiceDigest schema (fast-xml-parser with
// removeNSPrefix:true -> plain camelCase keys; invoiceOperation forced to array).
// VERIFY against the first live NAV_ENV=test response; adjust if the parsed
// nesting/casing differs. Unknown fields stay null (the raw_digest jsonb keeps
// the full object for later backfill).
function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v
}
function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function mapDigest(d: Record<string, any>, direction: Direction) {
  const isOutbound = direction === 'OUTBOUND'
  const net = num(d.invoiceNetAmount)
  const vat = num(d.invoiceVatAmount)
  const netHuf = num(d.invoiceNetAmountHUF)
  const vatHuf = num(d.invoiceVatAmountHUF)
  return {
    direction,
    invoice_number: String(d.invoiceNumber ?? ''),
    invoice_operation: first<string>(d.invoiceOperation) ?? null,
    original_invoice_number: d.originalInvoiceNumber ?? null,
    // OUTBOUND -> partner is the customer; INBOUND -> partner is the supplier.
    partner_name: (isOutbound ? d.customerName : d.supplierName) ?? null,
    partner_tax_number: (isOutbound ? d.customerTaxNumber : d.supplierTaxNumber) ?? null,
    issue_date: d.invoiceIssueDate ?? null,
    fulfillment_date: d.invoiceDeliveryDate ?? null,   // teljesites
    payment_due_date: d.paymentDate ?? null,           // esedekesseg
    net_amount: net,
    vat_amount: vat,
    gross_amount: net != null && vat != null ? net + vat : null,   // computed
    net_amount_huf: netHuf,
    gross_amount_huf: netHuf != null && vatHuf != null ? netHuf + vatHuf : null,
    currency: d.currency ?? null,
    payment_method: d.paymentMethod ?? null,
    invoice_category: d.invoiceCategory ?? null,
    invoice_appearance: d.invoiceAppearance ?? null,
    ins_date: d.insDate ?? null,
    // Pass the OBJECT (not a JSON string) so Bun.SQL serializes it to a jsonb
    // object. A pre-stringified value double-encodes into a jsonb STRING that
    // can't be queried with ->>/? operators (only via #>> '{}').
    raw_digest: d,
  }
}

// Pull the invoiceDigest array out of the NavClient response `data`, tolerant
// of the exact nesting (verify against the live response).
function extractDigests(data: any): Record<string, any>[] {
  const res = data?.invoiceDigestResult ?? data?.QueryInvoiceDigestResponse?.invoiceDigestResult ?? data
  const arr = res?.invoiceDigest
  if (!arr) return []
  return Array.isArray(arr) ? arr : [arr]
}
function availablePage(data: any): number {
  const res = data?.invoiceDigestResult ?? data
  const n = Number(res?.availablePage)
  return Number.isFinite(n) && n > 0 ? n : 1
}

async function upsert(sql: SQL, row: ReturnType<typeof mapDigest>): Promise<void> {
  await sql`
    INSERT INTO invoices (
      direction, invoice_number, invoice_operation, original_invoice_number,
      partner_name, partner_tax_number, issue_date, fulfillment_date,
      payment_due_date, net_amount, vat_amount, gross_amount, net_amount_huf,
      gross_amount_huf, currency, payment_method, invoice_category,
      invoice_appearance, ins_date, raw_digest
    ) VALUES (
      ${row.direction}, ${row.invoice_number}, ${row.invoice_operation}, ${row.original_invoice_number},
      ${row.partner_name}, ${row.partner_tax_number}, ${row.issue_date}, ${row.fulfillment_date},
      ${row.payment_due_date}, ${row.net_amount}, ${row.vat_amount}, ${row.gross_amount}, ${row.net_amount_huf},
      ${row.gross_amount_huf}, ${row.currency}, ${row.payment_method}, ${row.invoice_category},
      ${row.invoice_appearance}, ${row.ins_date}, ${row.raw_digest}
    )
    ON CONFLICT (direction, invoice_number, invoice_operation) DO UPDATE SET
      original_invoice_number = EXCLUDED.original_invoice_number,
      partner_name = EXCLUDED.partner_name,
      partner_tax_number = EXCLUDED.partner_tax_number,
      issue_date = EXCLUDED.issue_date,
      fulfillment_date = EXCLUDED.fulfillment_date,
      payment_due_date = EXCLUDED.payment_due_date,
      net_amount = EXCLUDED.net_amount,
      vat_amount = EXCLUDED.vat_amount,
      gross_amount = EXCLUDED.gross_amount,
      net_amount_huf = EXCLUDED.net_amount_huf,
      gross_amount_huf = EXCLUDED.gross_amount_huf,
      currency = EXCLUDED.currency,
      payment_method = EXCLUDED.payment_method,
      invoice_category = EXCLUDED.invoice_category,
      invoice_appearance = EXCLUDED.invoice_appearance,
      ins_date = EXCLUDED.ins_date,
      raw_digest = EXCLUDED.raw_digest,
      synced_at = now()
  `
}

async function syncDirection(sql: SQL, nav: NavClient, direction: Direction): Promise<number> {
  const rows = await sql`SELECT last_ins_date FROM sync_state WHERE direction = ${direction}`
  const last = rows[0]?.last_ins_date ? new Date(rows[0].last_ins_date) : null
  const now = new Date()
  const from = last ?? new Date(now.getTime() - BACKFILL_DAYS * 86400_000)

  let upserted = 0
  let maxIns = last
  for (const w of windows(from, now)) {
    let page = 1
    let pages = 1
    do {
      const resp = await nav.queryInvoiceDigest({
        page,
        invoiceDirection: direction,
        insDateTimeFrom: isoNoMs(w.from),
        insDateTimeTo: isoNoMs(w.to),
      })
      if (resp.result?.funcCode && resp.result.funcCode !== 'OK') {
        throw new Error(`NAV ${direction} p${page}: ${resp.result.errorCode ?? ''} ${resp.result.message ?? ''}`)
      }
      const digests = extractDigests(resp.data)
      pages = availablePage(resp.data)
      for (const d of digests) {
        const row = mapDigest(d, direction)
        if (!row.invoice_number) continue
        await upsert(sql, row)
        upserted++
        if (row.ins_date) {
          const t = new Date(row.ins_date)
          if (!maxIns || t > maxIns) maxIns = t
        }
      }
      page++
    } while (page <= pages)
  }

  // Advance the high-water ONLY on a clean direction sync.
  await sql`
    UPDATE sync_state
    SET last_ins_date = ${maxIns ? maxIns.toISOString() : null},
        last_run_at = now(), last_status = 'ok', rows_upserted = ${upserted}
    WHERE direction = ${direction}
  `
  return upserted
}

async function main(): Promise<void> {
  const nav = buildNavClient()
  const sql = openDb()
  let failed = false
  try {
    for (const direction of ['OUTBOUND', 'INBOUND'] as Direction[]) {
      try {
        const n = await syncDirection(sql, nav, direction)
        console.log(`[nav-sync] ${direction}: ${n} rows upserted (env=${NAV_ENV})`)
      } catch (err) {
        failed = true
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[nav-sync] ${direction} FAILED: ${msg}`)
        // Record the failure without advancing the high-water.
        await sql`UPDATE sync_state SET last_run_at = now(), last_status = ${'error: ' + msg} WHERE direction = ${direction}`
          .catch(() => { /* best-effort status write */ })
      }
    }
    // Incremental line-item fetch for newly-arrived invoices (both directions by
    // default, so new INBOUND and OUTBOUND invoices get their lines automatically).
    // Env-overridable (NAV_LINES_INC_DIRECTIONS) in case the 6h sync ever needs
    // trimming. Capped + rate-limited so the command-task stays well under its
    // timeout; whatever is left is picked up next run or by the standalone
    // backfill. Best-effort: a line-fetch failure never fails the digest sync
    // (the rows keep lines_fetched_at NULL and retry).
    const incDirections = (process.env.NAV_LINES_INC_DIRECTIONS ?? 'INBOUND,OUTBOUND')
      .split(',').map(s => s.trim()).filter(Boolean) as Direction[]
    try {
      const lineN = await runLineFetch(sql, nav, {
        directions: incDirections,
        cap: Number(process.env.NAV_LINES_INCREMENTAL_CAP ?? '40'),
        delayMs: Number(process.env.NAV_LINES_DELAY_MS ?? '400'),
      })
      if (lineN > 0) console.log(`[nav-sync] line-items: ${lineN} invoices fetched (incremental, ${incDirections.join('+')})`)
    } catch (err) {
      console.error(`[nav-sync] incremental line-item fetch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
  } finally {
    await sql.end().catch(() => { /* ignore */ })
  }
  if (failed) process.exit(1)
}

main().catch(err => {
  console.error(`[nav-sync] fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
