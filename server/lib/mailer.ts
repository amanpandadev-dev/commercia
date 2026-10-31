// Outgoing email, used for password-reset codes. The pilot works without it: set SMTP_URL
// (for example smtps://user:password@smtp.example.com:465) and MAIL_FROM to switch it on.
import nodemailer from 'nodemailer';
import { config } from './config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

interface Sender {
  sendMail(m: Mail & { from: string }): Promise<unknown>;
}

let override: Sender | null = null;
let cached: { url: string; transport: Sender } | null = null;

/** For tests: capture mail instead of sending it. Pass null to go back to SMTP_URL. */
export function setMailer(m: Sender | null) {
  override = m;
}

export const mailConfigured = () => !!override || !!config().smtpUrl;

export async function sendMail(m: Mail): Promise<void> {
  const from = config().mailFrom;
  if (override) {
    await override.sendMail({ from, ...m });
    return;
  }
  const url = config().smtpUrl;
  if (!url) throw new Error('Email is not set up (SMTP_URL)');
  if (!cached || cached.url !== url) cached = { url, transport: nodemailer.createTransport(url) as unknown as Sender };
  await cached.transport.sendMail({ from, ...m });
}
