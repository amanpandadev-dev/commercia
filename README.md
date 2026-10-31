# Commercia

Stock, bills, GST, payments and the customer khata for one kirana shop, in one private web app. Built from *Commercia — Product Requirements v1* and the demo walkthrough.

- **Phone first.** Works on a mid-range Android phone at 360 px and grows into the sidebar layout on a laptop.
- **English or Hindi.** Each person picks a language. Product names are stored in both, and Roman spellings (*chini*, *sarson*) find Hindi items.
- **Every change is recorded.** Who did what and when goes into an activity log and a per-record history. The database itself refuses to edit or delete those rows, or the ledger.
- **Pilot on one laptop, then Supabase.** The shop starts on a single SQLite file with no internet needed. The same code runs on Postgres at go-live (the tests pass on both).

## Quick start

Needs Node.js 20 or newer.

```bash
npm ci
npm run seed:demo   # optional: the "Sharma Kirana Store" demo shop from the video
npm start           # builds the web app and serves it on http://localhost:8787
```

Demo logins (password `demo1234`):

| User | Email | Role |
| --- | --- | --- |
| Ramesh Sharma | ramesh@shop.in | Admin (also has every Owner right) |
| Amit Kumar | amit@shop.in | Entry person |

On a fresh database (no seed), the first screen asks for the shop name and creates the Admin account.

For development, `npm run dev` runs the API with reload on :8787 and Vite on :5173.

### On Windows, without a terminal

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org) (or run `winget install OpenJS.NodeJS.LTS`).
2. Get the code. If `git clone` fails with a TLS or `schannel` error, use **Code → Download ZIP** on GitHub and unzip it.
3. Double-click **`setup.bat`** in the folder. It installs packages, builds the app, and asks whether to load the demo shop. Run it again after each update.
4. Double-click **`start.bat`**. The browser opens on http://localhost:8787. Keep the black window open while the app is in use; closing it stops Commercia.

If Windows asks about the firewall, allow **Private networks** so phones on the shop Wi-Fi can connect. To start Commercia with Windows, put a shortcut to `start.bat` in the Startup folder (`Win+R`, then `shell:startup`).

## Using it at the shop (pilot)

| Need | How |
| --- | --- |
| Start | `npm start` on the shop laptop. The console prints the address for this computer and for phones on the shop Wi-Fi (PILOT-2). Set `HOST=127.0.0.1` to keep it on the laptop only. Only this computer, private networks and Tailscale are let in (`ALLOWED_IPS` changes that). |
| Data | One file: `data/commercia.db`. Set `COMMERCIA_DB=/path/file.db` to put it elsewhere. |
| Backups | Automatic every night after 9 pm, and at start-up if the last one is over a day old. The last 30 copies are kept. They are **locked** (`.db.enc`) with the secret key: keep a copy of `data/commercia.key` (or your `COMMERCIA_SECRET_KEY`) somewhere other than the backup folder, or they cannot be opened. **Settings → Backup** has *Back up now*, *Download a copy*, and the folder setting (point it at a USB drive or a Google Drive/OneDrive synced folder). |
| Products | **Import → Products & opening stock**: download the template, which has exactly eight columns: **Category, Brand, Pack type, Pack size, Pack price, Stock, Reorder at, Aliases (Hindi names)**. Pack type and Pack size have dropdowns; Pack type can be *Loose* for things sold by the kg or litre (then Pack size is 1 kg or 1 L and Stock is in kg). The grey rows are examples: delete them, fill in one row per company and size, upload, check the preview (it shows the name each row will get), confirm. The uploaded file isn't stored, and uploading the same file again changes nothing. A pack type that isn't in the list is added first (**Settings → Pack types**, or *Add Product → Pack type → New type*), then download the template again. New items get the **default GST** from Settings; names are built for you (*Sooji — Annapurna 25 kg Bag*), and an item already added under another name is recognised by company, pack type and size. |
| Stock deliveries | **Import → Stock deliveries**: *Date, Supplier, Product, Quantity, Unit, Purchase rate per unit*, and **Amount**, which the sheet works out itself (Quantity × Rate: 10 bori at 1,200 = 12,000). Product, Supplier, Quantity and Unit have dropdowns (you can still type a new supplier or a bigger unit such as a carton). Rows with the same Supplier and Date form one delivery, and its total goes on that supplier's **purchase ledger**. Undoing the import reverses it. |
| Old khata and supplier dues | **Import → Dues: customers & suppliers**: a **Type** column says *Sale* (a customer who owes you, on the sales ledger) or *Purchase* (a supplier you owe, on the purchase ledger); empty means Sale. Only *Name* and *Amount owed* are otherwise required. A negative amount means they (or you) paid in advance. A customer already in Commercia only has their details updated. A supplier already in Commercia (made by a stock file, say) gets the amount too, unless they already have an opening balance; then only their details are updated, so the same file never adds it twice. |
| From outside the shop | **docs/REMOTE-ACCESS.md**: Cloudflare Tunnel with Cloudflare Access in front, step by step, and the security measures to take. Set `TRUST_PROXY=1` in `.env` when running behind it. |
| Keep the shop network only | `scripts\windows\firewall.bat allow` adds one Windows Firewall rule (Private networks, this subnet, the Commercia port); `remove` takes it out. |
| Wipe test data | **Settings → Before go-live** (Admin only; you type the shop name to confirm). Users and settings stay, and a backup is taken first. |

### Forgot your password?

On the login page tap **Forgot password?**, choose your name, and **Get a reset code**.

- **Without email** (the default at the shop): the Owner or Admin sees your request on their Dashboard and under **Users**, checks it is really you, taps **Make a reset code** and reads the 8-character code out to you. You type it with a new password. A code works once, for an hour, and allows five wrong tries.
- **With email**: set up email once (**[docs/EMAIL.md](docs/EMAIL.md)**: four lines in `.env`, free with a Gmail App Password; check it with `npm run test-mail -- you@example.com`). The code is then emailed to the address on the account (it works for 30 minutes). If sending fails, the request goes to the Owner as above.
- **The Admin** can't be reset by anyone else in the app. Without email, run this on the shop computer: `npm run reset-password -- ramesh@shop.in` (prints a new password; add `--reset-2fa` if the authenticator phone is lost). After too many wrong tries an account locks for up to an hour; `--unlock` (or `--unlock-all`) lifts it at once.

Setting a new password signs that person out everywhere. It does not switch off their authenticator-app code. Passwords must be at least 10 characters, not a common password, and not made from the person's name, email or the shop's name.

### Restore a backup (ADM-3, PILOT-5)

1. Stop the app (close the terminal window running `npm start`).
2. Run `npm run restore-backup -- backups/commercia-2026-10-12-21-10-00.db.enc --force` (`--force` is needed because a database is already there). It unlocks the backup with your secret key, checks it, keeps the current database aside as `data/commercia.db.before-restore-<time>`, and puts the backup in place. (An older plain `.db` backup also works: it is locked first, then restored.) A wrong key or a damaged file stops it before anything is changed.
3. Run `npm start` again, then check **Dashboard** and **Reports → Day book** against what you expect.

To rehearse this on another laptop, copy the backup and the key file (`data/commercia.key`, or set `COMMERCIA_SECRET_KEY`) there and run the same command (without `--force` on a fresh laptop). The totals should match.

### Security, in short

Full detail, the threat model, key rotation and what to do if a laptop is lost or a password leaks: **[SECURITY.md](SECURITY.md)**.

- Two-step login for Owners and the Admin, with one-time recovery codes. Setting it up needs a code emailed to the account or read out by the Admin/Owner.
- Wrong passwords and codes lock the account for 5 to 60 minutes (never for good). A lock shows on **Security** (Owner/Admin) and on the Dashboard.
- Backups and authenticator secrets are encrypted with a key kept in `data/commercia.key` (made on first run) or `COMMERCIA_SECRET_KEY`. `npm run rotate-key` changes it.
- Phones on the shop Wi-Fi type their email at login instead of tapping a name (set `SHOW_USERS_ON_LAN=1` to bring the list back). The first-run setup only works on the shop laptop.
- Optional settings live in `.env` (copy `.env.example`, or run `npm run init-env`). Nothing is required.

| Command | What it does |
| --- | --- |
| `npm run init-env` | Makes `.env` with a fresh random secret key (`setup.bat` does this) |
| `npm run test-mail -- you@example.com` | Sends one test email to check the SMTP settings (docs/EMAIL.md) |
| `npm run reset-password -- <email> [--unlock] [--reset-2fa] [--enrol-code]` / `-- --unlock-all` | Last-resort account help, on the shop computer |
| `npm run restore-backup -- <file> [--force]` | Restore a backup, locked or plain |
| `npm run rotate-key` | Move everything to a new secret key |
| `npm run pg-backup` / `pg-restore` | Encrypted backup and restore drill for Postgres (docs/POSTGRES.md) |

### Going live on Supabase (PILOT-6)

```bash
npm install pg
DATABASE_URL="postgres://…supabase…?sslmode=require" npm run move-to-postgres data/commercia.db
```

Before that, set up the two limited database logins, the secret key and encrypted off-site backups as in **[docs/POSTGRES.md](docs/POSTGRES.md)**.

The script copies every table into the empty Postgres database. It then compares stock per item, every customer's balance, sales and payment totals, and stops with an error unless they match to the paisa. After that, run the app with `DATABASE_URL` set. All database-specific code is in `server/db/` (PILOT-3).

## Roles

The server checks permissions on every request, not just the screens (AUTH-3, PILOT-4). Refused attempts go into the activity log. The full table is in `shared/perms.ts`.

| | Admin | Owner | Entry person |
| --- | :-: | :-: | :-: |
| Bills, stock in, payments, customers | ✓ | ✓ | ✓ |
| Change a rate | applies at once | applies at once | sent for approval |
| Cancel bills, reverse payments, adjust stock, record losses | ✓ | ✓ | report a shortage only |
| Add a new product (with its first price, and a category if needed), singly or from a products spreadsheet; undo your own latest import | ✓ | ✓ | ✓ |
| Edit products, prices, GST, categories, settings; change existing items from a spreadsheet; import customer dues; undo someone else's import | ✓ | ✓ | — |
| Reports, review, activity log, approvals | ✓ | ✓ | day book only |
| Stock summary | ✓ | ✓ | ✓ |
| Suppliers: purchase ledger, pay, reverse, correct | ✓ | ✓ | — (records a delivery and its invoice amount) |
| Users, and reset codes for people who forgot their password | ✓ | ✓ (not Admins) | — |
| Reset test data | ✓ | — | — |

Owners and the Admin confirm each login with an authenticator-app code (AUTH-2). They set it up at their first login, from a QR code, after proving it is them: with email set up, a code is emailed to them automatically and they type it in first; without email, the Admin reads one out. The Admin can switch this off in **Settings → Security**; the demo seed switches it off. Entry people do not need it (open risk in SECURITY.md). Risky actions (managing users, downloading a backup or `export.json`, wiping test data) ask for your password again.

## How the numbers work

- Money is stored as whole paise. Quantities are stored in thousandths of the base unit (2.5 kg = 2500). GST rates are stored in basis points (5% = 500).
- **Stock is never typed in.** It is the sum of movements: deliveries, sales, cancellations, imports, adjustments, losses (STK-2). Each product's history shows the running total.
- **Units and bags.** Each product counts stock in kg, L or pieces. It can have any number of larger units (Bag 50 kg, Box of 12, Tin 15 L), and each unit has its own price. Selling 2 bags + 7 kg removes 107 kg. Stock shows as "12 × Bag 50 kg + 7 kg".
- **Rates are dated.** A bill line starts from the rate in force on the *bill's* date. The first time an item is billed on a date, the app asks "still ₹X?". An Entry person's new rate is saved on the bill as typed, marked *rate awaiting approval*, and sent to the Owners. If an Owner rejects it and sets their own rate, the bill is corrected, the difference goes on the customer's ledger as a correction entry, and the old version stays in the bill's history (RATE-1..6, open question 6).
- **A price for one bill only.** Typing a different rate on a bill line gives that customer this price on this bill *only*; the item's own price is not touched and nobody has to approve it. The line is marked *This bill only · list ₹X*. To really change the item's rate, tap **Change rate** on that line (an Entry person's change goes to the Owners as before) or use the Rates screen. A price typed by an Entry person puts the bill in the Owners' **Review** list as *own price*.
- **Prices include GST** (the default; **Settings → GST**). The price you type or see on the shelf is what the customer pays: ₹105 at 5% is ₹100 + ₹2.50 CGST + ₹2.50 SGST, and the total never moves from qty × price. Switch it off to have GST added on top instead. Each bill remembers which way it was made, so changing the setting later never re-prices old bills.
- **Whole-pack items (bori, bag, tin, pouch…).** When adding a product, answer *What are you adding?* first — **Loose**, **Packet or piece**, or **Bori, bag, tin or pouch** — and the form shows only the fields that apply (the price sits right under the name; bags, boxes, HSN, reorder level and the rest are under *More options*). A bori / bag / tin / pouch item is counted in whole packs ("7 bags", "3 bori"), never loose; the kg or litre size is only a label. Each company and pack size is its own product with its own price and stock, grouped by **Item group**, e.g. Sooji → Annapurna 25 kg. Fill in the company, pack size and item group and the name builds itself. A **carton** is a larger unit holding a set number of packs ("Carton (12 × 1 L)"); stock then reads "2 × Carton (12 × 1 L) + 6 pouches".
- **Stock summary** (Inventory → *Stock summary*): stock on any day, laid out like a stock sheet: companies down, items and pack sizes across, grouped by category. Excel export included. Only items with a pack type or an item group appear.
- **Purchase ledger** (Ledger → *Suppliers · Purchase*): a stock in with a supplier name puts the invoice amount on what you owe them; the part you pay now comes off it. Pay later in any mix of modes, reverse a wrong payment (both rows stay), or add a correction for a wrong invoice. Filters: name, phone or area; only dues; unpaid 30/60/90+ days; and, inside a supplier, dates, purchases or payments, and payment mode. Prices include GST, so purchases are just amounts.
- **GST** is worked out per line and split into equal CGST and SGST, rounded to the paisa per line. The total is rounded to the rupee and the round-off is shown. The PRD's example (₹900 taxable → CGST ₹15.50 + SGST ₹15.50 → ₹931) is a test.
  - A kaccha slip has the same total and GST as a tax invoice; it only prints differently.
  - A bill with only 0% items prints as a Bill of Supply.
  - The shop's GST scheme (Regular / Composition / Not registered) is dated in Settings and decides how bills print from that date on.
- **Numbers** run in separate series for receipts, tax invoices and estimates. They restart every April with the year (`INV/26-27/0001`), and are never reused or skipped.
- **Corrections** happen only by reversal. Cancelled bills keep their number. Reversed payments and loss reversals stay visible next to the originals.

## What's in v1

Release 1 **Must** items, all built:

- **Access:** login, roles, user management, forgot password (AUTH-1..4).
- **Catalogue:** category tree, products, packs, loose and packed items, aliases (CAT-1..5).
- **Units and bags:** UNIT-1..5.
- **Search:** SRCH-1..6 and SRCH-8.
- **Stock and losses:** STK-1..4, LOSS-1..3.
- **Import:** IMP-1..7, IMP-9, MIG-1..5.
- **Rates and approvals:** RATE-1..6.
- **Billing and GST:** BILL-1..7, BILL-11, BILL-12, GST-1..3, GST-7.
- **Ledger and payments:** LED-1..6, PAY-1..5.
- **Dashboard, reports and history:** REP-1..5, HIST-1..3.
- **Day book:** DAY-1..3.
- **Settings and pilot:** ADM-1, ADM-3, PILOT-1..6.
- **Added after the first release:** a price typed for one bill only, GST-inclusive prices, whole-pack items and cartons, the stock summary, suppliers and the purchase ledger.

**Should** and **Could** items also built: sign out everywhere (AUTH-5), rename and move categories (CAT-6), usual buying and selling unit (UNIT-6), repeat a supplier's last delivery (STK-5), loss report and this month's losses (LOSS-5), header matching for your own spreadsheet columns (IMP-8, by common names), paper bill reference, duplicate warning, discount, Bill of Supply (BILL-8..10, BILL-13), dues ageing (LED-7), WhatsApp reminder (LED-8), stock value and Excel export of lists (REP-6, REP-7), version-to-version changes (HIST-4, consecutive versions), price history (HIST-5), payment references (PAY-6, stored and shown), pending-approval badge (RATE-7), day book filters and export (DAY-6, DAY-7), and the reset (PILOT-7).

### Not built yet

| Item | Note |
| --- | --- |
| Entry-person edit window (AUTH-6, open question 7) | Owners correct entries by cancelling and re-entering. Next step: allow edits to one's own bill for the window in Settings (default 60 min). |
| Category merge, category chips on New Bill, voice search, photos | CAT-6 (merge part), SRCH-7, SRCH-9, CAT-8 |
| Physical count mode, theft attachments | STK-6, LOSS-4 |
| Remembering a custom column mapping; old `.xls` files | IMP-8 (custom part). `.xls` asks the user to save as `.xlsx`. |
| Bulk GST update, IGST, composition quarterly summary | GST-4. GST-5 was left out per open question 4. GST-6 is partial: the Bill of Supply declaration prints. |
| Kruti Dev conversion; supplier opening-dues import; purchase returns; supplier statement printing | The shop's old sheet uses the Kruti Dev font, which must be converted to Unicode first. Supplier dues are typed in per supplier. |
| Cheque status, bank checking, mode-mix chart | PAY-7, PAY-9, PAY-8 (the `/api/reports/mode-mix` data exists; there is no chart yet) |
| Cash count and close the day | DAY-4, DAY-5 |
| Monthly profit, restore old versions, rate trend chart | REP-8, HIST-6, RATE-8 (the history list exists) |
| Hosted-only items | Nightly R2 backups with failure email (ADM-2), storage meter (ADM-4), monthly Excel export file (ADM-5; there is a full JSON export), yearly archive (ADM-6), database-down alert (ADM-7) |
| Hosting on Cloudflare Workers | The API (`server/app.ts`) is plain Hono and Workers-friendly. The Node entry point and the SQLite driver are not; a Workers entry point with a Postgres driver is still to do. |

## Project layout

```
shared/            GST and totals, money, units, search, permissions — used by server and screens
server/db/         schema, migrations, SQLite/Postgres connection (the only database-specific code)
server/lib/        billing, rates, catalogue, importer, backups, auth helpers
server/routes/     the HTTP API
server/scripts/    seed-demo, move-to-postgres, reset-password, init-env, rotate-key, restore-backup, pg-backup, pg-restore
web/src/           React screens
scripts/windows/   firewall.bat / firewall.ps1
tests/             vitest: GST/units/search rules, full API flows, and the security suites (throttle, two-step, secrets, backups, edge, uploads, injection...)
docs/              REMOTE-ACCESS.md (Cloudflare Tunnel), EMAIL.md (sending codes), POSTGRES.md (hosted database)
SECURITY.md        threat model, rotation, incident checklists, findings
```

## Tests

```bash
npm test          # SQLite in memory
npm run test:pg   # the same tests on Postgres (set TEST_DATABASE_URL to a server you can create databases on)
npm run typecheck
```
