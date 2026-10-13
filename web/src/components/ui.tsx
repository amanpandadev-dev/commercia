import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X, Search } from 'lucide-react';
import { useApp, type CProduct } from '../state';
import { avatarColor, initials, productStock, rs, baseUnitOf, priceFor, unitShort } from '../format';
import { SearchIndex } from '../../../shared/search';

export function Modal({ title, sub, onClose, children, foot, wide }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {sub && <div className="hi">{sub}</div>}
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, error, hint }: { label: ReactNode; children: ReactNode; error?: string; hint?: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="faint" style={{ fontSize: 12 }}>{hint}</span>}
      {error && <span className="err">{error}</span>}
    </div>
  );
}

export function Avatar({ name, lg }: { name: string; lg?: boolean }) {
  return (
    <span className={`avatar ${lg ? 'lg' : ''}`} style={{ background: avatarColor(name) }} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** A label in the chosen language with the other language underneath, like the demo screens. */
export function Bi({ en, as: As = 'span', className }: { en: string; as?: 'span' | 'h3' | 'h2' | 'b'; className?: string }) {
  const { t, sub } = useApp();
  const s = sub(en);
  return (
    <As className={className}>
      {t(en)}
      {s && s !== t(en) && <span className="hi"> {s}</span>}
    </As>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const RECENT_KEY = 'commercia.recentProducts';
export function rememberProduct(id: number) {
  try {
    const cur: number[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...cur.filter((x) => x !== id)].slice(0, 10)));
  } catch {
    /* ignore */
  }
}
function recentProducts(): number[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

/**
 * The search box used on New bill, Stock in and elsewhere (SRCH-1..6): focused on load,
 * any word order, part-words, Hindi and typos; Enter adds the top result.
 */
export function ProductSearch({
  onPick,
  autoFocus = true,
  placeholder,
  list = 'retail',
  showPrice = true,
}: {
  onPick: (p: CProduct) => void;
  autoFocus?: boolean;
  placeholder?: string;
  list?: 'retail' | 'wholesale';
  showPrice?: boolean;
}) {
  const { productIndex, products, t, lang } = useApp();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 60);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const results = useMemo(() => {
    if (!debounced.trim()) {
      const ids = recentProducts();
      const rec = ids.map((id) => products.find((p) => p.id === id)).filter(Boolean) as CProduct[];
      return rec.length ? rec : [...products].sort((a, b) => b.freq - a.freq).slice(0, 10);
    }
    return productIndex.search(debounced, 12);
  }, [debounced, productIndex, products]);

  useEffect(() => setHl(0), [debounced]);

  const pick = (p: CProduct) => {
    rememberProduct(p.id);
    onPick(p);
    setQ('');
    setHl(0);
    ref.current?.focus();
  };

  return (
    <div className="search-box">
      <div className="input-wrap">
        <Search size={16} />
        <input
          ref={ref}
          className="input"
          value={q}
          placeholder={placeholder ?? `${t('Add item…')}${lang === 'en' ? ' / सामान जोड़ें' : ''}`}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHl((h) => Math.min(h + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHl((h) => Math.max(h - 1, 0));
            } else if (e.key === 'Enter' && results[hl]) {
              e.preventDefault();
              pick(results[hl]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
          aria-label="Search items"
          autoComplete="off"
          enterKeyHint="search"
        />
      </div>
      {open && results.length > 0 && (
        <div className="results" role="listbox">
          {!q.trim() && <div className="faint" style={{ padding: '6px 12px', fontSize: 11 }}>RECENT / FREQUENT</div>}
          {results.map((p, i) => {
            const base = baseUnitOf(p);
            return (
              <div key={p.id} className={`result ${i === hl ? 'hl' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} role="option" aria-selected={i === hl}>
                <div className="grow">
                  <div>
                    <b style={{ fontWeight: 500 }}>{lang === 'hi' && p.nameHi ? p.nameHi : p.nameEn}</b>{' '}
                    <span className="hi">{lang === 'hi' ? p.nameEn : p.nameHi}</span>
                  </div>
                  <div className="meta">
                    {[p.brand, p.categoryPath.join(' › ')].filter(Boolean).join(' · ')}
                    {p.units.length > 1 && ` · ${p.units.filter((u) => !u.isBase).map((u) => u.name).join(', ')}`}
                  </div>
                </div>
                {showPrice && base && (
                  <div className="right nowrap">
                    <div className="num" style={{ fontWeight: 600, color: 'var(--brand)' }}>
                      {rs(priceFor(base, list))}
                      <span className="faint" style={{ fontWeight: 400 }}> /{unitShort(base, p)}</span>
                    </div>
                    <div className={`meta ${p.low ? 'err' : ''}`}>{productStock(p)}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface CustomerRow {
  id: number;
  name: string;
  nickname: string;
  phone: string;
  area: string;
  gstin: string;
  price_list: 'retail' | 'wholesale';
  balance: number;
  lastActivity: string | null;
  ageing: { b0: number; b30: number; b60: number; b90: number; oldest: string | null } | null;
}

export function customerIndex(customers: CustomerRow[]) {
  return new SearchIndex(customers, (c) => ({
    words: [c.name, c.nickname, c.area, c.phone, c.phone.slice(-4), c.phone.slice(-5), c.phone.slice(-6), c.gstin],
    primary: [c.name, c.nickname],
  }));
}

/** Customer search by name, nickname or phone digits, each with their due (SRCH-8). */
export function CustomerSearch({
  customers,
  onPick,
  onPay,
  autoFocus,
  placeholder = 'Customer name, nickname or phone…',
  footer,
}: {
  customers: CustomerRow[];
  onPick: (c: CustomerRow) => void;
  onPay?: (c: CustomerRow) => void;
  autoFocus?: boolean;
  placeholder?: string;
  footer?: (q: string) => ReactNode;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const idx = useMemo(() => customerIndex(customers), [customers]);
  const results = useMemo(() => (q.trim() ? idx.search(q, 10) : [...customers].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '')).slice(0, 10)), [q, idx, customers]);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div className="search-box">
      <div className="input-wrap">
        <Search size={16} />
        <input
          ref={ref}
          className="input"
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setHl(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, results.length - 1));
            else if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0));
            else if (e.key === 'Enter' && results[hl]) {
              e.preventDefault();
              onPick(results[hl]);
              setQ('');
              setOpen(false);
            }
          }}
          autoComplete="off"
          aria-label="Search customers"
        />
      </div>
      {open && (
        <div className="results">
          {results.map((c, i) => (
            <div
              key={c.id}
              className={`result ${i === hl ? 'hl' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(c);
                setQ('');
                setOpen(false);
              }}
            >
              <Avatar name={c.name} />
              <div className="grow">
                <b style={{ fontWeight: 500 }}>{c.name}</b>
                {c.nickname && <span className="muted"> ({c.nickname})</span>}
                <div className="meta">{[c.area, c.phone].filter(Boolean).join(' · ') || ' '}</div>
              </div>
              <div className="right">
                {c.balance > 0 ? <span className="tag warn num">Due {rs(c.balance, false)}</span> : c.balance < 0 ? <span className="tag ok num">Advance {rs(-c.balance, false)}</span> : null}
                {onPay && (
                  <div>
                    <button
                      className="btn sm ghost"
                      style={{ color: 'var(--brand)' }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPay(c);
                        setOpen(false);
                      }}
                    >
                      Receive payment
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {footer?.(q)}
        </div>
      )}
    </div>
  );
}

/** A reason prompt for cancels, reversals and adjustments. */
export function ReasonDialog({ title, label = 'Reason', confirmText = 'Confirm', danger, onClose, onConfirm }: { title: string; label?: string; confirmText?: string; danger?: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal
      title={title}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>Back</button>
          <button
            className={`btn ${danger ? 'danger solid' : 'primary'}`}
            disabled={!reason.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <Field label={label} error={err}>
        <textarea className="input" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
