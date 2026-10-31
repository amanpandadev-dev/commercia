// Checks the email settings by sending one real message. Run it after setting SMTP_* in .env:
//
//   npm run test-mail -- you@example.com
//
// Prints what went wrong in plain words (never the password).
import '../lib/boot';
import nodemailer from 'nodemailer';
import { config } from '../lib/config';
import { redact } from '../lib/redact';

const to = process.argv.slice(2).find((a) => a.includes('@'));
const { smtpUrl, mailFrom } = config();
if (!smtpUrl) {
  console.error('\n  Email is not set up. Put SMTP_HOST, SMTP_USER and SMTP_PASSWORD in .env (see docs/EMAIL.md), then run this again.\n');
  process.exit(1);
}
if (!to) {
  console.error('\n  Usage: npm run test-mail -- you@example.com\n');
  process.exit(1);
}

const hint = (e: { code?: string; responseCode?: number; message?: string }) => {
  if (e.code === 'EAUTH' || e.responseCode === 535) return 'The email provider refused the user name or password. For Gmail this must be an App Password (not your normal password), and 2-Step Verification must be on.';
  if (e.code === 'ENOTFOUND' || e.code === 'EDNS') return 'The mail server name (SMTP_HOST) was not found. Check the spelling, and that this computer is online.';
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ESOCKET') return 'Could not reach the mail server. Check SMTP_PORT (465, or 587) and that the internet and any firewall allow it.';
  if (e.responseCode === 550 || e.responseCode === 553) return 'The server refused the sender or the address. MAIL_FROM should be the same address as SMTP_USER.';
  return '';
};

try {
  const transport = nodemailer.createTransport(smtpUrl);
  await transport.verify();
  await transport.sendMail({ from: mailFrom, to, subject: 'Commercia: test email', text: 'This is a test from Commercia. If you can read it, email is set up: password reset codes and authenticator setup codes will arrive like this.\n' });
  console.log(`\n  Sent. Check the inbox of ${to} (and its Spam folder). Codes will come from: ${mailFrom}\n`);
} catch (e) {
  const err = e as { code?: string; responseCode?: number; message?: string };
  console.error(`\n  Could not send: ${redact(err.message ?? String(e))}`);
  const h = hint(err);
  if (h) console.error(`  ${h}`);
  console.error('');
  process.exit(1);
}
