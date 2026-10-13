import type { Tx } from './core';
import type { GstScheme } from '../../shared/gst';

export interface SchemePeriod {
  from: string;
  scheme: GstScheme;
}

export const DEFAULT_SETTINGS = {
  shop_name: 'My Kirana Store',
  shop_name_hi: '',
  shop_address: '',
  shop_phone: '',
  shop_gstin: '',
  paper: 'A4', // A4 | thermal (Q9: A4 default)
  prefix_receipt: 'R',
  prefix_invoice: 'INV',
  prefix_estimate: 'EST',
  gst_schemes: JSON.stringify([{ from: '2000-01-01', scheme: 'regular' }] satisfies SchemePeriod[]),
  composition_pct: '1',
  require_2fa: '1',
  edit_window_min: '60', // Q7: about an hour
  backup_dir: '',
  last_backup_at: '',
  default_lang: 'en',
};

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = Record<SettingKey, string>;

export async function getSettings(tx: Tx): Promise<Settings> {
  const rows = await tx.selectFrom('settings').selectAll().execute();
  const out = { ...DEFAULT_SETTINGS } as Settings;
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key as SettingKey] = r.value;
  return out;
}

export async function setSetting(tx: Tx, key: string, value: string): Promise<void> {
  const exists = await tx.selectFrom('settings').select('key').where('key', '=', key).executeTakeFirst();
  if (exists) await tx.updateTable('settings').set({ value }).where('key', '=', key).execute();
  else await tx.insertInto('settings').values({ key, value }).execute();
}

/** The shop's GST scheme on a date (GST-1): the latest period that started on or before it. */
export function schemeOn(settings: Settings, date: string): GstScheme {
  const periods = JSON.parse(settings.gst_schemes) as SchemePeriod[];
  let scheme: GstScheme = 'regular';
  for (const p of [...periods].sort((a, b) => a.from.localeCompare(b.from))) if (p.from <= date) scheme = p.scheme;
  return scheme;
}
