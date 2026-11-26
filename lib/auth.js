// Cuentas del panel: contraseñas con scrypt y sesión en cookie firmada.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, q, hashIp, clientIp, audit, sessionSecret } from './core.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'ia_panel';
const SESSION_HOURS = 8;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64'), 64);
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

async function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', await sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

async function unsign(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', await sessionSecret()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function cookieHeader(value, maxAge, secure = true) {
  return `${COOKIE}=${value}; Path=/api; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Max-Age=${maxAge}`;
}
// En producción siempre es HTTPS; solo el servidor local de pruebas va sin «Secure».
const isHttps = (request) => (request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '')) === 'https';

export function readCookie(request) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/** Devuelve la cuenta que ha iniciado sesión o lanza 401. */
export async function requireAdmin(request) {
  const p = await unsign(readCookie(request));
  if (!p) throw new HttpError(401, 'not_logged_in');
  const { rows } = await q('select id, email, name, role from admins where id = $1', [p.uid]);
  if (!rows[0]) throw new HttpError(401, 'not_logged_in');
  return rows[0];
}

/** Las acciones que cambian datos exigen esta cabecera: un formulario de otro sitio no puede enviarla. */
export function requirePanelHeader(request) {
  if (request.headers.get('x-panel') !== '1') throw new HttpError(403, 'forbidden');
}

export async function login(request, { email, password }) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  const ip = await hashIp(clientIp(request));
  const recent = await q(
    `select count(*)::int as n from login_attempts
      where ok = false and at > now() - interval '15 minutes' and (email = $1 or ip_hash = $2)`, [email, ip]);
  if (recent.rows[0].n >= 5) throw new HttpError(429, 'too_many_attempts');
  const { rows } = await q('select * from admins where email = $1', [email]);
  const admin = rows[0];
  // Se calcula siempre un hash para que el tiempo de respuesta no revele si el correo existe.
  const ok = admin ? await verifyPassword(password, admin.pass_hash)
    : (await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '=='), false);
  await q('insert into login_attempts (email, ip_hash, ok) values ($1, $2, $3)', [email, ip, ok]);
  if (!ok) throw new HttpError(401, 'bad_credentials');
  await q('update admins set last_login_at = now() where id = $1', [admin.id]);
  await audit(admin.email, 'login', null, null);
  const token = await sign({ uid: admin.id, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  return { admin: { email: admin.email, name: admin.name, role: admin.role }, cookie: cookieHeader(token, SESSION_HOURS * 3600, isHttps(request)) };
}

export function logoutCookie(request) { return cookieHeader('', 0, isHttps(request)); }

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'weak_password');
}

/** Alta de cuentas. Solo funciona mientras exista PANEL_SETUP_CODE en el servidor y coincida. */
export async function setupAccount({ code, name, email, password, role }) {
  const expected = process.env.PANEL_SETUP_CODE || '';
  if (expected.length < 8) throw new HttpError(403, 'setup_closed');
  const a = Buffer.from(String(code || '')), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'bad_setup_code');
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || name.length < 2) throw new HttpError(400, 'bad_account');
  checkPassword(password);
  role = role === 'titular' ? 'titular' : 'gestor';
  const count = await q('select count(*)::int as n from admins');
  const exists = await q('select id from admins where email = $1', [email]);
  if (!exists.rows[0] && count.rows[0].n >= 4) throw new HttpError(400, 'too_many_accounts');
  const hash = await hashPassword(password);
  await q(`insert into admins (email, name, role, pass_hash) values ($1, $2, $3, $4)
           on conflict (email) do update set name = excluded.name, role = excluded.role, pass_hash = excluded.pass_hash`,
    [email, name, role, hash]);
  await audit(email, exists.rows[0] ? 'account_reset' : 'account_created', null, { role });
  return { email, name, role };
}

export async function changePassword(admin, { current, next }) {
  checkPassword(next);
  const { rows } = await q('select pass_hash from admins where id = $1', [admin.id]);
  if (!rows[0] || !(await verifyPassword(String(current || ''), rows[0].pass_hash))) throw new HttpError(401, 'bad_credentials');
  await q('update admins set pass_hash = $1 where id = $2', [await hashPassword(next), admin.id]);
  await audit(admin.email, 'password_changed', null, null);
}
