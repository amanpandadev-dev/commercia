import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useApp, type CProduct, type Category } from '../state';
import { Field, Modal } from './ui';
import { formatQty, parseQty, parseRupees } from '../../../shared/money';
import { istDate } from '../../../shared/dates';
import { PACK_KINDS, cartonUnitName, packUnitName, type PackKind } from '../../../shared/units';

interface UnitRow {
  id?: number;
  name: string;
  size: string; // base units per unit
  retail: string;
  wholesale: string;
  isBase: boolean;
}

const money = (p: number | null | undefined) => (p == null ? '' : (p / 100).toFixed(2).replace(/\.00$/, ''));

export function categoryOptions(categories: Category[]) {
  const byParent = new Map<number | null, Category[]>();
  for (const c of categories) byParent.set(c.parent_id, [...(byParent.get(c.parent_id) ?? []), c]);
  const out: { id: number; label: string; depth: number }[] = [];
  const walk = (parent: number | null, prefix: string[], depth: number) => {
    for (const c of (byParent.get(parent) ?? []).sort((a, b) => a.name_en.localeCompare(b.name_en))) {
      const path = [...prefix, c.name_en];
      out.push({ id: c.id, label: path.join(' › '), depth });
      if (depth < 8) walk(c.id, path, depth + 1);
    }
  };
  walk(null, [], 0);
  return out;
}

type Kind = 'loose' | 'packet' | 'whole';

/** The first question: what are you adding? It decides which fields appear. */
const KINDS: { value: Kind; title: string; sub: string; eg: string }[] = [
  { value: 'loose', title: 'Loose', sub: 'Sold by kg or litre', eg: 'sugar, dal, loose oil' },
  { value: 'packet', title: 'Packet or piece', sub: 'Counted one by one', eg: 'tea, soap, biscuits' },
  { value: 'whole', title: 'Bori, bag, tin or pouch', sub: 'Sold only whole', eg: 'sooji bag, ghee tin, oil pouch' },
];
const kindOf = (p: CProduct): Kind => (p.packKind ? 'whole' : p.baseUnit === 'pc' ? 'packet' : 'loose');

const nameFrom = (x: { family: string; brand: string; packSize: string }) =>
  [x.family.trim(), x.brand.trim() && `— ${x.brand.trim()}`, x.packSize.trim()].filter(Boolean).join(' ').replace(/^— /, '');

export function ProductForm({ product, onClose, onSaved }: { product?: CProduct; onClose: () => void; onSaved: (id: number) => void }) {
  const { categories, reloadCatalog, toast, t, settings } = useApp();
  const editing = !!product;
  const [kind, setKind] = useState<Kind | null>(product ? kindOf(product) : null);
  const [nameTouched, setNameTouched] = useState(editing);
  const [f, setF] = useState(() => ({
    nameEn: product?.nameEn ?? '',
    nameHi: product?.nameHi ?? '',
    code: product?.code ?? '',
    categoryId: product?.categoryId ?? null,
    brand: product?.brand ?? '',
    type: product?.type ?? '',
    family: product?.family ?? '',
    packSize: product?.packSize ?? '',
    packKind: (product?.packKind ?? '') as PackKind,
    hsn: product?.hsn ?? '',
    gst: product ? String(product.gstBp / 100) : '5',
    gstFrom: istDate(),
    baseUnit: product?.baseUnit ?? ('kg' as 'kg' | 'L' | 'pc'),
    loose: product?.loose ?? true,
    step: product ? formatQty(product.stepMilli) : '0.25',
    aliases: product?.aliases ?? '',
    reorderQty: product?.reorderMilli != null ? formatQty(Math.round((product.reorderMilli * 1000) / (product.units.find((u) => u.id === product.reorderUnitId)?.factorMilli ?? 1000))) : '',
    reorderUnit: product?.units.find((u) => u.id === product.reorderUnitId)?.name ?? '',
    buyUnit: product?.units.find((u) => u.id === product.buyUnitId)?.name ?? '',
    sellUnit: product?.units.find((u) => u.id === product.sellUnitId)?.name ?? '',
    priceFrom: istDate(),
    reason: '',
  }));
  const [units, setUnits] = useState<UnitRow[]>(() =>
    product
      ? product.units.map((u) => ({ id: u.id, name: u.name, size: formatQty(u.factorMilli), retail: money(u.retail), wholesale: money(u.wholesale), isBase: u.isBase }))
      : [{ name: 'kg', size: '1', retail: '', wholesale: '', isBase: true }],
  );
  const [newCat, setNewCat] = useState('');
  const [cartonQty, setCartonQty] = useState('12');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const cats = useMemo(() => categoryOptions(categories), [categories]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const base = units.find((u) => u.isBase)!;
  const extras = units.map((u, i) => ({ u, i })).filter((x) => !x.u.isBase);
  const nameBase = (name: string) => setUnits((us) => us.map((u) => (u.isBase ? { ...u, name } : u)));
  const setBaseField = (field: 'retail' | 'wholesale', v: string) => setUnits((us) => us.map((u) => (u.isBase ? { ...u, [field]: v } : u)));
  const gstIncluded = settings?.prices_include_gst !== '0';

  /** Choosing what is being added sets the unit, loose/whole and pack type, so none of that is asked separately. */
  const chooseKind = (k: Kind) => {
    setKind(k);
    if (k === 'loose') {
      const b = f.baseUnit === 'pc' ? 'kg' : f.baseUnit;
      setF((x) => ({ ...x, packKind: '', baseUnit: b, loose: true }));
      nameBase(b);
    } else if (k === 'packet') {
      setF((x) => ({ ...x, packKind: '', baseUnit: 'pc', loose: false }));
      nameBase('pc');
    } else {
      const pk: PackKind = f.packKind || 'bag';
      setF((x) => ({ ...x, packKind: pk, baseUnit: 'pc', loose: false }));
      nameBase(packUnitName(pk, f.packSize));
    }
  };
  const setLooseUnit = (b: 'kg' | 'L') => {
    set('baseUnit', b);
    nameBase(b);
  };
  const setPackKind = (pk: PackKind) => {
    set('packKind', pk);
    nameBase(packUnitName(pk, f.packSize));
  };
  /** Company, item group and pack size build the name until someone types their own. */
  const setPackField = (key: 'family' | 'brand' | 'packSize', v: string) => {
    const next = { ...f, [key]: v };
    setF({ ...next, ...(kind === 'whole' && !nameTouched ? { nameEn: nameFrom(next) } : {}) });
    if (key === 'packSize' && f.packKind) nameBase(packUnitName(f.packKind, v));
  };
  const addExtra = (name: string, size: string) => {
    if (units.some((u) => u.name.toLowerCase() === name.toLowerCase())) return setErr(`${name} is already there`);
    setErr('');
    setUnits([...units, { name, size, retail: '', wholesale: '', isBase: false }]);
  };
  const addCarton = () => {
    const n = Math.round(Number(cartonQty));
    if (!(n > 1)) return setErr('A carton holds more than 1 pack');
    addExtra(cartonUnitName(n, f.packSize), String(n));
  };

  const priceLabel = kind === 'whole' ? packUnitName(f.packKind, f.packSize) : kind === 'packet' ? 'piece' : f.baseUnit;
  const unitNames = units.map((u) => u.name).filter(Boolean);

  const save = async () => {
    setErr('');
    if (!kind) return setErr('Choose what you are adding first');
    const gstBp = Math.round(parseFloat(f.gst) * 100);
    if (kind === 'whole') {
      if (!f.packKind) return setErr('Choose bori, bag, tin…');
      if (!f.brand.trim() || !f.family.trim() || !f.packSize.trim()) return setErr('Fill in the company, item group and pack size, so it lines up in the stock summary');
    }
    if (!f.nameEn.trim()) return setErr('Name is needed');
    if (Number.isNaN(gstBp)) return setErr('GST % is not a number');
    const unitBody = [];
    for (const u of units) {
      const factor = u.isBase ? 1000 : parseQty(u.size);
      if (!u.name.trim()) return setErr('Every unit needs a name');
      if (!(factor > 0)) return setErr(`Size of ${u.name} must be more than 0`);
      const retail = u.retail.trim() ? parseRupees(u.retail) : null;
      const wholesale = u.wholesale.trim() ? parseRupees(u.wholesale) : null;
      if (u.isBase && retail == null) return setErr(`Enter the selling price per ${priceLabel}`);
      if (Number.isNaN(retail) || Number.isNaN(wholesale)) return setErr(`Bad price for ${u.name}`);
      unitBody.push({ id: u.id, name: u.name.trim(), factorMilli: factor, isBase: u.isBase, retail, wholesale });
    }
    setBusy(true);
    try {
      let categoryId = f.categoryId;
      if (newCat.trim()) {
        // "Oil > Saffola" creates each missing level.
        let parent: number | null = categoryId;
        for (const part of newCat.split('>').map((s) => s.trim()).filter(Boolean)) {
          const c = await api.post('/api/categories', { nameEn: part, parentId: parent });
          parent = c.id;
        }
        categoryId = parent;
      }
      const whole = kind === 'whole';
      const body = {
        code: f.code.trim() || null,
        categoryId,
        nameEn: f.nameEn.trim(),
        nameHi: f.nameHi.trim(),
        brand: f.brand.trim(),
        type: f.type.trim(),
        family: f.family.trim(),
        packSize: f.packSize.trim(),
        packKind: whole ? f.packKind : '',
        hsn: f.hsn.trim(),
        gstBp,
        gstFrom: f.gstFrom,
        baseUnit: f.baseUnit,
        loose: whole ? false : f.loose,
        stepMilli: f.loose && !whole ? Math.max(1, parseQty(f.step) || 1000) : 1000,
        reorderQtyMilli: f.reorderQty.trim() ? parseQty(f.reorderQty) : null,
        reorderUnitName: f.reorderQty.trim() ? f.reorderUnit || base.name : null,
        buyUnitName: f.buyUnit || null,
        sellUnitName: f.sellUnit || null,
        aliases: f.aliases,
        units: unitBody,
        priceFrom: f.priceFrom,
        reason: f.reason,
      };
      const res = editing ? await api.patch(`/api/products/${product!.id}`, body) : await api.post('/api/products', body);
      await reloadCatalog();
      toast(editing ? 'Product saved' : 'Product added');
      onSaved(res.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const kindInfo = KINDS.find((k) => k.value === kind);
  const placeholder = kind === 'whole' ? 'Sooji — Annapurna 25 kg' : kind === 'packet' ? 'Tea 250g' : 'Sugar';

  return (
    <Modal
      wide
      title={editing ? `Edit ${product!.nameEn}` : t('Add Product')}
      sub={editing ? 'Saved bills keep their old rates' : 'सामान जोड़ें'}
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn primary" onClick={save} disabled={busy || !kind}>{t('Save')}</button>
        </>
      }
    >
      {editing ? (
        <div className="row wrap">
          <span className="tag neutral">{kindInfo?.title}</span>
          <span className="muted" style={{ fontSize: 12 }}>The kind of item can't be changed once it is added.</span>
        </div>
      ) : (
        <div className="col gap-4">
          <b>1. What are you adding?</b>
          <div className="choice-row">
            {KINDS.map((k) => (
              <button key={k.value} type="button" className={`choice ${kind === k.value ? 'on' : ''}`} onClick={() => chooseKind(k.value)} aria-pressed={kind === k.value}>
                <b>{k.title}</b>
                <span>{k.sub}</span>
                <span className="faint">e.g. {k.eg}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {kind && (
        <>
          {!editing && <b>2. Fill in the details</b>}
          <div className="grid grid-2">
            <Field label={`${t('Name')} (English)`}>
              <input className="input" value={f.nameEn} onChange={(e) => { setNameTouched(true); set('nameEn', e.target.value); }} autoFocus={kind !== 'whole'} placeholder={placeholder} />
            </Field>
            <Field label={t('Hindi name')}><input className="input" value={f.nameHi} onChange={(e) => set('nameHi', e.target.value)} placeholder="सरसों तेल" lang="hi" /></Field>
            <Field label={t('Category')} hint="Pick one, or type a new one on the right">
              <select className="input" value={f.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)}>
                <option value="">— None —</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Or a new category" hint="Use > for levels: Oil > Saffola">
              <input className="input" value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Oil > Saffola" />
            </Field>
          </div>

          {kind === 'whole' ? (
            <div className="card card-pad" style={{ boxShadow: 'none' }}>
              <div className="grid grid-2">
                <Field label="Pack type">
                  <select className="input" value={f.packKind} onChange={(e) => setPackKind(e.target.value as PackKind)}>
                    {PACK_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                </Field>
                <Field label="Pack size" hint="Just a label: 50 kg, 25 kg, 1 L">
                  <input className="input" value={f.packSize} onChange={(e) => setPackField('packSize', e.target.value)} placeholder="25 kg" autoFocus />
                </Field>
                <Field label="Company" hint="Each company is its own product">
                  <input className="input" value={f.brand} onChange={(e) => setPackField('brand', e.target.value)} placeholder="Annapurna" />
                </Field>
                <Field label="Item group" hint="The plain item, so companies line up in the stock summary">
                  <input className="input" value={f.family} onChange={(e) => setPackField('family', e.target.value)} placeholder="Sooji" />
                </Field>
              </div>
              {!nameTouched ? (
                <div className="faint" style={{ fontSize: 12 }}>The name above fills itself from these. You can still change it.</div>
              ) : (
                f.nameEn.trim() !== nameFrom(f) && nameFrom(f) && (
                  <div className="row wrap"><span className="muted">Suggested name:</span><button type="button" className="chip" onClick={() => { setNameTouched(false); set('nameEn', nameFrom(f)); }}>Use “{nameFrom(f)}”</button></div>
                )
              )}
            </div>
          ) : (
            <div className="grid grid-2">
              <Field label="Brand (optional)"><input className="input" value={f.brand} onChange={(e) => set('brand', e.target.value)} /></Field>
              <div />
            </div>
          )}

          <div className="card card-pad" style={{ boxShadow: 'none' }}>
            <div className="grid grid-3">
              <Field
                label={<>Selling price ₹ <span className="muted">per {priceLabel}</span></>}
                hint={gstIncluded ? 'The shelf price, GST included' : 'Before GST'}
              >
                <input className="input num" inputMode="decimal" value={base.retail} onChange={(e) => setBaseField('retail', e.target.value)} placeholder="e.g. 45" />
              </Field>
              <Field label={<>{t('Wholesale')} ₹ <span className="muted">(optional)</span></>} hint="Leave empty to use the selling price">
                <input className="input num" inputMode="decimal" value={base.wholesale} onChange={(e) => setBaseField('wholesale', e.target.value)} />
              </Field>
              <Field label="GST %">
                <div className="row">
                  <select className="input" value={['0', '5', '12', '18', '28'].includes(f.gst) ? f.gst : 'other'} onChange={(e) => e.target.value !== 'other' && set('gst', e.target.value)}>
                    {['0', '5', '12', '18', '28'].map((g) => <option key={g} value={g}>{g}%</option>)}
                    <option value="other">Other…</option>
                  </select>
                  {!['0', '5', '12', '18', '28'].includes(f.gst) && <input className="input" style={{ width: 90 }} value={f.gst} onChange={(e) => set('gst', e.target.value)} />}
                </div>
              </Field>
            </div>
            {kind === 'loose' && !editing && (
              <div className="row mt-8">
                <span className="muted">Sold by</span>
                <div className="seg">
                  {(['kg', 'L'] as const).map((b) => <button key={b} type="button" className={f.baseUnit === b ? 'on' : ''} onClick={() => setLooseUnit(b)}>{b === 'kg' ? 'Weight (kg)' : 'Volume (litre)'}</button>)}
                </div>
              </div>
            )}
          </div>

          <details className="more" open={editing}>
            <summary>More options: bags, boxes and cartons, HSN, reorder level, aliases…</summary>
            <div className="col gap-16" style={{ paddingTop: 10 }}>
              <div className="card card-pad" style={{ boxShadow: 'none' }}>
                <b>Bigger units</b>
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  {kind === 'loose' ? `For a bag or tin that holds many ${f.baseUnit}, each with its own price.` : 'For a box or carton that holds many, each with its own price.'}
                </div>
                {extras.length > 0 && (
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Unit name</th><th>Holds ({base.name})</th><th className="right">{t('Retail')} ₹</th><th className="right">{t('Wholesale')} ₹</th><th /></tr></thead>
                      <tbody>
                        {extras.map(({ u, i }) => (
                          <tr key={i}>
                            <td><input className="input sm" value={u.name} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Bag 50 kg" /></td>
                            <td style={{ width: 110 }}><input className="input sm num" value={u.size} inputMode="decimal" onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))} /></td>
                            <td style={{ width: 130 }}><input className="input sm num" value={u.retail} inputMode="decimal" onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, retail: e.target.value } : x)))} placeholder="own price" /></td>
                            <td style={{ width: 130 }}><input className="input sm num" value={u.wholesale} inputMode="decimal" onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, wholesale: e.target.value } : x)))} placeholder="same" /></td>
                            <td style={{ width: 40 }}><button className="btn ghost sm icon" onClick={() => setUnits(units.filter((_, j) => j !== i))} aria-label="Remove unit"><Trash2 size={15} /></button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="row wrap mt-8">
                  {kind === 'loose' && f.baseUnit === 'kg' && ['Bag 50 kg', 'Bag 25 kg', 'Bag 10 kg', 'Bag 5 kg'].filter((n) => !unitNames.includes(n)).map((n) => (
                    <button key={n} type="button" className="chip" onClick={() => addExtra(n, n.match(/\d+/)![0])}>+ {n}</button>
                  ))}
                  {kind === 'loose' && f.baseUnit === 'L' && !unitNames.includes('Tin 15 L') && <button type="button" className="chip" onClick={() => addExtra('Tin 15 L', '15')}>+ Tin 15 L</button>}
                  {kind === 'packet' && !unitNames.includes('Box of 12') && <button type="button" className="chip" onClick={() => addExtra('Box of 12', '12')}>+ Box of 12</button>}
                  {kind !== 'loose' && (
                    <span className="row gap-4">
                      <span className="muted">Carton holds</span>
                      <input className="input sm num" style={{ width: 64 }} inputMode="numeric" value={cartonQty} onChange={(e) => setCartonQty(e.target.value)} aria-label="Packs in a carton" />
                      <button type="button" className="btn sm" onClick={addCarton}><Plus size={14} /> Carton</button>
                    </span>
                  )}
                  <button type="button" className="btn sm" onClick={() => setUnits([...units, { name: '', size: '', retail: '', wholesale: '', isBase: false }])}><Plus size={14} /> Other unit</button>
                </div>
              </div>

              <div className="grid grid-3">
                <Field label="HSN code"><input className="input" value={f.hsn} onChange={(e) => set('hsn', e.target.value)} inputMode="numeric" /></Field>
                <Field label="Code (optional)"><input className="input" value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
                <Field label="Type" hint="e.g. mustard, sunflower, til"><input className="input" value={f.type} onChange={(e) => set('type', e.target.value)} /></Field>
                <Field label="Reorder level" hint="Leave empty to switch off">
                  <div className="row">
                    <input className="input" style={{ width: 90 }} value={f.reorderQty} onChange={(e) => set('reorderQty', e.target.value)} inputMode="decimal" />
                    <select className="input" value={f.reorderUnit || base.name} onChange={(e) => set('reorderUnit', e.target.value)}>
                      {unitNames.map((n) => <option key={n}>{n}</option>)}
                    </select>
                  </div>
                </Field>
                <Field label="Usual buying unit">
                  <select className="input" value={f.buyUnit} onChange={(e) => set('buyUnit', e.target.value)}><option value="">—</option>{unitNames.map((n) => <option key={n}>{n}</option>)}</select>
                </Field>
                <Field label="Usual selling unit">
                  <select className="input" value={f.sellUnit} onChange={(e) => set('sellUnit', e.target.value)}><option value="">—</option>{unitNames.map((n) => <option key={n}>{n}</option>)}</select>
                </Field>
                {kind === 'loose' && <Field label={`Smallest amount sold (${f.baseUnit})`} hint="Quantity steps on the bill"><input className="input" value={f.step} onChange={(e) => set('step', e.target.value)} inputMode="decimal" /></Field>}
                <Field label={t('Aliases')} hint="Other spellings: chini, cheeni"><input className="input" value={f.aliases} onChange={(e) => set('aliases', e.target.value)} /></Field>
              </div>

              {editing && (
                <div className="grid grid-3">
                  <Field label="Price changes apply from" hint="Bills before this date keep the old rate"><input type="date" className="input" value={f.priceFrom} onChange={(e) => set('priceFrom', e.target.value)} /></Field>
                  <Field label="GST change applies from"><input type="date" className="input" value={f.gstFrom} onChange={(e) => set('gstFrom', e.target.value)} /></Field>
                  <Field label="Reason for change (optional)"><input className="input" value={f.reason} onChange={(e) => set('reason', e.target.value)} /></Field>
                </div>
              )}
            </div>
          </details>
        </>
      )}
    </Modal>
  );
}
