import { rs } from '../format';
import { formatQty } from '../../../shared/money';
import { shortDate } from '../../../shared/dates';

export interface BoughtItem {
  productId: number;
  name: string;
  nameHi: string;
  unit: string;
  qtyMilli: number;
  amountPaise: number;
  times: number;
  lastDate: string;
}

/**
 * The list under a ledger: what was bought in the date range, one row per item, instead of the items
 * being spread through the dated rows above. `times` is bills (customer) or deliveries (supplier).
 */
export function ItemsBought({ items, title, times }: { items: BoughtItem[]; title: string; times: 'bills' | 'deliveries' }) {
  const total = items.reduce((a, i) => a + i.amountPaise, 0);
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <div className="card-pad row between" style={{ paddingBottom: 0 }}>
        <b>{title}</b>
        {items.length > 0 && <span className="muted num" style={{ fontSize: 13 }}>{items.length} {items.length === 1 ? 'item' : 'items'} · {rs(total, false)}</span>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Item</th><th className="right">Quantity</th><th className="right">{times === 'bills' ? 'Bills' : 'Deliveries'}</th><th>Last</th><th className="right">Amount</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={`${i.productId}|${i.unit}`}>
                <td>
                  {i.name}
                  {i.nameHi && i.nameHi !== i.name && <div className="faint" style={{ fontSize: 12 }}>{i.nameHi}</div>}
                </td>
                <td className="right num">{formatQty(i.qtyMilli)} {i.unit}</td>
                <td className="right num">{i.times}</td>
                <td className="nowrap">{shortDate(i.lastDate)}</td>
                <td className="right num">{i.amountPaise ? (i.amountPaise / 100).toFixed(2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="card-pad faint" style={{ fontSize: 13 }}>Nothing bought in this period.</div>}
      </div>
    </div>
  );
}
