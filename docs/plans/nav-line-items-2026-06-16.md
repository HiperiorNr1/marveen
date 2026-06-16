# NAV tetelsoros bovites (line items) -- terv (2026-06-16)

Status: PLANNING-FIRST. Nincs kod. EFiveen review -> Krisztian GO. Task #8.

CEL: a teljes szamla-tartalom (tetelsorok) lehuzasa `queryInvoiceData`-val ->
termek/kategoria-szintu koltes-elemzes a Metabase-en. MELLEKHATAS: a SIMPLIFIED
szamlak brutto-ja megoldodik (a digest nem ad osszeget egyszerusitettre, a
queryInvoiceData igen -- lasd a meglevo [[nav-cashflow-dashboard-2026-06-15]]
adatminoseg-szekciot). Forras: a NavClient interfeszt + egy valos szamla
tetelsor-szerkezetet ELOZETESEN verifikaltam (live probe, lent).

---

## 1. NavClient queryInvoiceData interfesz (VERIFIKALVA, live)

`nav.queryInvoiceData(invoiceNumber, invoiceDirection, batchIndex?, supplierTaxNumber?)`
-> `{ result, data, rawXml }`.

- A tetelsorok NEM kozvetlenul a valaszban vannak: `data.invoiceDataResult` =
  `{ invoiceData (BASE64 invoice-XML), auditData, compressedContentIndicator }`.
  A sync-nek DEKODOLNIA kell: base64 -> (ha compressedContentIndicator=true:
  gunzip) -> invoice-XML -> XMLParser (removeNSPrefix, `line` forced-array).
- A dekodolt XML: `InvoiceData -> invoiceMain.invoice ->`
  - `invoiceHead.{supplierInfo, customerInfo, invoiceDetail}`
  - `invoiceLines.line[]` (a tetelsorok)
  - `invoiceSummary.{summaryNormal, summaryGrossData}` (szamla-szintu osszegek
    -- INNEN jon a SIMPLIFIED brutto is).
- Egy `line` mezoi (valos pelda, 12-soros OUTBOUND szamla):
  `lineNumber, productCodes{productCode[]{productCodeCategory, productCodeOwnValue}},
  lineNatureIndicator (PRODUCT|SERVICE|OTHER), lineDescription, quantity,
  unitOfMeasure, unitOfMeasureOwn, unitPrice, unitPriceHUF,
  lineAmountsNormal{ lineNetAmountData{lineNetAmount, lineNetAmountHUF},
  lineVatRate{vatPercentage}, lineVatData{lineVatAmount, lineVatAmountHUF},
  lineGrossAmountData{lineGrossAmountNormal, lineGrossAmountNormalHUF} },
  depositIndicator`.
- BUKTATO (verifikalva): a `supplierTaxNumber` parameter CSAK INBOUND
  (vevo-oldali) lekerdezesben hasznalhato -- OUTBOUND-nal a NAV
  BAD_QUERY_PARAM_SUPPLIER_NOT_EXPECTED-et ad. Tehat OUTBOUND: ne add at;
  INBOUND: a beszallito adoszamaval egyertelmusiteni lehet.
- Egyszerusitett szamla: a `line` `lineAmountsSimplified` (nem `lineAmountsNormal`)
  + a summary `summarySimplified` adja a brutto-t -> ezt kulon kell kezelni a
  mappingben (verifikalando egy valos SIMPLIFIED queryInvoiceData-n a teszt-fazisban).

---

## 2. Per-szamla fetch-ut: MELY szamlakra, mikor (a KRITIKUS scope-dontes)

Volumen: a digest-tabla 11324 szamla -> a teljes tetelsor-backfill 11324
queryInvoiceData-hivas. Ez NAGYSAGREND nagyobb API-terheles mint a digest
(ami lapozva ~120 hivas volt). A NAV rate-limitel; egy -naiv- 11324-hivasos
tight loop kockazatos (throttling, ido).

Javasolt strategia (ketresztu):
- **(A) Inkrementalis, elore:** a nav-sync digest-lepes UTAN, az UJ szamlakra
  (amelyeknek meg nincs tetelsora) queryInvoiceData-t hiv es betolti a
  tetelsorokat. Mivel a 6h-s digest-sync jellemzoen par uj szamlat hoz, ez par
  extra hivas/futas -- olcso. (A 120s task-timeout-ba belefer, vagy capolva.)
- **(B) Historikus backfill, egyszeri, RESUMABLE, RATE-LIMITELT:** kulon command
  (NEM a 6h sync), ami a `lines_fetched=false` szamlakat dolgozza fel kotegelve,
  delay-jel (pl. 200-500ms/hivas), futasonkent capolva (pl. max N=500/futas), es
  a `lines_fetched` flag alapjan folytathatoan. Igy a 11324 tobb futasra oszlik,
  nem terheli tul a NAV-ot, es egy megszakadas nem kezd elolrol.

Scope-dontes Krisztiannak/EFiveen-nek (a tervben javaslat, de ti dontotok):
- **Mindket irany VAGY csak egy?** OUTBOUND (7547) = amit ELADUNK (termek-mix,
  arbevetel-elemzes); INBOUND (3777) = amit VESZUNK (beszallitoi koltes,
  kategoria-koltsegek). Krisztian celja (cegelemzes) valoszinuleg MINDKETTO, de
  ha priorizalni kell, az INBOUND (koltes) + a SIMPLIFIED-gross-fix az elso.
- **Historikus melyseg:** mind a 24 honap, vagy eleg pl. 12 honap a tetelsorokra?
  (A digest marad 24 honap; a tetelsor-backfill horizontja szukebb is lehet.)

---

## 3. postgres line-item child-tabla sema

```sql
CREATE TABLE invoice_lines (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction        TEXT NOT NULL,
  invoice_number   TEXT NOT NULL,
  line_number      INTEGER NOT NULL,
  line_nature      TEXT,                 -- PRODUCT | SERVICE | OTHER
  description      TEXT,                 -- lineDescription
  product_codes    JSONB,               -- productCodes (OWN/VTSZ/SZJ/stb.)
  quantity         NUMERIC(18,4),
  unit_of_measure  TEXT,                 -- unitOfMeasure / unitOfMeasureOwn
  unit_price_huf   NUMERIC(18,4),
  net_amount_huf   NUMERIC(18,2),
  vat_rate         NUMERIC(6,4),         -- vatPercentage (0.27)
  vat_amount_huf   NUMERIC(18,2),
  gross_amount_huf NUMERIC(18,2),
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (direction, invoice_number, line_number)
  -- NINCS formal FOREIGN KEY v1-ben (EFiveen review): az invoices UNIQUE-ja
  -- (direction, invoice_number, invoice_operation), egy tiszta composite-FK nem
  -- trivialis. A UNIQUE + indexek elegendoek; az integritast a fetch-logika
  -- tartja. MINDEN operacio (CREATE/MODIFY/STORNO) tetelsorai bekerulnek -- a
  -- sztorno sajat invoice_number-rel jon, igy nincs utkozes, es a termek-nezet
  -- a sztornoval nettoz (Q4, Krisztian uzleti korrekcio).
);
CREATE INDEX idx_lines_invoice ON invoice_lines (direction, invoice_number);
CREATE INDEX idx_lines_desc ON invoice_lines (description);
CREATE INDEX idx_lines_nature ON invoice_lines (line_nature);

-- fetch-allapot az invoices-on (resumable backfill + duplikacio-elkerules):
ALTER TABLE invoices ADD COLUMN lines_fetched_at TIMESTAMPTZ;  -- NULL = meg nincs tetelsor
```

Upsert: `ON CONFLICT (direction, invoice_number, line_number) DO UPDATE`. A
tetelsor-fetch utan az `invoices.lines_fetched_at = now()` + (SIMPLIFIED eseten)
a hianyzo `invoices.gross_amount_huf` kitoltese a summary-bol.

---

## 4. Illeszkedes a meglevo nav-sync inkrementalis logikahoz

- A digest-sync (scripts/nav-sync.ts) VALTOZATLAN marad (gyors, mind a 11324,
  insDate high-water). A tetelsor-fetch KULON modul/fuggveny.
- **Inkrementalis (A):** a syncDirection upsert-loopja utan, az ebben a futasban
  ujonnan beirt (vagy `lines_fetched_at IS NULL`) szamlakra fetchLineItems().
  Cap: max N/futas, hogy a 6h task ne nyuljon tul (120s timeout). A maradek a
  kovetkezo futasban / a backfill-commandben.
- **Historikus backfill (B):** uj command (pl. scripts/nav-line-backfill.ts) VAGY
  egy `NAV_FETCH_LINES=1` mod a nav-sync-ben, ami a `lines_fetched_at IS NULL`
  sorokon megy vegig kotegelve+delay-jel, capolva, resumable. Kulon (ritka)
  scheduled-task VAGY kezi futtatas, amig fel nem tolt.
- Hibakezeles: per-szamla fetch hiba -> a szamla `lines_fetched_at` marad NULL
  (ujraprobalhato), nem tori meg a tobbit; NAV-throttling eseten exponential
  backoff / a futas leallitasa (a resumable flag miatt biztonsagos).
- A fetch MINDEN invoices-sort dolgoz (CREATE/MODIFY/STORNO is) -- a
  `lines_fetched_at` per-sor van, es a sztorno sajat invoice_number-rel kulon sor,
  igy a tetelei is bejonnek (Q4). NINCS invoice_operation-szures.

---

## 5. Metabase-nezetek (ebbol jonnek)

- `v_product_spend` -- termek/megnevezes szerinti koltes: `GROUP BY direction,
  description` (vagy a normalizalt productCode), `SUM(gross_amount_huf)`,
  `SUM(quantity)`. Top vasarolt (INBOUND) / eladott (OUTBOUND) termekek. A STORNO
  tetelsorai BENNE vannak es NETTOZNAK az eredetivel -> a SUM-keplet a sztorno
  elojel-konvenciojatol fugg (6./teszt verify): negativ-elojelu sztorno -> sima
  SUM nettoz; pozitiv+sztorno-jelzes -> a nezet a STORNO sorokat KIVONJA. (A
  cashflow-gross nezetek WHERE op!=STORNO VALTOZATLANOK -- ez csak a tetelsoros
  termek-nezeteket erinti.)
- `v_line_nature` -- PRODUCT vs SERVICE bontas (anyag vs munkadij/szolgaltatas).
- `v_vat_breakdown` -- afa-kulcs szerinti bontas (0.27 / 0.05 / 0 stb.).
- (Lehetseges kesobb: kategoria-mapping a productCodes/VTSZ alapjan -- de az
  uzleti kategorizalas Krisztian/Odoo-tamogato asztala, nem a tieM.)
- A SIMPLIFIED-gross-fix a v_cashflow_due_monthly alulszamolast is megszunteti.

---

## 6. Teszt-terv

1. queryInvoiceData DEKODOLAS verifikalas par valos szamlan: OUTBOUND (NORMAL,
   tobb-soros), INBOUND (NORMAL), egy SIMPLIFIED, es egy STORNO -> a line +
   summary mezok parse-olasa, a lineAmountsNormal VS lineAmountsSimplified
   kulonbseg leigazolasa, compressedContentIndicator=true eset (gunzip) kezelese.
1b. STORNO ELOJEL-KONVENCIO (a v_product_spend keplet feltetele): egy VALOS
   STORNO queryInvoiceData tetel-osszegei NEGATIV elojeluek-e (akkor sima SUM
   nettoz) VAGY pozitivak sztorno-jelzessel (akkor a nezet kivonja a STORNO
   sorokat). A megfigyeles donti el az 5. nezet-kepletet.
2. invoice_lines sema betoltes + upsert-ellenorzes par szamlara (line_number
   UNIQUE, gross=net+vat egyezes a summary-val).
3. SIMPLIFIED-gross: egy SIMPLIFIED szamla queryInvoiceData-jabol a summary-brutto
   -> invoices.gross_amount_huf kitoltese, a v_cashflow_due_monthly null-bucket
   csokkenese.
4. Inkrementalis (A) smoke: 1-2 uj szamla tetelsorai a sync utan.
5. Backfill (B) kis koteg (pl. 50 szamla) rate-limitelt futasa, resumability
   (lines_fetched_at flag) ellenorzese.
6. Metabase: egy termek-koltes grafikon (v_product_spend top 20).

---

## Dontesek (EFiveen review 2026-06-16, Krisztian GO-ra var)

- **Q1 (irany-scope) -> INBOUND ELOSZOR.** A "mire koltunk" + a simplified-gross-fix
  az azonnali ertek, es a supplierTaxNumber-egyertelmusites is INBOUND-on megy.
  OUTBOUND utana.
- **Q2 (historikus melyseg) -> 12 HONAP kezdetben, PARAMETEREZHETO horizont,**
  amit a resumable backfill menet kozben FOLYAMATOSAN tol vissza a regebbi
  szamlakra (Krisztian). A backfill-command horizont-parametere allithato (kezd
  12ho, fokozatosan bovul). A digest marad 24 honap.
- **Q3 (backfill-utem) -> ovatosan: 300-500ms/hivas + cap/futas (pl. 200-500),**
  throttling-HIBAKOD-figyeles + exponential backoff, meresre allitva. A NAV
  pontos rate-limitje ismeretlen (FAQ JS-rendelt, Krisztian sem tudja) -> NEM
  tippelunk, a hibakodra reagalunk.
- **Q4 (MODIFY/STORNO tetelsorok) -> REVIDEALVA (Krisztian uzleti korrekcio):
  MINDEN operacio (CREATE/MODIFY/STORNO) tetelsorait le kell huzni, NEM csak a
  CREATE-et.** Indok: inkrementalis syncben a sztorno FO-adata bejon, de tetelei
  nelkul a termek/mennyiseg-nezet TULSZAMOL (a sztorno nem negalja az eredetit a
  tetel-szinten). MECHANIZMUS: a sztorno kulon szamla (sajat invoice_number,
  originalInvoiceNumber-re hivatkozik) -> tetelei a sajat invoice_number alatt
  mennek be, NINCS UNIQUE-utkozes. A termek-nezetek NETTOZNAK (eredeti + sztorno).
  -> a line-fetch NEM szur invoice_operation-re. TESZT-FAZIS VERIFY (lasd 6.): egy
  VALOS STORNO queryInvoiceData-n nezni, a sztorno tetel-osszegei NEGATIV
  elojeluek-e (akkor sima SUM nettoz) VAGY pozitivak sztorno-jelzessel (akkor a
  nezetben kivonni kell) -- ettol fugg a v_product_spend keplete.
- **Q5 (kategorizalas) -> nyers description + productCode a DB-be;** az uzleti
  termek->kategoria mapping KULON (Krisztian/Odoo-tamogato). ELFOGADVA.

Becsult munka a GO utan: sema + queryInvoiceData-dekoder + line-mapping +
inkrementalis-ut + backfill-command + tesztek ~1-1.5 munkanap; a historikus
backfill futasa (rate-limit miatt) tobb ora/nap hattermunka.
