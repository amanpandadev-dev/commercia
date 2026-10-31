# Going live on Postgres (Supabase or your own server)

The pilot runs on one SQLite file. The hosted version runs the same code on Postgres. This page is the security checklist for that step. The data move itself is `npm run move-to-postgres` (see the README).

## 1. Connection and TLS
- `DATABASE_URL` must end in `?sslmode=require` unless the database is on the same computer. Commercia refuses to start otherwise.
- Never put the URL in the repo, a chat or a log. On the host, keep it in the host's secret store (Supabase, Render, Fly, Railway and so on all have one), not in a file in the project.

## 2. Two logins, least privilege
Run `server/db/sql/postgres-roles.sql` once, as the database owner, in an **empty** database, before the first start. Replace the `{{…}}` placeholders with long random passwords.

| Login | Used for | Can |
| --- | --- | --- |
| `commercia_migrate` | `DATABASE_URL_MIGRATE`, only at start-up | create and change tables |
| `commercia_app` | `DATABASE_URL`, the running app | read and write rows. Not create, alter, drop, truncate, or touch roles |

The append-only triggers on the ledger, activity log, versions, payment parts and supplier ledger stay in force for both.

After go-live (test data wiped, real work begun) run `server/db/sql/postgres-lock-ledgers.sql` once. The app's login can then no longer update or delete those tables at all, even if the app were tricked into trying. "Reset test data" stops working from then on; that is the point.

## 3. Secrets
- `COMMERCIA_SECRET_KEY` is **required in the environment** on Postgres (there is no key file on a hosted machine). It seals authenticator secrets and encrypts backups. Generate one with `npm run init-env` on your own computer and paste only the key into the host's secret store.
- Keep a copy of the key in a password manager. Without it, backups cannot be opened.

## 4. Off-site encrypted backups
```bash
npm run pg-backup -- --out backups          # pg_dump, then AES-256-GCM with the secret key
```
- Needs `pg_dump` of the **same major version** as the server (a newer client writes dumps an older server cannot restore; the command stops if it sees that), `DATABASE_URL` and `COMMERCIA_SECRET_KEY`.
- Sync the folder to cloud storage with a token that can only **add** files, so a break-in cannot delete the backups.
- Run it daily from the host's scheduler (or Windows Task Scheduler). Keep at least 30 days.

## 5. Restore drill (do it before you need it)
```bash
npm run pg-restore -- backups/commercia-pg-<date>.dump.enc --to "postgres://…/freshdb?sslmode=require"
```
It opens the backup (a wrong key or a changed file stops it before anything is touched) and loads it into a **fresh, empty** database. Then start the app against that database and check the Dashboard and the Day book against what you expect. Put a reminder in the calendar to do this every quarter.

## 6. Row-level security: not done
Row-level security protects data when many different logins reach the database. Here only the API connects, with one login, and the API checks every permission itself. So RLS is **not implemented**. If you let anything else connect (Supabase's own API, a BI tool), turn on RLS and write policies first, and never hand out the `anon`/`service_role` keys. Disable Supabase's public REST API for this project if you do not use it.

## 7. Also
- Restrict the database's network access to the host that runs Commercia where the provider allows it.
- Turn on two-step login on the Supabase and hosting accounts.
- The tests pass on both databases: `npm test` and `npm run test:pg`.
