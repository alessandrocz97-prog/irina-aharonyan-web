// VERI*FACTU: cada factura se registra en la AEAT antes de salir hacia el cliente.
// El panel expide la factura; el proveedor (Verifacti, colaborador social de la AEAT) genera el registro
// de facturación, lo encadena, lo remite a la AEAT y devuelve el QR. Aquí solo vive la conexión:
// qué se envía, en qué orden, qué pasa si falla y cómo se consulta el resultado.
// La clave del proveedor está en la variable de entorno VERIFACTI_API_KEY (vf_test_… o vf_prod_…).
import { q } from './core.js';

/** Identidad de este programa para su declaración responsable. Cada cambio en la facturación es una versión nueva. */
export const SIF = { name: 'Panel de reservas y facturación', code: 'IA', version: '1.0.0' };

const API = 'https://api.verifacti.com';
let fake = null;

/** Para pruebas: sustituye al proveedor. fn({ method, path, body, headers }) -> { status, data }. */
export function useVerifactu(fn, mode = 'test') { fake = fn ? { fn, mode } : null; }

/** 'prod', 'test' o null si no hay clave. Solo se mira el prefijo: la clave nunca sale del servidor. */
export function vfMode() {
  if (fake) return fake.mode;
  const k = process.env.VERIFACTI_API_KEY || '';
  return k.startsWith('vf_prod_') ? 'prod' : k.startsWith('vf_test_') ? 'test' : null;
}

async function call(method, path, body, headers = {}, anonymous = false) {
  if (fake) {
    try { return await fake.fn({ method, path, body, headers }); } catch { return { status: 0, data: { error: 'network' } }; }
  }
  const key = process.env.VERIFACTI_API_KEY;
  if (!key && !anonymous) return { status: 0, data: { error: 'not_configured' } };
  try {
    const r = await fetch(API + path, {
      method, signal: AbortSignal.timeout(7000),
      headers: { ...(key && !anonymous ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await r.json(); } catch { /* respuesta sin cuerpo */ }
    return { status: r.status, data: data || {} };
  } catch {
    return { status: 0, data: { error: 'network' } };
  }
}

/* --------------------------- Identificación fiscal --------------------------- */

const LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** NIF, NIE o NIF de entidad español con su letra o dígito de control correcto. */
export function spanishTaxId(raw) {
  const s = String(raw || '').toUpperCase().replace(/[\s.-]/g, '');
  let m;
  if ((m = /^(\d{8})([A-Z])$/.exec(s))) return LETTERS[Number(m[1]) % 23] === m[2];
  if ((m = /^([XYZ])(\d{7})([A-Z])$/.exec(s))) return LETTERS[Number('XYZ'.indexOf(m[1]) + m[2]) % 23] === m[3];
  if ((m = /^[KLM](\d{7})([A-Z])$/.exec(s))) return LETTERS[Number(m[1]) % 23] === m[2];
  if ((m = /^[ABCDEFGHJNPQRSUVW](\d{7})([0-9A-J])$/.exec(s))) {
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const d = Number(m[1][i]);
      if (i % 2) sum += d; else { const x = d * 2; sum += Math.floor(x / 10) + (x % 10); }
    }
    const c = (10 - (sum % 10)) % 10;
    return m[2] === String(c) || m[2] === 'JABCDEFGHI'[c];
  }
  return false;
}

export const ID_TYPES = { '02': 'NIF-IVA', '03': 'Pasaporte', '04': 'Documento de identidad', '06': 'Documento' };

/* ----------------------------- Registro que se envía ----------------------------- */

const esDate = (iso) => iso.split('-').reverse().join('-');          // dd-mm-aaaa
const amount = (cents) => (cents / 100).toFixed(2);
/** El número que se registra tiene que ser el que va impreso: serie «A2026-» + número «0007» = «A2026-0007». */
const serieOf = (series) => `${series}-`;
const numOf = (number) => String(number).padStart(4, '0');
function splitCode(code) { const i = String(code).lastIndexOf('-'); return { serie: `${code.slice(0, i)}-`, numero: code.slice(i + 1) }; }

/** F1 completa, F2 simplificada, R1/R4 rectificativa de completa, R5 rectificativa de simplificada. */
export function recordType(inv) {
  if (inv.kind === 'R') return inv.simplified ? 'R5' : (inv.data && inv.data.rectType === 'R4' ? 'R4' : 'R1');
  return inv.simplified ? 'F2' : 'F1';
}

function describe(inv) {
  const d = inv.data || {};
  let t = d.concept || 'Servicios jurídicos';
  if (Array.isArray(d.lines) && d.lines.length > 1) t += ` y ${d.lines.length - 1} concepto${d.lines.length > 2 ? 's' : ''} más`;
  if (inv.kind === 'R' && d.rectifies) t = `Rectificación de la factura ${d.rectifies.code}: ${d.reason || 'anulación'}`;
  return t.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Cuerpo del registro de alta. La retención de IRPF no forma parte del registro: el total es base más IVA. */
export function buildRecord(inv) {
  const d = inv.data || {}, rec = d.recipient || {}, type = recordType(inv);
  const out = {
    serie: serieOf(inv.series), numero: numOf(inv.number), fecha_expedicion: esDate(inv.issued_on),
    tipo_factura: type, descripcion: describe(inv)
  };
  if (d.operationOn && d.operationOn !== inv.issued_on) out.fecha_operacion = esDate(d.operationOn);
  if (type !== 'F2' && type !== 'R5') {
    out.nombre = String(rec.name || '').slice(0, 120);
    if (rec.idType && rec.idType !== 'nif') {
      out.id_otro = { id_type: rec.idType, id: String(rec.taxId || '').slice(0, 20) };
      if (rec.idCountry) out.id_otro.codigo_pais = rec.idCountry;
    } else out.nif = rec.taxId;
  }
  out.lineas = [{ base_imponible: amount(inv.base_cents), tipo_impositivo: String(inv.vat_bp / 100), cuota_repercutida: amount(inv.vat_cents) }];
  out.importe_total = amount(inv.total_cents);
  if (inv.kind === 'R') {
    out.tipo_rectificativa = 'I';   // por diferencias: los importes van en negativo
    if (d.rectifies && d.rectifies.code) out.facturas_rectificadas = [{ ...splitCode(d.rectifies.code), fecha_expedicion: esDate(d.rectifies.issued_on) }];
  }
  // Pasadas 24 horas desde la expedición el retraso ya es una incidencia y se declara como tal.
  if (inv.created_at && Date.now() - new Date(inv.created_at).getTime() > 24 * 3600 * 1000) out.incidencia = 'S';
  return out;
}

/* ---------------------------------- Cola ---------------------------------- */
// Estados de una factura respecto a la AEAT (columna vf_state):
//   null       expedida con VERI*FACTU apagado
//   queued     pendiente de enviar al proveedor (se reintenta; no se entrega al cliente)
//   sending    una ejecución la está enviando ahora
//   pending    registrada por el proveedor, con QR; la AEAT aún no ha contestado
//   ok         la AEAT la ha aceptado
//   ok_errors  aceptada con errores: hay que subsanar
//   rejected   rechazada por la AEAT: hay que rectificar
//   invalid    el proveedor no la admite (datos del cliente, normalmente): no se ha enviado nada
//   annulled   registro anulado
export const DELIVERABLE = ['pending', 'ok', 'ok_errors'];

const STATE = { Correcto: 'ok', 'Aceptado con errores': 'ok_errors', Incorrecto: 'rejected', Anulado: 'annulled' };
const text = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function submit(inv) {
  const res = await call('POST', '/verifactu/create', buildRecord(inv), { 'Idempotency-Key': `ia-${inv.id}-${inv.vf_rev || 0}` });
  const back = (error) => q(`update invoices set vf_state = 'queued', vf_error = $2 where id = $1`, [inv.id, error]);
  if (res.status === 200 || res.status === 201) {
    const d = res.data || {};
    if (!d.uuid || !(d.qr || d.url)) { await back('respuesta incompleta del proveedor'); return 'stop'; }
    let warn = null;
    try {
      const n = d.url ? new URL(d.url).searchParams.get('numserie') : null;
      if (n && n !== inv.code) warn = `El número registrado (${text(n, 60)}) no coincide con el de la factura`;
    } catch { /* la URL no se pudo leer: no bloquea */ }
    const up = await q(`update invoices set vf_state = 'pending', vf_uuid = $2, vf_url = $3, vf_qr = $4, vf_hash = $5, vf_error = $6, vf_sent_at = now(), vf_checked_at = null
                         where id = $1 returning *`, [inv.id, String(d.uuid), d.url || null, d.qr || null, d.huella || null, warn]);
    return { invoice: up.rows[0] };
  }
  if (res.status === 400 || res.status === 422) {
    const d = res.data || {};
    await q(`update invoices set vf_state = 'invalid', vf_error = $2 where id = $1`, [inv.id, text([d.error || d.mensaje || 'El proveedor no admite los datos', d.codigo].filter(Boolean).join(' · '))]);
    return 'invalid';
  }
  // Clave incorrecta, proveedor caído, límite de peticiones o red: la factura sigue en cola y no se pierde.
  await back(res.status === 401 || res.status === 403 ? 'clave del proveedor no válida o NIF desactivado'
    : res.status === 0 ? (res.data && res.data.error === 'not_configured' ? 'falta la clave del proveedor' : 'sin conexión con el proveedor')
    : `el proveedor responde ${res.status}`);
  return 'stop';
}

/**
 * Envía la cola en el orden de expedición. Se detiene en el primer fallo de conexión para no alterar el orden.
 * onRegistered(invoice) se llama con cada factura que queda registrada (para entregarla al cliente).
 */
export async function flush({ onRegistered, budgetMs = 12000 } = {}) {
  const started = Date.now(), out = { registered: 0, invalid: 0, stopped: false };
  await q(`update invoices set vf_state = 'queued' where vf_state = 'sending' and vf_claimed_at < now() - interval '3 minutes'`);
  while (Date.now() - started < budgetMs) {
    const c = await q(`update invoices set vf_state = 'sending', vf_claimed_at = now(), vf_tries = vf_tries + 1
                        where vf_state = 'queued' and id = (select id from invoices where vf_state = 'queued' order by created_at, number limit 1)
                        returning *`);
    const inv = c.rows[0];
    if (!inv) break;
    const r = await submit(inv);
    if (r === 'stop') { out.stopped = true; break; }
    if (r === 'invalid') { out.invalid++; continue; }
    out.registered++;
    if (onRegistered) { try { await onRegistered(r.invoice); } catch (e) { console.error('vf_after_register_failed', inv.code, e && e.message); } }
  }
  return out;
}

/** Pregunta por las facturas que la AEAT aún no había contestado. */
export async function refresh(limit = 5, budgetMs = 3000) {
  const started = Date.now();
  const { rows } = await q(`select id, code, vf_uuid from invoices
                             where vf_state = 'pending' and vf_uuid is not null and (vf_checked_at is null or vf_checked_at < now() - interval '45 seconds')
                             order by vf_sent_at limit $1`, [limit]);
  let changed = 0;
  for (const inv of rows) {
    if (Date.now() - started > budgetMs) break;
    const res = await call('GET', `/verifactu/status?uuid=${encodeURIComponent(inv.vf_uuid)}`);
    if (res.status !== 200) { await q('update invoices set vf_checked_at = now() where id = $1', [inv.id]); continue; }
    const d = res.data || {};
    let state = STATE[d.estado] || 'pending';
    if (d.estado === 'Duplicado') state = /correct|acept/i.test(String(d.estado_registro_duplicado || '')) ? 'ok' : 'rejected';
    const msg = state === 'ok' ? null : text([d.estado !== 'Pendiente' ? d.estado : '', d.mensaje_error, d.codigo_error].filter(Boolean).join(' · ')) || null;
    await q(`update invoices set vf_state = $2, vf_checked_at = now(), vf_registered_at = case when $2 in ('ok', 'ok_errors') then coalesce(vf_registered_at, now()) else vf_registered_at end,
                                 vf_error = case when $2 = 'pending' then vf_error else $3 end,
                                 vf_url = coalesce($4, vf_url), vf_qr = coalesce($5, vf_qr)
              where id = $1 and vf_state = 'pending'`, [inv.id, state, msg, d.url || null, d.qr || null]);
    if (state !== 'pending') changed++;
  }
  return { checked: rows.length, changed };
}

/** Resumen para el panel: cuántas hay en cada situación que necesita atención. */
export async function summary() {
  const { rows } = await q(`select vf_state as s, count(*)::int as n from invoices where vf_state is not null group by vf_state`);
  const n = (k) => (rows.find((r) => r.s === k) || { n: 0 }).n;
  return { queued: n('queued') + n('sending'), invalid: n('invalid'), pending: n('pending'), rejected: n('rejected'), okErrors: n('ok_errors'), ok: n('ok') };
}

/** ¿Hay registros reales enviados este año? Si los hay, la opción por VERI*FACTU dura hasta el 31 de diciembre. */
export async function lockedYear(year) {
  const r = await q(`select 1 from invoices where vf_env = 'prod' and vf_uuid is not null and issued_on between $1 and $2 limit 1`, [`${year}-01-01`, `${year}-12-31`]);
  return r.rows.length > 0;
}

/** Datos del componente del proveedor para citarlo en la declaración responsable. No necesita clave. */
export async function providerComponent() {
  const res = await call('GET', '/verifactu/declaracion', null, {}, true);
  const s = res.status === 200 && res.data && res.data.sistema_informatico;
  if (!s) return null;
  return { name: text(s.nombre, 80), id: text(s.id, 20), version: text(s.version, 40), url: text(res.data.url_version || res.data.url, 300) };
}
