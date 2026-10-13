// The one permission table. The server checks it on every request (AUTH-3, PILOT-4);
// the screens use it only to hide buttons.

export type Role = 'admin' | 'owner' | 'entry';

export const PERMISSIONS = {
  'users.manage': ['admin', 'owner'],
  'settings.edit': ['admin', 'owner'],
  'catalog.edit': ['admin', 'owner'],
  'price.set': ['admin', 'owner'],
  'gst.edit': ['admin', 'owner'],
  'stock.in': ['admin', 'owner', 'entry'],
  'stock.adjust': ['admin', 'owner'],
  'loss.record': ['admin', 'owner'],
  'loss.report': ['admin', 'owner', 'entry'],
  'bill.create': ['admin', 'owner', 'entry'],
  'bill.cancel': ['admin', 'owner'],
  'bill.correct': ['admin', 'owner'],
  'customer.edit': ['admin', 'owner', 'entry'],
  'payment.receive': ['admin', 'owner', 'entry'],
  'payment.reverse': ['admin', 'owner'],
  'cashout.create': ['admin', 'owner', 'entry'],
  'import.products': ['admin', 'owner'],
  'import.stock': ['admin', 'owner', 'entry'],
  'import.customers': ['admin', 'owner'],
  'import.undo': ['admin', 'owner'],
  'reports.view': ['admin', 'owner'],
  'daybook.view': ['admin', 'owner', 'entry'],
  'rates.approve': ['admin', 'owner'],
  'review.view': ['admin', 'owner'],
  'activity.view': ['admin', 'owner'],
  'backup.run': ['admin', 'owner'],
  'data.reset': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | undefined | null, perm: Permission): boolean {
  return !!role && (PERMISSIONS[perm] as readonly Role[]).includes(role);
}

export const ROLE_LABEL: Record<Role, { en: string; hi: string }> = {
  admin: { en: 'Admin', hi: 'एडमिन' },
  owner: { en: 'Owner', hi: 'मालिक' },
  entry: { en: 'Entry person', hi: 'एंट्री' },
};
