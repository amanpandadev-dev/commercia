import { openDb, type Db } from '../server/db/index';
import { createApp } from '../server/app';
import { hashPassword } from '../server/lib/crypto';
import { setSetting } from '../server/lib/settings';
import { nowIso } from '../server/db/index';

export interface Client {
  req: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }>;
  get: (url: string) => Promise<any>;
  post: (url: string, body?: unknown) => Promise<any>;
  patch: (url: string, body?: unknown) => Promise<any>;
}

/**
 * A fresh database per test file. Set TEST_DATABASE_URL=postgres://… to run the same tests
 * against Postgres (PILOT-3); each setup gets its own new database there.
 */
async function freshDb(): Promise<Db> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return openDb({ file: ':memory:' });
  const pg = (await import('pg')).default;
  const name = `commercia_t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return openDb({ url: url.toString() });
}

export async function setup() {
  const db: Db = await freshDb();
  // The brakes on how often one visitor may call are tested on their own (tests/edge.test.ts); here they must not get in the way.
  const app = createApp(db, { limits: { global: 1e6, auth: 1e6, reset: 1e6, imports: 1e6, exports: 1e6 } });
  await setSetting(db.k, 'require_2fa', '0');
  await setSetting(db.k, 'shop_name', 'Sharma Kirana Store');
  // The older tests were written for prices before tax; tests of inclusive prices switch this on.
  await setSetting(db.k, 'prices_include_gst', '0');
  const mk = async (name: string, email: string, role: 'admin' | 'owner' | 'entry') =>
    db.k
      .insertInto('users')
      .values({ name, email, role, password_hash: hashPassword('password123'), active: 1, lang: 'en', totp_enabled: 0, totp_secret: null, session_epoch: 0, created_at: nowIso() })
      .returning('id')
      .executeTakeFirstOrThrow();
  await mk('Ramesh Sharma', 'ramesh@shop.in', 'admin');
  await mk('Sunil Sharma', 'sunil@shop.in', 'owner');
  await mk('Amit Kumar', 'amit@shop.in', 'entry');

  const client = async (email: string, password = 'password123'): Promise<Client> => {
    let cookie = '';
    const send = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json: any = text;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, json };
    };
    // Like the app's screen: when a risky action asks for the password again, type it and go on.
    const req = async (method: string, url: string, body?: unknown) => {
      const r = await send(method, url, body);
      if (r.status === 403 && r.json?.code === 'reauth_required') {
        await send('POST', '/api/account/reauth', { password });
        return send(method, url, body);
      }
      return r;
    };
    const ok = async (method: string, url: string, body?: unknown) => {
      const r = await req(method, url, body);
      if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json;
    };
    const login = await req('POST', '/api/auth/login', { email, password });
    if (login.status !== 200) throw new Error(`login failed ${JSON.stringify(login.json)}`);
    return { req, get: (u) => ok('GET', u), post: (u, b) => ok('POST', u, b ?? {}), patch: (u, b) => ok('PATCH', u, b ?? {}) };
  };

  return { db, app, client };
}

/** Sugar, Mustard Oil, Toor Dal, Bath Soap, Tea — the PRD's worked example items. */
export async function seedCatalog(owner: Client) {
  const mk = (body: object) => owner.post('/api/products', body);
  const sugar = await mk({
    nameEn: 'Sugar', nameHi: 'चीनी', gstBp: 500, hsn: '1701', baseUnit: 'kg', loose: true, stepMilli: 250, aliases: 'chini, cheeni',
    units: [
      { name: 'kg', factorMilli: 1000, isBase: true, retail: 4500 },
      { name: 'Bag 50 kg', factorMilli: 50000, retail: 215000 },
    ],
    reorderQtyMilli: 10000, reorderUnitName: 'kg',
  });
  const oil = await mk({
    nameEn: 'Fortune Mustard Oil 1 L', nameHi: 'सरसों तेल', brand: 'Fortune', type: 'mustard', gstBp: 500, hsn: '1514', baseUnit: 'L', aliases: 'sarson, sarso tel',
    units: [{ name: 'L', factorMilli: 1000, isBase: true, retail: 16000 }],
    reorderQtyMilli: 6000, reorderUnitName: 'L',
  });
  const dal = await mk({
    nameEn: 'Toor Dal (loose)', nameHi: 'अरहर दाल', gstBp: 0, hsn: '0713', baseUnit: 'kg', loose: true,
    units: [{ name: 'kg', factorMilli: 1000, isBase: true, retail: 14000 }],
  });
  const soap = await mk({
    nameEn: 'Bath Soap', nameHi: 'साबुन', gstBp: 500, hsn: '3401', baseUnit: 'pc',
    units: [
      { name: 'pc', factorMilli: 1000, isBase: true, retail: 4000 },
      { name: 'Box of 12', factorMilli: 12000, retail: 45000 },
    ],
  });
  const tea = await mk({
    nameEn: 'Tea 250g', nameHi: 'चाय', gstBp: 500, hsn: '0902', baseUnit: 'pc',
    units: [{ name: 'pc', factorMilli: 1000, isBase: true, retail: 13000 }],
  });
  const cat = await owner.get('/api/catalog');
  const unit = (pid: number, name: string) => cat.products.find((p: any) => p.id === pid).units.find((u: any) => u.name === name).id;
  return {
    sugar: { id: sugar.id, kg: unit(sugar.id, 'kg'), bag: unit(sugar.id, 'Bag 50 kg') },
    oil: { id: oil.id, L: unit(oil.id, 'L') },
    dal: { id: dal.id, kg: unit(dal.id, 'kg') },
    soap: { id: soap.id, pc: unit(soap.id, 'pc'), box: unit(soap.id, 'Box of 12') },
    tea: { id: tea.id, pc: unit(tea.id, 'pc') },
  };
}
