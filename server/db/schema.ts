import type { Generated, Insertable, Selectable } from 'kysely';
import type { Role } from '../../shared/perms';

// Money in paise, quantities in thousandths of a unit, GST in basis points.
// Dates are ISO "YYYY-MM-DD" (India time); timestamps ISO strings.

export interface SettingsTable {
  key: string;
  value: string;
}

export interface UsersTable {
  id: Generated<number>;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  active: number;
  lang: string;
  totp_secret: string | null;
  totp_enabled: number;
  /** A new authenticator being set up: it replaces totp_secret only when its first code is confirmed. */
  totp_pending: Generated<string | null>;
  /** The time step of the last authenticator code accepted: a code is never accepted twice. */
  totp_last_step: Generated<number | null>;
  /** Bumped on deactivate / sign out everywhere; sessions older than it die. */
  session_epoch: number;
  created_at: string;
}

export interface SessionsTable {
  id: string; // sha256 of the cookie token
  user_id: number;
  epoch: number;
  totp_ok: number;
  /** 1 once this session has proved it may set up an authenticator (an enrolment code, or first-time setup). */
  enrol_ok: Generated<number>;
  /** Until when a recent password check counts for sensitive actions. */
  reauth_until: Generated<string | null>;
  ip: Generated<string>;
  /** "Chrome on Windows" and the like, from the browser's own description. */
  device: Generated<string>;
  ua_hash: Generated<string>;
  created_at: string;
  last_seen: string;
  expires_at: string;
}

/** Browsers a person has logged in from (told apart by a long-lived cookie), so a login from a new one can be noticed. */
export interface KnownDevicesTable {
  id: Generated<number>;
  user_id: number;
  device_hash: string;
  label: string;
  first_seen: string;
  last_seen: string;
  last_ip: string;
}

/** One-use codes to get back in without the phone. Only a hash is kept. */
export interface RecoveryCodesTable {
  id: Generated<number>;
  user_id: number;
  code_hash: string;
  used_at: string | null;
  created_at: string;
}

/** One-time codes that allow a person to set up an authenticator: emailed to them, or issued by an Admin or Owner. */
export interface EnrolmentCodesTable {
  id: Generated<number>;
  user_id: number;
  kind: 'email' | 'admin';
  code_hash: string;
  issued_by: number | null;
  expires_at: string;
  attempts: number;
  used_at: string | null;
  created_at: string;
}

export interface CategoriesTable {
  id: Generated<number>;
  parent_id: number | null;
  name_en: string;
  name_hi: string;
  sort: number;
}

export interface ProductsTable {
  id: Generated<number>;
  code: string | null;
  category_id: number | null;
  name_en: string;
  name_hi: string;
  brand: string;
  type: string;
  hsn: string;
  base_unit: 'kg' | 'L' | 'pc';
  loose: number;
  /** Selling step for loose items, milli of base (250 = 0.25 kg). */
  step_milli: number;
  reorder_milli: number | null; // in base milli; null = switched off
  reorder_unit_id: number | null; // unit it was entered in, for display
  /** The item a pack size belongs to (Sooji, Refined Oil): lines packs of different brands up in the stock summary. */
  family: Generated<string>;
  /** Label only: '25 kg', '1 L'. */
  pack_size: Generated<string>;
  /** '' for ordinary items; bori | bag | tin | jar | pouch | bottle | pack for whole-pack items. */
  pack_kind: Generated<string>;
  aliases: string;
  buy_unit_id: number | null;
  sell_unit_id: number | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ProductUnitsTable {
  id: Generated<number>;
  product_id: number;
  name: string;
  factor_milli: number; // base milli per one of this unit
  is_base: number;
  active: number;
}

/** Dated selling prices per unit and price list (RATE-2, UNIT-3, HIST-5). */
export interface UnitPricesTable {
  id: Generated<number>;
  unit_id: number;
  list: 'retail' | 'wholesale';
  price_paise: number;
  from_date: string;
  set_by: number;
  approved_by: number | null;
  source: string; // manual | bill | import | approval | rates-screen
  created_at: string;
}

/** Dated GST rates per product (GST-2). */
export interface ProductGstTable {
  id: Generated<number>;
  product_id: number;
  gst_bp: number;
  from_date: string;
  set_by: number;
  created_at: string;
}

export interface RateChecksTable {
  unit_id: number;
  list: string;
  date: string;
  checked_by: number;
  created_at: string;
}

export interface RateRequestsTable {
  id: Generated<number>;
  unit_id: number;
  list: string;
  for_date: string;
  old_paise: number;
  new_paise: number;
  bill_id: number | null;
  status: 'pending' | 'approved' | 'rejected';
  final_paise: number | null;
  requested_by: number;
  decided_by: number | null;
  decided_at: string | null;
  created_at: string;
}

export interface StockInsTable {
  id: Generated<number>;
  supplier: string;
  date: string;
  /** The supplier's account this delivery went on (null when no supplier was named). */
  supplier_id: Generated<number | null>;
  /** The supplier's own invoice number. */
  invoice_no: Generated<string>;
  /** What the supplier is owed for this delivery: the invoice amount, as typed (prices include GST). */
  amount_paise: Generated<number>;
  /** Paid at the time of the delivery. The rest stayed on credit. */
  paid_paise: Generated<number>;
  note: string;
  total_paise: number;
  import_id: number | null;
  created_by: number;
  created_at: string;
}

export interface StockMovementsTable {
  id: Generated<number>;
  product_id: number;
  qty_milli: number; // base milli, signed
  kind: 'stock_in' | 'sale' | 'sale_cancel' | 'adjustment' | 'loss' | 'loss_reversal' | 'opening' | 'import';
  ref_type: string | null;
  ref_id: number | null;
  unit_id: number | null;
  unit_qty_milli: number | null;
  rate_paise: number | null; // purchase rate per unit, for stock in
  note: string;
  date: string;
  import_id: number | null;
  created_by: number;
  created_at: string;
}

export interface LossesTable {
  id: Generated<number>;
  reason: 'theft' | 'missing' | 'damaged' | 'expired' | 'other';
  date: string;
  notes: string;
  status: 'reported' | 'confirmed' | 'dismissed';
  value_paise: number;
  reverses_id: number | null;
  reported_by: number;
  confirmed_by: number | null;
  created_at: string;
}

export interface LossLinesTable {
  id: Generated<number>;
  loss_id: number;
  product_id: number;
  unit_id: number;
  qty_milli: number;
  base_milli: number;
  value_paise: number;
}

export interface CustomersTable {
  id: Generated<number>;
  name: string;
  nickname: string;
  phone: string;
  area: string;
  gstin: string;
  price_list: 'retail' | 'wholesale';
  active: number;
  created_at: string;
}

export interface BillsTable {
  id: Generated<number>;
  number: string;
  series: string;
  fy: string;
  seq: number;
  kind: 'receipt' | 'tax_invoice' | 'kaccha';
  print_as: string;
  status: 'active' | 'cancelled' | 'estimate' | 'converted';
  customer_id: number | null;
  customer_name: string;
  customer_gstin: string;
  bill_date: string;
  subtotal_paise: number;
  discount_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  round_off_paise: number;
  total_paise: number;
  /** 1 = the line rates on this bill contain GST (see settings.prices_include_gst when it was saved). */
  gst_inclusive: Generated<number>;
  paid_paise: number;
  credit_paise: number;
  rate_pending: number;
  needs_review: number;
  paper_ref: string;
  converted_to: number | null;
  cancel_reason: string;
  cancelled_by: number | null;
  cancelled_at: string | null;
  created_by: number;
  created_at: string;
}

export interface BillLinesTable {
  id: Generated<number>;
  bill_id: number;
  product_id: number;
  unit_id: number;
  name_en: string;
  name_hi: string;
  unit_name: string;
  factor_milli: number;
  hsn: string;
  qty_milli: number;
  rate_paise: number;
  official_rate_paise: number;
  gst_bp: number;
  amount_paise: number;
  discount_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  base_milli: number;
  /** 1 = a price typed for this bill only; the item's own price was not touched. */
  price_override: Generated<number>;
}

export interface PaymentsTable {
  id: Generated<number>;
  customer_id: number | null;
  bill_id: number | null;
  date: string;
  total_paise: number;
  note: string;
  reversal_of: number | null;
  reversed: number;
  /** Paid at the counter as part of the bill (shown inside the bill in the day book). */
  at_billing: number;
  created_by: number;
  created_at: string;
}

export type PayMode = 'cash' | 'upi' | 'card' | 'bank' | 'cheque';

export interface PaymentPartsTable {
  id: Generated<number>;
  payment_id: number;
  mode: PayMode;
  amount_paise: number;
  reference: string;
}

export interface LedgerTable {
  id: Generated<number>;
  customer_id: number;
  date: string;
  kind: 'opening' | 'bill' | 'payment' | 'reversal' | 'cancel' | 'correction';
  ref_type: string | null;
  ref_id: number | null;
  debit_paise: number;
  credit_paise: number;
  note: string;
  import_id: number | null;
  created_by: number;
  created_at: string;
}

export interface CashOutsTable {
  id: Generated<number>;
  date: string;
  category: 'supplier' | 'rent' | 'wages' | 'transport' | 'electricity' | 'other';
  payee: string;
  mode: PayMode;
  amount_paise: number;
  note: string;
  /** Set when the money went to a supplier on the purchase ledger. */
  supplier_id: Generated<number | null>;
  stock_in_id: Generated<number | null>;
  /** A reversal is a second row with a negative amount pointing at the original. */
  reversal_of: Generated<number | null>;
  reversed: Generated<number>;
  created_by: number;
  created_at: string;
}

export interface SuppliersTable {
  id: Generated<number>;
  name: string;
  phone: string;
  area: string;
  active: number;
  created_at: string;
}

/** What we owe each supplier. Append-only like the customer ledger; balance = owed - paid. */
export interface SupplierLedgerTable {
  id: Generated<number>;
  supplier_id: number;
  date: string;
  kind: 'opening' | 'purchase' | 'payment' | 'reversal' | 'correction';
  ref_type: string | null; // stock_in | cash_out
  ref_id: number | null;
  owed_paise: number; // adds to what we owe
  paid_paise: number; // takes away from it
  note: string;
  created_by: number;
  created_at: string;
}

/**
 * Forgotten passwords. A row is either a request waiting for an Owner (kind 'owner', no code yet)
 * or a one-time code, emailed (kind 'email') or issued by an Owner. Only a hash of the code is kept.
 */
export interface PasswordResetsTable {
  id: Generated<number>;
  user_id: number;
  kind: 'email' | 'owner';
  code_hash: string | null;
  requested_at: string;
  issued_at: string | null;
  issued_by: number | null;
  expires_at: string | null;
  attempts: number;
  used_at: string | null;
  dismissed: number;
}

/** Wrong passwords, codes and the like, counted per account and per address. See lib/throttle.ts. */
export interface AuthThrottleTable {
  key: string;
  fails: number;
  window_start: string;
  locked_until: string | null;
  /** How many times this key has been locked lately: each lock is longer than the last. */
  strikes: number;
  last_fail: string;
}

export interface ActivityTable {
  id: Generated<number>;
  user_id: number | null;
  action: string;
  entity: string;
  entity_id: number | null;
  summary: string;
  created_at: string;
}

/** Every saved version of a record (HIST-1). Append-only. */
export interface VersionsTable {
  id: Generated<number>;
  entity: string;
  entity_id: number;
  version: number;
  data: string; // JSON
  reason: string;
  changed_by: number | null;
  created_at: string;
}

export interface ImportsTable {
  id: Generated<number>;
  kind: 'products' | 'stock' | 'customers';
  file_name: string;
  summary: string;
  undone: number;
  created_by: number;
  created_at: string;
}

export interface CountersTable {
  name: string;
  value: number;
}

export interface DB {
  settings: SettingsTable;
  users: UsersTable;
  sessions: SessionsTable;
  categories: CategoriesTable;
  products: ProductsTable;
  product_units: ProductUnitsTable;
  unit_prices: UnitPricesTable;
  product_gst: ProductGstTable;
  rate_checks: RateChecksTable;
  rate_requests: RateRequestsTable;
  stock_ins: StockInsTable;
  stock_movements: StockMovementsTable;
  losses: LossesTable;
  loss_lines: LossLinesTable;
  customers: CustomersTable;
  bills: BillsTable;
  bill_lines: BillLinesTable;
  payments: PaymentsTable;
  payment_parts: PaymentPartsTable;
  ledger: LedgerTable;
  cash_outs: CashOutsTable;
  suppliers: SuppliersTable;
  supplier_ledger: SupplierLedgerTable;
  password_resets: PasswordResetsTable;
  auth_throttle: AuthThrottleTable;
  known_devices: KnownDevicesTable;
  recovery_codes: RecoveryCodesTable;
  enrolment_codes: EnrolmentCodesTable;
  activity: ActivityTable;
  versions: VersionsTable;
  imports: ImportsTable;
  counters: CountersTable;
}

export type User = Selectable<UsersTable>;
export type Product = Selectable<ProductsTable>;
export type NewProduct = Insertable<ProductsTable>;
export type Customer = Selectable<CustomersTable>;
export type Bill = Selectable<BillsTable>;
