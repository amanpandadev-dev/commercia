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

export function ProductForm({ product, onClose, onSaved }: { product?: CProduct; onClose: () => void; onSaved: (id: number) => void }) {
  const { categories, reloadCatalog, toast, t, settings } = useApp();
  const editing = !!product;
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

  const setBase = (b: 'kg' | 'L' | 'pc') => {
    set('baseUnit', b);
    set('loose', b !== 'pc');
    setUnits((us) => us.map((u) => (u.isBase ? { ...u, name: b } : u)));
  };

  // A bori, bag, tin or pouch is counted in whole packs: base unit pc, never loose, named after the pack.
  const nameBase = (name: string) => setUnits((us) => us.map((u) => (u.isBase ? { ...u, name } : u)));
  const setPackKind = (k: PackKind) => {
    setF((x) => ({ ...x, packKind: k, ...(k ? { baseUnit: 'pc' as const, loose: false } : {}) }));
    if (k) nameBase(packUnitName(k, f.packSize));
    else nameBase(f.baseUnit);
  };
  const setPackSize = (size: string) => {
    set('packSize', size);
    if (f.packKind) nameBase(packUnitName(f.packKind, size));
  };
  const suggestedName = [f.family.trim(), f.brand.trim() ? `— ${f.brand.trim()}` : '', f.packSize.trim()].filter(Boolean).join(' ').replace(/^— /, '');
  const addCarton = () => {
    const n = Math.round(Number(cartonQty));
    if (!(n > 1)) return setErr('A carton holds more than 1 pack');
    const name = cartonUnitName(n, f.packSize);
    if (units.some((u) => u.name.toLowerCase() === name.toLowerCase())) return setErr(`${name} is already there`);
    setErr('');
    setUnits([...units, { name, size: String(n), retail: '', wholesale: '', isBase: false }]);
  };

  const save = async () => {
    setErr('');
    const gstBp = Math.round(parseFloat(f.gst) * 100);
    if (!f.nameEn.trim()) return setErr('Name is needed');
    if (Number.isNaN(gstBp)) return setErr('GST % is not a number');
    const unitBody = [];
    for (const u of units) {
      const factor = u.isBase ? 1000 : parseQty(u.size);
      if (!u.name.trim()) return setErr('Every unit needs a name');
      if (!(factor > 0)) return setErr(`Size of ${u.name} must be more than 0`);
      const retail = u.retail.trim() ? parseRupees(u.retail) : null;
      const wholesale = u.wholesale.trim() ? parseRupees(u.wholesale) : null;
      if (u.isBase && retail == null) return setErr('Selling price per base unit is needed');
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
      const body = {
        code: f.code.trim() || null,
        categoryId,
        nameEn: f.nameEn.trim(),
        nameHi: f.nameHi.trim(),
        brand: f.brand.trim(),
        type: f.type.trim(),
        family: f.family.trim(),
        packSize: f.packSize.trim(),
        packKind: f.packKind,
        hsn: f.hsn.trim(),
        gstBp,
        gstFrom: f.gstFrom,
        baseUnit: f.baseUnit,
        loose: f.packKind ? false : f.loose,
        stepMilli: f.loose && !f.packKind ? Math.max(1, parseQty(f.step) || 1000) : 1000,
        reorderQtyMilli: f.reorderQty.trim() ? parseQty(f.reorderQty) : null,
        reorderUnitName: f.reorderQty.trim() ? f.reorderUnit || f.baseUnit : null,
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

  const unitNames = units.map((u) => u.name).filter(Boolean);

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
          <button className="btn primary" onClick={save} disabled={busy}>{t('Save')}</button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label={`${t('Name')} (English)`}><input className="input" value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} autoFocus placeholder="Fortune Mustard Oil 1 L" /></Field>
        <Field label={t('Hindi name')}><input className="input" value={f.nameHi} onChange={(e) => set('nameHi', e.target.value)} placeholder="सरसों तेल" lang="hi" /></Field>
        <Field label={t('Category')} hint="Or type a new path below, e.g. Oil > Saffola > Sunflower">
          <select className="input" value={f.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">— None —</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="New category (optional)" hint={f.categoryId ? 'Created under the category chosen above' : undefined}>
          <input className="input" value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Oil > Saffola" />
        </Field>
        <Field label="Brand / company"><input className="input" value={f.brand} onChange={(e) => set('brand', e.target.value)} /></Field>
        <Field label="Type" hint="e.g. mustard, sunflower, til"><input className="input" value={f.type} onChange={(e) => set('type', e.target.value)} /></Field>
        <Field label="Sold as" hint={f.packKind ? 'Counted in whole packs, never loose. Each company and pack size is its own product.' : 'Pick bori, bag, tin… for items sold only whole'}>
          <select className="input" value={f.packKind} onChange={(e) => setPackKind(e.target.value as PackKind)}>
            <option value="">Ordinary item (loose or packed)</option>
            {PACK_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Item (family)" hint="Sooji, Refined Oil… lines up the companies in the stock summary"><input className="input" value={f.family} onChange={(e) => set('family', e.target.value)} placeholder="Sooji" /></Field>
        <Field label="Pack size" hint="Label only: 25 kg, 1 L, 500 ml"><input className="input" value={f.packSize} onChange={(e) => setPackSize(e.target.value)} placeholder="25 kg" /></Field>
        <div />
        <Field label="Code (optional)"><input className="input" value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="HSN code"><input className="input" value={f.hsn} onChange={(e) => set('hsn', e.target.value)} inputMode="numeric" /></Field>
        <Field label="GST %">
          <div className="row">
            <select className="input" value={['0', '5', '12', '18', '28'].includes(f.gst) ? f.gst : 'other'} onChange={(e) => e.target.value !== 'other' && set('gst', e.target.value)}>
              {['0', '5', '12', '18', '28'].map((g) => <option key={g} value={g}>{g}%</option>)}
              <option value="other">Other…</option>
            </select>
            {!['0', '5', '12', '18', '28'].includes(f.gst) && <input className="input" style={{ width: 90 }} value={f.gst} onChange={(e) => set('gst', e.target.value)} />}
          </div>
        </Field>
        {editing ? (
          <Field label="GST change applies from" hint="Bills before this date keep the old rate"><input type="date" className="input" value={f.gstFrom} onChange={(e) => set('gstFrom', e.target.value)} /></Field>
        ) : <div />}
      </div>

      {suggestedName && suggestedName !== f.nameEn.trim() && (f.family.trim() || f.packKind) && (
        <div className="row wrap"><span className="muted">Name from the fields above:</span><button type="button" className="chip" onClick={() => set('nameEn', suggestedName)}>Use “{suggestedName}”</button></div>
      )}

      <div className="card card-pad" style={{ boxShadow: 'none' }}>
        <div className="row between wrap mb-8">
          <b>{t('Units')} &amp; prices <span className="hi">{settings?.prices_include_gst === '0' ? 'before GST' : 'GST included'}</span></b>
          {f.packKind ? (
            <span className="muted">Counted in {PACK_KINDS.find((k) => k.value === f.packKind)?.many}</span>
          ) : (
            <div className="row">
              <span className="label-sm">{t('Base unit')}</span>
              <div className="seg">
                {(['kg', 'L', 'pc'] as const).map((b) => <button key={b} type="button" className={f.baseUnit === b ? 'on' : ''} onClick={() => setBase(b)}>{b}</button>)}
              </div>
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Unit name</th><th>Holds ({f.baseUnit})</th><th className="right">{t('Retail')} ₹</th><th className="right">{t('Wholesale')} ₹</th><th /></tr></thead>
            <tbody>
              {units.map((u, i) => (
                <tr key={i}>
                  <td><input className="input sm" value={u.name} disabled={u.isBase} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Bag 50 kg" /></td>
                  <td style={{ width: 110 }}><input className="input sm num" value={u.isBase ? '1' : u.size} disabled={u.isBase} inputMode="decimal" onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))} /></td>
                  <td style={{ width: 130 }}><input className="input sm num" value={u.retail} inputMode="decimal" onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, retail: e.target.value } : x)))} placeholder={u.isBase ? 'required' : 'own price'} /></td>
                  <td style={{ width: 130 }}><input className="input sm num" value={u.wholesale} inputMode="decimal" onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, wholesale: e.target.value } : x)))} placeholder="same" /></td>
                  <td style={{ width: 40 }}>{!u.isBase && <button className="btn ghost sm icon" onClick={() => setUnits(units.filter((_, j) => j !== i))} aria-label="Remove unit"><Trash2 size={15} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row wrap mt-8">
          <button className="btn sm" onClick={() => setUnits([...units, { name: '', size: '', retail: '', wholesale: '', isBase: false }])}><Plus size={14} /> Add unit</button>
          {f.baseUnit === 'kg' && ['Bag 50 kg', 'Bag 25 kg', 'Bag 10 kg', 'Bag 5 kg'].filter((n) => !unitNames.includes(n)).map((n) => (
            <button key={n} className="chip" onClick={() => setUnits([...units, { name: n, size: n.match(/\d+/)![0], retail: '', wholesale: '', isBase: false }])}>+ {n}</button>
          ))}
          {f.baseUnit === 'pc' && !f.packKind && !unitNames.includes('Box of 12') && <button className="chip" onClick={() => setUnits([...units, { name: 'Box of 12', size: '12', retail: '', wholesale: '', isBase: false }])}>+ Box of 12</button>}
          {f.baseUnit === 'pc' && (
            <span className="row gap-4">
              <span className="muted">Carton holds</span>
              <input className="input sm num" style={{ width: 64 }} inputMode="numeric" value={cartonQty} onChange={(e) => setCartonQty(e.target.value)} aria-label="Packs in a carton" />
              <button type="button" className="btn sm" onClick={addCarton}><Plus size={14} /> Carton</button>
            </span>
          )}
          {f.baseUnit === 'L' && !unitNames.includes('Tin 15 L') && <button className="chip" onClick={() => setUnits([...units, { name: 'Tin 15 L', size: '15', retail: '', wholesale: '', isBase: false }])}>+ Tin 15 L</button>}
        </div>
        {editing && (
          <div className="row wrap mt-8">
            <Field label="Price changes apply from"><input type="date" className="input" value={f.priceFrom} onChange={(e) => set('priceFrom', e.target.value)} /></Field>
          </div>
        )}
      </div>

      <div className="grid grid-3">
        {f.packKind ? <div /> : (
          <Field label="Sold loose?">
            <label className="check"><input type="checkbox" checked={f.loose} onChange={(e) => set('loose', e.target.checked)} /> By weight / volume</label>
          </Field>
        )}
        {f.loose && !f.packKind ? <Field label={`Step (${f.baseUnit})`}><input className="input" value={f.step} onChange={(e) => set('step', e.target.value)} inputMode="decimal" /></Field> : <div />}
        <Field label="Reorder level" hint="Leave empty to switch off">
          <div className="row">
            <input className="input" style={{ width: 90 }} value={f.reorderQty} onChange={(e) => set('reorderQty', e.target.value)} inputMode="decimal" />
            <select className="input" value={f.reorderUnit || f.baseUnit} onChange={(e) => set('reorderUnit', e.target.value)}>
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
        <Field label={t('Aliases')} hint="Other spellings: chini, cheeni"><input className="input" value={f.aliases} onChange={(e) => set('aliases', e.target.value)} /></Field>
      </div>
      {editing && <Field label="Reason for change (optional)"><input className="input" value={f.reason} onChange={(e) => set('reason', e.target.value)} /></Field>}
    </Modal>
  );
}
