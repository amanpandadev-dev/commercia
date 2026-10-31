# Setting up email (free, about 10 minutes)

With email set up, Commercia sends a code to the person's own address:

- **First login, before the authenticator.** After the password, the screen says "we emailed a code to r***@…". They type the 8-character code, and only then see the QR code for their authenticator app. (This proves they own the address, so a stranger who learns a password cannot claim the authenticator first.)
- **Forgot password.** "Forgot password?" emails a code. They type it with a new password.
- **Alerts.** Owners and the Admin get an email when an account is locked after too many wrong tries, and a person gets an email when their account is used from a new device.

Without email, everything still works: the Admin or an Owner reads a code out in person (Users screen). Email is optional, free, and can be switched off by deleting the lines below.

Commercia sends mail by logging in to a mailbox you own. The simplest free one is a **Gmail** address made for the shop (for example `sharmakirana.alerts@gmail.com`). Use a separate one, not your personal inbox.

## 1. Get the access key (a Google "App Password")

This is a 16-letter password that works only for sending mail. It is not your Gmail password, and you can delete it at any time.

1. Sign in to the shop's Google account at myaccount.google.com.
2. Open **Security**. Under *How you sign in to Google*, turn on **2-Step Verification** (it asks for your phone number). App passwords do not exist until this is on.
3. Open **myaccount.google.com/apppasswords** (or search "App passwords" in the account search box).
4. Type a name such as `Commercia` and click **Create**.
5. Google shows a 16-letter password in four groups, like `abcd efgh ijkl mnop`. **Copy it now; Google never shows it again.** If you lose it, delete it and make another.

If you see "The setting you are looking for is not available for your account", 2-Step Verification is off, or the account is a work/school account whose administrator turned app passwords off. Use a plain Gmail address.

Google's screens change from time to time; follow the same steps under their current names.

## 2. Put it in `.env` on the shop laptop

1. In the Commercia folder, copy `.env.example` to `.env` (or run `npm run init-env`, which makes one with your secret key). `.env` stays on this computer; it is never uploaded.
2. Open `.env` in Notepad and add these lines (remove the `#` at the start of each). Paste the App Password with or without the spaces:

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=sharmakirana.alerts@gmail.com
   SMTP_PASSWORD=abcd efgh ijkl mnop
   MAIL_FROM=Sharma Kirana <sharmakirana.alerts@gmail.com>
   ```

   `MAIL_FROM` should use the same address as `SMTP_USER`; Gmail replaces any other sender.
3. Save, close, and **restart Commercia** (close its window and run `start.bat` again).

## 3. Test it

In a terminal in the Commercia folder:

```
npm run test-mail -- yourpersonal@gmail.com
```

It sends one message and says **Sent**, or says what is wrong ("the provider refused the password": the App Password is wrong or 2-Step Verification is off; "server not found": a typo in `SMTP_HOST`, or no internet). The password is never printed. Check the Spam folder the first time.

Then try the real thing: log in as an Owner who has no authenticator yet. You should see "We emailed a code to r***@…".

## Other providers

Anything that offers SMTP works; use its host, port, user name and password in the same four lines.

| Provider | Host / port | Notes |
| --- | --- | --- |
| Gmail | `smtp.gmail.com` / 465 | App Password as above. About 500 emails a day, far more than a shop needs. |
| Brevo (free plan) | `smtp-relay.brevo.com` / 587 | The password is an "SMTP key" from *SMTP & API* in your Brevo account; the user name is the SMTP login shown there (not your normal email). Brevo asks you to verify a sender address first. About 300 emails a day on the free plan. |
| Your own domain's mail | whatever the host tells you | Often 465 (secure from the start) or 587 (upgrades with STARTTLS). |

Port 587 and others use STARTTLS, and Commercia refuses to send if the server will not encrypt. Plain unencrypted ports are not supported by the four-line form.

## Keeping it safe

- The App Password lets someone send mail as that account, but not read it or change its settings. Treat it like a password: keep `.env` on the shop laptop only, never in the repository (`.env` is ignored by git), never in a chat or screenshot.
- If it leaks or the laptop is lost, delete it at myaccount.google.com/apppasswords and make a new one. Nothing else changes.
- Commercia hides the password in its own logs.
- Email is not a perfect channel: codes can be delayed or land in Spam, and anyone who can read that mailbox can read the codes. That is why the codes work once, expire in 30 minutes and allow five wrong tries. Keep two-step login on the Google account too.
- If email breaks (bad password, no internet), people are not locked out: the screens say the email could not be sent and the Admin or an Owner can read out a code from the Users screen.
