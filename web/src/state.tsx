import type { PackKind } from '../../shared/units';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { translate, other, type Lang } from './i18n';
import { can, type Permission, type Role } from '../../shared/perms';
import { SearchIndex } from '../../shared/search';
import { istDate } from '../../shared/dates';

export interface Me {
  id: number;
  name: string;
  email: string;
  role: Role;
  lang: Lang;
  totpEnabled: boolean;
}

export interface CUnit {
  id: number;
  name: string;
  factorMilli: number;
  isBase: boolean;
  retail: number | null;
  wholesale: number | null;
}

export interface CProduct {
  id: number;
  code: string | null;
  categoryId: number | null;
  categoryPath: string[];
  nameEn: string;
  nameHi: string;
  brand: string;
  type: string;
  family: string;
  packSize: string;
  packKind: PackKind;
  hsn: string;
  gstBp: number;
  baseUnit: 'kg' | 'L' | 'pc';
  loose: boolean;
  stepMilli: number;
  reorderMilli: number | null;
  reorderUnitId: number | null;
  aliases: string;
  buyUnitId: number | null;
  sellUnitId: number | null;
  stockMilli: number;
  low: boolean;
  freq: number;
  units: CUnit[];
}

export interface Category {
  id: number;
  parent_id: number | null;
  name_en: string;
  name_hi: string;
}

export interface Settings {
  shop_name: string;
  shop_name_hi: string;
  shop_address: string;
  shop_phone: string;
  shop_gstin: string;
  paper: 'A4' | 'thermal';
  prefix_receipt: string;
  prefix_invoice: string;
  prefix_estimate: string;
  gst_schemes: string;
  prices_include_gst: string;
  default_gst: string;
  pack_types: string;
  composition_pct: string;
  require_2fa: string;
  edit_window_min: string;
  backup_dir: string;
  last_backup_at: string;
  default_lang: string;
}

interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error' | 'warn';
}

interface AppState {
  me: Me;
  lang: Lang;
  setLang: (l: Lang) => void;
  /** The person's choice; 'system' follows the phone or PC setting. */
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  t: (en: string) => string;
  sub: (en: string) => string;
  can: (p: Permission) => boolean;
  settings: Settings | null;
  reloadSettings: () => Promise<void>;
  products: CProduct[];
  categories: Category[];
  productIndex: SearchIndex<CProduct>;
  reloadCatalog: () => Promise<void>;
  toast: (text: string, kind?: Toast['kind']) => void;
  logout: () => Promise<void>;
  counts: { pendingRates: number; review: number };
  reloadCounts: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
};

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export type ThemePref = 'system' | 'light' | 'dark';
const darkQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)');
export function getStoredTheme(): ThemePref {
  const s = store.get('commercia.theme');
  return s === 'light' || s === 'dark' ? s : 'system';
}
let following: ((e: MediaQueryListEvent) => void) | null = null;
/** Sets light or dark on the page; with 'system' it also follows the device when that changes (e.g. at sunset). */
export function applyTheme(t: ThemePref) {
  const q = darkQuery();
  const set = (dark: boolean) => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
  };
  if (following && q) q.removeEventListener('change', following);
  following = null;
  if (t === 'system') {
    set(!!q?.matches);
    if (q) {
      following = (e) => set(e.matches);
      q.addEventListener('change', following);
    }
  } else set(t === 'dark');
}
export const storedLang = (): Lang | null => {
  const s = store.get('commercia.lang');
  return s === 'en' || s === 'hi' ? s : null;
};

export function productSearchIndex(products: CProduct[]) {
  return new SearchIndex(products, (p) => ({
    words: [
      p.nameEn,
      p.nameHi,
      p.brand,
      p.type,
      p.code ?? '',
      p.aliases.replace(/,/g, ' '),
      ...p.categoryPath,
      ...p.units.map((u) => u.name),
    ],
    primary: [p.nameEn, p.nameHi],
    frequency: p.freq,
  }));
}

export function AppProvider({ me: initialMe, onLogout, children }: { me: Me; onLogout: () => void; children: ReactNode }) {
  const [me] = useState(initialMe);
  const [lang, setLangState] = useState<Lang>(storedLang() ?? initialMe.lang ?? 'en');
  const [theme, setThemeState] = useState<ThemePref>(getStoredTheme());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [products, setProducts] = useState<CProduct[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [counts, setCounts] = useState({ pendingRates: 0, review: 0 });
  const toastId = useRef(0);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    store.set('commercia.lang', l);
    document.documentElement.lang = l;
    api.post('/api/account/lang', { lang: l }).catch(() => {});
  }, []);
  const setTheme = useCallback((t: ThemePref) => {
    setThemeState(t);
    store.set('commercia.theme', t);
    applyTheme(t);
  }, []);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const reloadCatalog = useCallback(async () => {
    const data = await api.get<{ products: CProduct[]; categories: Category[] }>(`/api/catalog?date=${istDate()}`);
    setProducts(data.products);
    setCategories(data.categories);
  }, []);
  const reloadSettings = useCallback(async () => setSettings(await api.get('/api/settings')), []);
  const reloadCounts = useCallback(async () => {
    if (!can(me.role, 'rates.approve')) return;
    const d = await api.get('/api/dashboard').catch(() => null);
    if (d) setCounts({ pendingRates: d.pendingRates, review: d.reviewCount });
  }, [me.role]);

  useEffect(() => {
    reloadCatalog().catch(() => {});
    reloadSettings().catch(() => {});
    reloadCounts().catch(() => {});
    applyTheme(theme);
    document.documentElement.lang = lang;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const productIndex = useMemo(() => productSearchIndex(products), [products]);

  const value: AppState = {
    me,
    lang,
    setLang,
    theme,
    setTheme,
    t: (en) => translate(lang, en),
    sub: (en) => other(lang, en),
    can: (p) => can(me.role, p),
    settings,
    reloadSettings,
    products,
    categories,
    productIndex,
    reloadCatalog,
    toast,
    logout: async () => {
      await api.post('/api/auth/logout').catch(() => {});
      onLogout();
    },
    counts,
    reloadCounts,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts no-print" role="status" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
