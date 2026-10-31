// Security events people should see: written to the activity log (the Security screen and the Dashboard banner read
// them), and emailed to the Owners and the Admin when email is set up. The same kind of alert is emailed at most
// once every 30 minutes, so an attack does not fill an inbox.
import type { Tx } from './core';
import { logActivity } from './core';
import { mailConfigured, sendMail } from './mailer';
import { getSettings } from './settings';

/** Activity-log actions the Security screen shows. */
export const SECURITY_ACTIONS = [
  'login_failed', 'lockout', 'refused', 'password_forgot', 'password_reset', 'export', 'backup_download',
  'login_new_device', 'totp_reset', 'totp_enrolled', 'recovery_used', 'reauth_failed', 'setup_refused', 'enrolment_code',
] as const;

const lastEmailed = new Map<string, number>();
const EMAIL_EVERY_MS = 30 * 60_000;

export async function raiseAlert(k: Tx, a: { action: (typeof SECURITY_ACTIONS)[number]; userId?: number | null; entityId?: number | null; summary: string; email?: boolean; dedupe?: string }): Promise<void> {
  await logActivity(k, a.userId ?? null, a.action, 'security', a.entityId ?? null, a.summary);
  if (!a.email || !mailConfigured()) return;
  const key = a.dedupe ?? a.action;
  if (Date.now() - (lastEmailed.get(key) ?? 0) < EMAIL_EVERY_MS) return;
  lastEmailed.set(key, Date.now());
  try {
    const shop = (await getSettings(k)).shop_name;
    const people = await k.selectFrom('users').select(['email', 'name']).where('active', '=', 1).where('role', 'in', ['admin', 'owner']).execute();
    for (const p of people) {
      await sendMail({ to: p.email, subject: `${shop}: Commercia security alert`, text: `Hello ${p.name},\n\n${a.summary}\n\nLook at Security in Commercia for the details. If this was not you or someone you know, change the passwords and tell the shop Admin.\n` });
    }
  } catch (e) {
    console.error('Could not send the security alert email:', e instanceof Error ? e.message : e);
  }
}
