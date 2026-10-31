# Reaching Commercia from outside the shop (Cloudflare Tunnel + Access)

The shop laptop keeps running Commercia. A small program on it, `cloudflared`, makes an **outgoing** connection to Cloudflare, and Cloudflare serves `https://shop.yourdomain.com` through it. **Cloudflare Access** sits in front and lets in only the email addresses you list. The owner can reach the data whenever the laptop is on and online. Nothing is stored in the cloud, and nothing is opened on the shop's router.

Cloudflare's screens and plan terms change. If a name below has moved, follow Cloudflare's current documentation for the same step.

## What you need
- The shop laptop, already running Commercia (`start.bat`).
- A domain name (about ₹600 to ₹1,000 a year for a `.com` or `.in`).
- A free Cloudflare account. Turn on **two-step login** for it first (Profile → Authentication).

## Steps

1. **Put the domain on Cloudflare.** dash.cloudflare.com → *Add a domain* → enter it → choose the **Free** plan. Cloudflare gives two nameservers: set them at the place you bought the domain, and wait until Cloudflare says the domain is *Active*.
2. **Open Zero Trust.** In the Cloudflare dashboard, open **Zero Trust** (one.dash.cloudflare.com) and create the team name when asked. The Free plan is enough; it may ask for a card.
3. **Create the tunnel.** Zero Trust → *Networks* → *Tunnels* → *Create a tunnel* → **Cloudflared** → name it `shop-laptop` → choose **Windows**.
4. **Install it on the shop laptop.** Cloudflare shows a command with a long token. Copy it, open **Command Prompt as Administrator** on the shop laptop, and paste it. It installs `cloudflared` as a Windows service, so it starts by itself when the laptop starts. Back in the dashboard the connector should show **Healthy**. Treat that token like a password: don't share it or screenshot it.
5. **Point a web address at Commercia.** In the tunnel, *Public hostnames* → *Add*: subdomain `shop`, your domain, type **HTTP**, URL `localhost:8787`.
6. **Lock it to the owner.** Zero Trust → *Access* → *Applications* → *Add an application* → **Self-hosted**:
   - Name: Commercia. Application domain: `shop.yourdomain.com`.
   - Add a policy: name `Owner only`, action **Allow**, rule *Emails* → the owner's email address(es). Don't use "everyone" or a whole-domain rule.
   - Login method: **One-time PIN** (Cloudflare emails a code). Set the session length to 24 hours or less.
7. **Tell Commercia it is behind a proxy.** Copy `.env.example` to `.env` (or run `npm run init-env`) and add the line `TRUST_PROXY=1`. Add `ALLOWED_ORIGINS=https://shop.yourdomain.com` too. Close the Commercia window and start it again. `TRUST_PROXY=1` means: believe the forwarding headers **only** from a program on this same laptop (the tunnel). Someone on the shop Wi-Fi who sends fake headers is ignored. It makes the login cookie `Secure` (`__Host-` prefixed), and the lockouts and rate limits then see each visitor's real address.
8. **Check it.** On a phone using mobile data (not the shop Wi-Fi), open `https://shop.yourdomain.com`. You should get Cloudflare's email-code screen, then Commercia's login, then the authenticator code.

Staff in the shop keep using the laptop's address on the shop Wi-Fi, as before.

## Security measures

**Already in the app** (details in `SECURITY.md`)
- Wrong passwords, authenticator codes, recovery codes and reset codes lock the account (5, 15, 45, then 60 minutes, never longer) and the address, even for the right password later. A lock shows on the Security screen and Dashboard and is emailed if SMTP is set. Unlock on the laptop with `npm run reset-password -- <email> --unlock`.
- The login cookie is `__Host-`prefixed, `HttpOnly`, `SameSite=Strict` and `Secure` behind the tunnel. Strict CSP, HSTS and no framing. Changes must come from the app's own address.
- Rate limits on login, the API and uploads; request size and time limits.
- The first-run setup screen works only on the shop laptop itself (or with a one-time console code), so a stranger reaching the URL on day one cannot claim the shop.
- The login screen does not list names to anyone coming through the tunnel; people type their email.
- Sessions end after 12 idle hours; Settings shows every signed-in device and can end any of them; a new device raises an alert.

**Do these**
1. Cloudflare Access in front, with only the owners' emails (step 6). Anyone else never reaches the Commercia login.
2. Two-step login on the Cloudflare account and on the domain registrar. Whoever controls either controls the address.
3. Settings → the checkbox "Owners and the Admin must enter an authenticator code at login" stays on, and every Owner and Admin has enrolled their app.
4. Never port-forward on the router, and never share the tunnel token.
5. Long, unique passwords. Remove users who have left (deactivate them).
6. Encrypt the laptop's disk (BitLocker, in Windows 11 Pro), keep Windows Update and Defender on, and use a non-administrator Windows account for day-to-day work. The database has customer names, phone numbers and dues.
7. Backups: **Settings → Backup** to a synced Google Drive/OneDrive folder plus a USB copy, keep a copy of the secret key (`data/commercia.key` or `COMMERCIA_SECRET_KEY`) somewhere else, and try a restore once (`npm run restore-backup`).
8. Now and then, open **Security** in Commercia (lockouts, new devices, exports) and read the activity log for `login_failed` entries, and Zero Trust → *Logs* → *Access* for who got in.

**What this does not cover**
- The laptop being off or offline: no access. Staff on the shop Wi-Fi still work if the router is up.
- Malware on the laptop, or on the owner's phone.
- Cloudflare itself, or whoever controls the domain or the Cloudflare account (keep two-step login on both).
- Staff on the shop Wi-Fi use plain http: a person on that Wi-Fi can read a login in transit. Use a strong Wi-Fi password and a separate guest network, and run `scripts\windows\firewall.bat allow` so only the shop network reaches the laptop.
- Everything in this guide that touches Cloudflare was written from their documentation and has not been tried end to end.
