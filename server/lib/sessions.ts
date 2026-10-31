// Sessions: the cookie, the row behind it, and which devices a person has used.
//
// The cookie holds a random token; the database holds only its hash. Over https it is named "__Host-commercia_session",
// which a browser only accepts if it is Secure, has Path=/ and names no domain: another site or subdomain cannot plant or
// replace it. It is HttpOnly (scripts cannot read it) and SameSite=Strict (another site cannot make the browser send it).
// A new token is issued at login, again when the second step is passed, and when the password changes, so a token that
// leaked earlier, or was planted before login, is worth nothing afterwards.
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { nowIso } from '../db/index';
import type { Ctx, Tx } from './core';
import { randomToken, sha256 } from './crypto';
import { clientIp, isHttps } from './proxy';
import { raiseAlert } from './alerts';
import { mailConfigured, sendMail } from './mailer';
import { getSettings } from './settings';
import type { User } from '../db/schema';

const PLAIN = 'commercia_session';
const SECURE = '__Host-commercia_session';
const DEVICE_PLAIN = 'commercia_device';
const DEVICE_SECURE = '__Host-commercia_device';
export const IDLE_MS = 12 * 3600_000;
export const ABSOLUTE_MS = 30 * 24 * 3600_000;
const DEVICE_MAX_AGE = 400 * 24 * 3600; // a browser's own limit for cookies

/** The session token the browser sent, from whichever of the two cookie names it has. */
export function readSessionToken(c: Context): string | undefined {
  return getCookie(c, SECURE) ?? getCookie(c, PLAIN);
}

const cookieOptions = (c: Context, maxAge: number) => ({ httpOnly: true, sameSite: 'Strict' as const, path: '/', secure: isHttps(c), maxAge });

export function setSessionCookie(c: Context, token: string) {
  const secure = isHttps(c);
  setCookie(c, secure ? SECURE : PLAIN, token, cookieOptions(c, ABSOLUTE_MS / 1000));
  // A cookie of the other kind (left over from before https was used) must not linger.
  if (secure) deleteCookie(c, PLAIN, { path: '/' });
}

export function clearSessionCookies(c: Context) {
  deleteCookie(c, PLAIN, { path: '/' });
  deleteCookie(c, SECURE, { path: '/', secure: true });
}

/** "Chrome on Windows": enough for a person to recognise their own devices. */
export function deviceLabel(ua: string | undefined): string {
  const u = ua ?? '';
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'A browser';
  const os = /Android/.test(u) ? 'Android' : /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Windows/.test(u) ? 'Windows' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Has this browser logged in to this account before? A long-lived cookie tells the browsers apart. A first login to
 * an account is just recorded; a new device after that is logged (and, for an Owner or the Admin, emailed to them).
 */
async function noteDevice(c: Context, k: Tx, user: User): Promise<{ hash: string; remember: () => void }> {
  const secure = isHttps(c);
  let id = getCookie(c, secure ? DEVICE_SECURE : DEVICE_PLAIN) ?? getCookie(c, DEVICE_PLAIN);
  const known = !!id;
  if (!id) id = randomToken();
  const remember = () => setCookie(c, secure ? DEVICE_SECURE : DEVICE_PLAIN, id!, cookieOptions(c, DEVICE_MAX_AGE));
  const hash = sha256(id);
  const label = deviceLabel(c.req.header('user-agent'));
  const ip = clientIp(c);
  const row = await k.selectFrom('known_devices').select('id').where('user_id', '=', user.id).where('device_hash', '=', hash).executeTakeFirst();
  if (row) {
    await k.updateTable('known_devices').set({ last_seen: nowIso(), last_ip: ip, label }).where('id', '=', row.id).execute();
    return { hash, remember };
  }
  const others = await k.selectFrom('known_devices').select('id').where('user_id', '=', user.id).executeTakeFirst();
  await k.insertInto('known_devices').values({ user_id: user.id, device_hash: hash, label, first_seen: nowIso(), last_seen: nowIso(), last_ip: ip }).execute();
  if (others || known) {
    await raiseAlert(k, { action: 'login_new_device', userId: user.id, summary: `${user.name} logged in from a new device: ${label} (${ip})` });
    if (user.role !== 'entry' && mailConfigured()) {
      try {
        const shop = (await getSettings(k)).shop_name;
        await sendMail({ to: user.email, subject: `${shop}: a new device logged in to your Commercia account`, text: `Hello ${user.name},\n\nYour Commercia account was just used from a new device: ${label}, address ${ip}.\n\nIf this was you, nothing to do. If not, change your password now and tell the shop Admin.\n` });
      } catch (e) {
        console.error('Could not send the new-device email:', e instanceof Error ? e.message : e);
      }
    }
  }
  return { hash, remember };
}

export interface NewSession {
  totpOk?: boolean;
  enrolOk?: boolean;
  reauthUntil?: string | null;
}

/** Makes a session for the person and sets its cookie. Any session this browser already had is ended first. */
export async function createSession(c: Ctx, user: User, opts: NewSession = {}, noteNewDevice = true): Promise<string> {
  const { k } = c.get('db');
  const old = readSessionToken(c);
  if (old) await k.deleteFrom('sessions').where('id', '=', sha256(old)).execute();
  const token = randomToken();
  const now = Date.now();
  const device = noteNewDevice ? await noteDevice(c, k, user) : null;
  await k
    .insertInto('sessions')
    .values({
      id: sha256(token),
      user_id: user.id,
      epoch: user.session_epoch,
      totp_ok: opts.totpOk ? 1 : 0,
      enrol_ok: opts.enrolOk ? 1 : 0,
      reauth_until: opts.reauthUntil ?? null,
      ip: clientIp(c),
      device: deviceLabel(c.req.header('user-agent')),
      ua_hash: device?.hash ?? '',
      created_at: new Date(now).toISOString(),
      last_seen: new Date(now).toISOString(),
      expires_at: new Date(now + ABSOLUTE_MS).toISOString(),
    })
    .execute();
  setSessionCookie(c, token); // the session cookie first, then the device cookie
  device?.remember();
  return sha256(token);
}

/** The same session under a new token (and the old token ends), for when something about it just became more trusted or the password changed. */
export async function rotateSession(c: Ctx, user: User, session: { id: string; totp_ok: number; enrol_ok: number; reauth_until: string | null; ua_hash: string }): Promise<string> {
  const { k } = c.get('db');
  const token = randomToken();
  const now = Date.now();
  const old = await k.selectFrom('sessions').selectAll().where('id', '=', session.id).executeTakeFirst();
  await k.deleteFrom('sessions').where('id', '=', session.id).execute();
  await k
    .insertInto('sessions')
    .values({
      id: sha256(token),
      user_id: user.id,
      epoch: user.session_epoch,
      totp_ok: session.totp_ok,
      enrol_ok: session.enrol_ok,
      reauth_until: session.reauth_until,
      ip: clientIp(c),
      device: deviceLabel(c.req.header('user-agent')),
      ua_hash: session.ua_hash,
      created_at: old?.created_at ?? new Date(now).toISOString(),
      last_seen: new Date(now).toISOString(),
      expires_at: old?.expires_at ?? new Date(now + ABSOLUTE_MS).toISOString(),
    })
    .execute();
  setSessionCookie(c, token);
  return sha256(token);
}
