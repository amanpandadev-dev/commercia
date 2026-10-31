import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppEnv } from '../lib/core';
import { HttpError, bad, logActivity, need } from '../lib/core';
import { hashPassword, newTotpSecret, randomToken, sha256, verifyPassword, verifyTotpStep } from '../lib/crypto';
import { nowIso } from '../db/index';
import { getSettings, setSetting } from '../lib/settings';
import { readTotpSecret, sealTotpSecret } from '../lib/secrets';
import type { Tx } from '../lib/core';
import { POLICY, accountKey, addressKey, checkThrottle, clearThrottle, recordFailure, type Policy } from '../lib/throttle';
import { raiseAlert } from '../lib/alerts';
import { clientIp, isHttps } from '../lib/proxy';
import { clearSetupCode, setupAccess } from '../lib/setup';
import { emailEnrolmentCode, issueEnrolmentCode, redeemEnrolmentCode, voidEnrolmentCodes } from '../lib/enrolment';
import { makeRecoveryCodes, recoveryLeft, useRecoveryCode, voidRecoveryCodes } from '../lib/recovery';
import { mailConfigured } from '../lib/mailer';
import { askForReset, issueCode, pendingRequests, redeem, tellPasswordChanged } from '../lib/passwordReset';
import type { User } from '../db/schema';
import type { Role } from '../../shared/perms';

const COOKIE = 'commercia_session';
const IDLE_MS = 12 * 3600_000;
const ABSOLUTE_MS = 30 * 24 * 3600_000;

const needs2fa = (u: User, require2fa: boolean) => u.totp_enabled === 1 || (require2fa && u.role !== 'entry');

export const publicUser = (u: User) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  lang: u.lang,
  active: u.active === 1,
  totpEnabled: u.totp_enabled === 1,
});

async function loadSession(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const { k } = c.get('db');
  const sid = sha256(token);
  const s = await k.selectFrom('sessions').selectAll().where('id', '=', sid).executeTakeFirst();
  if (!s) return null;
  const now = Date.now();
  if (Date.parse(s.expires_at) < now || Date.parse(s.last_seen) + IDLE_MS < now) {
    await k.deleteFrom('sessions').where('id', '=', sid).execute();
    return null;
  }
  const user = await k.selectFrom('users').selectAll().where('id', '=', s.user_id).executeTakeFirst();
  // Deactivated users and "sign out everywhere" end sessions on the very next request (AUTH-4, AUTH-5).
  if (!user || user.active !== 1 || user.session_epoch !== s.epoch) {
    await k.deleteFrom('sessions').where('id', '=', sid).execute();
    return null;
  }
  if (Date.parse(s.last_seen) + 60_000 < now) {
    await k.updateTable('sessions').set({ last_seen: nowIso() }).where('id', '=', sid).execute();
  }
  return { s, user };
}

/** Every /api route except the ones in this file needs a full login (password + code when required). */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const loaded = await loadSession(c);
  if (!loaded) throw new HttpError(401, 'Please log in', 'unauthenticated');
  const settings = await getSettings(c.get('db').k);
  if (needs2fa(loaded.user, settings.require_2fa === '1') && loaded.s.totp_ok !== 1) {
    throw new HttpError(401, 'Enter the code from your authenticator app', 'totp_required');
  }
  c.set('user', loaded.user);
  c.set('sessionId', loaded.s.id);
  await next();
};

async function startSession(c: Parameters<MiddlewareHandler<AppEnv>>[0], user: User, opts: { enrolOk?: boolean } = {}) {
  const token = randomToken();
  const now = Date.now();
  await c
    .get('db')
    .k.insertInto('sessions')
    .values({
      id: sha256(token),
      user_id: user.id,
      epoch: user.session_epoch,
      totp_ok: 0,
      enrol_ok: opts.enrolOk ? 1 : 0,
      created_at: new Date(now).toISOString(),
      last_seen: new Date(now).toISOString(),
      expires_at: new Date(now + ABSOLUTE_MS).toISOString(),
    })
    .execute();
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isHttps(c),
    maxAge: ABSOLUTE_MS / 1000,
  });
}

type Ctx = Parameters<MiddlewareHandler<AppEnv>>[0];

let dummyHash = '';
/** Refuses while any of these keys is locked. A refused password attempt still costs the same time as a real one. */
async function refuseIfLocked(c: Ctx, keys: string[], password?: string) {
  const { k } = c.get('db');
  try {
    for (const key of keys) await checkThrottle(k, key);
  } catch (e) {
    if (password !== undefined) verifyPassword(password, (dummyHash ||= hashPassword('x')));
    throw e;
  }
}

/** Counts a wrong try against each key, and tells the Owners and the Admin when one of them causes a lock. */
async function countFailure(c: Ctx, tries: { key: string; policy: Policy; what: string }[]) {
  const { k } = c.get('db');
  for (const t of tries) {
    const f = await recordFailure(k, t.key, t.policy);
    if (f.locked) {
      const mins = Math.round((Date.parse(f.until!) - Date.now()) / 60000);
      await raiseAlert(k, { action: 'lockout', summary: `${t.what} was locked for ${mins} minutes after repeated wrong tries (from ${clientIp(c)})`, email: true, dedupe: `lockout:${t.key}` });
    }
  }
}

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters');

export const auth = new Hono<AppEnv>();

auth.get('/state', async (c) => {
  const { k } = c.get('db');
  const users = await k.selectFrom('users').selectAll().where('active', '=', 1).orderBy('id').execute();
  const s = await getSettings(k);
  const loaded = await loadSession(c);
  let me = null;
  let step: 'login' | 'totp' | 'enroll' | 'done' = 'login';
  if (loaded) {
    me = publicUser(loaded.user);
    if (needs2fa(loaded.user, s.require_2fa === '1') && loaded.s.totp_ok !== 1) {
      step = loaded.user.totp_enabled === 1 ? 'totp' : 'enroll';
    } else step = 'done';
  }
  const setupNeeded = users.length === 0;
  return c.json({
    setupNeeded,
    setupCodeRequired: setupNeeded && setupAccess(c) === 'refused',
    emailEnabled: mailConfigured(),
    enrol: step === 'enroll' && loaded ? { codeRequired: loaded.s.enrol_ok !== 1, canEmail: mailConfigured() } : null,
    shop: { name: s.shop_name, nameHi: s.shop_name_hi, address: s.shop_address, gstin: s.shop_gstin },
    defaultLang: s.default_lang,
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    me,
    step,
  });
});

auth.post('/setup', async (c) => {
  const body = z
    .object({ shopName: z.string().min(1), name: z.string().min(1), email: z.string().email(), password: passwordSchema, setupCode: z.string().optional() })
    .parse(await c.req.json());
  const { k } = c.get('db');
  const count = await k.selectFrom('users').select(({ fn }) => fn.countAll().as('n')).executeTakeFirst();
  if (Number(count?.n) > 0) throw new HttpError(409, 'Already set up', 'conflict');
  // Only from the shop computer itself, or with the setup code printed in its console.
  const from = addressKey(clientIp(c));
  await refuseIfLocked(c, [`setup:${from}`]);
  if (setupAccess(c, body.setupCode) === 'refused') {
    await countFailure(c, [{ key: `setup:${from}`, policy: POLICY.setup, what: `Setting up the shop from ${clientIp(c)}` }]);
    await raiseAlert(k, { action: 'setup_refused', summary: `First-time setup was refused from ${clientIp(c)}: it must be done on the shop computer, or with the setup code shown there`, email: false });
    throw new HttpError(403, 'Set-up can only be done on the shop computer, or with the setup code shown in its window.', 'setup_forbidden');
  }
  const user = await k.transaction().execute(async (tx) => {
    // Claiming the flag is atomic: of two set-ups at once, one wins.
    try {
      await tx.insertInto('settings').values({ key: 'setup_done', value: '1' }).execute();
    } catch {
      throw new HttpError(409, 'Already set up', 'conflict');
    }
    await setSetting(tx, 'shop_name', body.shopName);
    const u = await tx
      .insertInto('users')
      .values({
        name: body.name,
        email: body.email.toLowerCase(),
        password_hash: hashPassword(body.password),
        role: 'admin',
        active: 1,
        lang: 'en',
        totp_enabled: 0,
        session_epoch: 0,
        totp_secret: null,
        created_at: nowIso(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await logActivity(tx, u.id, 'create', 'user', u.id, `Set up shop "${body.shopName}" with admin ${body.name}`);
    return u;
  });
  clearSetupCode();
  // The person who set the shop up is the Admin, and was just trusted with that: they may set up their authenticator at once.
  await startSession(c, user, { enrolOk: true });
  return c.json({ ok: true });
});

auth.post('/login', async (c) => {
  const body = z
    .object({ userId: z.number().optional(), email: z.string().optional(), password: z.string() })
    .parse(await c.req.json());
  const { k } = c.get('db');
  let q = k.selectFrom('users').selectAll().where('active', '=', 1);
  if (body.userId) q = q.where('id', '=', body.userId);
  else if (body.email) q = q.where('email', '=', body.email.toLowerCase());
  else throw bad('Choose a user');
  const user = await q.executeTakeFirst();
  // Wrong passwords lock the account (also for names that are not users) and the address for a while.
  const who = accountKey(user, body.email);
  const from = addressKey(clientIp(c));
  await refuseIfLocked(c, [who, from], body.password);
  // Same work whether or not the user exists, so timing doesn't reveal accounts.
  const ok = user ? verifyPassword(body.password, user.password_hash) : (verifyPassword(body.password, (dummyHash ||= hashPassword('x'))), false);
  if (!user || !ok) {
    await logActivity(k, user?.id ?? null, 'login_failed', 'user', user?.id ?? null, `Wrong password for ${user?.name ?? body.email ?? '?'} (from ${clientIp(c)})`);
    await countFailure(c, [
      { key: who, policy: POLICY.account, what: user ? `${user.name}'s account` : `A login name that is not a user (${(body.email ?? '?').slice(0, 60)})` },
      { key: from, policy: POLICY.address, what: `The address ${clientIp(c)}` },
    ]);
    throw new HttpError(401, 'Wrong password', 'bad_credentials');
  }
  await clearThrottle(k, who);
  await startSession(c, user);
  await logActivity(k, user.id, 'login', 'user', user.id, `${user.name} logged in`);
  const s = await getSettings(k);
  const step = needs2fa(user, s.require_2fa === '1') ? (user.totp_enabled ? 'totp' : 'enroll') : 'done';
  return c.json({ step });
});

// ---- Forgot password: no login needed for these two ----
const whoSchema = z.object({ userId: z.number().optional(), email: z.string().optional() });
const findPerson = async (c: Parameters<MiddlewareHandler<AppEnv>>[0], who: z.infer<typeof whoSchema>) => {
  let q = c.get('db').k.selectFrom('users').selectAll().where('active', '=', 1);
  if (who.userId) q = q.where('id', '=', who.userId);
  else if (who.email?.trim()) q = q.where('email', '=', who.email.trim().toLowerCase());
  else throw bad('Choose who forgot their password');
  return q.executeTakeFirst();
};

/** "Forgot password?": emails a code when email is set up, otherwise leaves a request for an Owner. The answer is the same for any name. */
auth.post('/forgot', async (c) => {
  const who = whoSchema.parse(await c.req.json());
  const { k } = c.get('db');
  // Each request counts (it cannot "fail"), per address and per name, so the button cannot be used to flood anyone's inbox or Owners' list.
  const guard = [`forgot-ip:${clientIp(c)}`, `forgot:${who.userId ?? (who.email ?? '').trim().toLowerCase().slice(0, 120)}`];
  await refuseIfLocked(c, guard);
  for (const key of guard) await recordFailure(k, key, POLICY.reset);
  const user = await findPerson(c, who);
  const via = await askForReset(k, user, (await getSettings(k)).shop_name);
  await logActivity(k, user?.id ?? null, 'password_forgot', 'user', user?.id ?? null, user ? `${user.name} asked to reset their password (${via})` : `Password reset asked for someone who is not a user (${who.email ?? who.userId})`);
  return c.json({ ok: true, via });
});

/** The code plus a new password. A wrong code, an old one and an unknown person all get the same answer. */
auth.post('/reset', async (c) => {
  const body = whoSchema.extend({ code: z.string().min(1), password: passwordSchema }).parse(await c.req.json());
  const { k } = c.get('db');
  const user = await findPerson(c, body);
  const guard = [`reset:${user ? `u${user.id}` : `e${(body.email ?? '').trim().toLowerCase().slice(0, 120)}`}`, addressKey(clientIp(c))];
  await refuseIfLocked(c, guard);
  const ok = user ? await k.transaction().execute((tx) => redeem(tx, user, body.code, body.password)) : false;
  if (!user || !ok) {
    await countFailure(c, [
      { key: guard[0], policy: POLICY.code, what: user ? `${user.name}'s password reset codes` : 'A password reset for a name that is not a user' },
      { key: guard[1], policy: POLICY.address, what: `The address ${clientIp(c)}` },
    ]);
    throw new HttpError(400, 'That code did not work or has expired. Ask for a new one.', 'bad_code');
  }
  await clearThrottle(k, guard[0]);
  await tellPasswordChanged(user, (await getSettings(k)).shop_name);
  return c.json({ ok: true });
});

async function partialSession(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const loaded = await loadSession(c);
  if (!loaded) throw new HttpError(401, 'Please log in', 'unauthenticated');
  return loaded;
}

/** Takes a time step for a person. False if that step, or a later one, was already taken: a code is never accepted twice. */
async function takeStep(k: Tx, userId: number, step: number): Promise<boolean> {
  const r = await k
    .updateTable('users')
    .set({ totp_last_step: step })
    .where('id', '=', userId)
    .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', step)]))
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

const codeGuard = (c: Ctx, user: User) => [`code:u${user.id}`, addressKey(clientIp(c))];
const codeFailure = (c: Ctx, user: User, keys: string[]) =>
  countFailure(c, [
    { key: keys[0], policy: POLICY.code, what: `${user.name}'s codes` },
    { key: keys[1], policy: POLICY.address, what: `The address ${clientIp(c)}` },
  ]);

auth.post('/totp/verify', async (c) => {
  const { code } = z.object({ code: z.string() }).parse(await c.req.json());
  const { s, user } = await partialSession(c);
  const { k } = c.get('db');
  const keys = codeGuard(c, user);
  await refuseIfLocked(c, keys);
  const secret = readTotpSecret(c.get('db').secrets, user);
  const step = secret && user.totp_enabled === 1 ? verifyTotpStep(secret, code) : null;
  const fresh = step !== null && (await takeStep(k, user.id, step));
  if (!fresh) {
    await logActivity(k, user.id, 'login_failed', 'user', user.id, `${step !== null ? 'An authenticator code was used a second time for' : 'Wrong authenticator code for'} ${user.name} (from ${clientIp(c)})`);
    await codeFailure(c, user, keys);
    throw new HttpError(401, 'Wrong code', 'bad_totp');
  }
  await clearThrottle(k, keys[0]);
  await k.updateTable('sessions').set({ totp_ok: 1 }).where('id', '=', s.id).execute();
  return c.json({ ok: true });
});

/** A recovery code in place of an authenticator code (lost phone). Works once. */
auth.post('/totp/recover', async (c) => {
  const { code } = z.object({ code: z.string() }).parse(await c.req.json());
  const { s, user } = await partialSession(c);
  const { k } = c.get('db');
  if (user.totp_enabled !== 1) throw bad('There is no authenticator to recover');
  const keys = codeGuard(c, user);
  await refuseIfLocked(c, keys);
  if (!(await useRecoveryCode(k, user.id, code))) {
    await logActivity(k, user.id, 'login_failed', 'user', user.id, `Wrong recovery code for ${user.name} (from ${clientIp(c)})`);
    await codeFailure(c, user, keys);
    throw new HttpError(401, 'That recovery code did not work. Each one works once.', 'bad_recovery');
  }
  await clearThrottle(k, keys[0]);
  await k.updateTable('sessions').set({ totp_ok: 1 }).where('id', '=', s.id).execute();
  const left = await recoveryLeft(k, user.id);
  await raiseAlert(k, { action: 'recovery_used', userId: user.id, summary: `${user.name} logged in with a recovery code (${left} left) from ${clientIp(c)}`, email: true, dedupe: `recovery:${user.id}` });
  return c.json({ ok: true, left });
});

/** Setting up (or replacing) an authenticator needs proof it is really the person: first an enrolment code, or an authenticator already in use. */
const mayEnrol = (s: { enrol_ok: number; totp_ok: number }, user: User) => (user.totp_enabled === 1 ? s.totp_ok === 1 : s.enrol_ok === 1);
const needCode = () => new HttpError(403, 'Enter the one-time enrolment code first. Ask the Admin or an Owner for one, or have one emailed to you.', 'enrol_code_required');

auth.post('/totp/enrol-code', async (c) => {
  const { code } = z.object({ code: z.string() }).parse(await c.req.json());
  const { s, user } = await partialSession(c);
  const { k } = c.get('db');
  const keys = codeGuard(c, user);
  await refuseIfLocked(c, keys);
  if (!(await k.transaction().execute((tx) => redeemEnrolmentCode(tx, user, code)))) {
    await logActivity(k, user.id, 'login_failed', 'user', user.id, `Wrong enrolment code for ${user.name} (from ${clientIp(c)})`);
    await codeFailure(c, user, keys);
    throw new HttpError(400, 'That code did not work or has expired. Ask for a new one.', 'bad_code');
  }
  await clearThrottle(k, keys[0]);
  await k.updateTable('sessions').set({ enrol_ok: 1 }).where('id', '=', s.id).execute();
  return c.json({ ok: true });
});

/** Emails an enrolment code to the address on the account, when email is set up. The answer is the same either way. */
auth.post('/totp/enrol-code/email', async (c) => {
  const { user } = await partialSession(c);
  const { k } = c.get('db');
  const guard = [`enrol-mail-ip:${clientIp(c)}`, `enrol-mail:u${user.id}`];
  await refuseIfLocked(c, guard);
  for (const key of guard) await recordFailure(k, key, POLICY.reset);
  const sent = user.totp_enabled === 1 ? false : await k.transaction().execute(async (tx) => emailEnrolmentCode(tx, user, (await getSettings(tx)).shop_name));
  return c.json({ via: sent ? 'email' : 'admin' });
});

/** First-time setup of an authenticator app. The new secret waits in totp_pending until its first code is confirmed. */
auth.post('/totp/enroll', async (c) => {
  const { s, user } = await partialSession(c);
  if (!mayEnrol(s, user)) throw needCode();
  const secret = newTotpSecret();
  await c.get('db').k.updateTable('users').set({ totp_pending: sealTotpSecret(c.get('db').secrets, user.id, secret, 'totp_pending') }).where('id', '=', user.id).execute();
  const shop = (await getSettings(c.get('db').k)).shop_name;
  const uri = `otpauth://totp/${encodeURIComponent(`Commercia (${shop})`)}:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Commercia`;
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return c.json({ secret, uri, qr });
});

auth.post('/totp/confirm', async (c) => {
  const { code } = z.object({ code: z.string() }).parse(await c.req.json());
  const { s, user } = await partialSession(c);
  if (!mayEnrol(s, user)) throw needCode();
  const { k, secrets } = c.get('db');
  const keys = codeGuard(c, user);
  await refuseIfLocked(c, keys);
  const pending = readTotpSecret(secrets, user, 'totp_pending');
  const step = pending ? verifyTotpStep(pending, code) : null;
  if (!pending || step === null) {
    await codeFailure(c, user, keys);
    throw new HttpError(400, 'That code did not match', 'bad_totp');
  }
  await clearThrottle(k, keys[0]);
  const recoveryCodes = await k.transaction().execute(async (tx) => {
    await tx.updateTable('users').set({ totp_secret: sealTotpSecret(secrets, user.id, pending), totp_pending: null, totp_enabled: 1, totp_last_step: step }).where('id', '=', user.id).execute();
    await tx.updateTable('sessions').set({ totp_ok: 1 }).where('id', '=', s.id).execute();
    await raiseAlert(tx, { action: 'totp_enrolled', userId: user.id, summary: `${user.name} set up an authenticator` });
    return makeRecoveryCodes(tx, user.id);
  });
  return c.json({ ok: true, recoveryCodes });
});

auth.post('/logout', async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await c.get('db').k.deleteFrom('sessions').where('id', '=', sha256(token)).execute();
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ---- Routes below need a full login ----
export const account = new Hono<AppEnv>();

account.get('/me', (c) => c.json(publicUser(c.get('user'))));

account.post('/logout-all', async (c) => {
  const user = c.get('user');
  const { k } = c.get('db');
  await k.updateTable('users').set({ session_epoch: user.session_epoch + 1 }).where('id', '=', user.id).execute();
  await logActivity(k, user.id, 'update', 'user', user.id, `${user.name} signed out of all devices`);
  return c.json({ ok: true });
});

account.post('/password', async (c) => {
  const body = z.object({ current: z.string(), next: passwordSchema }).parse(await c.req.json());
  const user = c.get('user');
  if (!verifyPassword(body.current, user.password_hash)) throw new HttpError(400, 'Current password is wrong', 'bad_credentials');
  const { k } = c.get('db');
  await k.updateTable('users').set({ password_hash: hashPassword(body.next) }).where('id', '=', user.id).execute();
  await logActivity(k, user.id, 'update', 'user', user.id, `${user.name} changed their password`);
  return c.json({ ok: true });
});

/** What the person can see about their own sign-in security. */
account.get('/security', async (c) => {
  const user = c.get('user');
  return c.json({ totpEnabled: user.totp_enabled === 1, recoveryLeft: await recoveryLeft(c.get('db').k, user.id) });
});

/** New recovery codes (the old ones stop working). Needs the password again, and is only for someone who has an authenticator. */
account.post('/recovery-codes', async (c) => {
  const { password } = z.object({ password: z.string() }).parse(await c.req.json());
  const user = c.get('user');
  const { k } = c.get('db');
  if (user.totp_enabled !== 1) throw bad('Set up an authenticator first');
  const keys = [accountKey(user), addressKey(clientIp(c))];
  await refuseIfLocked(c, keys, password);
  if (!verifyPassword(password, user.password_hash)) {
    await countFailure(c, [{ key: keys[0], policy: POLICY.account, what: `${user.name}'s account` }, { key: keys[1], policy: POLICY.address, what: `The address ${clientIp(c)}` }]);
    throw new HttpError(400, 'Wrong password', 'bad_credentials');
  }
  const codes = await k.transaction().execute((tx) => makeRecoveryCodes(tx, user.id));
  await logActivity(k, user.id, 'update', 'user', user.id, `${user.name} made new recovery codes`);
  return c.json({ recoveryCodes: codes });
});

account.post('/lang', async (c) => {
  const { lang } = z.object({ lang: z.enum(['en', 'hi']) }).parse(await c.req.json());
  const user = c.get('user');
  await c.get('db').k.updateTable('users').set({ lang }).where('id', '=', user.id).execute();
  return c.json({ ok: true });
});

// ---- People (AUTH-4) ----
export const users = new Hono<AppEnv>();

users.get('/', async (c) => {
  await need(c, 'users.manage');
  const rows = await c.get('db').k.selectFrom('users').selectAll().orderBy('id').execute();
  return c.json(rows.map(publicUser));
});

const roleSchema = z.enum(['admin', 'owner', 'entry']);

/** People who tapped "Forgot password?" and are waiting for an Owner. */
users.get('/password-requests', async (c) => {
  const actor = await need(c, 'users.manage');
  return c.json(await pendingRequests(c.get('db').k, actor));
});

users.post('/password-requests/:id/dismiss', async (c) => {
  const actor = await need(c, 'users.manage');
  const id = Number(c.req.param('id'));
  const { k } = c.get('db');
  const req = (await pendingRequests(k, actor)).find((r) => r.id === id);
  if (!req) throw new HttpError(404, 'Request not found', 'not_found');
  await k.updateTable('password_resets').set({ dismissed: 1 }).where('id', '=', id).execute();
  await logActivity(k, actor.id, 'update', 'password_reset', req.userId, `${actor.name} dismissed ${req.name}'s password request`);
  return c.json({ ok: true });
});

function guardAdmin(actor: User, targetRole: Role | undefined) {
  if (targetRole === 'admin' && actor.role !== 'admin') throw new HttpError(403, 'Only the Admin can manage Admin accounts', 'forbidden');
}

users.post('/', async (c) => {
  const actor = await need(c, 'users.manage');
  const body = z
    .object({ name: z.string().min(1), email: z.string().email(), role: roleSchema, password: passwordSchema })
    .parse(await c.req.json());
  guardAdmin(actor, body.role);
  const { k } = c.get('db');
  const exists = await k.selectFrom('users').select('id').where('email', '=', body.email.toLowerCase()).executeTakeFirst();
  if (exists) throw new HttpError(409, 'Someone already uses this email', 'conflict');
  const u = await k
    .insertInto('users')
    .values({
      name: body.name,
      email: body.email.toLowerCase(),
      role: body.role,
      password_hash: hashPassword(body.password),
      active: 1,
      lang: 'en',
      totp_enabled: 0,
      totp_secret: null,
      session_epoch: 0,
      created_at: nowIso(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await logActivity(k, actor.id, 'create', 'user', u.id, `Added ${u.name} as ${u.role}`);
  return c.json(publicUser(u));
});

/** A one-time code to read out to someone who forgot their password. Shown once, works for an hour. */
users.post('/:id/reset-code', async (c) => {
  const actor = await need(c, 'users.manage');
  const { k } = c.get('db');
  const target = await k.selectFrom('users').selectAll().where('id', '=', Number(c.req.param('id'))).executeTakeFirst();
  if (!target) throw new HttpError(404, 'User not found', 'not_found');
  guardAdmin(actor, target.role);
  if (target.active !== 1) throw bad('This person is deactivated');
  const { code, expiresAt } = await k.transaction().execute((tx) => issueCode(tx, actor, target));
  return c.json({ code, expiresAt, name: target.name });
});

/** A one-time code that lets someone set up their authenticator. Shown once, works for a day. */
users.post('/:id/enrolment-code', async (c) => {
  const actor = await need(c, 'users.manage');
  const { k } = c.get('db');
  const target = await k.selectFrom('users').selectAll().where('id', '=', Number(c.req.param('id'))).executeTakeFirst();
  if (!target) throw new HttpError(404, 'User not found', 'not_found');
  guardAdmin(actor, target.role);
  if (target.active !== 1) throw bad('This person is deactivated');
  if (target.totp_enabled === 1) throw bad('This person already has an authenticator. Use "Reset authenticator" if their phone is lost.');
  return c.json({ ...(await k.transaction().execute((tx) => issueEnrolmentCode(tx, actor, target))), name: target.name });
});

users.patch('/:id', async (c) => {
  const actor = await need(c, 'users.manage');
  const id = Number(c.req.param('id'));
  const body = z
    .object({
      name: z.string().min(1).optional(),
      role: roleSchema.optional(),
      active: z.boolean().optional(),
      password: passwordSchema.optional(),
      resetTotp: z.boolean().optional(),
      signOutAll: z.boolean().optional(),
    })
    .parse(await c.req.json());
  const { k } = c.get('db');
  const target = await k.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  if (!target) throw new HttpError(404, 'User not found', 'not_found');
  guardAdmin(actor, target.role);
  guardAdmin(actor, body.role);
  if (target.id === actor.id && (body.active === false || (body.role && body.role !== actor.role))) {
    throw bad("You can't deactivate yourself or change your own role");
  }
  const patch: Partial<User> = {};
  const notes: string[] = [];
  if (body.name) patch.name = body.name;
  if (body.role && body.role !== target.role) {
    patch.role = body.role;
    notes.push(`role ${target.role} → ${body.role}`);
  }
  if (body.active !== undefined && (body.active ? 1 : 0) !== target.active) {
    patch.active = body.active ? 1 : 0;
    notes.push(body.active ? 'reactivated' : 'deactivated');
  }
  if (body.password) {
    patch.password_hash = hashPassword(body.password);
    notes.push('password reset');
  }
  if (body.resetTotp) {
    patch.totp_enabled = 0;
    patch.totp_secret = null;
    patch.totp_pending = null;
    patch.totp_last_step = null;
    notes.push('authenticator reset');
  }
  if (body.active === false) await voidEnrolmentCodes(k, id);
  if (body.active === false || body.password || body.signOutAll || body.role) {
    patch.session_epoch = target.session_epoch + 1;
    if (body.signOutAll) notes.push('signed out of all devices');
  }
  if (Object.keys(patch).length) await k.updateTable('users').set(patch).where('id', '=', id).execute();
  await logActivity(k, actor.id, 'update', 'user', id, `Updated ${target.name}: ${notes.join(', ') || 'details'}`);
  const u = await k.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  // Setting up an authenticator again needs an enrolment code, so a reset does not leave the door open to whoever knows the password.
  let enrolment: { code: string; expiresAt: string } | null = null;
  if (body.resetTotp) {
    enrolment = await k.transaction().execute(async (tx) => {
      await voidRecoveryCodes(tx, id);
      await raiseAlert(tx, { action: 'totp_reset', userId: actor.id, entityId: id, summary: `${actor.name} reset the authenticator of ${target.name}`, email: true, dedupe: `totp_reset:${id}` });
      return issueEnrolmentCode(tx, actor, u);
    });
  }
  return c.json({ ...publicUser(u), enrolment });
});
