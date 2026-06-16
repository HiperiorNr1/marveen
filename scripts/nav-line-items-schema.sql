-- NAV line-items (tetelsorok) schema -- target DB: nav_invoices (efi-analytics-db).
-- Load after the base schema:
--   psql "postgresql://navsync:***@172.19.250.10:5433/nav_invoices" -f scripts/nav-line-items-schema.sql
-- Idempotent. Plan: docs/plans/nav-line-items-2026-06-16.md.

-- One row per invoice line, from queryInvoiceData. NO formal FK (the invoices
-- key is (direction, invoice_number, invoice_operation); a clean composite-FK
-- is non-trivial). Every operation's lines are stored -- a STORNO comes with its
-- own invoice_number and NEGATIVE-signed amounts (verified live), so product
-- views net it via a plain SUM.
CREATE TABLE IF NOT EXISTS invoice_lines (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction        TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  invoice_number   TEXT NOT NULL,
  line_number      INTEGER NOT NULL,
  line_nature      TEXT,                   -- PRODUCT | SERVICE | OTHER
  description      TEXT,                   -- lineDescription
  product_codes    JSONB,                  -- productCodes (OWN/VTSZ/SZJ/...)
  quantity         NUMERIC(18,4),
  unit_of_measure  TEXT,
  unit_price_huf   NUMERIC(18,4),
  net_amount_huf   NUMERIC(18,2),
  vat_rate         NUMERIC(6,4),           -- normalized vatPercentage (0.27)
  vat_amount_huf   NUMERIC(18,2),
  gross_amount_huf NUMERIC(18,2),
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (direction, invoice_number, line_number)
);
CREATE INDEX IF NOT EXISTS idx_lines_invoice ON invoice_lines (direction, invoice_number);
CREATE INDEX IF NOT EXISTS idx_lines_desc    ON invoice_lines (description);
CREATE INDEX IF NOT EXISTS idx_lines_nature  ON invoice_lines (line_nature);

-- Resumable line-fetch state on the digest rows: NULL = not yet fetched.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS lines_fetched_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_invoices_lines_pending
  ON invoices (direction, ins_date) WHERE lines_fetched_at IS NULL;

-- Product/description spend. STORNO lines are negative-signed, so a plain SUM
-- nets original + storno to the real figure -- NO operation filter needed here.
CREATE OR REPLACE VIEW v_product_spend AS
  SELECT direction,
         description,
         SUM(gross_amount_huf) AS gross_huf,
         SUM(net_amount_huf)   AS net_huf,
         SUM(quantity)         AS quantity,
         count(*)              AS line_count
  FROM invoice_lines
  GROUP BY direction, description;

-- Material (PRODUCT) vs labour/service (SERVICE) split.
CREATE OR REPLACE VIEW v_line_nature AS
  SELECT direction,
         line_nature,
         SUM(gross_amount_huf) AS gross_huf,
         count(*)              AS line_count
  FROM invoice_lines
  GROUP BY direction, line_nature;

-- VAT-rate breakdown (0.27 / 0.05 / 0 / ...).
CREATE OR REPLACE VIEW v_vat_breakdown AS
  SELECT direction,
         vat_rate,
         SUM(net_amount_huf)   AS net_huf,
         SUM(vat_amount_huf)   AS vat_huf,
         SUM(gross_amount_huf) AS gross_huf,
         count(*)              AS line_count
  FROM invoice_lines
  GROUP BY direction, vat_rate;
