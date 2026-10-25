import { useEffect, useMemo, useState } from 'react';
import { Download, Upload, Undo2, RefreshCw } from 'lucide-react';
import { api, download } from '../api';
import { useApp } from '../state';
import { Empty, Field, Seg } from '../components/ui';
import { dateTimeOf } from '../format';
import { istDate } from '../../../shared/dates';

type Kind = 'products' | 'stock' | 'customers';
interface Row {
  rowNo: number;
  data: Record<string, string>;
  status: 'new' | 'update' | 'same' | 'error';
  errors: string[];
  notes: string[];
}
interface Preview {
  rows: Row[];
  counts: Record<string, number>;
  newCategories: string[];
  fileName?: string;
}

const COLUMNS: Record<Kind, { key: string; label: string }[]> = {
  products: [
    { key: 'category', label: 'Category path' }, { key: 'name', label: 'Product name' }, { key: 'nameHi', label: 'Hindi' }, { key: 'brand', label: 'Brand' },
    { key: 'packKind', label: 'Pack type' }, { key: 'packSize', label: 'Pack size' }, { key: 'family', label: 'Item group' }, { key: 'baseUnit', label: 'Base unit' },
    { key: 'units', label: 'Extra units' }, { key: 'price', label: 'Price' }, { key: 'unitPrices', label: 'Unit prices' }, { key: 'gst', label: 'GST %' }, { key: 'hsn', label: 'HSN' },
    { key: 'reorder', label: 'Reorder' }, { key: 'opening', label: 'Opening stock' }, { key: 'aliases', label: 'Aliases' },
  ],
  stock: [{ key: 'date', label: 'Date' }, { key: 'supplier', label: 'Supplier' }, { key: 'product', label: 'Product' }, { key: 'qty', label: 'Qty' }, { key: 'unit', label: 'Unit' }, { key: 'rate', label: 'Rate' }],
  customers: [{ key: 'name', label: 'Name' }, { key: 'amount', label: 'Amount owed' }, { key: 'nickname', label: 'Nickname' }, { key: 'phone', label: 'Phone' }, { key: 'area', label: 'Area' }],
};

const STATUS: Record<Row['status'], { label: string; cls: string }> = {
  new: { label: 'New', cls: 'ok' }, update: { label: 'Update', cls: 'info' }, same: { label: 'No change', cls: 'neutral' }, error: { label: 'Error', cls: 'danger' },
};

/** Spreadsheet import (IMP-1..8, MIG-1..5). The uploaded file is read and thrown away; only the confirmed rows are saved. */
export function ImportPage() {
  const { can, toast, reloadCatalog } = useApp();
  const kinds = (['products', 'stock', 'customers'] as Kind[]).filter((k) => can(k === 'products' ? 'import.products' : k === 'stock' ? 'import.stock' : 'import.customers'));
  const [kind, setKind] = useState<Kind>(kinds[0] ?? 'stock');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [asOf, setAsOf] = useState(istDate());
  const [history, setHistory] = useState<any[]>([]);
  const [filter, setFilter] = useState<'' | Row['status']>('');

  const loadHistory = () => api.get('/api/imports').then(setHistory).catch(() => {});
  useEffect(() => {
    loadHistory();
  }, []);
  useEffect(() => {
    setPreview(null);
    setSkip(new Set());
    setErr('');
  }, [kind]);

  const upload = async (file: File) => {
    setErr('');
    setBusy(true);
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', file);
    try {
      const res = await api.post<Preview>('/api/import/preview', fd);
      setPreview(res);
      setSkip(new Set());
      setFilter(res.counts.error ? 'error' : '');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recheck = async (rows: Row[]) => {
    const res = await api.post<Preview>('/api/import/validate', { kind, rows: rows.map((r) => r.data) });
    // Keep original row numbers.
    setPreview({ ...res, fileName: preview?.fileName, rows: res.rows.map((r, i) => ({ ...r, rowNo: rows[i].rowNo })) });
  };

  const included = useMemo(() => (preview?.rows ?? []).filter((r) => !skip.has(r.rowNo)), [preview, skip]);
  const blocking = included.filter((r) => r.status === 'error').length;
  const counts = useMemo(() => {
    const c = { new: 0, update: 0, same: 0, error: 0 };
    for (const r of included) c[r.status]++;
    return c;
  }, [included]);

  const commit = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await api.post('/api/import/commit', { kind, rows: included.filter((r) => r.status !== 'same').map((r) => r.data), fileName: preview?.fileName ?? '', asOf });
      toast(`Imported: ${res.summary}`);
      setPreview(null);
      reloadCatalog();
      loadHistory();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shown = (preview?.rows ?? []).filter((r) => !filter || r.status === filter);

  return (
    <>
      <div className="card card-pad col">
        <div className="row wrap between">
          <Seg value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: k === 'products' ? 'Products & opening stock' : k === 'stock' ? 'Stock deliveries' : 'Customer dues (khata)' }))} />
          <div className="row">
            <button className="btn" onClick={() => download(`/api/import/template/${kind}.xlsx`)}><Download size={15} /> Template .xlsx</button>
            <button className="btn" onClick={() => download(`/api/import/template/${kind}.csv`)}><Download size={15} /> .csv</button>
          </div>
        </div>
        {kind === 'products' && !can('catalog.edit') && (
          <div className="banner info">You can add new items from a file. Items that are already in the list can only be changed by an Owner, so a row for one of them (with a different price, GST or units) will be marked as an error: remove it from the file.</div>
        )}
        <ol className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Download the template and fill it in Excel or Google Sheets — or use your own sheet with similar column names.</li>
          <li>Upload it. Every row is checked and marked New, Update or Error. Nothing is saved yet.</li>
          <li>Fix or skip the error rows, then confirm. Everything is saved together. You can undo the last import.</li>
        </ol>
        <label className="btn primary big" style={{ alignSelf: 'flex-start' }}>
          <Upload size={18} /> {busy ? 'Reading…' : 'Upload .xlsx or .csv'}
          <input type="file" accept=".xlsx,.csv,.xls" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        </label>
        {err && <div className="banner danger">{err}</div>}
      </div>

      {preview && (
        <div className="card">
          <div className="card-head">
            <div className="row wrap gap-4">
              <b>{preview.fileName}</b>
              <button className={`chip ${filter === '' ? 'on' : ''}`} onClick={() => setFilter('')}>All {preview.rows.length}</button>
              {(['new', 'update', 'same', 'error'] as const).map((s) => <button key={s} className={`chip ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)}>{STATUS[s].label} {counts[s]}</button>)}
              {skip.size > 0 && <span className="tag neutral">{skip.size} skipped</span>}
            </div>
            <button className="btn sm" onClick={() => recheck(preview.rows)}><RefreshCw size={14} /> Check again</button>
          </div>
          {preview.newCategories.length > 0 && <div className="card-pad banner info" style={{ borderRadius: 0 }}>New categories to create: {preview.newCategories.join(', ')}</div>}
          <div className="table-wrap" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>Row</th><th>Status</th>{COLUMNS[kind].map((c) => <th key={c.key}>{c.label}</th>)}<th>Skip</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.rowNo} style={{ opacity: skip.has(r.rowNo) ? 0.45 : 1 }}>
                    <td className="muted">{r.rowNo}</td>
                    <td>
                      <span className={`tag ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                      {r.errors.map((e) => <div key={e} className="err" style={{ fontSize: 11.5 }}>{e}</div>)}
                      {r.notes.length > 0 && <div className="faint" style={{ fontSize: 11.5 }}>{r.notes.join(', ')}</div>}
                    </td>
                    {COLUMNS[kind].map((c) => (
                      <td key={c.key}>
                        {r.status === 'error' ? (
                          <input
                            className="input sm"
                            style={{ minWidth: 80 }}
                            value={r.data[c.key] ?? ''}
                            onChange={(e) => setPreview({ ...preview, rows: preview.rows.map((x) => (x.rowNo === r.rowNo ? { ...x, data: { ...x.data, [c.key]: e.target.value } } : x)) })}
                            onBlur={() => recheck(preview.rows)}
                          />
                        ) : (
                          <span>{r.data[c.key]}</span>
                        )}
                      </td>
                    ))}
                    <td><input type="checkbox" checked={skip.has(r.rowNo)} onChange={(e) => { const n = new Set(skip); if (e.target.checked) n.add(r.rowNo); else n.delete(r.rowNo); setSkip(n); }} aria-label="Skip row" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <Empty>No rows here</Empty>}
          </div>
          <div className="card-pad row wrap" style={{ borderTop: '1px solid var(--border)' }}>
            {kind === 'customers' && <Field label="Opening balance as on"><input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>}
            <span className="grow muted">{counts.new} new · {counts.update} updated · {counts.same} unchanged{blocking ? ` · ${blocking} errors to fix or skip` : ''}</span>
            <button className="btn" onClick={() => setPreview(null)}>Discard</button>
            <button className="btn primary" disabled={busy || blocking > 0 || counts.new + counts.update === 0} onClick={commit}>Confirm import</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h3>Recent imports</h3></div>
        {history.length === 0 ? <Empty>No imports yet</Empty> : history.map((h, i) => (
          <div key={h.id} className="list-item" style={{ cursor: 'default' }}>
            <div className="grow">
              <b style={{ fontWeight: 500, textTransform: 'capitalize' }}>{h.kind}</b> <span className="muted">· {h.file_name || 'sheet'} · {h.summary}</span>
              <div className="faint" style={{ fontSize: 12 }}>{h.by} · {dateTimeOf(h.created_at)}</div>
            </div>
            {h.undone ? <span className="tag neutral">Undone</span> : i === 0 && can('import.undo') ? (
              <button className="btn sm" onClick={async () => { if (!confirm('Undo this import? Sales made since stay recorded.')) return; try { await api.post(`/api/imports/${h.id}/undo`); toast('Import undone'); reloadCatalog(); loadHistory(); } catch (e) { toast((e as Error).message, 'error'); } }}>
                <Undo2 size={14} /> Undo
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
