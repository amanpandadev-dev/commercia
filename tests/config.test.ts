import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, config, loadDotEnv, parseKey, secretValues } from '../server/lib/config';
import { PRIVATE_RANGES } from '../server/lib/net';
import { redact } from '../server/lib/redact';

const KEY = 'a'.repeat(64);

describe('config', () => {
  it('runs with no settings at all, on safe defaults', () => {
    const c = config({});
    expect(c).toMatchObject({ port: 8787, host: '0.0.0.0', trustedProxies: [], allowedOrigins: [], showUsersOnLan: false, scryptLog2: 17 });
    expect(c.allowedIps).toEqual(PRIVATE_RANGES);
    expect(c.databaseUrl).toBeUndefined();
    expect(c.secretKey).toBeUndefined();
  });

  it('treats an empty value as not set', () => {
    expect(config({ PORT: '', SMTP_URL: '  ', ALLOWED_IPS: '', TRUST_PROXY: '' }).port).toBe(8787);
  });

  it('reads and checks every setting', () => {
    const c = config({
      PORT: '9000', HOST: '127.0.0.1', COMMERCIA_DB: 'x.db', DATABASE_URL: 'postgres://u:p@h/db', SMTP_URL: 'smtps://u:p@smtp.example.com:465',
      MAIL_FROM: 'Shop <a@b.c>', COMMERCIA_SECRET_KEY: KEY, TRUSTED_PROXIES: '10.0.0.5, 10.1.0.0/16', TRUST_PROXY: '1', ALLOWED_ORIGINS: 'https://Shop.Example.com',
      ALLOWED_IPS: '192.168.1.0/24', SHOW_USERS_ON_LAN: '1', COMMERCIA_SCRYPT_LOG2: '12',
    });
    expect(c).toMatchObject({ port: 9000, host: '127.0.0.1', dbFile: 'x.db', mailFrom: 'Shop <a@b.c>', secretKey: KEY, allowedOrigins: ['https://shop.example.com'], allowedIps: ['192.168.1.0/24'], showUsersOnLan: true, scryptLog2: 12 });
    expect(c.trustedProxies).toEqual(['127.0.0.0/8', '::1/128', '10.0.0.5', '10.1.0.0/16']); // TRUST_PROXY=1 is a proxy on this computer
  });

  it('fails fast, naming the settings that are wrong and never showing their values', () => {
    const bad = { PORT: 'LEAKCANARYPORT', SMTP_URL: 'http://user:LEAKCANARYPASS@x', COMMERCIA_SECRET_KEY: 'LEAKCANARYKEY', ALLOWED_IPS: 'LEAKCANARYIP', TRUST_PROXY: 'LEAKCANARYYES', DATABASE_URL: 'mysql://LEAKCANARYDB' };
    let err: unknown;
    try {
      config(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    for (const name of Object.keys(bad)) expect(msg).toContain(name);
    expect(msg).not.toMatch(/LEAKCANARY/);
  });

  it('accepts a key as hex or as base64, and nothing else', () => {
    expect(parseKey(KEY)?.length).toBe(32);
    expect(parseKey(Buffer.alloc(32, 7).toString('base64'))?.length).toBe(32);
    expect(parseKey('short')).toBeNull();
    expect(parseKey('z'.repeat(64))).toBeNull();
  });
});

describe('.env file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercia-env-'));
  afterEach(() => fs.rmSync(path.join(dir, '.env'), { force: true }));

  it('is read, with comments, quotes, export and Windows line endings, and never overrides the environment', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '﻿# comment\r\nPORT=9100\r\nexport HOST="127.0.0.1"\r\nMAIL_FROM=\'Shop <a@b.c>\'  # note\r\nEMPTY=\r\nnot a setting\r\nALREADY=from-file\r\n');
    const env: NodeJS.ProcessEnv = { ALREADY: 'from-environment' };
    expect(loadDotEnv(file, env).sort()).toEqual(['EMPTY', 'HOST', 'MAIL_FROM', 'PORT']);
    expect(env).toMatchObject({ PORT: '9100', HOST: '127.0.0.1', MAIL_FROM: 'Shop <a@b.c>', ALREADY: 'from-environment' });
  });

  it('is fine when there is none', () => {
    expect(loadDotEnv(path.join(dir, 'missing.env'), {})).toEqual([]);
  });
});

describe('redact', () => {
  const saved = { smtp: process.env.SMTP_URL, db: process.env.DATABASE_URL, key: process.env.COMMERCIA_SECRET_KEY };
  afterEach(() => {
    for (const [k, v] of [['SMTP_URL', saved.smtp], ['DATABASE_URL', saved.db], ['COMMERCIA_SECRET_KEY', saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('hides the configured secrets wherever they turn up', () => {
    process.env.SMTP_URL = 'smtps://mailer:S3cretMailPw@smtp.example.com:465';
    process.env.DATABASE_URL = 'postgres://app:Db-P%40ss-9@db.example.com/shop';
    process.env.COMMERCIA_SECRET_KEY = 'b'.repeat(64);
    const line = redact(`connect failed for ${process.env.SMTP_URL}; db says password Db-P@ss-9 and ${process.env.DATABASE_URL}; key ${'b'.repeat(64)}`);
    for (const s of ['S3cretMailPw', 'Db-P%40ss-9', 'Db-P@ss-9', 'b'.repeat(64)]) expect(line).not.toContain(s);
    expect(line).toContain('smtp.example.com'); // the useful part stays
    expect(secretValues()).toEqual(expect.arrayContaining(['S3cretMailPw', 'Db-P@ss-9']));
  });

  it('hides passwords in any URL, and values next to words like password, token, code and cookie', () => {
    expect(redact('GET https://user:hunter2@host/x')).toBe('GET https://user:[hidden]@host/x');
    expect(redact('body {"password":"hunter2","email":"a@b.c"}')).toContain('"email":"a@b.c"');
    expect(redact('body {"password":"hunter2","email":"a@b.c"}')).not.toContain('hunter2');
    expect(redact('reset code: ABCD-2345')).not.toContain('ABCD-2345');
    expect(redact('totp=123456&x=1')).toBe('totp=[hidden]&x=1');
    expect(redact('cookie: commercia_session=V1aysDE1Xi0b0a_cY-uYQ5d38ay4ChSRf4u68IuFur4')).not.toContain('V1aysDE1');
    expect(redact('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
  });

  it('leaves ordinary text alone', () => {
    const s = 'Imported products from stock.xlsx: 3 new, 1 updated · customers owe ₹1,660.00';
    expect(redact(s)).toBe(s);
  });
});
