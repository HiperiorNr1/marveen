# NAV cashflow-dashboard -- terv (2026-06-15)

Status: PLANNING-FIRST. Nincs kod. EFiveen review -> Krisztian GO. Csak utana kod.

CEL: ceges varhato bevetel/kiadas/cashflow idosor a NAV szamla-adatbol
(OUTBOUND=kimeno=bevetel, INBOUND=bejovo=kiadas), nagy kiadasok, allando
koltsegek. Referencia: Kulcs-Szoft penzkeszlet-diagram (idosoros + szuros).
CAVEAT (a dashboardon is feltuntetendo): NAV = szamlazott/esedekes nezet, NEM
valos banki egyenleg. A "cashflow" itt szamlazasi varhato penzmozgas.

Forras-memoriak: id 301 (architektura), 297 (vault+scope), 296 (MCP security
review). NavClient interfész a Szotasz/nav-online-invoice-mcp repobol verifikalva.

---

## 0. TET-IGENYLO -- Krisztian MOST (helyben elerheto), elore hozva

Ezek BLOKKOLJAK a tovabbi munkat es Krisztian jelenletet igenylik. Sorrendben:

- **[K1] efi-analytics stack deploy a Portainerben (ESXi)** -- az 1. szekcio
  compose-aval. Click-through lent.
- **[K2] Halozati eleresi adatok (3. szekcio kritikus fuggosege):** az ESXi-host
  LAN-IP-je, a efi-analytics-db publikalt portja (javaslat 5433, hogy ne usse az
  odoo_db 5432-t), tuzfal Marveen-host -> ESXi:5433, es egy sync-DB user+jelszo.
- **[K3] NAV TEST-credek validacioja:** a vault 5 titka (nav_login, nav_password,
  nav_tax_number, nav_signature_key, nav_exchange_key) a NAV TEST-kornyezetre
  ervenyes-e (token-exchange a test API-n). Ha a vault-titkok a productionre
  szolnak, kell egy test-technikai-user a NAV test-fiokban.
- **[K4] Metabase first-run admin** -- a Metabase elso inditasanal browserben
  admin-user wizard (csak Krisztian tudja beallitani a jelszot).

Minden tovabbi (sync-script, schema-betoltes, Metabase-grafikon) ezek utan,
Krisztian tavolleteben is megy.

---

## 1. docker-compose: efi-analytics stack (postgres + metabase)

Uj IZOLALT stack a Portainerben, neve `efi-analytics` (altalanos BI-platform;
a NAV csak az elso dataset benne -- a postgres-ben kesobb tobb DB is johet).
Sajat halozat, sajat
volume, KULON az odoo-stacktol. Egyetlen postgres instance ket DB-vel:
`nav_invoices` (a szamla-adat) + `metabase_app` (a Metabase sajat metadat-tara,
hogy egy helyen legyen es egyutt mentodjon).

```yaml
# Portainer -> Stacks -> Add stack -> name: efi-analytics -> Web editor -> paste
version: "3.8"

services:
  efi-analytics-db:
    image: postgres:15-alpine
    container_name: efi-analytics-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${NAVDB_USER}            # Portainer env (lent)
      POSTGRES_PASSWORD: ${NAVDB_PASSWORD}
      POSTGRES_DB: nav_invoices
    volumes:
      - analytics_db_data:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro   # metabase_app DB + schema seed
    ports:
      - "5433:5432"        # [K2] kifele publikalva, hogy a Marveen-host elerje
    networks: [efi-analytics-net]

  efi-analytics-metabase:
    image: metabase/metabase:v0.50.21        # PINELT verzio (ne :latest)
    container_name: efi-analytics-metabase
    restart: unless-stopped
    depends_on: [efi-analytics-db]
    environment:
      MB_DB_TYPE: postgres
      MB_DB_DBNAME: metabase_app
      MB_DB_PORT: 5432
      MB_DB_USER: ${NAVDB_USER}
      MB_DB_PASS: ${NAVDB_PASSWORD}
      MB_DB_HOST: efi-analytics-db
    ports:
      - "3001:3000"        # dashboard UI; host 3001 (3000 gyakran foglalt)
    networks: [efi-analytics-net]

volumes:
  analytics_db_data:

networks:
  efi-analytics-net:
    driver: bridge
```

Portainer env-valtozok (Stack -> Environment variables, NEM a compose-ba beegetve):
`NAVDB_USER`, `NAVDB_PASSWORD` (ezek a postgres-superuser; a sync ezt hasznalja
a [K2]-ben). A NAV-credek NEM ide jonnek -- azok a Marveen vaultban maradnak.

initdb seed (`./initdb/01-init.sql`, a 2. szekcio schema-ja + a metabase_app DB
letrehozasa). Krisztiannak: a stack-konyvtarba kell tenni az initdb mappat, VAGY
egyszerubb: a stacket deploy utan kezzel toltjuk be a schemat (3. szekcio teszt-
lepes), es a metabase_app DB-t egy `CREATE DATABASE metabase_app;`-pal. Javaslat:
kezi schema-betoltes, hogy ne kelljen fajlt masolnia az ESXi-re.

**[K1] Click-through Krisztiannak:**
1. Portainer -> Stacks -> + Add stack -> Name: `efi-analytics`.
2. Web editor -> a fenti YAML beillesztese.
3. Environment variables -> add: NAVDB_USER (pl. navsync), NAVDB_PASSWORD (eros).
4. Deploy the stack.
5. Ellenorzes: efi-analytics-db + efi-analytics-metabase containers "running".
6. metabase_app DB letrehozas (Portainer -> efi-analytics-db -> Console / exec):
   `psql -U navsync -d nav_invoices -c "CREATE DATABASE metabase_app;"`
   (a Metabase enelkul nem indul el rendesen -> a [K4] elott kell).

---

## 2. postgres schema (nav_invoices DB)

A Metabase idosoros + szuros nezetekhez. Digest-szintu adat eleg a cashflow-hoz
(a queryInvoiceDigest mar ad osszegeket; per-szamla tetelsor NEM kell a v1-hez).

```sql
-- invoices: egy sor / digest-talalat. Az upsert kulcs az idempotens sync-hez.
CREATE TABLE invoices (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction         TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  invoice_number    TEXT NOT NULL,
  invoice_operation TEXT,                 -- CREATE | MODIFY | STORNO
  original_invoice_number TEXT,           -- STORNO/MODIFY eseten az eredeti
  partner_name      TEXT,
  partner_tax_number TEXT,
  issue_date        DATE,                 -- szamla kiallitas
  fulfillment_date  DATE,                 -- teljesites (cashflow-hoz fontos)
  payment_due_date  DATE,                 -- fizetesi hatarido (esedekesseg)
  net_amount        NUMERIC(18,2),
  vat_amount        NUMERIC(18,2),
  gross_amount      NUMERIC(18,2),
  net_amount_huf    NUMERIC(18,2),
  gross_amount_huf  NUMERIC(18,2),
  currency          TEXT,
  payment_method    TEXT,                 -- TRANSFER|CASH|CARD|VOUCHER|OTHER
  invoice_category  TEXT,                 -- NORMAL|SIMPLIFIED|AGGREGATE
  invoice_appearance TEXT,
  ins_date          TIMESTAMPTZ,          -- NAV-beemeles idopontja (sync high-water)
  raw_digest        JSONB,                -- a teljes digest-objektum (audit/jovore)
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (direction, invoice_number, invoice_operation)
);
CREATE INDEX idx_invoices_issue ON invoices (issue_date);
CREATE INDEX idx_invoices_fulfil ON invoices (fulfillment_date);
CREATE INDEX idx_invoices_due ON invoices (payment_due_date);
CREATE INDEX idx_invoices_dir ON invoices (direction);
CREATE INDEX idx_invoices_partner ON invoices (partner_name);

-- sync_state: per-irany high-water mark az inkrementalis synchez.
CREATE TABLE sync_state (
  direction       TEXT PRIMARY KEY CHECK (direction IN ('INBOUND','OUTBOUND')),
  last_ins_date   TIMESTAMPTZ,           -- eddig bekerult (insDate) -- innen folytat
  last_run_at     TIMESTAMPTZ,
  last_status     TEXT,                  -- ok | error: <msg>
  rows_upserted   INTEGER DEFAULT 0
);
INSERT INTO sync_state (direction) VALUES ('INBOUND'),('OUTBOUND');

-- Metabase-barat nezetek (a grafikonok ezekre epulnek):
-- Teljesites-tengely (mikor teljesult a szamla).
CREATE VIEW v_cashflow_monthly AS
  SELECT date_trunc('month', fulfillment_date) AS month,
         direction,
         SUM(gross_amount_huf) AS gross_huf,
         COUNT(*) AS invoice_count
  FROM invoices
  WHERE invoice_operation IS DISTINCT FROM 'STORNO'
  GROUP BY 1,2;

-- Esedekesseg-tengely (mikor JAR LE a fizetes) -- ez a "varhato cashflow"
-- igazabb tengelye (Krisztian: "mikor hogyan alakulnak a penzeszkozeink").
-- A v1 elsodleges cashflow-grafikonja ERRE epul; a teljesites-nezet megmarad.
CREATE VIEW v_cashflow_due_monthly AS
  SELECT date_trunc('month', payment_due_date) AS month,
         direction,
         SUM(gross_amount_huf) AS gross_huf,
         COUNT(*) AS invoice_count
  FROM invoices
  WHERE invoice_operation IS DISTINCT FROM 'STORNO'
  GROUP BY 1,2;

CREATE VIEW v_large_expenses AS
  SELECT issue_date, partner_name, gross_amount_huf, currency, invoice_number
  FROM invoices
  WHERE direction='INBOUND' AND invoice_operation IS DISTINCT FROM 'STORNO'
  ORDER BY gross_amount_huf DESC;
```

Megjegyzes a STORNO/MODIFY kezelesere: a digest minden operaciot kulon sorként
ad (invoiceOperation). Az UNIQUE(direction, invoice_number, invoice_operation)
megengedi a CREATE + STORNO egyutteles. A nezetek a STORNO-t kihagyjak; a netto
cashflow-hoz egy kesobbi iteracio finomithatja (STORNO-parok kivonasa). v1: a
nyers operacios sorok + a STORNO-szures eleg.

---

## 3. NAV-sync scheduled-task (zero-LLM, zero-token)

Mechanizmus: Marveen `type='command'` scheduled-task (scheduled-tasks-io.ts: a
command-tipus `bash -lc`-vel futtat nyers parancsot, NINCS LLM/tmux/token,
timeoutMs + failThreshold + command-task-health.json). NEM kontener.

A repo helye a gepen: `git clone Szotasz/nav-online-invoice-mcp` ->
`/home/efi/marveen/vendor/nav-online-invoice-mcp`, `bun install` + build. A
NavClient KONYVTARKENT importalhato (verifikalt export):
`new NavClient(config: NavConfig)`, majd
`queryInvoiceDigest({ page, invoiceDirection, insDateTimeFrom, insDateTimeTo, ... })`.

Sync-script (kesobb irando, NEM most): `/home/efi/marveen/scripts/nav-sync.ts`,
bun-nal fut. Vazlat:
1. NavConfig osszeallitasa: getSecret('nav_login'|'nav_password'|'nav_tax_number'|
   'nav_signature_key'|'nav_exchange_key') a Marveen vaultbol; baseUrl a NAV_ENV
   szerint (test/prod); software* mezok (lasd nyitott kerdes Q1).
2. Mindket iranyra (INBOUND, OUTBOUND): a sync_state.last_ins_date-tol now()-ig
   insDate-ablakban lapozva (queryInvoiceDigest page=1..N), max 35 napos ablakokra
   darabolva (NAV insDate-range limit), elso futasnal historikus backfill tobb
   ablakban.
3. Minden digest-sort upsert a nav_invoices.invoices-ba (pg client, ON CONFLICT
   (direction, invoice_number, invoice_operation) DO UPDATE), raw_digest=jsonb.
4. sync_state frissites: last_ins_date = a futas legkesobbi feldolgozott insDate-je
   (CSAK siker eseten lep elore), last_run_at, last_status, rows_upserted.
5. Hibakezeles: token-exchange / API hiba / pg hiba -> nem lepteti a high-watert,
   last_status='error: ...', nem-nulla exit -> a command-task failThreshold (pl. 2)
   utan Telegram-alert. Reszleges lap-hiba: az addigi sorok commitolva, a high-water
   csak a biztosan-feldolgozott pontig.

task-config.json (a scheduled-task regisztracio, /api/schedules-en at):
```json
{
  "name": "nav-cashflow-sync",
  "type": "command",
  "command": "cd /home/efi/marveen && bun run scripts/nav-sync.ts",
  "schedule": "0 */6 * * *",
  "timeoutMs": 120000,
  "failThreshold": 2,
  "agent": "dev"
}
```
Cron-javaslat: 6 oranként (a NAV-adat nem valos-ideju; a cashflow-nezethez boven
eleg). Manualis "run now" a dashboardrol elerheto. A 6 oras kezdetet kerulje a
0:00-t, hogy ne essen egybe az ejszakai pg_dump backuppal.

Halozati cel: a sync a efi-analytics-db postgres-be ir az ESXi-n -> a [K2]
fuggoseg (4. szekcio).

Backup: kulon ejszakai `pg_dump nav_invoices` (+ metabase_app) -> NAS DS1621.
Ez lehet egy masik command-scheduled-task VAGY az ESXi-oldali cron; javaslat
Marveen command-task `0 2 * * *`, a dump-ot a NAS-mountra irja. (Reszlet a v1
utan; nem blokkolo.)

---

## 4. Halozati elerhetoseg (KRITIKUS fuggoseg -- [K2])

A sync a Marveen-hoston fut, a postgres az ESXi-n. A kapcsolat:
`Marveen-host --(LAN)--> ESXi-host:5433 (efi-analytics-db publikalt port)`.

Krisztiantol kell ([K2]):
- **ESXi-host LAN-IP-je** (a Marveen-host ugyanazon a LAN-on van-e? ha nem,
  routing/VPN kerdes -- ez deal-breaker, tisztazni kell ELOSZOR).
- A **publikalt port** jovahagyasa (javaslat 5433; az odoo_db 5432-t ne ussuk).
- **Tuzfal**: ESXi-host engedje a Marveen-host fele az 5433-at.
- **postgres hozzaferes**: a compose `ports: 5433:5432` publikal; a postgres:15
  default `listen_addresses='*'` a kontenerben + a docker pg_hba megengedi a
  kulso kapcsolatot. A sync a NAVDB_USER/NAVDB_PASSWORD-del csatlakozik.
- Biztonsag: a publikalt 5432 NE legyen internet-fele nyitva, csak LAN. Ha az
  ESXi-host publikus IP-n is hallgat, a tuzfal szukitse a Marveen-host IP-jere.

Ha a ket host NEM ugyanazon a LAN-on van, alternativa: a sync-script SSH-tunnelen
at ir (mint a remote-agent tmux), vagy a sync maga az ESXi-n fut kontenerben.
Ezt a [K2] valasza donti el -- elso kerdes Krisztianhoz.

---

## 5. Teszt-terv

1. **NAV_ENV=test:** a sync-script token-exchange a NAV TEST API-n a vault-
   credekkel ([K3]). Siker = ervenyes token. Ha hiba: a test-credek rosszak ->
   vissza Krisztianhoz.
2. **Kis ablak lekerdezes:** egy par napos insDate-ablak mindket iranyra,
   queryInvoiceDigest page=1; a digest parse + upsert ellenorzese (par sor a
   nav_invoices.invoices-ban).
3. **Halozat-verify ([K2] utan):** a Marveen-host `psql`/pg-client tud-e
   csatlakozni az ESXi:5433-ra (a sync ezen ir).
4. **Metabase elso grafikon ([K4] utan):** Metabase -> Add database -> postgres
   (efi-analytics-db, nav_invoices) -> egy idosoros cashflow-grafikon a
   v_cashflow_due_monthly-bol (esedekesseg-tengely, gross_huf havonta,
   iranyonkent) -- ez a "varhato cashflow" elsodleges nezete. A
   v_cashflow_monthly (teljesites) parhuzamos masodlagos nezet. Ez az elso
   vizualis validacio.
5. **Production-valtas:** a test-validacio UTAN NAV_ENV=production, historikus
   backfill (tobb insDate-ablak), majd a 6 oras cron eles.

---

## Nyitott kerdesek / dontesek (EFiveen review 2026-06-15)

- **Q1 (software* mezok) -- KRISZTIANHOZ (Telegram #812):** production-fuggoseg
  (EFi NAV szoftver-regisztracio). Test-env valoszinuleg elnezo; tisztazni a
  production-valtas elott.
- **Q2 (ket host egy LAN-on?) -- KRISZTIANHOZ (Telegram #812), SAROKKO:** ez donti
  el a sync->postgres utat (LAN-direct vs SSH-tunnel vs ESXi-oldali sync). A kod
  NEM kezdodhet a Q2 valasza elott.
- **Q3 (Metabase verzio-pin) -- JOVAHAGYVA: v0.50.21.**
- **Q4 (pg_dump -> NAS backup) -- KOVETO ITERACIO (v1 utan azonnal).** Nem blokkolja
  a v1-et: a NAV-adat ujraszinkronizalhato NAV-bol, a postgres ennek cache-e.
- **Q5 (devizas szamlak) -- v1 = HUF.** Eredeti-deviza nezet kesobb, ha kell.

Becsult munkamennyiseg a GO utan: stack-deploy (Krisztian, ~30 perc) + schema +
sync-script + test-validacio ~1 munkanap; production-backfill + Metabase-nezetek
~0.5 nap.
