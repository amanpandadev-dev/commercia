import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Minus, Plus, Trash2, Users, X, Banknote, Smartphone, CreditCard, Landmark, FileCheck2, Clock } from 'lucide-react';
import { api } from '../api';
import { useApp, type CProduct, type CUnit } from '../state';
import { CustomerSearch, Empty, Field, Modal, ProductSearch, Seg, Avatar, rememberProduct, type CustomerRow } from '../components/ui';
import { CustomerForm } from '../components/CustomerForm';
import { PrintModal, type BillDetail } from '../components/BillDoc';
import { productStock, rs, unitShort, priceFor, qty as fmtQty } from '../format';
import { computeBill, type GstScheme } from '../../../shared/gst';
import { formatRate, parseQty, parseRupees } from '../../../shared/money';
import { istDate, shortDate } from '../../../shared/dates';

type Kind = 'receipt' | 'tax_invoice' | 'kaccha' | 'estimate';
type Mode = 'cash' | 'upi' | 'card' | 'bank' | 'cheque';

interface Line {
  key: number;
  productId: number;
  unitId: number;
  qty: string;
  rate: string; // rupees, as typed
  rateEdited: boolean;
}

const MODE_ICON: Record<Mode, React.ReactNode> = {
  cash: <Banknote size={15} />, upi: <Smartphone size={15} />, card: <CreditCard size={15} />, bank: <Landmark size={15} />, cheque: <FileCheck2 size={15} />,
};
const MODE_NAME: Record<Mode, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', cheque: 'Cheque' };
const DRAFT = 'commercia.draft.bill';
let lk = 0;
const toRupeeStr = (p: number | null | undefined) => (p == null ? '' : (p / 100).toFixed(2).replace(/\.00$/, ''));

function schemeOn(json: string | undefined, date: string): GstScheme {
  try {
    let s: GstScheme = 'regular';
    for (const p of (JSON.parse(json ?? '[]') as { from: string; scheme: GstScheme }[]).sort((a, b) => a.from.localeCompare(b.from))) if (p.from <= date) s = p.scheme;
    return s;
  } catch {
    return 'regular';
  }
}

export function Billing() {
  const { products, t, lang, settings, toast, reloadCatalog, can, me } = useApp();
  const [billDate, setBillDate] = useState(istDate());
  const [kind, setKind] = useState<Kind>('receipt');
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [parts, setParts] = useState<{ mode: Mode; amount: string; reference: string }[]>([{ mode: 'cash', amount: '', reference: '' }]);
  const [tendered, setTendered] = useState('');
  const [discount, setDiscount] = useState('');
  const [discountType, setDiscountType] = useState<'amount' | 'percent'>('amount');
  const [paperRef, setPaperRef] = useState('');
  const [gstin, setGstin] = useState('');
  const [dateCatalog, setDateCatalog] = useState<CProduct[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [printed, setPrinted] = useState<BillDetail | null>(null);
  const [dupWarn, setDupWarn] = useState<string | null>(null);
  const restored = useRef(false);
  const draftCustomer = useRef<number | null>(null);

  const list: 'retail' | 'wholesale' = customer?.price_list === 'wholesale' ? 'wholesale' : 'retail';
  const today = istDate();
  const cat = billDate === today || !dateCatalog ? products : dateCatalog;
  const prod = useCallback((id: number) => cat.find((p) => p.id === id) ?? products.find((p) => p.id === id), [cat, products]);
  const official = useCallback((l: Line) => {
    const u = prod(l.productId)?.units.find((x) => x.id === l.unitId);
    return u ? priceFor(u, list) : null;
  }, [prod, list]);

  const loadCustomers = useCallback(
    () =>
      api
        .get<CustomerRow[]>('/api/customers')
        .then((list) => {
          setCustomers(list);
          if (draftCustomer.current) {
            const id = draftCustomer.current;
            draftCustomer.current = null;
            setCustomer((c) => c ?? list.find((x) => x.id === id) ?? null);
          }
        })
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  // Restore an unsaved bill (typing is never lost on a slow connection).
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT) ?? 'null');
      if (d?.lines?.length) {
        setLines(d.lines);
        setKind(d.kind ?? 'receipt');
        setBillDate(d.billDate ?? istDate());
        setPaperRef(d.paperRef ?? '');
        draftCustomer.current = d.customerId ?? null;
        lk = Math.max(lk, ...d.lines.map((l: Line) => l.key));
      }
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      if (lines.length) localStorage.setItem(DRAFT, JSON.stringify({ lines, kind, billDate, paperRef, customerId: customer?.id ?? null }));
      else localStorage.removeItem(DRAFT);
    } catch {
      /* ignore */
    }
  }, [lines, kind, billDate, paperRef, customer]);

  // Rates in force on the bill date (RATE-2), and which ones were already confirmed that day (RATE-3).
  useEffect(() => {
    if (billDate !== today) api.get(`/api/catalog?date=${billDate}`).then((d) => setDateCatalog(d.products)).catch(() => {});
    else setDateCatalog(null);
    api.get<string[]>(`/api/rates/checks?date=${billDate}`).then((x) => setChecked(new Set(x))).catch(() => {});
    setAnswered(new Set());
  }, [billDate, today]);

  // Re-price untouched lines when the date or price list changes.
  useEffect(() => {
    setLines((ls) => ls.map((l) => (l.rateEdited ? l : { ...l, rate: toRupeeStr(official(l)) })));
  }, [official]);

  const scheme = schemeOn(settings?.gst_schemes, billDate);
  const totals = useMemo(() => {
    const valid = lines
      .map((l) => ({ l, p: prod(l.productId) }))
      .filter((x) => x.p)
      .map(({ l, p }) => ({ qtyMilli: Math.max(0, parseQty(l.qty) || 0), ratePaise: Math.max(0, parseRupees(l.rate) || 0), gstBp: p!.gstBp }));
    const d = discount.trim() ? (discountType === 'amount' ? { type: 'amount' as const, value: parseRupees(discount) || 0 } : { type: 'percent' as const, value: Math.round((parseFloat(discount) || 0) * 100) }) : null;
    return computeBill(valid, { scheme, kind: kind === 'estimate' ? 'receipt' : kind, discount: d });
  }, [lines, prod, scheme, kind, discount, discountType]);

  const paidParts = parts.map((p, i) => ({ ...p, paise: p.amount.trim() ? parseRupees(p.amount) || 0 : parts.length === 1 && i === 0 ? totals.total : 0 }));
  const paid = kind === 'estimate' ? 0 : paidParts.reduce((a, p) => a + p.paise, 0);
  const credit = Math.max(0, totals.total - paid);
  const cashPart = paidParts.find((p) => p.mode === 'cash')?.paise ?? 0;
  const change = tendered.trim() ? (parseRupees(tendered) || 0) - cashPart : 0;

  const addProduct = (p: CProduct, unit?: CUnit) => {
    const u = unit ?? p.units.find((x) => x.id === p.sellUnitId) ?? p.units.find((x) => x.isBase) ?? p.units[0];
    rememberProduct(p.id);
    setLines((ls) => {
      const same = ls.find((l) => l.productId === p.id && l.unitId === u.id);
      if (same) return ls.map((l) => (l === same ? { ...l, qty: fmtQty((parseQty(l.qty) || 0) + 1000) } : l));
      const pp = prod(p.id) ?? p;
      const uu = pp.units.find((x) => x.id === u.id) ?? u;
      return [...ls, { key: ++lk, productId: p.id, unitId: u.id, qty: '1', rate: toRupeeStr(priceFor(uu, list)), rateEdited: false }];
    });
  };
  const upd = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const step = (l: Line, dir: 1 | -1) => {
    const p = prod(l.productId)!;
    const u = p.units.find((x) => x.id === l.unitId)!;
    const s = u.isBase && p.loose ? p.stepMilli : 1000;
    const next = Math.max(0, (parseQty(l.qty) || 0) + dir * s);
    upd(l.key, { qty: fmtQty(next) });
  };

  const answerRate = async (l: Line, same: boolean) => {
    const k = `${l.unitId}:${list}`;
    setAnswered((a) => new Set(a).add(k));
    // Recording the answer marks this item/unit/date as checked; a changed rate travels with the bill.
    api.post('/api/rates/check', { unitId: l.unitId, list, date: billDate }).catch(() => {});
    setChecked((c) => new Set(c).add(k));
    if (!same) setTimeout(() => (document.querySelector(`[data-rate="${l.key}"]`) as HTMLInputElement | null)?.select(), 30);
  };

  const reset = () => {
    setLines([]);
    setCustomer(null);
    setParts([{ mode: 'cash', amount: '', reference: '' }]);
    setTendered('');
    setDiscount('');
    setPaperRef('');
    setGstin('');
    setErr('');
    setDupWarn(null);
    localStorage.removeItem(DRAFT);
  };

  const save = async (force = false) => {
    setErr('');
    if (!lines.length) return setErr('Add at least one item');
    const body = {
      kind: kind === 'estimate' ? 'receipt' : kind,
      estimate: kind === 'estimate',
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? '',
      customerGstin: gstin || customer?.gstin || '',
      billDate,
      paperRef,
      discount: discount.trim() ? (discountType === 'amount' ? { type: 'amount', value: parseRupees(discount) || 0 } : { type: 'percent', value: Math.round((parseFloat(discount) || 0) * 100) }) : null,
      lines: lines.map((l) => ({ productId: l.productId, unitId: l.unitId, qtyMilli: parseQty(l.qty), ratePaise: parseRupees(l.rate) })),
      payments: kind === 'estimate' ? [] : paidParts.filter((p) => p.paise > 0).map((p) => ({ mode: p.mode, amountPaise: p.paise, reference: p.reference })),
    };
    if (body.lines.some((l) => !(l.qtyMilli > 0))) return setErr('Every line needs a quantity');
    if (body.lines.some((l) => Number.isNaN(l.ratePaise))) return setErr('Check the rates');
    if (kind === 'tax_invoice' && !customer) return setErr('A tax invoice needs a customer');
    if (credit > 0 && !customer && kind !== 'estimate') return setErr('Choose a customer to put the balance on credit');
    if (paid > totals.total) return setErr('Payments are more than the total');
    setBusy(true);
    try {
      if (!force && customer && kind !== 'estimate') {
        const dup = await api.post('/api/bills/duplicate-check', { customerId: customer.id, billDate, total: totals.total });
        if (dup.duplicate) {
          setDupWarn(dup.duplicate.number);
          setBusy(false);
          return;
        }
      }
      const res = await api.post('/api/bills', body);
      const detail = await api.get<BillDetail>(`/api/bills/${res.id}`);
      if (res.ratePending) toast('Saved. The changed rate is waiting for an Owner to approve.', 'warn');
      else toast(`${res.number} saved`);
      reset();
      setPrinted(detail);
      reloadCatalog();
      loadCustomers();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key === 'Enter') || e.key === 'F9') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const tiles = useMemo(() => [...products].sort((a, b) => b.freq - a.freq || a.nameEn.localeCompare(b.nameEn)).slice(0, 7), [products]);
  const kinds: { value: Kind; label: string }[] = [
    { value: 'receipt', label: t('Receipt') },
    ...(scheme === 'regular' ? [{ value: 'tax_invoice' as Kind, label: t('Tax Invoice') }, { value: 'kaccha' as Kind, label: t('Kaccha slip') }] : []),
    { value: 'estimate', label: t('Estimate') },
  ];
  const showTax = scheme === 'regular' && kind !== 'kaccha' && kind !== 'estimate';

  return (
    <>
      <div className="split-bill">
        <div className="card card-pad col gap-16">
          <ProductSearch onPick={(p) => addProduct(p)} list={list} />
          {products.length === 0 ? (
            <Empty>No products yet — add them in Inventory or Import.</Empty>
          ) : (
            <div className="tiles">
              {tiles.map((p) => {
                const u = p.units.find((x) => x.id === p.sellUnitId) ?? p.units.find((x) => x.isBase)!;
                return (
                  <button key={p.id} className="tile" onClick={() => addProduct(p)}>
                    <div>
                      <b style={{ fontWeight: 500 }}>{lang === 'hi' && p.nameHi ? p.nameHi : p.nameEn}</b>
                      <div className="hi">{lang === 'hi' ? p.nameEn : p.nameHi}</div>
                    </div>
                    <div className="row between" style={{ marginTop: 'auto' }}>
                      <span className="price num">{rs(priceFor(u, list), false)}<span className="faint" style={{ fontWeight: 400 }}> /{unitShort(u, p)}</span></span>
                      <span className={`stock ${p.low ? 'low' : ''}`}>{productStock(p)}</span>
                    </div>
                  </button>
                );
              })}
              {products.length > tiles.length && (
                <button className="tile" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }} onClick={() => (document.querySelector('[aria-label="Search items"]') as HTMLInputElement)?.focus()}>
                  + {products.length - tiles.length} more
                </button>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-pad col" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="col gap-4">
              <div className="col gap-4">
                <span className="label-sm">{t('Customer')}</span>
                {customer ? (
                  <div className="row">
                    <Avatar name={customer.name} />
                    <b>{customer.name}</b>
                    {customer.balance > 0 && <span className="tag warn num">Due {rs(customer.balance, false)}</span>}
                    {customer.balance < 0 && <span className="tag ok num">Advance {rs(-customer.balance, false)}</span>}
                    {customer.price_list === 'wholesale' && <span className="tag info">{t('Wholesale')}</span>}
                    <button className="btn ghost sm icon" onClick={() => setCustomer(null)} aria-label="Remove customer"><X size={15} /></button>
                  </div>
                ) : pickCustomer ? (
                  <CustomerSearch
                    customers={customers}
                    autoFocus
                    onPick={(c) => { setCustomer(c); setPickCustomer(false); }}
                    footer={(q) => (
                      <div className="result" onMouseDown={(e) => e.preventDefault()} onClick={() => { setNewCustomer(q); setPickCustomer(false); }}>
                        <Plus size={15} /> {t('Add customer')}{q.trim() && ` “${q.trim()}”`}
                      </div>
                    )}
                  />
                ) : (
                  <button className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => setPickCustomer(true)}>
                    <Users size={16} /> {t('Walk-in')} <span className="faint hide-sm">· tap to choose a customer</span>
                  </button>
                )}
              </div>
            </div>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field label={t('Bill type')}><Seg value={kind} onChange={setKind} options={kinds} /></Field>
              <Field label={t('Bill date')}><input type="date" className="input sm" value={billDate} max={today} onChange={(e) => setBillDate(e.target.value || today)} /></Field>
              <Field label={t('Paper bill no.')}><input className="input sm" style={{ width: 110 }} value={paperRef} onChange={(e) => setPaperRef(e.target.value)} /></Field>
              {kind === 'tax_invoice' && <Field label="Customer GSTIN"><input className="input sm" value={gstin || customer?.gstin || ''} onChange={(e) => setGstin(e.target.value.toUpperCase())} /></Field>}
              {billDate !== today && <span className="tag warn" style={{ alignSelf: 'flex-end', marginBottom: 6 }}><Clock size={12} /> Back-dated: rates of {shortDate(billDate)}</span>}
            </div>
          </div>

          <div className="table-wrap">
            <table className="table bill-lines">
              <thead>
                <tr><th>{t('Item')}</th><th>{t('Qty')}</th><th className="right">{t('Rate')}</th><th className="right">{t('Amount')}</th><th /></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const p = prod(l.productId);
                  if (!p) return null;
                  const u = p.units.find((x) => x.id === l.unitId);
                  const off = official(l);
                  const rateP = parseRupees(l.rate);
                  const changed = off != null && !Number.isNaN(rateP) && rateP !== off;
                  const ck = `${l.unitId}:${list}`;
                  const needsCheck = !checked.has(ck) && !answered.has(ck) && off != null;
                  const line = totals.lines[i];
                  return (
                    <Fragment key={l.key}>
                      <tr>
                        <td className="name">
                          <b>{lang === 'hi' && p.nameHi ? p.nameHi : p.nameEn}</b>
                          <span className="hi">{lang === 'hi' ? p.nameEn : p.nameHi}{showTax && <span className="faint"> · GST {formatRate(p.gstBp)}</span>}</span>
                          {changed && (
                            <span className={`tag ${can('price.set') ? 'info' : 'warn'}`} style={{ marginTop: 3 }}>
                              {can('price.set') ? `New rate from ${shortDate(billDate)}` : t('rate awaiting approval')} (was {rs(off)})
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="row gap-4 nowrap">
                            <button className="btn sm icon ghost hide-sm" onClick={() => step(l, -1)} aria-label="Less"><Minus size={14} /></button>
                            <input className="input sm num" style={{ width: 58 }} inputMode="decimal" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} onFocus={(e) => e.target.select()} aria-label="Quantity" />
                            <button className="btn sm icon ghost hide-sm" onClick={() => step(l, 1)} aria-label="More"><Plus size={14} /></button>
                            {p.units.length > 1 ? (
                              <select className="input sm" style={{ width: 'auto' }} value={l.unitId} onChange={(e) => {
                                const nu = p.units.find((x) => x.id === Number(e.target.value))!;
                                upd(l.key, { unitId: nu.id, rate: toRupeeStr(priceFor(nu, list)), rateEdited: false });
                              }}>
                                {p.units.map((x) => <option key={x.id} value={x.id}>{unitShort(x, p)}</option>)}
                              </select>
                            ) : (
                              <span className="muted">{u && unitShort(u, p)}</span>
                            )}
                          </div>
                        </td>
                        <td className="right"><input data-rate={l.key} className="input sm num" style={{ width: 76 }} inputMode="decimal" value={l.rate} onChange={(e) => upd(l.key, { rate: e.target.value, rateEdited: true })} onFocus={(e) => e.target.select()} aria-label="Rate" /></td>
                        <td className="right num nowrap">{line ? (line.amount / 100).toFixed(2) : ''}</td>
                        <td><button className="btn ghost sm icon" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label="Remove"><Trash2 size={15} /></button></td>
                      </tr>
                      {needsCheck && (
                        <tr>
                          <td colSpan={5} style={{ background: 'var(--accent-soft)', paddingTop: 6, paddingBottom: 6 }}>
                            <div className="row wrap" style={{ color: 'var(--accent-text)' }}>
                              <span className="grow">Rate for <b>{p.nameEn}</b> ({u && unitShort(u, p)}) on {shortDate(billDate)} still <b>{rs(off)}</b>?</span>
                              <button className="btn sm" onClick={() => answerRate(l, true)}>{t('Same')}</button>
                              <button className="btn sm" onClick={() => answerRate(l, false)}>{t('Changed')}</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {lines.length === 0 && <Empty>Search or tap an item to start the bill. On a laptop, Enter adds the top result.</Empty>}
          </div>

          <div className="card-pad col" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="row top between wrap">
              <div className="row gap-4">
                <span className="label-sm">{t('Discount')}</span>
                <input className="input sm num" style={{ width: 80 }} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} />
                <Seg value={discountType} onChange={setDiscountType} options={[{ value: 'amount', label: '₹' }, { value: 'percent', label: '%' }]} />
              </div>
              <div className="totals" style={{ minWidth: 220 }}>
                {kind === 'kaccha' ? null : (
                  <>
                    <span className="muted">{showTax ? 'Taxable value' : t('Subtotal')}</span><span className="right num">{rs(showTax ? totals.taxable : totals.subtotal)}</span>
                  </>
                )}
                {totals.discount > 0 && <><span className="muted">{t('Discount')}</span><span className="right num">−{rs(totals.discount)}</span></>}
                {showTax && <><span className="muted">CGST</span><span className="right num">{rs(totals.cgst)}</span><span className="muted">SGST</span><span className="right num">{rs(totals.sgst)}</span></>}
                {totals.roundOff !== 0 && <><span className="muted">{t('Round off')}</span><span className="right num">{totals.roundOff > 0 ? '+' : '−'}{rs(Math.abs(totals.roundOff))}</span></>}
                <span style={{ alignSelf: 'end' }}>{t('Total')}</span><span className="right grand num">{rs(totals.total, false)}</span>
              </div>
            </div>
            {kind === 'kaccha' && <div className="faint" style={{ fontSize: 12 }}>Kaccha slip prints tax-inclusive rates and one total. GST is still recorded for the GST summary.</div>}
            {scheme !== 'regular' && <div className="faint" style={{ fontSize: 12 }}>GST scheme on this date: {scheme === 'composition' ? 'Composition — prints as Bill of Supply' : 'Not registered — prints as Cash memo'}</div>}
          </div>

          {kind !== 'estimate' && (
            <div className="card-pad col" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="row wrap gap-4">
                {(Object.keys(MODE_NAME) as Mode[]).map((m) => {
                  const on = parts.some((p) => p.mode === m);
                  return (
                    <button key={m} className={`chip ${on ? 'on' : ''}`} onClick={() => setParts(on ? parts.filter((p) => p.mode !== m) : [...parts, { mode: m, amount: '', reference: '' }])}>
                      {MODE_ICON[m]} {t(MODE_NAME[m])}
                    </button>
                  );
                })}
                <button className={`chip ${parts.length === 0 ? 'on' : ''}`} onClick={() => setParts([])} disabled={!customer} title={customer ? '' : 'Choose a customer for credit'}>
                  <Clock size={15} /> {t('Credit')}
                </button>
              </div>
              {parts.length > 0 && (
                <div className="row wrap">
                  {parts.map((p, i) => (
                    <div key={p.mode} className="row gap-4">
                      <span className="label-sm">{MODE_NAME[p.mode]} ₹</span>
                      <input
                        className="input sm num"
                        style={{ width: 96 }}
                        inputMode="decimal"
                        value={p.amount}
                        placeholder={parts.length === 1 ? (totals.total / 100).toFixed(0) : '0'}
                        onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                      />
                      {(p.mode === 'upi' || p.mode === 'cheque' || p.mode === 'bank' || p.mode === 'card') && (
                        <input className="input sm hide-sm" style={{ width: 110 }} placeholder={p.mode === 'cheque' ? 'Cheque no.' : p.mode === 'card' ? 'Last 4' : 'Ref no.'} value={p.reference} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />
                      )}
                    </div>
                  ))}
                  {parts.some((p) => p.mode === 'cash') && (
                    <div className="row gap-4">
                      <span className="label-sm">{t('Received')} ₹</span>
                      <input className="input sm num" style={{ width: 90 }} inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                      {tendered && change >= 0 && <span className="num" style={{ color: 'var(--ok)', fontWeight: 600 }}>{t('Change')} {rs(change)}</span>}
                    </div>
                  )}
                </div>
              )}
              {credit > 0 && (
                <div className={customer ? 'muted' : 'err'}>
                  {t('Credit')}: <b className="num" style={{ color: 'var(--accent-text)' }}>{rs(credit)}</b>
                  {customer ? <> · new due {rs(customer.balance + credit)}</> : ' — choose a customer'}
                </div>
              )}
            </div>
          )}

          <div className="card-pad row" style={{ borderTop: '1px solid var(--border)' }}>
            {err && <span className="err grow">{err}</span>}
            {!err && <span className="faint grow hide-sm" style={{ fontSize: 12 }}>Ctrl+Enter to save · {me.name}</span>}
            {lines.length > 0 && <button className="btn" onClick={reset}>Clear</button>}
            <button className="btn primary big" disabled={busy || !lines.length} onClick={() => save()}>
              <Check size={18} /> {kind === 'estimate' ? 'Save estimate' : t('Save bill')}
            </button>
          </div>
        </div>
      </div>

      {newCustomer !== null && (
        <CustomerForm
          initialName={newCustomer}
          onClose={() => setNewCustomer(null)}
          onSaved={async (id) => {
            const list = await api.get<CustomerRow[]>('/api/customers');
            setCustomers(list);
            setCustomer(list.find((c) => c.id === id) ?? null);
            setNewCustomer(null);
          }}
        />
      )}
      {dupWarn && (
        <Modal title="Possible duplicate" onClose={() => setDupWarn(null)} foot={<><button className="btn" onClick={() => setDupWarn(null)}>Go back</button><button className="btn primary" onClick={() => { setDupWarn(null); save(true); }}>Save anyway</button></>}>
          <p style={{ margin: 0 }}>{dupWarn} already has the same customer, date and total ({rs(totals.total)}). Save this bill too?</p>
        </Modal>
      )}
      {printed && <PrintModal d={printed} onClose={() => setPrinted(null)} extra={<button className="btn" onClick={() => setPrinted(null)}>{t('New Bill')}</button>} />}
    </>
  );
}
