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
7. **Tell Commercia it is behind a proxy.** Open `start.bat` in Notepad and add this line just above the line that starts `call npm run serve`:

   ```
   set TRUST_PROXY=1
   ```

   Save, close the Commercia window, and start it again. This makes the login cookie `Secure` and lets the lockout see each visitor's real address.
8. **Check it.** On a phone using mobile data (not the shop Wi-Fi), open `https://shop.yourdomain.com`. You should get Cloudflare's email-code screen, then Commercia's login, then the authenticator code.

Staff in the shop keep using the laptop's address on the shop Wi-Fi, as before.

## Security measures

**Already in the app**
- Five wrong passwords lock that account for 15 minutes, even for the right password; the same goes for five wrong authenticator codes. 30 wrong tries from one address lock that address.
- The login cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` behind the tunnel. The site sends HSTS and refuses to be shown inside another page.
- Sessions end after 12 idle hours, and a deactivated user or "sign out everywhere" ends them at once. Passwords are hashed. Wrong logins are in the activity log.

**Do these**
1. Cloudflare Access in front, with only the owners' emails (step 6). Anyone else never reaches the Commercia login.
2. Two-step login on the Cloudflare account and on the domain registrar. Whoever controls either controls the address.
3. Settings → the checkbox "Owners and the Admin must enter an authenticator code at login" stays on, and every Owner and Admin has enrolled their app.
4. Never port-forward on the router, and never share the tunnel token.
5. Long, unique passwords. Remove users who have left (deactivate them).
6. Encrypt the laptop's disk (BitLocker, in Windows 11 Pro), keep Windows Update and Defender on, and use a non-administrator Windows account for day-to-day work. The database has customer names, phone numbers and dues.
7. Backups: **Settings → Backup** to a synced Google Drive/OneDrive folder plus a USB copy, and try a restore once.
8. Now and then, read the activity log for `login_failed` entries, and Zero Trust → *Logs* → *Access* for who got in.

**What this does not cover**
- The laptop being off or offline: no access. Staff on the shop Wi-Fi still work if the router is up.
- Malware on the laptop, or on the owner's phone.
- Someone on the shop Wi-Fi who knows a password: `TRUST_PROXY` lets them fake their address to dodge the per-address limit, but the per-account lockout still applies. If that worries you, use a separate Wi-Fi for staff and keep the laptop's Windows firewall on.
- There is no Content-Security-Policy yet, and the login screen still lists user names (Access hides it from everyone but the owner).
