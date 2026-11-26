// Utilidades comunes: errores HTTP, respuestas, hora de Madrid y base de datos.
import crypto from 'node:crypto';

/* ------------------------------ HTTP ------------------------------ */
export class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      ...headers
    }
  });
}

export async function readJson(request, maxBytes = 20000) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'bad_json'); }
}

export function clientIp(request) {
  const h = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || '';
  return h.split(',')[0].trim() || 'local';
}

export function hashIp(ip) {
  const salt = process.env.SESSION_SECRET || 'sin-secreto';
  return crypto.createHmac('sha256', salt).update(String(ip)).digest('hex').slice(0, 32);
}

export function origin(request) {
  const u = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto') || u.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || u.host;
  return `${proto}://${host}`;
}

/* --------------------------- Hora de Madrid --------------------------- */
const TZ = 'Europe/Madrid';
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

/** Fecha y hora de pared en Madrid para un instante dado. */
export function madrid(date = new Date()) {
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Minutos de reloj de pared (sirve para comparar y sumar dentro de Madrid). */
export function wall(day, time = '00:00') {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) / 60000;
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Día de la semana: 1 = lunes … 7 = domingo. */
export function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Instante real (UTC) en que empieza una hora de Madrid. */
export function slotInstant(day, time) {
  const target = wall(day, time);
  let guess = new Date(target * 60000);
  for (let i = 0; i < 3; i++) {
    const m = madrid(guess);
    const diff = target - wall(m.day, m.time);
    if (!diff) break;
    guess = new Date(guess.getTime() + diff * 60000);
  }
  return guess;
}

export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/* --------------------------- Base de datos --------------------------- */
export const SCHEMA = `
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  role text not null default 'gestor' check (role in ('titular','gestor')),
  pass_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create table if not exists overrides (
  day text not null,
  time text not null default '',
  open boolean not null,
  note text,
  created_by text,
  created_at timestamptz not null default now(),
  primary key (day, time)
);
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  day text not null,
  time text not null,
  starts_at timestamptz not null,
  mode text not null check (mode in ('presencial','video','telefono')),
  name text not null,
  phone text not null,
  email text not null default '',
  lang text not null default 'es',
  note text,
  status text not null check (status in ('hold','confirmed','cancelled','expired','refunded')),
  source text not null default 'web' check (source in ('web','manual')),
  payment text not null default 'stripe' check (payment in ('stripe','manual','none')),
  amount_cents integer,
  currency text,
  stripe_session_id text unique,
  stripe_payment_intent text,
  hold_expires_at timestamptz,
  release_key text,
  consent_at timestamptz,
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  flag text
);
create unique index if not exists bookings_one_active_per_slot
  on bookings (day, time) where status in ('hold','confirmed');
create index if not exists bookings_day on bookings (day);
create table if not exists audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  booking_id uuid,
  detail jsonb
);
alter table bookings add column if not exists tax_id text;
alter table bookings add column if not exists bill_address text;
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('F','R')),
  series text not null,
  number integer not null,
  code text not null unique,
  booking_id uuid not null,
  rectifies uuid,
  issued_on text not null,
  total_cents integer not null,
  base_cents integer not null,
  vat_cents integer not null,
  vat_bp integer not null,
  simplified boolean not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  send_error text,
  unique (series, number),
  unique (booking_id, kind)
);
alter table invoices alter column booking_id drop not null;
alter table invoices add column if not exists origin text not null default 'web';
alter table invoices add column if not exists irpf_bp integer not null default 0;
alter table invoices add column if not exists irpf_cents integer not null default 0;
alter table invoices add column if not exists paid_on text;
alter table invoices add column if not exists created_by text;
create unique index if not exists invoices_one_rectification on invoices (rectifies) where rectifies is not null;
create index if not exists invoices_issued_on on invoices (issued_on);
alter table invoices add column if not exists vf_state text;
alter table invoices add column if not exists vf_env text;
alter table invoices add column if not exists vf_deliver boolean not null default false;
alter table invoices add column if not exists vf_uuid text;
alter table invoices add column if not exists vf_url text;
alter table invoices add column if not exists vf_qr text;
alter table invoices add column if not exists vf_hash text;
alter table invoices add column if not exists vf_error text;
alter table invoices add column if not exists vf_tries integer not null default 0;
alter table invoices add column if not exists vf_rev integer not null default 0;
alter table invoices add column if not exists vf_claimed_at timestamptz;
alter table invoices add column if not exists vf_sent_at timestamptz;
alter table invoices add column if not exists vf_checked_at timestamptz;
alter table invoices add column if not exists vf_registered_at timestamptz;
create index if not exists invoices_vf_state on invoices (vf_state) where vf_state is not null;
create table if not exists login_attempts (
  id bigserial primary key,
  at timestamptz not null default now(),
  email text,
  ip_hash text,
  ok boolean not null
);
`;

let db = null;        // { query(sql, params) -> { rows, rowCount } }
let dbReady = null;

/** Para pruebas: inyecta una base de datos ya abierta. */
export function useDb(adapter) { db = adapter; dbReady = Promise.resolve(adapter); }

export function dbConfigured() {
  return Boolean(db || process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

async function connect() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new HttpError(503, 'db_missing');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  pool.on('error', () => { /* una conexión inactiva cerrada por el servidor no debe tumbar la función */ });
  await pool.query(SCHEMA);
  db = { query: (sql, params) => pool.query(sql, params) };
  return db;
}

export async function q(sql, params = []) {
  if (!dbReady) dbReady = connect().catch((e) => { dbReady = null; throw e; });
  const d = await dbReady;
  const r = await d.query(sql, params);
  return { rows: r.rows || [], rowCount: r.rowCount ?? r.affectedRows ?? (r.rows ? r.rows.length : 0) };
}

export const isUniqueViolation = (e) => e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message || ''));

export async function audit(actor, action, bookingId, detail) {
  await q('insert into audit (actor, action, booking_id, detail) values ($1, $2, $3, $4)',
    [actor, action, bookingId || null, detail ? JSON.stringify(detail) : null]);
}

/* ----------------------------- Ajustes ----------------------------- */
const AM = ['09:00', '10:00', '11:00', '12:00', '13:00'];
const PM = ['16:00', '17:00', '18:00'];
export const DEFAULTS = {
  schedule: { 1: [...AM, ...PM], 2: [...AM, ...PM], 3: [...AM, ...PM], 4: [...AM, ...PM], 5: [...AM, ...PM], 6: [], 7: [] },
  minNoticeHours: 12,
  maxDaysAhead: 60,
  durationMin: 60,
  currency: 'eur',
  modes: {
    presencial: { enabled: true, priceCents: null },
    video: { enabled: true, priceCents: null },
    telefono: { enabled: true, priceCents: null }
  },
  policy: '',
  // Facturación: no se expide nada hasta que la titular la active y complete sus datos fiscales.
  invoice: {
    enabled: false,
    series: 'A',
    vatBp: 2100,
    copyTo: '',
    payNote: '',
    issuer: { name: '', taxId: '', address: '', extra: '', contact: '' }
  },
  // VERI*FACTU: apagado hasta que haya clave del proveedor y, en real, declaración responsable suscrita.
  verifactu: {
    enabled: false,
    producer: { name: '', taxId: '', address: '', contact: '' },
    place: '',
    signedOn: ''
  }
};
export const HOLD_MINUTES = 31;   // Stripe exige que la sesión de pago dure al menos 30 minutos

export async function getSettings() {
  const { rows } = await q('select key, value from settings');
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  for (const r of rows) {
    const v = r.value;   // el controlador ya entrega el jsonb interpretado (un texto llega como texto)
    if (r.key === 'modes') for (const k of Object.keys(s.modes)) s.modes[k] = { ...s.modes[k], ...(v[k] || {}) };
    else if (r.key === 'invoice') s.invoice = { ...s.invoice, ...v, issuer: { ...s.invoice.issuer, ...((v && v.issuer) || {}) } };
    else if (r.key === 'verifactu') s.verifactu = { ...s.verifactu, ...v, producer: { ...s.verifactu.producer, ...((v && v.producer) || {}) } };
    else if (r.key in s) s[r.key] = v;
  }
  return s;
}

export async function saveSetting(key, value) {
  await q(`insert into settings (key, value, updated_at) values ($1, $2, now())
           on conflict (key) do update set value = excluded.value, updated_at = now()`, [key, JSON.stringify(value)]);
}
