-- NAV cashflow-dashboard schema -- target DB: nav_invoices (ESXi efi-analytics-db).
-- Load once the stack is up:
--   psql "postgresql://navsync:***@172.19.250.10:5433/nav_invoices" -f scripts/nav-cashflow-schema.sql
-- Idempotent: safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- Plan: docs/plans/nav-cashflow-dashboard-2026-06-15.md (sections 2).

-- One row per digest hit. The UNIQUE key drives the idempotent sync upsert.
CREATE TABLE IF NOT EXISTS invoices (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction         TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  invoice_number    TEXT NOT NULL,
  invoice_operation TEXT,                       -- CREATE | MODIFY | STORNO
  original_invoice_number TEXT,                 -- set on STORNO/MODIFY
  partner_name      TEXT,
  partner_tax_number TEXT,
  issue_date        DATE,                        -- invoice issue
  fulfillment_date  DATE,                        -- teljesites
  payment_due_date  DATE,                        -- fizetesi hatarido (esedekesseg)
  net_amount        NUMERIC(18,2),
  vat_amount        NUMERIC(18,2),
  gross_amount      NUMERIC(18,2),
  net_amount_huf    NUMERIC(18,2),
  gross_amount_huf  NUMERIC(18,2),
  currency          TEXT,
  payment_method    TEXT,                        -- TRANSFER|CASH|CARD|VOUCHER|OTHER
  invoice_category  TEXT,                        -- NORMAL|SIMPLIFIED|AGGREGATE
  invoice_appearance TEXT,
  ins_date          TIMESTAMPTZ,                 -- NAV insertion ts (sync high-water)
  raw_digest        JSONB,                       -- full digest object (audit/future)
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (direction, invoice_number, invoice_operation)
);
CREATE INDEX IF NOT EXISTS idx_invoices_issue   ON invoices (issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_fulfil  ON invoices (fulfillment_date);
CREATE INDEX IF NOT EXISTS idx_invoices_due     ON invoices (payment_due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_dir     ON invoices (direction);
CREATE INDEX IF NOT EXISTS idx_invoices_partner ON invoices (partner_name);

-- Per-direction high-water mark for incremental sync.
CREATE TABLE IF NOT EXISTS sync_state (
  direction       TEXT PRIMARY KEY CHECK (direction IN ('INBOUND','OUTBOUND')),
  last_ins_date   TIMESTAMPTZ,                   -- last processed insDate -- resume here
  last_run_at     TIMESTAMPTZ,
  last_status     TEXT,                          -- ok | error: <msg>
  rows_upserted   INTEGER DEFAULT 0
);
INSERT INTO sync_state (direction) VALUES ('INBOUND'),('OUTBOUND')
  ON CONFLICT (direction) DO NOTHING;

-- Esedekesseg-tengely (mikor JAR LE a fizetes) -- the truer "expected cashflow"
-- axis (Krisztian: "mikor hogyan alakulnak a penzeszkozeink"). v1 PRIMARY chart.
CREATE OR REPLACE VIEW v_cashflow_due_monthly AS
  SELECT date_trunc('month', payment_due_date) AS month,
         direction,
         SUM(gross_amount_huf) AS gross_huf,
         COUNT(*) AS invoice_count
  FROM invoices
  WHERE invoice_operation IS DISTINCT FROM 'STORNO'
  GROUP BY 1,2;

-- Teljesites-tengely (mikor teljesult a szamla). Secondary parallel view.
CREATE OR REPLACE VIEW v_cashflow_monthly AS
  SELECT date_trunc('month', fulfillment_date) AS month,
         direction,
         SUM(gross_amount_huf) AS gross_huf,
         COUNT(*) AS invoice_count
  FROM invoices
  WHERE invoice_operation IS DISTINCT FROM 'STORNO'
  GROUP BY 1,2;

-- Nagy kiadasok (bejovo szamlak osszeg szerint).
CREATE OR REPLACE VIEW v_large_expenses AS
  SELECT issue_date, partner_name, gross_amount_huf, currency, invoice_number
  FROM invoices
  WHERE direction='INBOUND' AND invoice_operation IS DISTINCT FROM 'STORNO'
  ORDER BY gross_amount_huf DESC NULLS LAST;
