// Pure NAV invoice line-item decode + mapping. NO bun/runtime imports so it is
// unit-testable under vitest (which runs on Node, not Bun). The I/O layer
// (nav-line-items.ts) imports these. Plan: docs/plans/nav-line-items-2026-06-16.md.

import { gunzipSync } from 'node:zlib'
import { parseXmlResponse } from '../vendor/nav-online-invoice-mcp/dist/xml-parser.js'

export type Direction = 'INBOUND' | 'OUTBOUND'

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Decode the queryInvoiceData payload: base64 (gunzip if compressed) -> invoice
// XML -> parsed object. The vendor parser forces `line` to an array.
export function decodeInvoiceData(
  invoiceDataResult: { invoiceData?: string; compressedContentIndicator?: boolean } | undefined,
): Record<string, any> | null {
  const b64 = invoiceDataResult?.invoiceData
  if (!b64) return null
  let buf = Buffer.from(b64, 'base64')
  if (invoiceDataResult?.compressedContentIndicator) buf = gunzipSync(buf)
  return parseXmlResponse(buf.toString('utf-8'))
}

function invoiceRoot(parsed: Record<string, any> | null): Record<string, any> | null {
  const data = parsed?.InvoiceData ?? parsed?.invoiceData ?? parsed
  return data?.invoiceMain?.invoice ?? null
}

export function extractInvoiceLines(parsed: Record<string, any> | null): Record<string, any>[] {
  const lines = invoiceRoot(parsed)?.invoiceLines?.line
  if (!lines) return []
  return Array.isArray(lines) ? lines : [lines]
}

// Invoice-level gross from the summary -- present for both NORMAL and SIMPLIFIED,
// so it fills invoices.gross_amount_huf where the SIMPLIFIED digest had none.
export function extractInvoiceGrossHuf(parsed: Record<string, any> | null): number | null {
  return num(invoiceRoot(parsed)?.invoiceSummary?.summaryGrossData?.invoiceGrossAmountHUF)
}

export interface LineRow {
  direction: Direction
  invoice_number: string
  line_number: number
  line_nature: string | null
  description: string | null
  product_codes: string | null   // JSON string for the jsonb column
  quantity: number | null
  unit_of_measure: string | null
  unit_price_huf: number | null
  net_amount_huf: number | null
  vat_rate: number | null
  vat_amount_huf: number | null
  gross_amount_huf: number | null
}

// Map one NAV invoice line -> a row. Handles lineAmountsNormal (net/vat/gross
// split) AND lineAmountsSimplified (gross + vatContent only -- derive net/vat).
export function mapInvoiceLine(line: Record<string, any>, direction: Direction, invoiceNumber: string): LineRow {
  const base: LineRow = {
    direction,
    invoice_number: invoiceNumber,
    line_number: num(line.lineNumber) ?? 0,
    line_nature: line.lineNatureIndicator ?? null,
    description: line.lineDescription ?? null,
    product_codes: line.productCodes != null ? JSON.stringify(line.productCodes) : null,
    quantity: num(line.quantity),
    unit_of_measure: line.unitOfMeasureOwn ?? line.unitOfMeasure ?? null,
    unit_price_huf: num(line.unitPriceHUF) ?? num(line.unitPrice),
    net_amount_huf: null,
    vat_rate: null,
    vat_amount_huf: null,
    gross_amount_huf: null,
  }
  const normal = line.lineAmountsNormal
  const simple = line.lineAmountsSimplified
  if (normal) {
    base.net_amount_huf = num(normal.lineNetAmountData?.lineNetAmountHUF)
    base.vat_rate = num(normal.lineVatRate?.vatPercentage)
    // Some suppliers report ONLY net + vatRate per line (no lineVatData /
    // lineGrossAmountData). Prefer the explicit values; derive vat/gross from
    // net * rate when absent so product views stay complete.
    base.vat_amount_huf = num(normal.lineVatData?.lineVatAmountHUF)
      ?? (base.net_amount_huf != null && base.vat_rate != null
        ? Math.round(base.net_amount_huf * base.vat_rate) : null)
    base.gross_amount_huf = num(normal.lineGrossAmountData?.lineGrossAmountNormalHUF)
      ?? (base.net_amount_huf != null && base.vat_amount_huf != null
        ? base.net_amount_huf + base.vat_amount_huf : null)
  } else if (simple) {
    const gross = num(simple.lineGrossAmountSimplifiedHUF)
    // vatContent = VAT as a fraction of GROSS (e.g. 0.2126 for a 27% rate).
    const vatContent = num(simple.lineVatRate?.vatContent)
    base.gross_amount_huf = gross
    if (gross != null && vatContent != null) {
      base.vat_amount_huf = Math.round(gross * vatContent)
      base.net_amount_huf = gross - base.vat_amount_huf
      // Normalize to vatPercentage (fraction of NET) so v_vat_breakdown is
      // comparable with NORMAL lines: pct = content / (1 - content).
      base.vat_rate = vatContent < 1 ? Math.round((vatContent / (1 - vatContent)) * 10000) / 10000 : null
    }
  }
  return base
}
