import { useState } from 'react';
import { Printer } from 'lucide-react';
import { Modal, Seg } from './ui';
import { rs, qty, PRINT_AS_LABEL, timeOf, MODE_LABEL } from '../format';
import { formatRate } from '../../../shared/money';
import { formatDate } from '../../../shared/dates';

export interface BillDetail {
  bill: any;
  lines: any[];
  payments: { id: number; parts: { mode: string; amount_paise: number; reference: string }[]; reversal_of: number | null; at_billing: number; total_paise: number; date: string }[];
  customer: any;
  balance: number | null;
  converted: { id: number; number: string } | null;
  history: any[];
  shop: any;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function two(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}
function three(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? two(r) : ''].filter(Boolean).join(' ');
}
/** 93100 paise → "Rupees Nine Hundred Thirty-One Only" (Indian system: lakh, crore). */
export function amountInWords(paise: number): string {
  let n = Math.floor(Math.abs(paise) / 100);
  if (n === 0) return 'Rupees Zero Only';
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const parts = [crore && `${three(crore)} Crore`, lakh && `${two(lakh)} Lakh`, thousand && `${two(thousand)} Thousand`, n && three(n)].filter(Boolean);
  const p = Math.abs(paise) % 100;
  return `Rupees ${parts.join(' ')}${p ? ` and ${two(p)} Paise` : ''} Only`;
}

export function BillDoc({ d, paper }: { d: BillDetail; paper: 'A4' | 'thermal' }) {
  const b = d.bill;
  const s = d.shop;
  const isEstimate = b.status === 'estimate' || b.status === 'converted';
  const kind: string = isEstimate ? 'estimate' : b.print_as;
  const showTax = kind === 'tax_invoice' || kind === 'receipt';
  const inclusive = kind === 'kaccha' || kind === 'estimate';
  const title = isEstimate ? 'ESTIMATE — NOT A BILL' : (PRINT_AS_LABEL[kind] ?? 'Bill').toUpperCase();
  const lineRate = (l: any) => (inclusive ? Math.round((l.rate_paise * (10000 + l.gst_bp)) / 10000) : l.rate_paise);
  const lineAmt = (l: any) => (inclusive ? l.taxable_paise + l.cgst_paise + l.sgst_paise : l.amount_paise);
  const parts = d.payments.filter((p) => p.at_billing && !p.reversal_of).flatMap((p) => p.parts);
  const bySlab = new Map<number, { taxable: number; cgst: number; sgst: number }>();
  for (const l of d.lines) {
    const x = bySlab.get(l.gst_bp) ?? { taxable: 0, cgst: 0, sgst: 0 };
    x.taxable += l.taxable_paise; x.cgst += l.cgst_paise; x.sgst += l.sgst_paise;
    bySlab.set(l.gst_bp, x);
  }
  const showGstin = kind !== 'cash_memo' && s.shop_gstin;
  const cancelled = b.status === 'cancelled';

  if (paper === 'thermal') {
    return (
      <div className="doc thermal">
        <div style={{ textAlign: 'center' }}>
          <b style={{ fontSize: 14 }}>{s.shop_name.toUpperCase()}</b>
          {s.shop_address && <div>{s.shop_address}</div>}
          {s.shop_phone && <div>Ph {s.shop_phone}</div>}
          {showGstin && <div>GSTIN {s.shop_gstin}</div>}
          <div style={{ marginTop: 4 }}><b>{title}</b></div>
          {cancelled && <div><b>*** CANCELLED ***</b></div>}
        </div>
        <hr />
        <div>{b.number} · {formatDate(b.bill_date)} {timeOf(b.created_at)}</div>
        {b.customer_name && <div>To: {b.customer_name}{b.customer_gstin ? ` (${b.customer_gstin})` : ''}</div>}
        <hr />
        <table>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.name_en}<br /><span>{qty(l.qty_milli)} {l.unit_name} × {(lineRate(l) / 100).toFixed(2)}</span></td>
                <td className="r" style={{ verticalAlign: 'bottom' }}>{(lineAmt(l) / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <hr />
        <table>
          <tbody>
            {!inclusive && <tr><td>Subtotal</td><td className="r">{(b.subtotal_paise / 100).toFixed(2)}</td></tr>}
            {b.discount_paise > 0 && <tr><td>Discount</td><td className="r">-{(b.discount_paise / 100).toFixed(2)}</td></tr>}
            {showTax && b.cgst_paise > 0 && <tr><td>GST (CGST+SGST)</td><td className="r">{((b.cgst_paise + b.sgst_paise) / 100).toFixed(2)}</td></tr>}
            {b.round_off_paise !== 0 && <tr><td>Round off</td><td className="r">{(b.round_off_paise / 100).toFixed(2)}</td></tr>}
            <tr><td><b style={{ fontSize: 15 }}>TOTAL</b></td><td className="r"><b style={{ fontSize: 15 }}>₹{(b.total_paise / 100).toFixed(0)}</b></td></tr>
            {parts.map((p, i) => <tr key={i}><td>{MODE_LABEL[p.mode]}</td><td className="r">{(p.amount_paise / 100).toFixed(2)}</td></tr>)}
            {b.credit_paise > 0 && <tr><td>On credit</td><td className="r">{(b.credit_paise / 100).toFixed(2)}</td></tr>}
          </tbody>
        </table>
        {kind === 'bill_of_supply' && <div style={{ fontSize: 10 }}>Composition taxable person, not eligible to collect tax on supplies.</div>}
        <hr />
        <div style={{ textAlign: 'center' }}>Thank you! धन्यवाद</div>
      </div>
    );
  }

  return (
    <div className="doc a4">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{s.shop_name}</div>
          {s.shop_address && <div>{s.shop_address}</div>}
          {s.shop_phone && <div>Phone {s.shop_phone}</div>}
          {showGstin && <div>GSTIN {s.shop_gstin}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#0e7a6e' }}>{title}</div>
          <div>{b.number}</div>
          <div>{formatDate(b.bill_date)}</div>
          {b.paper_ref && <div>Paper bill {b.paper_ref}</div>}
          {cancelled && <div style={{ color: '#c00', fontWeight: 600 }}>CANCELLED</div>}
        </div>
      </div>
      <div style={{ margin: '14px 0 10px' }}>
        <b>Bill to:</b> {b.customer_name || 'Walk-in customer'}
        {b.customer_gstin && <span> · GSTIN {b.customer_gstin}</span>}
        {d.customer?.phone && <span> · {d.customer.phone}</span>}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th><th>Item</th>{showTax && <th>HSN</th>}<th className="r">Qty</th><th className="r">Rate</th>{showTax && <th className="r">GST</th>}<th className="r">Amount</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={l.id}>
              <td>{i + 1}</td>
              <td>{l.name_en}{l.name_hi && <span style={{ color: '#666' }}> · {l.name_hi}</span>}{l.price_override === 1 && <span className="no-print tag warn" style={{ marginLeft: 6 }}>own price · list {(l.official_rate_paise / 100).toFixed(2)}</span>}</td>
              {showTax && <td>{l.hsn}</td>}
              <td className="r q">{qty(l.qty_milli)} {l.unit_name}</td>
              <td className="r">{(lineRate(l) / 100).toFixed(2)}</td>
              {showTax && <td className="r">{formatRate(l.gst_bp)}</td>}
              <td className="r">{(lineAmt(l) / 100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          {showTax && b.cgst_paise > 0 && (
            <table style={{ fontSize: 11 }}>
              <thead><tr><th>GST</th><th className="r">Taxable</th><th className="r">CGST</th><th className="r">SGST</th></tr></thead>
              <tbody>
                {[...bySlab.entries()].sort((a, c) => a[0] - c[0]).map(([bp, x]) => (
                  <tr key={bp}><td>{formatRate(bp)}</td><td className="r">{(x.taxable / 100).toFixed(2)}</td><td className="r">{(x.cgst / 100).toFixed(2)}</td><td className="r">{(x.sgst / 100).toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ marginTop: 10, fontStyle: 'italic' }}>{amountInWords(b.total_paise)}</div>
          {parts.length > 0 && <div style={{ marginTop: 6 }}>Paid: {parts.map((p) => `${MODE_LABEL[p.mode]} ₹${(p.amount_paise / 100).toFixed(2)}`).join(' + ')}</div>}
          {b.credit_paise > 0 && <div>On credit: ₹{(b.credit_paise / 100).toFixed(2)}{d.balance != null && ` · Balance due ₹${(d.balance / 100).toFixed(2)}`}</div>}
          {kind === 'bill_of_supply' && <div style={{ marginTop: 6, fontSize: 11 }}>Composition taxable person, not eligible to collect tax on supplies.</div>}
        </div>
        <table style={{ width: 240 }}>
          <tbody>
            {!inclusive && <tr><td>{showTax ? 'Taxable value' : 'Subtotal'}</td><td className="r">{((showTax ? b.taxable_paise : b.subtotal_paise) / 100).toFixed(2)}</td></tr>}
            {b.discount_paise > 0 && <tr><td>Discount</td><td className="r">-{(b.discount_paise / 100).toFixed(2)}</td></tr>}
            {showTax && b.cgst_paise > 0 && <tr><td>CGST</td><td className="r">{(b.cgst_paise / 100).toFixed(2)}</td></tr>}
            {showTax && b.sgst_paise > 0 && <tr><td>SGST</td><td className="r">{(b.sgst_paise / 100).toFixed(2)}</td></tr>}
            {b.round_off_paise !== 0 && <tr><td>Round off</td><td className="r">{(b.round_off_paise / 100).toFixed(2)}</td></tr>}
            <tr><td><b>Total</b></td><td className="r"><b style={{ fontSize: 16 }}>₹{(b.total_paise / 100).toFixed(2)}</b></td></tr>
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 30, display: 'flex', justifyContent: 'space-between', color: '#666', fontSize: 11 }}>
        <span>Thank you for shopping with us · धन्यवाद</span>
        <span>For {s.shop_name}</span>
      </div>
    </div>
  );
}

export function PrintModal({ d, onClose, extra }: { d: BillDetail; onClose: () => void; extra?: React.ReactNode }) {
  const [paper, setPaper] = useState<'A4' | 'thermal'>(d.shop.paper === 'thermal' ? 'thermal' : 'A4');
  return (
    <Modal
      wide
      title={`${d.bill.number} · ${rs(d.bill.total_paise)}`}
      sub={d.bill.customer_name || 'Walk-in'}
      onClose={onClose}
      foot={
        <>
          <Seg value={paper} onChange={setPaper} options={[{ value: 'A4', label: 'A4' }, { value: 'thermal', label: 'Thermal 80 mm' }]} />
          <div className="grow" />
          {extra}
          <button className="btn primary" onClick={() => window.print()}><Printer size={16} /> Print / PDF</button>
        </>
      }
    >
      <div className="preview-pane">
        <div className="print-area"><BillDoc d={d} paper={paper} /></div>
      </div>
    </Modal>
  );
}
