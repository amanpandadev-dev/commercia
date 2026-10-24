import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Repeat, Trash2, Truck } from 'lucide-react';
import { api } from '../api';
import { useApp, type CProduct } from '../state';
import { Bi, Empty, Field, ProductSearch } from '../components/ui';
import { baseUnitOf, productStock, rs, unitShort, qty, reorderLabel } from '../format';
import { parseQty, parseRupees, roundHalfUp } from '../../../shared/money';
import { istDate } from '../../../shared/dates';
import { baseLabel } from '../../../shared/units';

interface Line {
  key: number;
  productId: number;
  unitId: number;
  qty: string;
  rate: string;
}

let lineKey = 0;
const DRAFT = 'commercia.draft.stockin';

export function StockIn() {
  const { products, t, lang, reloadCatalog, toast } = useApp();
  const [params] = useSearchParams();
  const [supplier, setSupplier] = useState('');
  const [date, setDate] = useState(istDate());
  const [lines, setLines] = useState<Line[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [focus, setFocus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    api.get('/api/suppliers').then(setSuppliers).catch(() => {});
    api.get('/api/stock-ins').then(setRecent).catch(() => {});
    // Restore an unsaved draft so a slow connection never loses typing.
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT) ?? 'null');
      if (d?.lines?.length && !params.get('items')) {
        setSupplier(d.supplier ?? '');
        setLines(d.lines);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT, JSON.stringify({ supplier, lines }));
    } catch {
      /* ignore */
    }
  }, [supplier, lines]);

  // Prefill from the dashboard's "stock in for all low items".
  useEffect(() => {
    const ids = params.get('items')?.split(',').map(Number) ?? [];
    if (ids.length && products.length) {
      setLines(ids.map((id) => products.find((p) => p.id === id)).filter(Boolean).map((p) => newLine(p!)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, products.length]);

  const newLine = (p: CProduct): Line => {
    const unit = p.units.find((u) => u.id === p.buyUnitId) ?? [...p.units].sort((a, b) => b.factorMilli - a.factorMilli)[0] ?? baseUnitOf(p);
    return { key: ++lineKey, productId: p.id, unitId: unit.id, qty: '', rate: '' };
  };
  const add = (p: CProduct) => {
    setLines((ls) => [...ls, newLine(p)]);
    setFocus(p.id);
    setTimeout(() => (document.querySelector(`[data-qty="${lineKey}"]`) as HTMLInputElement | null)?.focus(), 30);
  };
  const upd = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const total = lines.reduce((a, l) => {
    const q = parseQty(l.qty);
    const r = parseRupees(l.rate);
    return a + (q > 0 && r >= 0 ? roundHalfUp((q * r) / 1000) : 0);
  }, 0);

  const repeatLast = async () => {
    if (!supplier) return;
    const d = await api.get(`/api/stock-ins/last?supplier=${encodeURIComponent(supplier)}`);
    if (!d.lines.length) return toast(`No earlier delivery from ${supplier}`, 'warn');
    setLines(d.lines.filter((l: any) => products.some((p) => p.id === l.productId)).map((l: any) => ({ key: ++lineKey, productId: l.productId, unitId: l.unitId, qty: qty(l.qtyMilli ?? 0), rate: l.ratePaise != null ? String(l.ratePaise / 100) : '' })));
  };

  const save = async () => {
    setErr('');
    const body = [];
    for (const l of lines) {
      const q = parseQty(l.qty);
      if (!(q > 0)) return setErr('Every line needs a quantity');
      const r = l.rate.trim() ? parseRupees(l.rate) : null;
      if (r != null && Number.isNaN(r)) return setErr('Check the purchase rates');
      body.push({ productId: l.productId, unitId: l.unitId, qtyMilli: q, ratePaise: r });
    }
    setBusy(true);
    try {
      await api.post('/api/stock-ins', { supplier, date, lines: body });
      toast(`Added to stock${supplier ? ` from ${supplier}` : ''}`);
      setLines([]);
      localStorage.removeItem(DRAFT);
      await reloadCatalog();
      api.get('/api/stock-ins').then(setRecent).catch(() => {});
      api.get('/api/suppliers').then(setSuppliers).catch(() => {});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const focused = products.find((p) => p.id === focus) ?? products.find((p) => p.id === lines[lines.length - 1]?.productId);

  return (
    <div className="split">
      <div className="card">
        <div className="card-head"><Bi en="New stock entry" as="h3" /></div>
        <div className="card-pad col gap-16">
          <div className="grid grid-2">
            <Field label={t('Supplier')}>
              <div className="row">
                <div className="input-wrap grow">
                  <Truck size={16} />
                  <input className="input" list="suppliers" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Gupta Traders" />
                </div>
                <button className="btn" onClick={repeatLast} disabled={!supplier} title="Repeat this supplier's last delivery"><Repeat size={15} /><span className="hide-sm">{t('Repeat')}</span></button>
              </div>
              <datalist id="suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
            </Field>
            <Field label={t('Date')}><input className="input" type="date" value={date} max={istDate()} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          <ProductSearch onPick={add} showPrice={false} placeholder={lang === 'en' ? 'Add item… / सामान जोड़ें' : 'सामान जोड़ें…'} />
          {lines.length === 0 ? (
            <Empty>Search above to add what arrived. Quantities can be in bags, boxes or loose units.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('Product')}</th><th>{t('Quantity')}</th><th>{t('Unit')}</th><th className="right">{t('Purchase rate')} ₹</th><th className="right">{t('Amount')}</th><th /></tr></thead>
                <tbody>
                  {lines.map((l) => {
                    const p = products.find((x) => x.id === l.productId);
                    if (!p) return null;
                    const q = parseQty(l.qty);
                    const r = parseRupees(l.rate);
                    const u = p.units.find((x) => x.id === l.unitId)!;
                    return (
                      <tr key={l.key} onClick={() => setFocus(p.id)}>
                        <td className="name"><b>{lang === 'hi' && p.nameHi ? p.nameHi : p.nameEn}</b>{q > 0 && u && <span className="faint" style={{ fontSize: 12 }}>= {baseLabel(p.baseUnit, Math.round((q * u.factorMilli) / 1000), p.packKind)}</span>}</td>
                        <td style={{ width: 90 }}><input data-qty={l.key} className="input sm num" inputMode="decimal" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /></td>
                        <td style={{ width: 130 }}>
                          <select className="input sm" value={l.unitId} onChange={(e) => upd(l.key, { unitId: Number(e.target.value) })}>
                            {p.units.map((x) => <option key={x.id} value={x.id}>{unitShort(x, p)}</option>)}
                          </select>
                        </td>
                        <td style={{ width: 120 }}><input className="input sm num" inputMode="decimal" value={l.rate} onChange={(e) => upd(l.key, { rate: e.target.value })} placeholder={`/${unitShort(u, p)}`} /></td>
                        <td className="right num nowrap">{q > 0 && r >= 0 ? rs(roundHalfUp((q * r) / 1000)) : '—'}</td>
                        <td><button className="btn ghost sm icon" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label="Remove"><Trash2 size={15} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr><td colSpan={4} className="right">{t('Total')}</td><td className="right num">{rs(total)}</td><td /></tr></tfoot>
              </table>
            </div>
          )}
          {err && <div className="err">{err}</div>}
          <button className="btn primary big" disabled={!lines.length || busy} onClick={save}>
            <Check size={18} /> {t('Add to stock')}
          </button>
        </div>
      </div>

      <div className="col gap-16">
        {focused ? (
          <div className="card card-pad">
            <div className="row between">
              <b>{focused.nameEn} <span className="hi">{focused.nameHi}</span></b>
              <span className="muted" style={{ fontSize: 12 }}>Current stock</span>
            </div>
            <div className={`num ${focused.low ? 'err' : ''}`} style={{ fontSize: 34, fontWeight: 600, margin: '6px 0' }}>{productStock(focused)}</div>
            {focused.reorderMilli != null && (
              <>
                <div className="meter"><i style={{ width: `${Math.min(100, (focused.stockMilli / Math.max(1, focused.reorderMilli * 3)) * 100)}%`, background: focused.low ? 'var(--danger)' : 'var(--brand)' }} /></div>
                <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Reorder at {reorderLabel(focused)}</div>
              </>
            )}
          </div>
        ) : null}
        <div className="card">
          <div className="card-head"><Bi en="Recent deliveries" as="h3" /></div>
          {recent.length === 0 ? <Empty>None yet</Empty> : recent.slice(0, 8).map((s) => (
            <div key={s.id} className="list-item" style={{ cursor: 'default' }}>
              <span className="tag ok">+</span>
              <div className="grow">
                <div>{s.supplier || 'Delivery'}</div>
                <div className="faint" style={{ fontSize: 12 }}>{s.by} · {s.date}</div>
              </div>
              <span className="num">{s.total_paise ? rs(s.total_paise, false) : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

