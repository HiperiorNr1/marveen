// Shared NAV + nav_invoices config for the sync scripts (nav-sync.ts digest
// sync + nav-line-items.ts line-item fetch). Pure config + client/connection
// builders; no side effects on import. Plan: docs/plans/nav-line-items-2026-06-16.md.

import { SQL } from 'bun'
import { NavClient } from '../vendor/nav-online-invoice-mcp/dist/nav-client.js'
import { getSecret } from '../src/web/vault.js'

export type { Direction } from '../src/nav-line-mapping.js'

export const NAV_ENV = (process.env.NAV_ENV ?? 'test').toLowerCase()
export const IS_TEST = NAV_ENV !== 'production'

// NAV API base. Test is lenient (no real software registration needed).
export const NAV_BASE_URL = IS_TEST
  ? 'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3'
  : 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3'

// Self-declared software identifier (NOT a NAV registration -- an 18-char
// [A-Z0-9] id carried in every request header). Test-env accepts it.
const SOFTWARE_ID = process.env.NAV_SOFTWARE_ID ?? 'EFICASHFLOW000001X'

const SECRET_IDS = IS_TEST
  ? { login: 'nav-test_login', password: 'nav-test_password', signatureKey: 'nav-test_signature_key', exchangeKey: 'nav-test_exchange_key' }
  : { login: 'nav_login', password: 'nav_password', signatureKey: 'nav_signature_key', exchangeKey: 'nav_exchange_key' }
const TAXNUMBER_SECRET_ID = process.env.NAV_TAXNUMBER_SECRET_ID ?? (IS_TEST ? 'nav-test_tax_number' : 'nav_tax_number')

// nav_invoices postgres (ESXi). Host/port overridable; creds from vault.
const PG_HOST = process.env.NAVDB_HOST ?? '172.19.250.10'
const PG_PORT = process.env.NAVDB_PORT ?? '5433'
const PG_NAME = process.env.NAVDB_NAME ?? 'nav_invoices'

export function reqSecret(id: string): string {
  const v = getSecret(id)
  if (v == null || v === '') throw new Error(`vault secret missing: ${id}`)
  return v
}

export function buildNavClient(): NavClient {
  const taxNumber = reqSecret(TAXNUMBER_SECRET_ID)
  return new NavClient({
    login: reqSecret(SECRET_IDS.login),
    password: reqSecret(SECRET_IDS.password),
    taxNumber,
    signatureKey: reqSecret(SECRET_IDS.signatureKey),
    exchangeKey: reqSecret(SECRET_IDS.exchangeKey),
    baseUrl: NAV_BASE_URL,
    softwareId: SOFTWARE_ID,
    softwareName: 'EFi NAV cashflow sync',
    softwareVersion: '1.0.0',
    softwareDevName: 'Egresits es Fiai Kft',
    softwareDevContact: 'hiperior@gmail.com',
    softwareDevCountryCode: 'HU',
    softwareDevTaxNumber: taxNumber,
  })
}

export function openDb(): SQL {
  const user = encodeURIComponent(reqSecret('navdb_user'))
  const pass = encodeURIComponent(reqSecret('navdb_password'))
  return new SQL({ url: `postgres://${user}:${pass}@${PG_HOST}:${PG_PORT}/${PG_NAME}`, max: 1, idleTimeout: 30 })
}
