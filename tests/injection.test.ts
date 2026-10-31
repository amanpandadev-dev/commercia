import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, seedCatalog, type Client } from './helpers';
import { istDate } from '../shared/dates';

const read = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? read(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe('searching and injection', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  const today = istDate();

  beforeAll(async () => {
    ctx = await setup();
    owner = await ctx.client('sunil@shop.in');
    const items = await seedCatalog(owner);
    for (const name of ['A_B Traders', 'AxB Traders', '100% Cotton Co', '100 Stores', 'Back\\slash Mart', "O'Brien & Sons"]) {
      const c = await owner.post('/api/customers', { name, phone: '9800000000' });
      await owner.post('/api/bills', { kind: 'tax_invoice', customerId: c.id, billDate: today, lines: [{ productId: items.tea.id, unitId: items.tea.pc, qtyMilli: 1000 }] }); // on credit
    }
  });
  const search = async (q: string) => (await owner.get(`/api/bills?q=${encodeURIComponent(q)}`)).map((b: any) => b.customer_name).sort();

  it('treats % _ and \\ in a search as the characters they are, not as wildcards', async () => {
    expect(await search('_')).toEqual(['A_B Traders']); // not "any single character": AxB is not a match
    expect(await search('a_b')).toEqual(['A_B Traders']);
    expect(await search('%')).toEqual(['100% Cotton Co']); // not "everything"
    expect(await search('100%')).toEqual(['100% Cotton Co']);
    expect(await search('\\')).toEqual(['Back\\slash Mart']);
    expect(await search('100')).toEqual(['100 Stores', '100% Cotton Co']); // plain text still finds both
    expect(await search('TRADERS')).toEqual(['A_B Traders', 'AxB Traders']); // any case
    expect(await search("o'brien")).toEqual(["O'Brien & Sons"]);
  });

  it('is not changed by text that looks like SQL, in a search, a query value, a name or a login', async () => {
    const tables = async () => (await ctx.db.k.introspection.getTables()).map((t) => t.name).sort();
    const before = await tables();
    const count = async () => (await ctx.db.k.selectFrom('bills').select(({ fn }) => fn.countAll().as('n')).executeTakeFirstOrThrow()).n;
    const bills = Number(await count());
    for (const evil of ["'; DROP TABLE bills; --", '" OR 1=1 --', "' OR '1'='1", '1; DELETE FROM users', "%' UNION SELECT password_hash FROM users --"]) {
      expect(await search(evil)).toEqual([]);
      expect((await owner.req('GET', `/api/bills?customerId=${encodeURIComponent(evil)}`)).status).toBeLessThan(500);
      expect((await owner.req('GET', `/api/bills?from=${encodeURIComponent(evil)}`)).status).toBeLessThan(500);
      const login = await ctx.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: evil, password: evil }) });
      expect([400, 401, 429]).toContain(login.status);
      const made = await owner.req('POST', '/api/customers', { name: `Bobby ${evil}`.slice(0, 60), phone: '9800000001' });
      expect(made.status).toBe(200); // stored as plain text
    }
    expect(await tables()).toEqual(before);
    expect(Number(await count())).toBe(bills);
    expect((await ctx.db.k.selectFrom('users').select('id').execute()).length).toBe(3);
    const stored = await ctx.db.k.selectFrom('customers').select('name').where('name', 'like', 'Bobby %DROP TABLE%').executeTakeFirst();
    expect(stored?.name).toContain("'; DROP TABLE bills; --");
  });
});

describe('what the code is made of', () => {
  const server = read('server').filter((f) => f.endsWith('.ts'));
  const web = read('web/src').filter((f) => /\.(ts|tsx)$/.test(f));
  const src = (f: string) => fs.readFileSync(f, 'utf8');

  it('uses sql.raw only in the migration and the move script, and only with constants', () => {
    const files = server.filter((f) => /sql\s*\.raw\(/.test(src(f))).sort();
    expect(files).toEqual(['server/db/migrate.ts', 'server/scripts/move-to-postgres.ts']);
    // Their only interpolations are table names from fixed lists.
    for (const f of files) for (const m of src(f).matchAll(/sql\s*\.raw\(\s*`([^`]*)`/g)) for (const x of m[1].matchAll(/\$\{([^}]+)\}/g)) expect(x[1], `${f}: ${m[1].slice(0, 60)}`).toMatch(/^\s*(t|table)\s*$/);
  });

  it('has no LIKE with a pattern built outside the escaping helper', () => {
    const offenders = server.filter((f) => f !== 'server/lib/core.ts').flatMap((f) => (src(f).match(/'like'|\blike \$\{/g) ?? []).map(() => f));
    expect(offenders).toEqual(['server/db/index.ts']); // the one fixed pattern: authenticator secrets that start with "enc:v1:"
    expect(src('server/db/index.ts')).toMatch(/'like', 'enc:v1:%'/);
  });

  it('has no way to put HTML or code into a page: no innerHTML, dangerouslySetInnerHTML, eval or new Function', () => {
    for (const f of [...web, ...server]) expect(src(f), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(|document\.write\(/);
  });

  it('builds the web app without source maps', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-build-'));
    execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], { stdio: 'ignore', timeout: 120_000 });
    const files = read(out);
    expect(files.length).toBeGreaterThan(2);
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    for (const f of files.filter((x) => /\.(js|css)$/.test(x))) expect(src(f), f).not.toMatch(/sourceMappingURL/);
  }, 180_000);
});
