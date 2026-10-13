import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../state';
import { Field, Modal, Seg, type CustomerRow } from './ui';

export function CustomerForm({ customer, initialName = '', onClose, onSaved }: { customer?: CustomerRow; initialName?: string; onClose: () => void; onSaved: (id: number) => void }) {
  const { t, toast } = useApp();
  const [f, setF] = useState({
    name: customer?.name ?? initialName,
    nickname: customer?.nickname ?? '',
    phone: customer?.phone ?? '',
    area: customer?.area ?? '',
    gstin: customer?.gstin ?? '',
    priceList: customer?.price_list ?? ('retail' as 'retail' | 'wholesale'),
  });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const res = customer ? await api.patch(`/api/customers/${customer.id}`, f) : await api.post('/api/customers', f);
      toast(customer ? 'Customer saved' : 'Customer added');
      onSaved(customer?.id ?? res.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal
      title={customer ? `Edit ${customer.name}` : t('Add customer')}
      sub={customer ? 'Balance is not changed by editing details' : 'ग्राहक जोड़ें'}
      onClose={onClose}
      foot={
        <>
          {err && <span className="err grow">{err}</span>}
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!f.name.trim()} onClick={save}>{t('Save')}</button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label={t('Name')}><input className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label={t('Nickname')} hint="Tells two people with the same name apart"><input className="input" value={f.nickname} onChange={set('nickname')} /></Field>
        <Field label={t('Phone')}><input className="input" value={f.phone} onChange={set('phone')} inputMode="tel" /></Field>
        <Field label={t('Area')}><input className="input" value={f.area} onChange={set('area')} /></Field>
        <Field label="GSTIN (business buyers)"><input className="input" value={f.gstin} onChange={set('gstin')} style={{ textTransform: 'uppercase' }} /></Field>
        <Field label="Price list">
          <Seg value={f.priceList} onChange={(v) => setF({ ...f, priceList: v })} options={[{ value: 'retail', label: t('Retail') }, { value: 'wholesale', label: t('Wholesale') }]} />
        </Field>
      </div>
    </Modal>
  );
}
