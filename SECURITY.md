# Security

Commercia holds a shop's customer names, phone numbers, dues and sales. This file says what it defends against, what each layer does, what it does **not** do, and what to do when something goes wrong. Nothing here is a guarantee: it lists the controls that exist and the gaps that remain.

It is meant to run with **zero configuration** on one laptop, offline, and still be secure by default. Everything in `.env.example` is optional.

## Threat model

| Who | What they might try | Where it is covered |
| --- | --- | --- |
| Someone on the shop Wi-Fi | Guess passwords, sniff logins on plain http, probe the API, upload hostile files | §A, §B, [Open risks](#open-risks) |
| Someone who stole the laptop | Read the database, backups, authenticator secrets | §C |
| Someone with a leaked password | Log in as that person | §D |
| Someone who reached the tunnel URL | Brute force, hit the setup screen, scan the API | §E |
| A staff member (Entry person) | Read or change more than their role allows, export data | §F |

Out of scope: malware on the laptop or phones, a malicious Windows administrator, Cloudflare or the domain registrar being compromised, physical coercion.

## What each layer does

**Passwords** (`server/lib/passwordPolicy.ts`, `crypto.ts`)
- At least 10 characters, at most 128; refused if on the common-password list (with look-alike letters undone), a keyboard run, or built from the person's name, email or the shop's name.
- Hashed with scrypt, the cost stored in the hash (`scrypt$N$r$p$salt$hash`). Old hashes still work and are upgraded on the next login. `COMMERCIA_SCRYPT_LOG2` (default 17) sets the cost.
- Risky actions ask for the current password again (valid for 5 minutes): managing users, downloading `export.json` or a backup, resetting data, changing the password.

**Brute-force throttling** (`server/lib/throttle.ts`)
- Kept in the database, so a restart does not clear it. Per account and per address, for passwords, authenticator codes, recovery codes and reset codes.
- Locks escalate 5 → 15 → 45 → 60 minutes and never exceed one hour: the Admin is never locked out for good. The reply is `429` with `Retry-After`.
- A lock raises an alert: activity log, the Security screen, a Dashboard banner, and email to Owners/Admin if SMTP is set (de-duplicated for 30 minutes).
- Unlock on the shop computer: `npm run reset-password -- <email> --unlock`, or `--unlock-all`.

**Two-step login** (`server/lib/enrolment.ts`, `recovery.ts`)
- Authenticator codes cannot be replayed (the last accepted time-step is stored and refused again).
- 10 one-time recovery codes, stored hashed, shown once.
- The QR code is shown only after proof of control: a code emailed to the account (sent automatically when email is set up, `docs/EMAIL.md`), or a code an Admin/Owner reads out. This also holds after "Reset 2FA". Five wrong tries kill the code.
- Authenticator secrets are encrypted at rest (AES-256-GCM, bound to the user's id).
- Owners and the Admin must use it by default (Settings → Security). **Entry people do not**; see [Open risks](#open-risks).

**Sessions** (`server/lib/sessions.ts`)
- Cookie: `__Host-commercia_session` over https (plain `commercia_session` over http), `HttpOnly`, `SameSite=Strict`, path `/`.
- A new session id is issued at login, after the second step and after a password change. Settings → Devices lists sessions and signs any of them out. A new, unseen device raises an alert.
- Forwarding headers (`X-Forwarded-For/Proto`) are believed only from a trusted proxy (loopback when `TRUST_PROXY=1`, plus `TRUSTED_PROXIES`).

**First-run setup** (`server/lib/setup.ts`)
- `/api/auth/setup` works only from the shop PC itself (loopback with no forwarding headers), or with a one-time setup code printed on the console. It closes for good once the first user exists.

**Secrets, backups, exports** (`server/lib/secrets.ts`, `backupCrypto.ts`)
- One master key: `COMMERCIA_SECRET_KEY` (env or `.env`), otherwise made on first run in `data/commercia.key` (mode 0600). It is never silently replaced when sealed data exists.
- Backups are AES-256-GCM files (`*.db.enc`). Old plain backups are locked at start-up. `npm run restore-backup` opens one.
- `export.json` never contains password hashes or authenticator secrets.
- Key rotation: see below.

**Network edge** (`server/lib/edge.ts`)
- Order: security headers → IP allow-list → rate limits → same-origin check → body limits → request timeout.
- Strict CSP (`default-src 'self'`, no inline styles or scripts, `frame-ancestors 'none'`), `nosniff`, no-referrer, `Cache-Control: no-store` on `/api`, HSTS only over https. No CORS.
- Allow-list: loopback, private networks and Tailscale by default (`ALLOWED_IPS` to change). Anything else gets 403 before anything runs.
- Layered rate limits (login, other API, uploads) answering 429 with `Retry-After`; body limits (small for JSON, larger for uploads); socket timeouts.
- Static files: no path traversal, no dotfiles, no source maps in the build.

**Uploads and exports** (`server/lib/sheets.ts`, `zipSafety.ts`)
- File type decided from content, not the name. Spreadsheets are inflated under a size cap before being parsed (zip bombs). Caps: 5000 rows, 60 columns, 2000 characters per cell.
- Cells starting `= + - @` are neutralised on Excel/CSV export so a customer named `=HYPERLINK(...)` cannot run in the owner's Excel. Exports and downloads are logged.

**Database access**
- All SQL is parameterised (Kysely); `LIKE` searches escape `%` `_` `\`; ids and limits are validated as integers (bad input is a 400, not a 500). `sql.raw` appears only in the migration scripts. No `dangerouslySetInnerHTML` in the web app.
- The database refuses to edit or delete ledger and activity rows.

**On Postgres** (`server/db/sql/postgres-roles.sql`, `docs/POSTGRES.md`)
- TLS is required when the database is not on the same computer. App login role has only the rights it needs; migrations use a separate role. Encrypted `pg_dump` backups with a restore drill (`npm run pg-backup`, `pg-restore`).

**Windows** (`scripts/windows/firewall.bat`)
- Adds one inbound rule: Private profile only, local subnet only (optionally Tailscale), only the Commercia port. `scripts\windows\firewall.bat allow` adds it, `remove` takes it out, `status` shows it. Not run on a real Windows machine yet.

**CI** (`.github/workflows`)
- Typecheck, tests on SQLite and Postgres, `npm audit` failing on high, gitleaks, Dependabot. CodeQL runs through the repository's own default setup (an extra CodeQL workflow conflicts with it, so there is none). These have not run yet: they start when the pull request is opened.

## Keys and passwords: how to rotate

**Master key** (every few years, or at once if the key file leaked):
1. Stop the app. Copy `data/` and `backups/` somewhere safe.
2. Make a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. In `.env` set `COMMERCIA_SECRET_KEY=<new>` and `COMMERCIA_SECRET_KEY_PREVIOUS=<old>`.
4. `npm run rotate-key`. It re-seals authenticator secrets and re-encrypts every backup, and is safe to run twice.
5. Remove `COMMERCIA_SECRET_KEY_PREVIOUS`. Keep the **new** key in a password manager, not in the backup folder.

**Losing the key** means encrypted backups and authenticator secrets cannot be opened. People re-enrol their authenticator (Admin runs `reset-password --reset-2fa`); old backups are gone. Keep a copy of the key off the laptop.

**A password**: Users → *Make a reset code*, or the person uses *Forgot password*. The Admin: `npm run reset-password -- <email>` on the shop computer.

## Incident checklists

**Lost or stolen laptop**
1. From another device, change the Cloudflare Access policy to remove the laptop's tunnel (Zero Trust → Tunnels → delete) so the URL stops working.
2. Assume the database and backups can be read if the disk was not encrypted (the key file sits beside them). Change every password, on a restored copy elsewhere.
3. Rotate the master key and SMTP password; tell customers if their phone numbers matter to you.
4. From next time: BitLocker on, key backed up away from the laptop.

**Leaked password**
1. Users → deactivate then reactivate the person, or *Make a reset code* (this signs them out everywhere).
2. Read Security → recent events and the activity log for that person's logins and exports.
3. If the person is an Owner/Admin, rotate their authenticator too.

**Suspected breach** (unexpected exports, new devices, lock alerts at odd hours)
1. Take the laptop off the network. Copy `data/` and `backups/` for evidence.
2. `npm run reset-password -- <admin email> --unlock-all` is for *you* getting back in; then reset every password and authenticator.
3. Rotate the master key, SMTP password and the Cloudflare tunnel token.
4. Restore from a backup you trust if data was changed. The activity log is append-only, so edits show.

**Lost authenticator phone**
1. Use a recovery code at login. If none: the Admin runs `npm run reset-password -- <email> --reset-2fa`, or an Owner issues an enrolment code under Users.
2. Re-enrol with the code, save the new recovery codes.

## Threat-model pass

**Someone on the shop Wi-Fi.** They can reach the app (that is the pilot design) but cannot get far without a password: logins lock after five wrong tries per account and per address, owners need an authenticator code, and uploads and the API are bounded. **They can read logins and session cookies in transit because the LAN is plain http** (open risk). Mitigations today: a strong Wi-Fi password, a separate guest network, the firewall script. The user list is hidden on the LAN unless `SHOW_USERS_ON_LAN=1`.

**Someone who stole the laptop.** With the disk unencrypted they can read the live SQLite database directly, and the key file next to it unlocks backups and authenticator secrets. Controls: backups and secrets are encrypted, but only the key *location* differs; real protection is BitLocker. Passwords are slow-hashed and not in `export.json`.

**Someone with a leaked password.** They still need the authenticator code (Owner/Admin) and are throttled; new devices alert; sessions can be listed and ended; risky actions ask for the password again. An Entry person's leaked password gives that person's rights only.

**Someone who reached the tunnel URL.** Cloudflare Access should stop them first. If it is bypassed: the allow-list sees the Cloudflare connector as loopback (trusted proxy), the rate limits and lockouts use the real client address from `CF-Connecting-IP`/`X-Forwarded-For`, setup is closed, the login screen does not list users, CSP and cookie flags apply. Remaining: the app is then only as strong as a password plus authenticator.

**A staff member.** Permissions are checked on the server for every request and refusals are logged. Entry people cannot export `export.json`, download backups, manage users or change rates without approval. They can still see customers and the day book, as the job needs. They cannot disable another person's lock; a deliberate attacker who knows a colleague's email can lock that account for up to an hour (an Admin unlocks it from the console).

## Findings

| # | Finding | Severity | Status | Residual risk |
| --- | --- | --- | --- | --- |
| 1 | No brute-force limits on login or authenticator code | High | Fixed | Lockout can be used to deny a known account for ≤ 1 h |
| 2 | Authenticator code replayable; no recovery codes; QR shown without proof | High | Fixed | Entry people have no 2FA by default |
| 3 | `export.json` included password hashes and TOTP secrets | High | Fixed | none |
| 4 | Backups plain files | High | Fixed (AES-256-GCM) | Key file is beside the data unless set in env |
| 5 | TOTP secrets plain in database | High | Fixed (encrypted, migrated in place) | Live DB itself is not encrypted |
| 6 | `/api/auth/setup` open | High | Fixed (shop PC or console code) | none |
| 7 | Dependencies: nodemailer < 8 advisories, uuid | Moderate | Fixed (nodemailer 10, uuid override) | |
| 8 | exceljs → archiver → glob/minimatch/rimraf/zip-stream advisories | Moderate | Accepted | No user-supplied glob patterns reach them |
| 9 | Weak password rules, weak scrypt, no rehash | Medium | Fixed | |
| 10 | Session cookie `Lax`, no rotation, no session list | Medium | Fixed | |
| 11 | No CSP, headers, body/time limits, rate limits, allow-list | Medium | Fixed | In-memory rate limits reset on restart (lockouts do not) |
| 12 | Forwarding headers trusted from anyone | Medium | Fixed (trusted proxies only) | A wrong `TRUST_PROXY` setting weakens the allow-list |
| 13 | Upload content, zip bombs, formula injection | Medium | Fixed | |
| 14 | `LIKE` wildcards, bad ids giving 500 | Low | Fixed | |
| 15 | Secrets could reach logs | Medium | Fixed (`redact()` + test) | |
| 16 | Login screen lists all users | Low | Fixed off the shop PC | Phones now type an email unless `SHOW_USERS_ON_LAN=1` |
| 17 | LAN traffic is plain http | Medium | **Open** | Sniffing on Wi-Fi gives passwords/cookies; needs local HTTPS (a new dependency or certificate flow) |
| 18 | Default `HOST=0.0.0.0` | Low | **Open, needs owner's decision** | Allow-list and firewall script reduce it |
| 19 | Live SQLite file not encrypted | Medium | **Accepted** | Use BitLocker |
| 20 | Postgres row-level security | Low | **Open (planned)** | Only the API connects to the database |
| 21 | Windows firewall script, `setup.bat` `.env`/icacls, CI workflows, Cloudflare Access | Info | **Unverified** | Not run on Windows / not yet run in CI |

## Reporting

This is a shop's private project. Report anything you find to the shop's Admin or the maintainer privately, not in a public issue.
