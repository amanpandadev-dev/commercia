import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, FolderTree, Pencil, SlidersHorizontal, EyeOff, Download } from 'lucide-react';
import { api, exportExcel } from '../api';
import { useApp, type CProduct } from '../state';
import { Empty, Field, Modal, Seg } from '../components/ui';
import { ProductForm, categoryOptions } from '../components/ProductForm';
import { baseUnitOf, productStock, reorderLabel, rs, unitShort, qty, dateTimeOf } from '../format';
import { istDate } from '../../../shared/dates';
import { formatRate, parseQty } from '../../../shared/money';
import { baseLabel } from '../../../shared/units';

export function Inventory() {
  const { products, productIndex, t, lang, can, categories } = useApp();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | number>(params.get('filter') === 'low' ? 'low' : 'all');
  const [adding, setAdding] = useState(params.get('add') === '1');
  const [openId, setOpenId] = useState<number | null>(params.get('id') ? Number(params.get('id')) : null);
  const [cats, setCats] = useState(false);
  const [view, setView] = useState<'list' | 'summary'>(params.get('view') === 'summary' ? 'summary' : 'list');

  useEffect(() => {
    if (params.get('id')) setOpenId(Number(params.get('id')));
    if (params.get('add') === '1') setAdding(true);
  }, [params]);

  const topCats = categories.filter((c) => c.parent_id === null);
  const list = useMemo(() => {
    let l = q.trim() ? productIndex.search(q, 500) : products;
    if (filter === 'low') l = l.filter((p) => p.low);
    else if (typeof filter === 'number') {
      const name = categories.find((c) => c.id === filter)?.name_en;
      l = l.filter((p) => p.categoryPath[0] === name);
    }
    return l;
  }, [q, productIndex, products, filter, categories]);
  const lowCount = products.filter((p) => p.low).length;
  const open = products.find((p) => p.id === openId);

  const exportList = () =>
    exportExcel('Commercia stock', [
      {
        name: 'Stock',
        columns: [
          { header: 'Product', key: 'name' }, { header: 'Hindi', key: 'hi' }, { header: 'Category', key: 'cat' }, { header: 'Unit', key: 'unit' },
          { header: 'Price', key: 'price', type: 'money' }, { header: 'GST %', key: 'gst', type: 'number' }, { header: 'HSN', key: 'hsn' },
          { header: 'Stock', key: 'stock', type: 'number' }, { header: 'Stock (units)', key: 'stockLabel' }, { header: 'Reorder at', key: 'reorder' },
        ],
        rows: list.map((p) => ({ name: p.nameEn, hi: p.nameHi, cat: p.categoryPath.join(' > '), unit: p.baseUnit, price: baseUnitOf(p)?.retail ?? 0, gst: p.gstBp / 100, hsn: p.hsn, stock: p.stockMilli / 1000, stockLabel: productStock(p), reorder: reorderLabel(p) })),
      },
    ]);

  const views = <Seg value={view} onChange={setView} options={[{ value: 'list', label: t('Products') }, { value: 'summary', label: t('Stock summary') }]} />;
  if (view === 'summary') return <><div className="row wrap">{views}</div><StockSummary /></>;

  return (
    <>
      <div className="row wrap">
        {views}
        <div className="input-wrap grow" style={{ maxWidth: 460, minWidth: 220 }}>
          <Search size={16} />
          <input className="input" placeholder={`${t('Search products…')}${lang === 'en' ? ' / सामान खोजें' : ''}`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grow" />
        <button className="btn" onClick={exportList} title={t('Export to Excel')}><Download size={16} /><span className="hide-sm">Excel</span></button>
        {can('catalog.edit') && <button className="btn" onClick={() => setCats(true)}><FolderTree size={16} /><span className="hide-sm">{t('Categories')}</span></button>}
        {can('catalog.edit') && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> {t('Add Product')}</button>}
      </div>
      <div className="row wrap gap-4">
        <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>{t('All')} · {products.length}</button>
        <button className={`chip ${filter === 'low' ? 'on' : ''}`} onClick={() => setFilter('low')}>{t('Low Stock')} · {lowCount}</button>
        {topCats.map((c) => (
          <button key={c.id} className={`chip ${filter === c.id ? 'on' : ''}`} onClick={() => setFilter(c.id)}>{lang === 'hi' && c.name_hi ? c.name_hi : c.name_en}</button>
        ))}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Product')}</th>
                <th className="hide-sm">{t('Unit')}</th>
                <th>{t('Price')}</th>
                <th className="hide-sm">GST</th>
                <th>{t('Stock')}</th>
                <th className="hide-sm">{t('Reorder at')}</th>
                <th className="hide-sm">{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const base = baseUnitOf(p);
                return (
                  <tr key={p.id} className="click" onClick={() => setOpenId(p.id)}>
                    <td className="name">
                      <b>{lang === 'hi' && p.nameHi ? p.nameHi : p.nameEn}</b>
                      <span className="hi">{lang === 'hi' ? p.nameEn : p.nameHi}</span>
                    </td>
                    <td className="hide-sm muted">{p.units.map((u) => unitShort(u, p)).join(', ')}</td>
                    <td className="num nowrap">{rs(base?.retail)}</td>
                    <td className="hide-sm"><span className="tag neutral">{formatRate(p.gstBp)}</span></td>
                    <td className={`num ${p.low ? 'err' : ''}`} style={{ fontWeight: 600 }}>{productStock(p)}</td>
                    <td className="hide-sm muted">{reorderLabel(p)}</td>
                    <td className="hide-sm">{p.low ? <span className="tag danger">● {t('Low')}</span> : <span className="tag ok">● {t('In stock')}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length === 0 && (
            <Empty>
              {products.length === 0 ? (
                <>No products yet. Add them one by one, or load your list from a spreadsheet on the <a href="/import">Import</a> page.</>
              ) : (
                <>Nothing matches “{q}”.</>
              )}
            </Empty>
          )}
        </div>
      </div>

      {adding && <ProductForm onClose={() => { setAdding(false); setParams({}); }} onSaved={(id) => { setAdding(false); setParams({}); setOpenId(id); }} />}
      {open && <ProductDetail product={open} onClose={() => { setOpenId(null); setParams({}); }} />}
      {cats && <CategoryManager onClose={() => setCats(false)} />}
    </>
  );
}

interface Summary {
  asOf: string;
  groups: { name: string; columns: { key: string; label: string }[] }[];
  rows: { brand: string; cells: Record<string, { qtyMilli: number; label: string }> }[];
}

/** Stock on one day, laid out like the shop's own sheet: companies down, items and pack sizes across. */
function StockSummary() {
  const { t, toast } = useApp();
  const today = istDate();
  const [asOf, setAsOf] = useState(today);
  const [data, setData] = useState<Summary | null>(null);
  useEffect(() => {
    let live = true;
    api.get<Summary>(`/api/reports/stock-summary?asOf=${asOf}`).then((d) => live && setData(d)).catch((e) => toast((e as Error).message, 'error'));
    return () => {
      live = false;
    };
  }, [asOf, toast]);

  const key = (g: string, c: string) => `${g}\u0000${c}`;
  const cols = data?.groups.flatMap((g) => g.columns.map((c) => ({ ...c, group: g.name }))) ?? [];
  const exportSheet = () =>
    data &&
    exportExcel(`Stock summary ${data.asOf}`, [
      {
        name: 'Stock summary',
        columns: [{ header: 'Company', key: 'brand' }, ...cols.map((c, i) => ({ header: `${c.group} · ${c.label}`, key: `c${i}` }))],
        rows: data.rows.map((r) => ({ brand: r.brand, ...Object.fromEntries(cols.map((c, i) => [`c${i}`, r.cells[key(c.group, c.key)]?.label ?? ''])) })),
      },
    ]);

  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3>{t('Stock summary')}</h3>
        <div className="row wrap">
          <label className="row gap-4"><span className="muted">{t('Stock as on')}</span><input type="date" className="input sm" value={asOf} max={today} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
          <button className="btn sm" onClick={exportSheet} disabled={!data}><Download size={14} /> Excel</button>
        </div>
      </div>
      {!data ? null : cols.length === 0 ? (
        <Empty>No products yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th rowSpan={2}>Company</th>
                {data.groups.map((g) => <th key={g.name} colSpan={g.columns.length} style={{ textAlign: 'center', borderLeft: '1px solid var(--line)' }}>{g.name}</th>)}
              </tr>
              <tr>
                {cols.map((c, i) => <th key={i} className="right nowrap" style={c === cols.find((x) => x.group === c.group) ? { borderLeft: '1px solid var(--line)' } : undefined}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.brand}>
                  <td className="name"><b>{r.brand}</b></td>
                  {cols.map((c, i) => {
                    const cell = r.cells[key(c.group, c.key)];
                    return <td key={i} className={`right num nowrap ${cell && cell.qtyMilli < 0 ? 'err' : cell && cell.qtyMilli === 0 ? 'faint' : ''}`}>{cell ? cell.label : ''}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="faint" style={{ padding: '8px 16px', fontSize: 12 }}>Counted from the stock records up to the end of {asOf}. Blank means the company doesn't sell that item. Items without a pack type or an item name stay in the product list.</div>
    </div>
  );
}

const KIND: Record<string, string> = {
  stock_in: 'Stock in', sale: 'Sale', sale_cancel: 'Sale cancelled', adjustment: 'Adjustment', loss: 'Loss', loss_reversal: 'Goods found', opening: 'Opening', import: 'Import',
};

function ProductDetail({ product: p, onClose }: { product: CProduct; onClose: () => void }) {
  const { t, can, lang, reloadCatalog, toast } = useApp();
  const [hist, setHist] = useState<any>(null);
  const [tab, setTab] = useState<'moves' | 'prices' | 'versions'>('moves');
  const [editing, setEditing] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [plain, setPlain] = useState(false);
  const load = () => api.get(`/api/products/${p.id}/history`).then(setHist).catch(() => {});
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, p.stockMilli]);

  if (editing) return <ProductForm product={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />;
  if (adjust) return <AdjustStock product={p} onClose={() => setAdjust(false)} onDone={() => { setAdjust(false); load(); }} />;

  return (
    <Modal
      wide
      title={lang === 'hi' && p.nameHi ? p.nameHi : p.nameEn}
      sub={[lang === 'hi' ? p.nameEn : p.nameHi, p.categoryPath.join(' › '), p.hsn && `HSN ${p.hsn}`, `GST ${formatRate(p.gstBp)}`].filter(Boolean).join(' · ')}
      onClose={onClose}
      foot={
        <>
          {can('catalog.edit') && (
            <button className="btn danger" onClick={async () => { await api.post(`/api/products/${p.id}/active`, { active: false }); await reloadCatalog(); toast('Product hidden'); onClose(); }}>
              <EyeOff size={15} /> Hide
            </button>
          )}
          <div className="grow" />
          {can('stock.adjust') && <button className="btn" onClick={() => setAdjust(true)}><SlidersHorizontal size={15} /> Adjust stock</button>}
          {can('catalog.edit') && <button className="btn primary" onClick={() => setEditing(true)}><Pencil size={15} /> {t('Edit')}</button>}
        </>
      }
    >
      <div className="grid grid-3">
        <div className="card card-pad" style={{ boxShadow: 'none' }}>
          <div className="label-sm">{t('Stock')}</div>
          <div className={`num ${p.low ? 'err' : ''}`} style={{ fontSize: 22, fontWeight: 600, cursor: 'pointer' }} onClick={() => setPlain(!plain)} title="Tap to switch">
            {plain ? baseLabel(p.baseUnit, p.stockMilli, p.packKind) : productStock(p)}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>Reorder at {reorderLabel(p)}</div>
        </div>
        <div className="card card-pad" style={{ boxShadow: 'none', gridColumn: 'span 2' }}>
          <div className="label-sm">Today's rates (before GST)</div>
          <div className="row wrap" style={{ gap: 14 }}>
            {p.units.map((u) => (
              <div key={u.id}>
                <span className="muted">{unitShort(u, p)}</span>{' '}
                <b className="num">{rs(u.retail)}</b>
                {u.wholesale != null && <span className="faint num"> · wholesale {rs(u.wholesale)}</span>}
              </div>
            ))}
          </div>
          {p.aliases && <div className="faint mt-8" style={{ fontSize: 12 }}>Also found as: {p.aliases}</div>}
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'moves' ? 'on' : ''} onClick={() => setTab('moves')}>{t('Stock movements')}</button>
        <button className={tab === 'prices' ? 'on' : ''} onClick={() => setTab('prices')}>Price history</button>
        <button className={tab === 'versions' ? 'on' : ''} onClick={() => setTab('versions')}>{t('History')}</button>
      </div>
      {!hist ? <div className="muted">Loading…</div> : tab === 'moves' ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('Date')}</th><th>Movement</th><th className="right">Change</th><th className="right">{t('Balance')}</th><th>By</th></tr></thead>
            <tbody>
              {hist.movements.map((m: any) => (
                <tr key={m.id}>
                  <td className="nowrap">{m.date}</td>
                  <td>
                    {KIND[m.kind] ?? m.kind} {m.ref && <span className="muted">· {m.ref}</span>}
                    {m.unit_qty_milli != null && m.unit && <span className="faint"> · {qty(m.unit_qty_milli)} {m.unit}{m.rate_paise != null ? ` @ ${rs(m.rate_paise)}` : ''}</span>}
                    {m.note && <div className="faint" style={{ fontSize: 12 }}>{m.note}</div>}
                  </td>
                  <td className={`right num ${m.qty_milli < 0 ? 'err' : ''}`} style={{ color: m.qty_milli > 0 ? 'var(--ok)' : undefined }}>{m.qty_milli > 0 ? '+' : ''}{baseLabel(p.baseUnit, m.qty_milli, p.packKind)}</td>
                  <td className="right num">{baseLabel(p.baseUnit, m.balance, p.packKind)}</td>
                  <td className="muted">{m.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hist.movements.length === 0 && <Empty>No stock movements yet</Empty>}
        </div>
      ) : tab === 'prices' ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>From</th><th>{t('Unit')}</th><th>List</th><th className="right">{t('Price')}</th><th>Set by</th><th>Source</th></tr></thead>
            <tbody>
              {hist.prices.map((r: any) => (
                <tr key={r.id}><td>{r.from_date === '2000-01-01' ? 'Start' : r.from_date}</td><td>{r.unit}</td><td>{r.list}</td><td className="right num">{rs(r.price_paise)}</td><td>{r.by}{r.approvedBy && r.approvedBy !== r.by ? <span className="faint"> · approved by {r.approvedBy}</span> : ''}</td><td className="muted">{r.source}</td></tr>
              ))}
              {hist.gst.map((g: any) => (
                <tr key={`g${g.id}`}><td>{g.from_date === '2000-01-01' ? 'Start' : g.from_date}</td><td colSpan={2}>GST rate</td><td className="right">{formatRate(g.gst_bp)}</td><td>{g.by}</td><td /></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <VersionList versions={hist.versions} />
      )}
    </Modal>
  );
}

/** History tab: who changed what, when, before → after (HIST-2). */
export function VersionList({ versions }: { versions: { version: number; data: any; reason: string; created_at: string; by: string | null }[] }) {
  if (!versions.length) return <Empty>No changes recorded</Empty>;
  return (
    <div className="col">
      {versions.map((v, i) => {
        const prev = versions[i + 1]?.data;
        const changes = prev ? diff(prev, v.data) : [];
        return (
          <div key={v.version} className="card card-pad" style={{ boxShadow: 'none' }}>
            <div className="row between">
              <b>v{v.version} · {v.reason}</b>
              <span className="muted" style={{ fontSize: 12 }}>{v.by ?? 'system'} · {dateTimeOf(v.created_at)}</span>
            </div>
            {changes.length > 0 && (
              <div className="col gap-4 mt-8" style={{ fontSize: 13 }}>
                {changes.map((c) => (
                  <div key={c.key}><span className="muted">{c.key}:</span> <span className="diff-del">{c.before}</span> → <span className="diff-add">{c.after}</span></div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function flat(o: any, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (o == null || typeof o !== 'object') return { [prefix || 'value']: String(o ?? '') };
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) v.forEach((x, i) => Object.assign(out, flat(x, `${key}[${(x as any)?.name ?? i}]`)));
    else if (v && typeof v === 'object') Object.assign(out, flat(v, key));
    else out[key] = v == null ? '—' : String(v);
  }
  return out;
}
function diff(a: any, b: any) {
  const fa = flat(a);
  const fb = flat(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  return [...keys].filter((k) => fa[k] !== fb[k]).map((k) => ({ key: k, before: fa[k] ?? '—', after: fb[k] ?? '—' }));
}

function AdjustStock({ product: p, onClose, onDone }: { product: CProduct; onClose: () => void; onDone: () => void }) {
  const { reloadCatalog, toast } = useApp();
  const [dir, setDir] = useState<'add' | 'remove'>('remove');
  const [q, setQ] = useState('');
  const [unitId, setUnitId] = useState(baseUnitOf(p).id);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal
      title={`Adjust stock · ${p.nameEn}`}
      sub="For count corrections. Use Losses for theft, damage or expiry."
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!q || !reason.trim()}
            onClick={async () => {
              const m = parseQty(q);
              if (!(m > 0)) return setErr('Enter a quantity');
              try {
                await api.post('/api/stock/adjust', { productId: p.id, unitId, qtyMilli: dir === 'add' ? m : -m, reason });
                await reloadCatalog();
                toast('Stock adjusted');
                onDone();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Save adjustment
          </button>
        </>
      }
    >
      <div className="muted">Current stock: <b>{productStock(p)}</b></div>
      <Seg value={dir} onChange={setDir} options={[{ value: 'remove', label: '− Remove' }, { value: 'add', label: '+ Add' }]} />
      <div className="row">
        <Field label="Quantity"><input className="input num" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></Field>
        <Field label="Unit">
          <select className="input" value={unitId} onChange={(e) => setUnitId(Number(e.target.value))}>
            {p.units.map((u) => <option key={u.id} value={u.id}>{unitShort(u, p)}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Reason (required)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Count correction after stock check" /></Field>
    </Modal>
  );
}

function CategoryManager({ onClose }: { onClose: () => void }) {
  const { categories, reloadCatalog, toast, products } = useApp();
  const opts = categoryOptions(categories);
  const [name, setName] = useState('');
  const [nameHi, setNameHi] = useState('');
  const [parent, setParent] = useState<number | ''>('');
  const [editing, setEditing] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setErr('');
    try {
      await fn();
      await reloadCatalog();
      toast(msg);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const count = (id: number) => products.filter((p) => p.categoryId === id).length;
  return (
    <Modal wide title="Categories" sub="Shape the tree your way: Oil › Saffola › Sunflower, Sugar › Loose / Packed" onClose={onClose}>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Hindi name"><input className="input" value={nameHi} onChange={(e) => setNameHi(e.target.value)} /></Field>
        <Field label="Under">
          <select className="input" value={parent} onChange={(e) => setParent(e.target.value ? Number(e.target.value) : '')}>
            <option value="">— Top level —</option>
            {opts.filter((o) => o.id !== editing).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={() =>
            run(
              () => (editing ? api.patch(`/api/categories/${editing}`, { nameEn: name, nameHi, parentId: parent || null }) : api.post('/api/categories', { nameEn: name, nameHi, parentId: parent || null })),
              editing ? 'Category saved' : 'Category added',
            ).then(() => { setName(''); setNameHi(''); setEditing(null); })
          }
        >
          {editing ? 'Save' : 'Add'}
        </button>
        {editing && <button className="btn" onClick={() => { setEditing(null); setName(''); setNameHi(''); }}>Cancel</button>}
      </div>
      {err && <div className="err">{err}</div>}
      <div className="card" style={{ boxShadow: 'none' }}>
        {opts.length === 0 && <Empty>No categories yet</Empty>}
        {opts.map((o) => {
          const c = categories.find((x) => x.id === o.id)!;
          return (
            <div key={o.id} className="list-item" style={{ paddingLeft: 16 + o.depth * 22, cursor: 'default' }}>
              <div className="grow">
                {c.name_en} {c.name_hi && <span className="hi">{c.name_hi}</span>}
                <span className="faint" style={{ fontSize: 12 }}> · {count(c.id)} items</span>
              </div>
              <button className="btn sm ghost" onClick={() => { setEditing(c.id); setName(c.name_en); setNameHi(c.name_hi); setParent(c.parent_id ?? ''); }}>Rename / move</button>
              <button className="btn sm ghost danger" onClick={() => run(() => api.del(`/api/categories/${c.id}`), 'Category deleted')}>Delete</button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
