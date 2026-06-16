import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mapInvoiceLine,
  extractInvoiceLines,
  extractInvoiceGrossHuf,
  decodeInvoiceData,
} from '../nav-line-mapping.js'

// The 6h nav-sync incremental line-fetch must cover BOTH directions so new
// INBOUND and OUTBOUND invoices get their lines automatically (env-overridable).
// Locked here so it is never silently reverted to INBOUND-only.
describe('nav-sync incremental line-fetch direction scope', () => {
  const src = readFileSync(join(__dirname, '../../scripts/nav-sync.ts'), 'utf-8')
  it('defaults to both directions via NAV_LINES_INC_DIRECTIONS', () => {
    expect(src).toMatch(/NAV_LINES_INC_DIRECTIONS/)
    expect(src).toMatch(/'INBOUND,OUTBOUND'/)
  })
  it('does not hardcode the incremental to INBOUND-only', () => {
    expect(src).not.toMatch(/directions:\s*\['INBOUND'\]/)
  })
})

// Fixtures are REAL line structures captured from live NAV queryInvoiceData
// responses (2026-06-16). They lock the field mapping against the actual schema.

const NORMAL_LINE = {
  lineNumber: 1,
  lineNatureIndicator: 'PRODUCT',
  lineDescription: 'LIV LAGUNA WC TARTÁLY TÖLTŐSZELEP',
  productCodes: { productCode: [{ productCodeCategory: 'OWN', productCodeOwnValue: 3838912011916 }] },
  quantity: 1,
  unitOfMeasure: 'OWN',
  unitOfMeasureOwn: 'db',
  unitPrice: 4788.42,
  unitPriceHUF: 4788.42,
  lineAmountsNormal: {
    lineNetAmountData: { lineNetAmount: 4788, lineNetAmountHUF: 4788 },
    lineVatRate: { vatPercentage: 0.27 },
    lineVatData: { lineVatAmount: 1293, lineVatAmountHUF: 1293 },
    lineGrossAmountData: { lineGrossAmountNormal: 6081, lineGrossAmountNormalHUF: 6081 },
  },
}

const SIMPLIFIED_LINE = {
  lineNumber: 1,
  lineDescription: 'ESZ95/E5 ólmozatlan benzin',
  quantity: 31.23,
  unitOfMeasure: 'PIECE',
  unitPrice: 634,
  unitPriceHUF: 634,
  lineAmountsSimplified: {
    lineVatRate: { vatContent: 0.2126 },
    lineGrossAmountSimplified: 19800,
    lineGrossAmountSimplifiedHUF: 19800,
  },
}

const STORNO_LINE = {
  lineNumber: 1,
  lineModificationReference: { lineNumberReference: 8, lineOperation: 'CREATE' },
  lineDescription: 'Henco ötrétegű cső 16x2',
  quantity: -100,
  unitOfMeasure: 'METER',
  unitPrice: 416,
  lineAmountsNormal: {
    lineNetAmountData: { lineNetAmount: -41600, lineNetAmountHUF: -41600 },
    lineVatRate: { vatPercentage: 0.27 },
    lineVatData: { lineVatAmount: -11232, lineVatAmountHUF: -11232 },
    lineGrossAmountData: { lineGrossAmountNormal: -52832, lineGrossAmountNormalHUF: -52832 },
  },
}

describe('mapInvoiceLine -- NORMAL', () => {
  const r = mapInvoiceLine(NORMAL_LINE, 'OUTBOUND', 'INV-1')
  it('maps identity + descriptive fields', () => {
    expect(r.invoice_number).toBe('INV-1')
    expect(r.line_number).toBe(1)
    expect(r.line_nature).toBe('PRODUCT')
    expect(r.description).toBe('LIV LAGUNA WC TARTÁLY TÖLTŐSZELEP')
    expect(r.quantity).toBe(1)
    expect(r.unit_of_measure).toBe('db')         // prefers unitOfMeasureOwn
    expect(r.unit_price_huf).toBe(4788.42)
  })
  it('maps net/vat/gross + vat_rate from lineAmountsNormal (HUF columns)', () => {
    expect(r.net_amount_huf).toBe(4788)
    expect(r.vat_amount_huf).toBe(1293)
    expect(r.gross_amount_huf).toBe(6081)
    expect(r.vat_rate).toBe(0.27)
  })
})

describe('mapInvoiceLine -- SIMPLIFIED (digest gives no amount; derive from gross + vatContent)', () => {
  const r = mapInvoiceLine(SIMPLIFIED_LINE, 'INBOUND', 'INV-S')
  it('takes the gross and derives vat/net', () => {
    expect(r.gross_amount_huf).toBe(19800)
    expect(r.vat_amount_huf).toBe(Math.round(19800 * 0.2126)) // 4209
    expect(r.net_amount_huf).toBe(19800 - Math.round(19800 * 0.2126)) // 15591
  })
  it('normalizes vatContent -> vatPercentage (0.2126 -> 0.27)', () => {
    expect(r.vat_rate).toBe(0.27)
  })
})

describe('mapInvoiceLine -- NORMAL net+rate only (supplier omits lineVatData/lineGrossAmountData)', () => {
  // Real shape (MS2037260075): only net + vatRate per line; derive vat/gross.
  const NET_ONLY = {
    lineNumber: 1, lineNatureIndicator: 'PRODUCT', lineDescription: 'Mosogatógép tabletta',
    quantity: 1, unitOfMeasure: 'PACK', unitPrice: 2908.248, unitPriceHUF: 2908.248,
    lineAmountsNormal: {
      lineNetAmountData: { lineNetAmount: 2908.25, lineNetAmountHUF: 2908.25 },
      lineVatRate: { vatPercentage: 0.27 },
    },
  }
  const r = mapInvoiceLine(NET_ONLY, 'INBOUND', 'INV-NETONLY')
  it('derives vat and gross from net * rate when explicit amounts are absent', () => {
    expect(r.net_amount_huf).toBe(2908.25)
    expect(r.vat_rate).toBe(0.27)
    expect(r.vat_amount_huf).toBe(Math.round(2908.25 * 0.27)) // 785
    expect(r.gross_amount_huf).toBe(2908.25 + Math.round(2908.25 * 0.27)) // 3693.25
  })
})

describe('mapInvoiceLine -- STORNO (negative-signed -> SUM nets in the view)', () => {
  const r = mapInvoiceLine(STORNO_LINE, 'INBOUND', 'INV-STORNO')
  it('preserves the negative sign on quantity and amounts', () => {
    expect(r.quantity).toBe(-100)
    expect(r.net_amount_huf).toBe(-41600)
    expect(r.vat_amount_huf).toBe(-11232)
    expect(r.gross_amount_huf).toBe(-52832)
  })
})

describe('extractInvoiceLines / extractInvoiceGrossHuf', () => {
  const parsedMulti = { InvoiceData: { invoiceMain: { invoice: {
    invoiceLines: { line: [NORMAL_LINE, STORNO_LINE] },
    invoiceSummary: { summaryGrossData: { invoiceGrossAmountHUF: 6081 } },
  } } } }
  const parsedSingle = { InvoiceData: { invoiceMain: { invoice: {
    invoiceLines: { line: SIMPLIFIED_LINE },
    invoiceSummary: { summarySimplified: {}, summaryGrossData: { invoiceGrossAmountHUF: 19800 } },
  } } } }

  it('returns the line array', () => {
    expect(extractInvoiceLines(parsedMulti)).toHaveLength(2)
  })
  it('wraps a single (non-array) line', () => {
    expect(extractInvoiceLines(parsedSingle)).toHaveLength(1)
  })
  it('returns [] when there are no lines', () => {
    expect(extractInvoiceLines({ InvoiceData: { invoiceMain: { invoice: {} } } })).toEqual([])
    expect(extractInvoiceLines(null)).toEqual([])
  })
  it('reads the invoice-level gross (fills SIMPLIFIED gross)', () => {
    expect(extractInvoiceGrossHuf(parsedSingle)).toBe(19800)
    expect(extractInvoiceGrossHuf(null)).toBeNull()
  })
})

describe('decodeInvoiceData -- base64 (+ gzip)', () => {
  const xml = '<InvoiceData><invoiceMain><invoice><invoiceLines><line><lineNumber>1</lineNumber>' +
    '<lineDescription>Teszt</lineDescription></line></invoiceLines></invoice></invoiceMain></InvoiceData>'
  it('decodes plain base64', () => {
    const parsed = decodeInvoiceData({ invoiceData: Buffer.from(xml).toString('base64'), compressedContentIndicator: false })
    expect(extractInvoiceLines(parsed)[0]?.lineDescription).toBe('Teszt')
  })
  it('gunzips when compressedContentIndicator is set', () => {
    const gz = gzipSync(Buffer.from(xml)).toString('base64')
    const parsed = decodeInvoiceData({ invoiceData: gz, compressedContentIndicator: true })
    expect(extractInvoiceLines(parsed)[0]?.lineDescription).toBe('Teszt')
  })
  it('returns null on empty payload', () => {
    expect(decodeInvoiceData(undefined)).toBeNull()
    expect(decodeInvoiceData({})).toBeNull()
  })
})
