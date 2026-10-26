import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppEnv } from '../lib/core';
import { HttpError, bad, logActivity, need } from '../lib/core';
import { hashPassword, newTotpSecret, randomToken, sha256, verifyPassword, verifyTotp } from '../lib/crypto';
import { nowIso } from '../db/index';
import { getSettings, setSetting } from '../lib/settings';
import { AttemptLimiter } from '../lib/rateLimit';
import { clientIp, isHttps } from '../lib/proxy';
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

async function startSession(c: Parameters<MiddlewareHandler<AppEnv>>[0], user: User) {
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

// 5 wrong passwords in 15 minutes lock the account for 15 minutes; 30 from one address lock that address. 5 wrong authenticator codes lock the codes.
const loginAccount = new AttemptLimiter(5, 15 * 60_000, 15 * 60_000);
const loginAddress = new AttemptLimiter(30, 15 * 60_000, 15 * 60_000);
const codeAttempts = new AttemptLimiter(5, 10 * 60_000, 15 * 60_000);

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
  return c.json({
    setupNeeded: users.length === 0,
    shop: { name: s.shop_name, nameHi: s.shop_name_hi, address: s.shop_address, gstin: s.shop_gstin },
    defaultLang: s.default_lang,
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    me,
    step,
  });
});

auth.post('/setup', async (c) => {
  const body = z
    .object({ shopName: z.string().min(1), name: z.string().min(1), email: z.string().email(), password: passwordSchema })
    .parse(await c.req.json());
  const { k } = c.get('db');
  const count = await k.selectFrom('users').select(({ fn }) => fn.countAll().as('n')).executeTakeFirst();
  if (Number(count?.n) > 0) throw new HttpError(409, 'Already set up', 'conflict');
  await setSetting(k, 'shop_name', body.shopName);
  const user = await k
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
  await logActivity(k, user.id, 'create', 'user', user.id, `Set up shop "${body.shopName}" with admin ${body.name}`);
  await startSession(c, user);
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
  const who = `login:${user?.id ?? `?${(body.email ?? '').toLowerCase()}`}`;
  const from = `login-ip:${clientIp(c)}`;
  loginAccount.check(who);
  loginAddress.check(from);
  // Same work whether or not the user exists, so timing doesn't reveal accounts.
  const ok = user ? verifyPassword(body.password, user.password_hash) : (verifyPassword(body.password, hashPassword('x')), false);
  if (!user || !ok) {
    loginAccount.fail(who);
    loginAddress.fail(from);
    await logActivity(k, user?.id ?? null, 'login_failed', 'user', user?.id ?? null, `Wrong password for ${user?.name ?? body.email ?? '?'}`);
    throw new HttpError(401, 'Wrong password', 'bad_credentials');
  }
  loginAccount.clear(who);
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
  const ok = user ? await k.transaction().execute((tx) => redeem(tx, user, body.code, body.password)) : false;
  if (!user || !ok) throw new HttpError(400, 'That code did not work or has expired. Ask for a new one.', 'bad_code');
  await tellPasswordChanged(user, (await getSettings(k)).shop_name);
  return c.json({ ok: true });
});

async function partialSession(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const loaded = await loadSession(c);
  if (!loaded) throw new HttpError(401, 'Please log in', 'unauthenticated');
  return loaded;
}

auth.post('/totp/verify', async (c) => {
  const { code } = z.object({ code: z.string() }).parse(await c.req.json());
  const { s, user } = await partialSession(c);
  codeAttempts.check(`code:${user.id}`);
  if (!user.totp_secret || user.totp_enabled !== 1 || !verifyTotp(user.totp_secret, code)) {
    codeAttempts.fail(`code:${user.id}`);
    await logActivity(c.get('db').k, user.id, 'login_failed', 'user', user.id, `Wrong authenticator code for ${user.name}`);
    throw new HttpError(401, 'Wrong code', 'bad_totp');
  }
  codeAttempts.clear(`code:${user.id}`);
  await c.get('db').k.updateTable('sessions').set({ totp_ok: 1 }).where('id', '=', s.id).execute();
  return c.json({ ok: true });
});

/** First-time setup of an authenticator app. */
auth.post('/totp/enroll', async (c) => {
  const { s, user } = await partialSession(c);
  if (user.totp_enabled === 1 && s.totp_ok !== 1) throw new HttpError(403, 'Enter your current code first', 'forbidden');
  const secret = newTotpSecret();
  await c.get('db').k.updateTable('users').set({ totp_secret: secret }).where('id', '=', user.id).execute();
  const shop = (await getSettings(c.get('db').k)).shop_name;
  const uri = `otpauth://totp/${encodeURIComponent(`Commercia (${shop})`)}:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Commercia`;
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return c.json({ secret, uri, qr });
});

auth.post('/totp/confirm', async (c) => {
  const { code } = z.object({ code: z.string() }).parse(await c.req.json());
  const { s, user } = await partialSession(c);
  codeAttempts.check(`code:${user.id}`);
  if (!user.totp_secret || !verifyTotp(user.totp_secret, code)) {
    codeAttempts.fail(`code:${user.id}`);
    throw new HttpError(400, 'That code did not match', 'bad_totp');
  }
  codeAttempts.clear(`code:${user.id}`);
  const { k } = c.get('db');
  await k.updateTable('users').set({ totp_enabled: 1 }).where('id', '=', user.id).execute();
  await k.updateTable('sessions').set({ totp_ok: 1 }).where('id', '=', s.id).execute();
  await logActivity(k, user.id, 'update', 'user', user.id, `${user.name} turned on authenticator codes`);
  return c.json({ ok: true });
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
    notes.push('authenticator reset');
  }
  if (body.active === false || body.password || body.signOutAll || body.role) {
    patch.session_epoch = target.session_epoch + 1;
    if (body.signOutAll) notes.push('signed out of all devices');
  }
  if (Object.keys(patch).length) await k.updateTable('users').set(patch).where('id', '=', id).execute();
  await logActivity(k, actor.id, 'update', 'user', id, `Updated ${target.name}: ${notes.join(', ') || 'details'}`);
  const u = await k.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  return c.json(publicUser(u));
});
