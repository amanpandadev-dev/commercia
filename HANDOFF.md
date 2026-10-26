# Commercia — Handoff

*13 Oct 2026 · branch `claude/new-session-uplywj` (3 commits, no PR yet)*

This note is for whoever picks up Commercia next. It covers what's built, how it fits together, what's left, and what to watch out for. Read it alongside `README.md`, which covers setup and how to use the app, and the PRD, *Commercia — Product Requirements v1*. The requirement IDs below (BILL-3, RATE-6…) are the PRD's.

---

## 1. Where things stand

**Built.** The app has every Release 1 **Must** item, a good share of the Release 1.1 **Should** items, and a few **Could** items. Section 4 has the full list.

**Verified:**

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` (SQLite, in memory) | 63 / 63 pass |
| `npm run test:pg` (Postgres 16) | the same 63 / 63 pass |
| `npm run build` | builds |
| End-to-end in headless Chromium, with demo data | login; a keyboard-only walk-in bill with A4 and thermal print; a credit tax invoice with a split payment; receiving a payment in the ledger; a CSV dues import; the Hindi switch; billing on a 360 px phone. No console errors, and no page scrolls sideways at 360 px. |
| `move-to-postgres` on the demo database | all 24 tables copied. Stock, dues, sales and payment totals are identical. After the move, a new bill on Postgres got id 52 and number `R/26-27/0044`, so numbering continues. |

**Not yet done in the real world.** Nothing has run on the shop's own laptop. Nobody at the shop has used it yet, and no real product list or khata has been imported. The PRD's go-live gate needs all three, plus a backup-restore check.

---

## 2. Run it

```bash
npm install
npm run seed:demo        # optional: the demo shop from the video
npm start                # build + serve on http://localhost:8787 (and the shop Wi-Fi address)
npm run dev              # development: API on :8787 with reload, Vite on :5173
```

The demo logins use password `demo1234`:

- `ramesh@shop.in` — Admin. The Admin also has every Owner right.
- `amit@shop.in` — Entry person.

The seed switches authenticator codes off. A fresh install leaves them on.

**On Windows** (the shop laptop), no terminal is needed. Download the repo (**Code → Download ZIP** works if `git clone` fails), unzip it, and double-click:

- `setup.bat`: checks Node.js, installs packages, builds, and offers to load the demo shop. Run it once, and again after each update.
- `start.bat`: starts Commercia and opens it in the browser. Keep its window open while the shop uses the app.

The data lives in `data/commercia.db`. Set `COMMERCIA_DB` to put it elsewhere, or `DATABASE_URL=postgres://…` to run on Postgres instead. `data/` and `backups/` are gitignored.

---

## 3. How it's built

| Layer | Choice | Why |
| --- | --- | --- |
| API | **Hono** (`server/app.ts`) on Node (`server/index.ts`) | Small, and the same code runs on Cloudflare Workers later |
| Database access | **Kysely** query builder, with **better-sqlite3** for the pilot and **pg** for Supabase | One set of queries for both databases (PILOT-3) |
| Screens | **React 19 + Vite**, react-router, lucide icons, Poppins (bundled, so it works offline) | Phone first; no UI library to fight with |
| Validation | zod, on every request body | |
| Spreadsheets | exceljs (.xlsx), plus its own CSV parser | .xls isn't supported (see §6) |
| Tests | vitest | `tests/api.test.ts` drives the real HTTP API |

```
shared/        Rules used by both server and screens:
               gst.ts (totals, GST, round-off, print type), money.ts (paise, ₹ formatting),
               units.ts (bags ↔ kg, pack kinds, "12 × Bag 50 kg + 7 kg"), search.ts (fuzzy search),
               perms.ts (the single permission table), dates.ts (India time)
server/db/     schema.ts (types), migrate.ts (tables, indexes, append-only triggers), index.ts (open SQLite or Postgres)
               ← the only database-specific code
server/lib/    suppliers.ts (purchase ledger, supplier payments), billing.ts (create, cancel, rate correction, payments), rates.ts (dated prices, approval requests),
               catalog.ts (price/GST on a date, stock, catalogue snapshot), importer.ts (preview/commit/undo),
               backup.ts, settings.ts, crypto.ts (scrypt, TOTP), core.ts (errors, need(), activity log, versions, counters)
server/routes/ auth, catalog (products, categories, rates), sales (bills, customers, payments, cash-outs),
               stock (stock in, adjust, losses), suppliers (purchase ledger), reports (dashboard, day book, GST, registers), admin (import, settings, backup, export, reset)
server/scripts/ seed-demo.ts, move-to-postgres.ts
web/src/       pages/ (one file per screen), components/ (ui, Layout, ProductForm, CustomerForm, BillDoc), state.tsx, i18n.ts
```

### Rules worth knowing before you change anything

- **Units of storage.** Money is whole **paise**. Quantities are **thousandths** of the base unit (2.5 kg = `2500`). GST rates are **basis points** (5% = `500`). Never store floats.
- **Stock is never stored.** It is `SUM(stock_movements.qty_milli)` per product. Every change to stock is a new movement row: sale, sale_cancel, stock_in, import, adjustment, loss, loss_reversal.
- **Prices and GST rates are dated.** They live in `unit_prices(unit_id, list, from_date)` and `product_gst(product_id, from_date)`. Look them up with `priceOn()` / `gstOn()`, using the bill's date, not today. A unit's *first* price is back-dated to `2000-01-01`, so paper bills typed in later still get a rate.
- **Bills copy what they need.** Each bill line keeps its own name, unit, conversion, rate, GST rate and amounts (RATE-1), so later changes to products never touch a saved bill.
- **Append-only tables.** The database refuses UPDATE and DELETE on `activity`, `versions`, `ledger` and `payment_parts`: SQLite triggers, a Postgres trigger function. Make corrections with reversal rows (`reversePayment`, `cancelBill`, loss reversals). The only way round this is the Admin's "reset test data", which sets `__allow_purge` inside one transaction.
- **Permissions.** Every route that changes data calls `need(c, 'perm')` from `server/lib/core.ts`, which checks `shared/perms.ts` and logs refusals. Add new permissions to that table, nowhere else.
- **History.** Changes to products, customers, bills and losses call `saveVersion()`. Anything that changes data should also call `logActivity()`.
- **Bill numbers.** `nextCounter()` is one atomic `UPDATE … RETURNING` per series and financial year (`invoice:26-27`). It's safe under concurrent saves on both databases.
- **Rate approvals (RATE-5/6, open question 6).** An Entry person's different rate is saved on the bill as typed, and a `rate_requests` row is created. **Approve** makes it official from that date. **Reject** lets the Owner give a rate. `correctBillRate()` then rewrites that bill's lines and totals and writes a ledger `correction` row for the difference. The version before the correction is kept.
- **Prices include GST** by default (`settings.prices_include_gst`, stored per bill as `bills.gst_inclusive`). `computeBill(..., {inclusive})` takes the tax back out of the price; `correctBillRate` uses the bill's own flag. The older tests run with it off (`tests/helpers.ts`), the newer ones switch it on.
- **A price typed on a bill line is "this bill only" by default** (`bill_lines.price_override = 1`, set by `oneOff: true` in the API). The item's own price is not touched, nothing goes for approval, and the line keeps the list price in `official_rate_paise`. A real rate change is still available (`oneOff` false: Owners apply it at once, an Entry person's goes to approval). An Entry person's own price puts the bill in the Owners' review list. `correctBillRate()` skips own-price lines.
- **Whole-pack items** (bori, bag, tin, jar, pouch, bottle, pack) have `products.pack_kind`, base unit `pc`, never loose. The kg or litre size is only a label (`pack_size`); the base unit is named after the pack ("Bori 50 kg"). **One product per item × company × pack size**, each with its own price and stock, tied together by `family` (shown as **Item group**: "Sooji") and `brand` (the company). Cartons are an ordinary larger unit ("Carton (12 × 1 L)"). Display helpers are in `shared/units.ts`.
- **Forgot password** (`server/lib/passwordReset.ts`, `mailer.ts`; public `POST /api/auth/forgot` and `/api/auth/reset`; table `password_resets`). One mechanism, two ways to get the code: emailed when `SMTP_URL` is set, else left as a *request* that an Owner/Admin answers with `POST /api/users/:id/reset-code` (shown once). Codes are 8 characters, hashed with the user id, single use, 30 min (email) or 60 min (Owner), five wrong tries kill them, and a new code cancels the old. `/forgot` gives the same answer for any name, allows three requests an hour per person, and falls back to an Owner request if the email can't be sent. A reset sets the password, bumps `session_epoch` (signs them out everywhere) and does **not** touch the authenticator. An Owner cannot reset the Admin (`guardAdmin`), so the Admin's recovery without email is `npm run reset-password -- <email> [--reset-2fa]` on the shop computer.
- **Who can add products.** `catalog.add` is open to the Entry person (a new product with its first price, plus a category for it); a product's name is unique case-insensitively, so duplicates are refused. The Entry person may also upload a **products spreadsheet**, but only to add: a row that matches an existing item by code or name and would change anything is an error (`addOnly()` in `routes/admin.ts`, enforced in preview and commit), unchanged rows are fine, and the whole file is all-or-nothing as usual. Editing a product, changing prices or GST, renaming or moving categories and customer-dues import stay Owner/Admin (`catalog.edit`, `import.customers`). *Undoing* an import is Owner/Admin for anyone's, and the Entry person may undo **their own** (`import.undo.own`), still only while it is the latest. New products are logged in the activity log under the adder's name; there is no "new items to check" list for Owners yet.
- **Add Product form** is a two-step flow (`web/src/components/ProductForm.tsx`): the person first picks Loose / Packet or piece / Bori-bag-tin-pouch, which sets base unit, loose and pack type; only the fields for that kind appear, the price is next to the name, and extras are under *More options*. The kind cannot be changed on an existing product (stock is counted in its unit).
- **Products sheet** (`server/lib/importer.ts`, `server/routes/admin.ts`): the template has exactly eight columns, in this order: Category, Brand, Pack type, Pack size, Pack price, Stock, Reorder at, Aliases (Hindi names). Pack type and Pack size are dropdowns (a hidden `Lists` sheet; each dropdown is written as one range, because ExcelJS otherwise emits overlapping ranges that make Excel "repair" the file, and a test guards that). Everything else is derived: **name** = `derivePackName` (*Sooji — Annapurna 25 kg Bag*; *Toor Dal (loose)* for Loose), **item group** = last part of Category (the first part is the stock-summary group), **Hindi name** = first Devanagari alias, **GST** = `settings.default_gst` (new items only), unit = the pack ("Bag 25 kg"). **Loose** is a word in the sheet, not a stored pack type: Pack size is then 1 kg or 1 L, stock and price are per kg / litre, base unit kg or L. **Pack types** are the built-ins (`PACK_KINDS` in `shared/units.ts`) plus this shop's own in `settings.pack_types`, added with `POST /api/pack-types` (`catalog.add`, so the Entry person can too); an unknown type in a file is one clear error, never auto-added. A column the file does not have never changes an existing item (GST, HSN, Hindi name, type…), so re-uploading the simple sheet cannot wipe details set in the form. A row is matched to an existing item by code, then name, then (for built names) by item + brand + pack type + size, so items added earlier under another name are not duplicated. The fuller 20-column sheet of earlier versions (`advanced` fields in `FIELDS`) still imports. Examples are in `EXAMPLES`, keyed by field; a test imports every one.
- **Stock summary** (`GET /api/reports/stock-summary?asOf=`): column groups = top-level category, a column per `family + pack size`, a row per `brand`. Only products with a pack kind or a family are listed. Past dates sum `stock_movements` up to that day.
- **Stock and dues sheets** (`importer.ts`, template route in `routes/admin.ts`). *Stock deliveries*: Date, Supplier (required), Product, Quantity, Unit, Purchase rate per unit, Amount. Dropdowns (hidden `Lists` sheet, one column per list; warning-style except the rate's number check) for Product, Supplier, Quantity and Unit; **Amount** is a formula `ROUND(Qty × Rate, 2)` in rows 2–500, with `fullCalcOnLoad`, plus a total on the Instructions sheet. The importer never reads Amount: it works `lineTotalPaise()` out itself and puts it in the preview. Rows with the same supplier and date are one delivery (`saveStockIn`), whose total (= `stock_ins.amount_paise`) becomes one `purchase` row on `supplier_ledger`, and the preview shows the sum per supplier. Undo reverses each such row (append-only, so a `reversal` row with `ref_type='import'`), and hides suppliers the import made if nothing else touched them. A unit can be a pack word (`Bori`), kg/L/pc, the exact unit name, or the first word of one bigger unit (`Carton`). *Dues*: a **Type** column (`Sale` = customer, `Purchase` = supplier; empty = Sale, so old files work). Sale rows are as before. Purchase rows find or create a supplier by name (phone and area only) and write an `opening` row on `supplier_ledger` (owed if positive, paid if negative, dated "as on"); an existing supplier gets the same opening row **unless they already have a live opening balance** (`suppliersWithOpening()` in `lib/suppliers.ts`; one reversed by an undone import does not count), so a stock file loaded first doesn't block the amount and a second upload of the same file doesn't add it twice. Customers are still details-only. A customer and a supplier may share a name. `UndoData.createdSuppliers/updatedSuppliers` undo them. No schema change was needed: `supplier_ledger`, `stock_ins.amount_paise` and `kind='opening'` already existed.
- **Items under the ledgers** (`server/lib/itemSummary.ts`, `web/src/components/ItemsBought.tsx`). Both statements stay one row per entry, by date. Under them, `items` lists what was bought in the same from/to range: one row per item *and unit* (6 Bori and 20 kg of one item are separate rows), with quantity, number of bills or deliveries, last date and amount. Customers: lines of `active` bills (cancelled bills and estimates are out), amount after discount. Suppliers: lines of that supplier's deliveries, quantity × rate paid; the list adds up to the ledger's purchases. Shown on the customer ledger tab, the printed statement, the supplier ledger (hidden when filtered to payments only) and as a second sheet of the supplier Excel export.
- **Login brakes and proxy** (`lib/rateLimit.ts`, `lib/proxy.ts`, `routes/auth.ts`, `app.ts`). `AttemptLimiter` (in memory): 5 wrong passwords / 15 min lock the account 15 min (names that are not users too), 30 lock an address, 5 wrong authenticator codes lock the codes (429, `rate_limited`). `TRUST_PROXY=1` makes `isHttps()` and `clientIp()` believe `X-Forwarded-Proto`, `CF-Visitor` and `CF-Connecting-IP` (off by default, since anyone on the LAN can send them); the session cookie is `Secure` when https. `secureHeaders` adds `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS, CORP/COOP; no CSP yet. Setup is in `docs/REMOTE-ACCESS.md`.
- **Purchase ledger.** `suppliers` and `supplier_ledger` (append-only; balance = Σ owed − Σ paid). A stock in with a named supplier writes a `purchase` row for the invoice amount; "paid now" parts become `cash_outs` (category `supplier`, so the day book and cash flow stay right) plus `payment` rows. A reversal is a second, negative cash-out plus a `reversal` row; wrong invoices are fixed with `correction` rows. Stock-in *imports* post to it too (see **Stock and dues sheets** below). Logic is in `server/lib/suppliers.ts`; routes in `server/routes/suppliers.ts`. Entry persons record deliveries and the invoice amount; only Owners/Admin pay, correct, reverse or see the Purchase tab (`supplier.*` permissions).
- **Schema changes after the first release** are added by `addColumnIfMissing()` in `server/db/migrate.ts`, so databases made earlier upgrade on start. Old stock-in supplier names become supplier accounts on start (no dues).
- **GST rounding.** CGST and SGST are each rounded per line, so they are always equal. The demo's walk-in receipt therefore shows ₹8.76 GST rather than ₹8.75. The total is still ₹184.

---

## 4. Requirement status

✅ built · 🟡 partial · ⬜ not started · ➖ dropped by decision

### Access and roles
| ID | Status | Notes |
| --- | --- | --- |
| AUTH-1 | ✅ | Email/user-picker + password login, and **Forgot password** (see §3, "Forgot password"): emailed code when `SMTP_URL` is set, otherwise a request an Owner answers with a one-time code; the Admin recovers with `npm run reset-password`. |
| AUTH-2 | ✅ | TOTP (`server/lib/crypto.ts`). Owners and the Admin enrol by QR at first login. A setting can switch it off. |
| AUTH-3 | 🟡 | The **app server** enforces permissions (meets PILOT-4). On Supabase the PRD wants the **database** to enforce them; see §5, item 2. |
| AUTH-4, AUTH-5 | ✅ | Deactivating a user, a password reset or "sign out everywhere" bumps `session_epoch`, which kills sessions on their next request. |
| AUTH-6 | ⬜ | Edit window for the Entry person. Open question 7 says about an hour. `edit_window_min = 60` is already in settings but unused. |
| AUTH-7 | ⬜ | Phone + OTP login (Could) |

### Catalogue, units, search
| ID | Status | Notes |
| --- | --- | --- |
| CAT-1..5 | ✅ | |
| CAT-6 | 🟡 | Rename and move work; merge doesn't |
| CAT-7 | ➖ | Open question 11: the catalogue comes from the spreadsheet only |
| CAT-8 | ⬜ | Photos |
| UNIT-1..5 | ✅ | |
| UNIT-6 | 🟡 | Usual buy and sell unit work. "Last unit used for this customer" doesn't. |
| SRCH-1..6, SRCH-8 | ✅ | In-browser index (`shared/search.ts`): part-words, any order, Hindi, aliases, typo tolerance, recent and frequent first, Enter adds the top result |
| SRCH-7 | ⬜ | Category chips on New Bill (Inventory has chips) |
| SRCH-9 | ⬜ | Voice |

### Stock, losses, import
| ID | Status | Notes |
| --- | --- | --- |
| STK-1..5 | ✅ | |
| STK-6 | ⬜ | Physical count mode |
| LOSS-1..3, LOSS-5 | ✅ | |
| LOSS-4 | ⬜ | Theft details and attachments; needs file storage |
| IMP-1..7, IMP-9, MIG-1..5 | ✅ | The uploaded file isn't stored (open question 10) |
| IMP-8 | 🟡 | Headers are matched by common names (Item, Rate, Qty…). There's no screen to map custom columns, and no remembered mapping. |

### Rates, billing, GST
| ID | Status | Notes |
| --- | --- | --- |
| RATE-1..7 | ✅ | Wholesale/retail price lists per unit (open question 2) |
| RATE-8 | 🟡 | The price-history list is built; the chart isn't |
| BILL-1..13 | ✅ | Numbers restart each April with the year (open question 8). A4 is the default paper size (open question 9). |
| GST-1..3, GST-7 | ✅ | The scheme is dated. Open question 1 is still unanswered, so it defaults to Regular. |
| GST-4 | ⬜ | Bulk GST update by category or HSN |
| GST-5 | ➖ | IGST, dropped by open question 4 |
| GST-6 | 🟡 | The Bill of Supply declaration prints. The composition % is stored but unused; there's no quarterly summary. |

### Ledger, payments, day book, reports
| ID | Status | Notes |
| --- | --- | --- |
| LED-1..8 | ✅ | LED-8 opens WhatsApp with a filled message (needs internet on the phone) |
| PAY-1..5 | ✅ | |
| PAY-6 | 🟡 | References are stored and shown, but you can't search by them |
| PAY-7 | ⬜ | Cheque status (received → cleared or bounced) |
| PAY-8 | 🟡 | `/api/reports/mode-mix` exists; there's no chart |
| PAY-9 | ⬜ | Bank statement checking |
| DAY-1..3, DAY-6, DAY-7 | ✅ | |
| DAY-4, DAY-5 | ⬜ | Cash count with shortfall; close the day with a "changed after closing" flag |
| REP-1..7 | ✅ | REP-7: lists export to Excel through `POST /api/export` |
| REP-8 | ⬜ | Monthly profit |
| HIST-1..3, HIST-5 | ✅ | |
| HIST-4 | 🟡 | Shows changes between consecutive versions; can't pick two arbitrary versions |
| HIST-6 | ⬜ | Restore an earlier version |

### Admin, pilot, hosting
| ID | Status | Notes |
| --- | --- | --- |
| ADM-1 | ✅ | |
| ADM-2 | ⬜ | Nightly R2 backups and the failure email (hosted only) |
| ADM-3 | 🟡 | The restore steps are in the README. The **rehearsal hasn't been done** (it's a go-live gate). |
| ADM-4 | ⬜ | Storage meter (hosted only) |
| ADM-5 | 🟡 | Full JSON export, plus Excel per report. There's no single monthly Excel file. |
| ADM-6, ADM-7 | ⬜ | Yearly archive; database-down alert |
| PILOT-1..7 | ✅ | Nightly SQLite backups plus "Back up now" and "Download a copy". `move-to-postgres` checks the totals. Reset is Admin-only and needs the shop name typed. |
| Hosting | ⬜ | Cloudflare Workers at `.workers.dev` (open question 12). See §5, item 3. |

### Added after the first handoff

| What | Status |
| --- | --- |
| One-off price on a bill line, without touching the item's price | ✅ |
| Prices include GST (setting, per-bill basis) | ✅ |
| Whole-pack items: bori, bag, tin…; family, pack size, cartons | ✅ (form, import, stock labels) |
| Stock summary (stock on a day, companies × items) + Excel | ✅ |
| Suppliers, purchase ledger, payments, reversals, corrections | ✅ |
| Ledger Sales / Purchase tabs with filters (name, dues, overdue; dates, type, mode) | ✅ |
| Dashboard "To pay suppliers" | ✅ |
| Kruti Dev → Unicode conversion on import | ⬜ |
| Supplier opening-dues import, purchase returns, input tax credit | ⬜ |
| Print or share a supplier statement | ⬜ (Excel only) |

---

## 5. Suggested next steps, in order

### Before the pilot starts
1. **Install on the shop laptop.**
   - Install Node.js LTS, then run `setup.bat` and `start.bat` (section 2). `better-sqlite3` ships prebuilt Windows binaries for LTS releases; check they install on the shop laptop. The scripts were written in a Linux container and haven't been run on Windows yet.
   - To start with Windows, put a shortcut to `start.bat` in the Startup folder (`Win+R`, then `shell:startup`).
   - Set **Settings → Backup folder** to a Google Drive or USB path.
   - Open question 5 says one device for now, so the laptop's Wi-Fi address can be ignored.
2. **Rehearse a restore** (ADM-3, PILOT-5). Restore last night's copy on a second machine and compare the Dashboard and Day book.
3. **Load the real data**: the products sheet, then the khata sheet with the correct "as on" date. Then reset the test data (**Settings → Before go-live**) *before* the real import, not after.
4. **Get answers** to open questions 1 (GST scheme: drives tax invoice vs Bill of Supply vs Cash memo) and 3 (bag sizes; only matters for the import sheet).

### Release 1 gaps that matter before Supabase go-live
5. **Database-enforced roles on Supabase** (AUTH-3). Today the Node server is the only gatekeeper. With the API still in front of the database, the simplest compliant setup is:
   - the app connects as a dedicated Postgres role;
   - `GRANT`/`REVOKE` makes everything except the API's own role read-only;
   - the append-only triggers that already exist stay in place.

   If the browser will ever talk to Supabase directly, real RLS policies keyed on a `role` claim are needed.
6. **A Workers entry point.**
   - `server/app.ts` doesn't depend on Node, but `server/db/index.ts` imports `better-sqlite3` at the top. Split that into `db/sqlite.ts` and `db/postgres.ts`.
   - Add `server/worker.ts` using Hono's Workers adapter and a Workers-compatible Postgres driver (e.g. `postgres` over Hyperdrive, or Supabase's pooler).
   - Serve `dist/` as static assets.
   - Backups move to ADM-2 (a cron Worker doing `pg_dump`-equivalent export to R2) and the email alert.
7. **Email for the hosted version.** Forgot password already emails a code when `SMTP_URL` and `MAIL_FROM` are set (any SMTP provider's free tier works). Next: use the same mail setup for the 2FA-enrolment verification and the storage / backup alerts.
8. **Storage meter (ADM-4) and pause alert (ADM-7).** Use `pg_database_size()` on the dashboard; a cron check emails the Admin at 85%.

### Release 1.1 (Should), roughly by value to the shop
9. **Entry-person edit window** (AUTH-6, open question 7). Allow `PATCH /api/bills/:id` for the bill's creator while `now − created_at < edit_window_min`. Implement it as cancel + re-create under the same number, or as `correctBill` generalised from `correctBillRate()`, so stock and ledger stay consistent. The open-question answer says "if he's still working just refresh the token"; sessions already slide (12 h idle), so nothing else is needed for that part.
10. **Cash count and close the day** (DAY-4, DAY-5). Add a `day_closes(date, counted_cash, expected, closed_by)` table. Flag any bill, payment or cash-out whose date ≤ a closed date and whose `created_at` is after the close.
11. **Cheque status** (PAY-7). Add `status` and `cleared_at` to `payment_parts` (it's append-only, so use a separate `cheque_events` table). A bounce calls `reversePayment()`.
12. **Bulk GST update** (GST-4). Preview the products by category subtree or HSN, then insert `product_gst` rows with a `from_date`.
13. **Merge categories (CAT-6), chips on New Bill (SRCH-7), last unit per customer (UNIT-6).**
14. **Column mapping UI for imports** (IMP-8). There's already `mapHeaders()`; add a screen and store the mapping in `settings`.
15. **Mode-mix chart (PAY-8), rate trend chart (RATE-8).** The data endpoints exist.
16. **Yearly archive** (ADM-6) after March 2027.

### Release 2 (Could)
Phone + OTP login, photos, voice search, physical count, monthly profit, restoring old versions, bank checking. None of these is started.

---

## 6. Known gaps and risks

- **Kruti Dev text.** The shop's own stock sheet uses the old Kruti Dev font, which stores English keystrokes that only *look* like Hindi. Anything copied from it into Commercia (names, aliases) will be gibberish. Convert to Unicode first, or retype. Not handled by the importer.
- **Stock summary layout is a reading of one photo.** The "26/28/30" bori column is modelled as bori in three sizes; the item name is unknown, so give those products a `family` when known. Rows are companies (brands); groups are top-level categories. Check against the real `.xlsx` when it arrives.
- **Purchases carry no GST.** Per the shop, prices include GST and only amounts are tracked: no input tax credit, no supplier GSTIN, no purchase returns. A stock in cannot be cancelled; fix stock with an adjustment and the money with a correction.
- **Supplier opening dues** come in with the dues sheet (Type = Purchase), or by typing an opening balance on the supplier.
- **Old deliveries.** Stock-ins made before suppliers had accounts are linked to an account but put nothing on the ledger (treated as paid). Stock *files* now do go on it; if a past delivery was already paid, record the payment in Ledger → Purchase, or leave it out of the file.
- **Hindi is partial.** Menus, headings and main labels are translated (`web/src/i18n.ts`). Many smaller strings (banners, hints, empty states, toasts) fall back to English. To fix, wrap the remaining strings in `t()` and add entries.
- **Stock can go negative.** The app allows it on purpose, because paper bills are typed in after the fact. There's no warning in the bill screen yet; consider a soft warning.
- **Login screen lists users.** Like the demo, it shows every active user's name and role to anyone who opens it. That's fine on one laptop; reconsider once hosted on the internet (switch to the email field, which already appears automatically when there are more than 6 users).
- **No login rate limiting.** Failed logins are logged but not throttled. Add a limit before hosting. (The forgot-password flow has its own limits: three requests an hour per person, five tries per code.)
- **`.xls` (Excel 97) isn't read.** The user is told to "Save as .xlsx". The common reader (SheetJS from npm) is outdated, with known security issues.
- **Product matching on import** uses Code, then the English name, case-insensitive. The PRD says "name + pack size"; here the pack size is part of the name ("Tea 250g"), so two products differing only in pack must have different names or codes.
- **Version numbers under heavy concurrency.** `saveVersion()` uses max+1 without a lock, so two simultaneous edits of the *same* record on Postgres could produce duplicate version numbers. The content is still kept. Add a unique index plus a retry if this ever matters.
- **Dates in pickers** follow the browser's locale (mm/dd in the US-locale test browser, dd/mm on Indian Chrome). Displayed dates use DD-MM-YYYY.
- **`npm start` needs devDependencies** (tsx, vite), so a plain `npm install` is required; `npm install --production` won't do. `npm run test:pg` uses bash syntax, so it doesn't work on Windows.
- **`pg` is a devDependency.** Anyone running on Postgres must run `npm i pg` (the README says so). Move it to `dependencies` at go-live.

---

## 7. Open questions (from the PRD), with their current status

| # | Question | Answer given | What the code does |
| --- | --- | --- | --- |
| 1 | GST scheme | Not yet | Defaults to Regular; change it in Settings with a start date |
| 2 | Wholesale prices | Yes | Retail and wholesale price per unit; customer marked retail or wholesale |
| 3 | Bag sizes | Flexible, mostly 10 kg / 5 kg | Any units per product; quick-add chips for 50/25/10/5 kg bags |
| 4 | GSTIN / inter-state | Keep it simple | Optional customer GSTIN on invoices; no IGST |
| 5 | Pilot laptop / Wi-Fi | One device | Works; Wi-Fi access is optional |
| 6 | Rate auto-approval | Always ask the Owner; if rejected, use the Owner's rate | Built that way, including correcting the bill |
| 7 | Edit window | About an hour | **Not built yet** (§5, item 9); setting stored |
| 8 | Yearly numbering | Yes, with the year | `INV/26-27/0001` |
| 9 | Default print | A4 | A4 default; thermal in Settings |
| 10 | Spreadsheet | Give a template; don't store the file | .xlsx/.csv templates; file discarded after reading |
| 11 | Starter categories | Populate from the spreadsheet | No starter tree |
| 12 | Domain | Free | Not deployed yet |
| 13 | Volume | 50–70 bills/day | SQLite and Postgres are comfortable at this size |

---

## 8. Testing notes

- `tests/shared.test.ts` covers GST and totals (including the PRD's ₹931 example), rounding, kaccha / Bill of Supply / cash memo, discounts, the financial year, money parsing, unit conversion and the stock label, search (`fort mus 1`, `चीनी`, `chini`, `saffolla`), and the TOTP RFC test vector.
- `tests/ledger-sheets.test.ts`: the stock and dues templates (dropdowns, Amount formulas, ranges), stock files posting totals to the purchase ledger, Sale/Purchase dues, undo of both.
- `tests/items-bought.test.ts`: the items list under customer and supplier ledgers (units, cancelled bills, discounts, date filter, adds up to the ledger).
- `tests/security.test.ts`: the limiter, lockouts on login and authenticator codes, Secure cookie and visitor address behind a trusted proxy, security headers.
- `tests/packs.test.ts`: whole-pack items, cartons, the stock summary on past days, import of pack columns.
- `tests/suppliers.test.ts`: purchase on stock in, paid now, Entry-person limits, payments and reversals (also in the day book's cash flow), corrections, append-only triggers, opening balance, filters and running balances, reset.
- `tests/migrate.test.ts`: existing databases gain the new columns; old supplier names get accounts.
- `tests/api.test.ts` drives the real API:
  - credit sale and ledger (₹1,681), bags + kg on one bill, refusals for credit without a customer and for a tax invoice without a name;
  - concurrent numbering, role refusals being logged, the rate approval and rejection correction, rates on the bill's date;
  - cancel and reverse, the split payment and its reversal, and the database refusing to change the ledger or log;
  - dashboard due equalling the dues list, day book and register totals, the GST summary;
  - losses (report → confirm → found), estimate → bill, deactivation logging the user out;
  - product import (preview, errors, all-or-nothing, re-import does nothing, undo) and dues import (duplicates, advances, details editable later).
- Postgres: `npm run test:pg` runs all of this on Postgres. It also exposed that the Admin's reset crashed on Postgres (it tried a file backup first); fixed.
- **No UI tests are committed.** The Playwright screenshots and flows were run from a scratch folder; consider adding `@playwright/test` with the flows described in §1.
- To run against Postgres locally: `service postgresql start`, then `npm run test:pg`. Each test file creates its own database named `commercia_t_*`, and these aren't dropped automatically.
