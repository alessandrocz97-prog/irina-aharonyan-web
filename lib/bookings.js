// Disponibilidad y ciclo de vida de una reserva.
// Regla central: una hora solo queda reservada cuando Stripe confirma el pago.
import crypto from 'node:crypto';
import {
  HttpError, q, audit, isUniqueViolation, getSettings, HOLD_MINUTES,
  madrid, wall, addDays, weekday, slotInstant, isDay, isTime, hashIp, clientIp, origin
} from './core.js';
import { createCheckout, refund, expireSession, stripeMode } from './payments.js';
import { afterPaid, afterRefund } from './invoices.js';

const MODES = ['presencial', 'video', 'telefono'];
const LANGS = ['es', 'ru', 'hy', 'it'];
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newRef() {
  const b = crypto.randomBytes(6);
  let s = '';
  for (const x of b) s += REF_ALPHABET[x % REF_ALPHABET.length];
  return `IA-${s}`;
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/* --------------------------- Disponibilidad --------------------------- */

/** Estado de todas las horas entre dos días: plantilla semanal ± excepciones − reservas activas. */
export async function slotStates(from, to, settings) {
  const s = settings || await getSettings();
  const [ov, bk] = await Promise.all([
    q('select day, time, open, note from overrides where day between $1 and $2', [from, to]),
    q(`select id, ref, day, time, status, name, mode, source, payment, hold_expires_at
         from bookings
        where day between $1 and $2
          and (status = 'confirmed' or (status = 'hold' and hold_expires_at > now()))`, [from, to])
  ]);
  const days = {};
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const slots = new Map();
    for (const t of s.schedule[weekday(d)] || []) slots.set(t, { time: t, state: 'free', base: true });
    days[d] = { day: d, closed: false, note: null, slots };
  }
  for (const o of ov.rows) {
    const day = days[o.day];
    if (!day) continue;
    if (o.time === '') {
      if (!o.open) { day.closed = true; day.note = o.note; for (const x of day.slots.values()) x.state = 'closed'; }
    }
  }
  for (const o of ov.rows) {
    const day = days[o.day];
    if (!day || o.time === '') continue;
    if (o.open) day.slots.set(o.time, { time: o.time, state: 'free', base: (day.slots.get(o.time) || {}).base || false, extra: true });
    else if (day.slots.has(o.time)) day.slots.get(o.time).state = 'closed';
    else day.slots.set(o.time, { time: o.time, state: 'closed', base: false });
  }
  for (const b of bk.rows) {
    const day = days[b.day];
    if (!day) continue;
    const cur = day.slots.get(b.time) || { time: b.time, base: false };
    day.slots.set(b.time, { ...cur, state: b.status === 'hold' ? 'hold' : 'booked', booking: { id: b.id, ref: b.ref, name: b.name, mode: b.mode, source: b.source, payment: b.payment } });
  }
  for (const d of Object.values(days)) d.slots = [...d.slots.values()].sort((a, b) => a.time.localeCompare(b.time));
  return days;
}

/** Horas que un cliente puede reservar ahora mismo. */
export async function publicAvailability(from, to, now = new Date()) {
  const s = await getSettings();
  const m = madrid(now);
  const earliest = wall(m.day, m.time) + s.minNoticeHours * 60;
  const lastDay = addDays(m.day, s.maxDaysAhead);
  if (from < m.day) from = m.day;
  if (to > lastDay) to = lastDay;
  const out = {};
  if (from > to) return out;
  const states = await slotStates(from, to, s);
  for (const d of Object.values(states)) {
    const free = d.slots.filter((x) => x.state === 'free' && wall(d.day, x.time) >= earliest).map((x) => x.time);
    if (free.length) out[d.day] = free;
  }
  return out;
}

export async function publicConfig() {
  const s = await getSettings();
  const mode = stripeMode();
  const modes = {};
  for (const k of MODES) {
    const m = s.modes[k];
    if (m.enabled && Number.isInteger(m.priceCents) && m.priceCents >= 50) modes[k] = { priceCents: m.priceCents };
  }
  return {
    payments: Boolean(mode) && Object.keys(modes).length > 0,
    test: mode === 'test',
    currency: s.currency,
    durationMin: s.durationMin,
    maxDaysAhead: s.maxDaysAhead,
    modes,
    policy: s.policy || ''
  };
}

/* ------------------------- Reserva desde la web ------------------------- */

export async function createHold(request, body) {
  const s = await getSettings();
  if (!stripeMode()) throw new HttpError(503, 'payments_off');
  const day = body.day, time = body.time, mode = body.mode;
  if (!isDay(day) || !isTime(time) || !MODES.includes(mode)) throw new HttpError(400, 'bad_request');
  const name = clean(body.name, 120), phone = clean(body.phone, 40), email = clean(body.email, 160).toLowerCase();
  const note = clean(body.note, 500) || null;
  const taxId = clean(body.taxId, 20).replace(/[\s.-]/g, '').toUpperCase() || null;
  const billAddress = clean(body.billAddress, 300) || null;
  if (taxId && !/^[A-Z0-9]{7,15}$/.test(taxId)) throw new HttpError(400, 'bad_tax_id');
  const lang = LANGS.includes(body.lang) ? body.lang : 'es';
  if (name.length < 3) throw new HttpError(400, 'bad_name');
  if (phone.replace(/\D/g, '').length < 9) throw new HttpError(400, 'bad_phone');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'bad_email');
  if (body.consent !== true || body.terms !== true) throw new HttpError(400, 'consent_required');
  const m = s.modes[mode];
  if (!m.enabled || !Number.isInteger(m.priceCents) || m.priceCents < 50) throw new HttpError(409, 'mode_unavailable');

  const free = await publicAvailability(day, day);
  if (!free[day] || !free[day].includes(time)) throw new HttpError(409, 'slot_taken');

  // Freno al abuso: nadie puede retener muchas horas sin pagar.
  const ip = await hashIp(clientIp(request));
  const recent = await q(
    `select count(*)::int as n from bookings
      where source = 'web' and created_at > now() - interval '1 hour' and (ip_hash = $1 or email = $2)`, [ip, email]);
  if (recent.rows[0].n >= 4) throw new HttpError(429, 'too_many_holds');

  // Libera retenciones caducadas de esa hora y ocupa la hora. El índice único impide dos activas.
  await q(`update bookings set status = 'expired', updated_at = now()
            where day = $1 and time = $2 and status = 'hold' and hold_expires_at <= now()`, [day, time]);
  const releaseKey = crypto.randomBytes(18).toString('base64url');
  let booking;
  try {
    const r = await q(
      `insert into bookings (ref, day, time, starts_at, mode, name, phone, email, lang, note, status, source, payment,
                             amount_cents, currency, hold_expires_at, release_key, consent_at, ip_hash, tax_id, bill_address)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'hold', 'web', 'stripe', $11, $12,
               now() + ($13 || ' minutes')::interval, $14, now(), $15, $16, $17)
       returning *`,
      [newRef(), day, time, slotInstant(day, time).toISOString(), mode, name, phone, email, lang, note,
        m.priceCents, s.currency, String(HOLD_MINUTES), releaseKey, ip, taxId, billAddress]);
    booking = r.rows[0];
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'slot_taken');
    throw e;
  }

  let session;
  try {
    session = await createCheckout({ booking, base: origin(request), releaseKey });
  } catch (e) {
    await q(`update bookings set status = 'expired', updated_at = now() where id = $1 and status = 'hold'`, [booking.id]);
    console.error('stripe_checkout_failed', e && e.message);
    throw new HttpError(502, 'payment_unavailable');
  }
  await q('update bookings set stripe_session_id = $1, updated_at = now() where id = $2', [session.id, booking.id]);
  return { id: booking.id, ref: booking.ref, url: session.url };
}

/** El cliente vuelve de Stripe sin pagar: se libera la hora al momento. */
export async function releaseHold({ id, key }) {
  if (typeof id !== 'string' || typeof key !== 'string') throw new HttpError(400, 'bad_request');
  const r = await q(`update bookings set status = 'expired', updated_at = now()
                      where id = $1 and release_key = $2 and status = 'hold' returning stripe_session_id`, [id, key]);
  if (r.rows[0] && r.rows[0].stripe_session_id) await expireSession(r.rows[0].stripe_session_id);
  return { released: r.rowCount > 0 };
}

export async function statusBySession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 8) throw new HttpError(400, 'bad_request');
  const { rows } = await q(
    `select ref, day, time, starts_at, mode, status, amount_cents, currency, lang, flag from bookings where stripe_session_id = $1`, [sessionId]);
  if (!rows[0]) throw new HttpError(404, 'not_found');
  const s = await getSettings();
  return { ...rows[0], durationMin: s.durationMin };
}

/* --------------------------- Avisos de Stripe --------------------------- */

async function confirmPaid(session) {
  const id = session.client_reference_id || (session.metadata && session.metadata.booking_id);
  if (!id) return 'ignored';
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null;
  const set = `status = 'confirmed', confirmed_at = now(), updated_at = now(), stripe_payment_intent = $2, hold_expires_at = null`;
  const ok = await q(`update bookings set ${set} where id = $1 and status = 'hold' returning ref`, [id, pi]);
  if (ok.rowCount) { await audit('stripe', 'paid_confirmed', id, { session: session.id }); await afterPaid(id); return 'confirmed'; }

  const cur = await q('select status, ref from bookings where id = $1', [id]);
  if (!cur.rows[0]) return 'unknown_booking';
  if (cur.rows[0].status === 'confirmed') { await afterPaid(id); return 'already'; }
  if (cur.rows[0].status === 'refunded') return 'already';

  // Pago que llega con la retención ya caducada o cancelada: se recupera la hora si sigue libre…
  try {
    const late = await q(`update bookings set ${set} where id = $1 and status = 'expired' and source = 'web' returning ref`, [id, pi]);
    if (late.rowCount) { await audit('stripe', 'paid_confirmed_late', id, { session: session.id }); await afterPaid(id); return 'confirmed_late'; }
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  // …y si otra persona la ha ocupado, se devuelve el dinero automáticamente.
  await q(`update bookings set stripe_payment_intent = $2, flag = 'conflict_refund', updated_at = now() where id = $1`, [id, pi]);
  if (pi) {
    await refund(pi, id);
    await q(`update bookings set status = 'refunded', updated_at = now() where id = $1`, [id]);
  }
  await audit('stripe', 'paid_conflict_refunded', id, { session: session.id });
  return 'refunded_conflict';
}

async function expireUnpaid(session) {
  const id = session.client_reference_id || (session.metadata && session.metadata.booking_id);
  if (!id) return 'ignored';
  const r = await q(`update bookings set status = 'expired', updated_at = now() where id = $1 and status = 'hold'`, [id]);
  return r.rowCount ? 'expired' : 'noop';
}

export async function handleStripeEvent(event) {
  const o = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
      return o.payment_status === 'paid' ? confirmPaid(o) : 'awaiting_payment';
    case 'checkout.session.async_payment_succeeded':
      return confirmPaid(o);
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return expireUnpaid(o);
    case 'charge.refunded': {
      if (!o.refunded || !o.payment_intent) return 'ignored';
      const r = await q(`update bookings set status = 'refunded', updated_at = now()
                          where stripe_payment_intent = $1 and status in ('confirmed','cancelled') returning id`, [o.payment_intent]);
      if (r.rows[0]) { await audit('stripe', 'refunded', r.rows[0].id, null); await afterRefund(r.rows[0].id); }
      return r.rowCount ? 'refunded' : 'noop';
    }
    default:
      return 'ignored';
  }
}

/* ------------------------------- Panel ------------------------------- */

const PUBLIC_COLS = `id, ref, day, time, starts_at, mode, name, phone, email, lang, note, status, source, payment,
  amount_cents, currency, created_at, confirmed_at, cancelled_at, cancelled_by, cancel_reason, flag,
  (stripe_payment_intent is not null) as paid_online, tax_id, bill_address,
  (select json_build_object('id', i.id, 'code', i.code, 'sent_at', i.sent_at, 'send_error', i.send_error, 'total_cents', i.total_cents)
     from invoices i where i.booking_id = bookings.id and i.kind = 'F') as invoice,
  (select json_build_object('id', i.id, 'code', i.code, 'sent_at', i.sent_at, 'send_error', i.send_error, 'total_cents', i.total_cents)
     from invoices i where i.booking_id = bookings.id and i.kind = 'R') as rectification`;

export async function listBookings({ from, to, status }) {
  const where = ['1 = 1'], params = [];
  if (isDay(from)) { params.push(from); where.push(`day >= $${params.length}`); }
  if (isDay(to)) { params.push(to); where.push(`day <= $${params.length}`); }
  if (status === 'active') where.push(`status = 'confirmed'`);
  else if (['confirmed', 'cancelled', 'refunded', 'expired', 'hold'].includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
  else where.push(`status <> 'expired'`);
  const { rows } = await q(`select ${PUBLIC_COLS} from bookings where ${where.join(' and ')} order by day, time limit 500`, params);
  return rows;
}

export async function getBooking(id) {
  const { rows } = await q(`select ${PUBLIC_COLS} from bookings where id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found');
  return rows[0];
}

export async function createManual(admin, body) {
  const day = body.day, time = body.time, mode = body.mode;
  if (!isDay(day) || !isTime(time) || !MODES.includes(mode)) throw new HttpError(400, 'bad_request');
  const name = clean(body.name, 120), phone = clean(body.phone, 40), email = clean(body.email, 160).toLowerCase();
  if (name.length < 2) throw new HttpError(400, 'bad_name');
  const payment = body.payment === 'manual' ? 'manual' : 'none';
  const cents = Number.isInteger(body.amountCents) && body.amountCents >= 0 ? body.amountCents : null;
  await q(`update bookings set status = 'expired', updated_at = now()
            where day = $1 and time = $2 and status = 'hold' and hold_expires_at <= now()`, [day, time]);
  try {
    const r = await q(
      `insert into bookings (ref, day, time, starts_at, mode, name, phone, email, lang, note, status, source, payment, amount_cents, currency, confirmed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'es', $9, 'confirmed', 'manual', $10, $11, 'eur', now()) returning id, ref`,
      [newRef(), day, time, slotInstant(day, time).toISOString(), mode, name, phone, email, clean(body.note, 500) || null, payment, cents]);
    await audit(admin.email, 'manual_booking', r.rows[0].id, { day, time });
    return r.rows[0];
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'slot_taken');
    throw e;
  }
}

export async function cancelBooking(admin, id, { refundPayment, reason }) {
  const { rows } = await q('select * from bookings where id = $1', [id]);
  const b = rows[0];
  if (!b) throw new HttpError(404, 'not_found');
  if (!['confirmed', 'hold'].includes(b.status)) throw new HttpError(409, 'not_active');
  let refunded = false;
  if (refundPayment && b.stripe_payment_intent) {
    try { await refund(b.stripe_payment_intent, b.id); refunded = true; }
    catch (e) { console.error('refund_failed', e && e.message); throw new HttpError(502, 'refund_failed'); }
  }
  if (b.status === 'hold' && b.stripe_session_id) await expireSession(b.stripe_session_id);
  await q(`update bookings set status = $2, cancelled_at = now(), cancelled_by = $3, cancel_reason = $4, updated_at = now() where id = $1`,
    [id, refunded ? 'refunded' : 'cancelled', admin.email, clean(reason, 300) || null]);
  await audit(admin.email, refunded ? 'cancelled_refunded' : 'cancelled', id, { reason: clean(reason, 300) || null });
  const rect = refunded ? await afterRefund(id) : null;
  return { status: refunded ? 'refunded' : 'cancelled', rectification: rect && rect.invoice ? rect.invoice.code : null };
}

/** Abrir o cerrar una hora o un día entero. open = null quita la excepción y vuelve a la plantilla. */
export async function setOverride(admin, { day, time, open, note }) {
  if (!isDay(day)) throw new HttpError(400, 'bad_request');
  time = time ? String(time) : '';
  if (time !== '' && !isTime(time)) throw new HttpError(400, 'bad_request');
  if (open === null || open === undefined) {
    await q('delete from overrides where day = $1 and time = $2', [day, time]);
  } else {
    await q(`insert into overrides (day, time, open, note, created_by) values ($1, $2, $3, $4, $5)
             on conflict (day, time) do update set open = excluded.open, note = excluded.note, created_by = excluded.created_by, created_at = now()`,
      [day, time, Boolean(open), clean(note, 200) || null, admin.email]);
  }
  await audit(admin.email, open === null || open === undefined ? 'override_removed' : (open ? 'slot_opened' : 'slot_closed'), null, { day, time: time || 'día completo' });
  return { ok: true };
}

/* ----------------------- Días libres y vacaciones ----------------------- */

/** Días cerrados enteros desde una fecha, agrupados en tramos seguidos con el mismo motivo. */
export async function listClosures(from) {
  const start = isDay(from) ? from : madrid().day;
  const { rows } = await q(`select day, note from overrides where time = '' and open = false and day >= $1 order by day limit 400`, [start]);
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === r.day && last.note === (r.note || '')) { last.to = r.day; last.days++; }
    else out.push({ from: r.day, to: r.day, note: r.note || '', days: 1, bookings: 0 });
  }
  if (out.length) {
    const b = await q(`select day from bookings where status = 'confirmed' and day between $1 and $2`, [out[0].from, out[out.length - 1].to]);
    for (const x of b.rows) { const c = out.find((r) => r.from <= x.day && x.day <= r.to); if (c) c.bookings++; }
  }
  return out;
}

/** Cierra todos los días de un tramo (vacaciones, señalamientos, festivos). Las reservas ya confirmadas se mantienen. */
export async function closeRange(admin, { from, to, note }) {
  if (!isDay(from) || !isDay(to) || to < from || to < madrid().day) throw new HttpError(400, 'bad_range');
  if (addDays(from, 120) < to) throw new HttpError(400, 'range_too_long');
  const text = clean(note, 200) || null, days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  await q(`insert into overrides (day, time, open, note, created_by)
           values ${days.map((_, i) => `($${i + 3}, '', false, $1, $2)`).join(', ')}
           on conflict (day, time) do update set open = false, note = excluded.note, created_by = excluded.created_by, created_at = now()`,
    [text, admin.email, ...days]);
  const kept = await q(`select count(*)::int as n from bookings where status = 'confirmed' and day between $1 and $2`, [from, to]);
  await audit(admin.email, 'range_closed', null, { from, to, reason: text });
  return { days: days.length, bookings: kept.rows[0].n };
}

/** Reabre un tramo de días cerrados: vuelven al horario habitual. */
export async function openRange(admin, { from, to }) {
  if (!isDay(from) || !isDay(to) || to < from) throw new HttpError(400, 'bad_range');
  await q(`delete from overrides where time = '' and open = false and day between $1 and $2`, [from, to]);
  await audit(admin.email, 'range_opened', null, { from, to });
  return { ok: true };
}

/** Cambia una reserva confirmada de día u hora. No avisa al cliente ni toca la factura ya expedida. */
export async function moveBooking(admin, id, { day, time }) {
  if (!isDay(day) || !isTime(time)) throw new HttpError(400, 'bad_request');
  const { rows } = await q('select id, ref, day, time, status from bookings where id = $1', [id]);
  const b = rows[0];
  if (!b) throw new HttpError(404, 'not_found');
  if (b.status !== 'confirmed') throw new HttpError(409, 'not_active');
  if (b.day === day && b.time === time) throw new HttpError(400, 'same_slot');
  const start = slotInstant(day, time);
  if (start.getTime() < Date.now()) throw new HttpError(400, 'slot_past');
  await q(`update bookings set status = 'expired', updated_at = now()
            where day = $1 and time = $2 and status = 'hold' and hold_expires_at <= now()`, [day, time]);
  try {
    await q(`update bookings set day = $2, time = $3, starts_at = $4, updated_at = now() where id = $1 and status = 'confirmed'`,
      [id, day, time, start.toISOString()]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'slot_taken');
    throw e;
  }
  await audit(admin.email, 'booking_moved', id, { day, time, was: `${b.day} ${b.time}` });
  return { id, ref: b.ref, day, time, was: { day: b.day, time: b.time } };
}

export function validateSettings(body, current) {
  const out = {};
  if (body.modes) {
    out.modes = {};
    for (const k of MODES) {
      const m = body.modes[k] || {};
      const cents = m.priceCents === null || m.priceCents === '' || m.priceCents === undefined ? null : Number(m.priceCents);
      if (cents !== null && (!Number.isInteger(cents) || cents < 50 || cents > 500000)) throw new HttpError(400, 'bad_price');
      out.modes[k] = { enabled: m.enabled !== false, priceCents: cents };
    }
  }
  if (body.schedule) {
    out.schedule = {};
    for (let d = 1; d <= 7; d++) {
      const list = Array.isArray(body.schedule[d]) ? body.schedule[d] : [];
      if (list.length > 24 || !list.every(isTime)) throw new HttpError(400, 'bad_schedule');
      out.schedule[d] = [...new Set(list)].sort();
    }
  }
  const int = (v, min, max, code) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, code); return n; };
  if (body.minNoticeHours !== undefined) out.minNoticeHours = int(body.minNoticeHours, 0, 336, 'bad_notice');
  if (body.maxDaysAhead !== undefined) out.maxDaysAhead = int(body.maxDaysAhead, 1, 365, 'bad_horizon');
  if (body.durationMin !== undefined) out.durationMin = int(body.durationMin, 15, 240, 'bad_duration');
  if (body.policy !== undefined) out.policy = String(body.policy).slice(0, 2000);
  if (body.invoice) {
    const v = body.invoice, i = v.issuer || {}, cur = current.invoice;
    const vat = v.vatBp === undefined ? cur.vatBp : Number(v.vatBp);
    if (!Number.isInteger(vat) || vat < 0 || vat > 3000) throw new HttpError(400, 'bad_vat');
    const series = v.series === undefined ? cur.series : clean(v.series, 4).toUpperCase();
    if (!/^[A-Z]{1,4}$/.test(series) || series === 'R') throw new HttpError(400, 'bad_series');
    const copyTo = v.copyTo === undefined ? cur.copyTo : clean(v.copyTo, 160).toLowerCase();
    if (copyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(copyTo)) throw new HttpError(400, 'bad_copy_email');
    const text = (x, max) => String(x ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
    out.invoice = {
      enabled: v.enabled === true, series, vatBp: vat, copyTo, payNote: v.payNote === undefined ? (cur.payNote || '') : text(v.payNote, 300),
      issuer: { name: text(i.name, 200), taxId: text(i.taxId, 20).replace(/[\s.-]/g, '').toUpperCase(), address: text(i.address, 300), extra: text(i.extra, 200), contact: text(i.contact, 200) }
    };
    if (out.invoice.enabled && !(out.invoice.issuer.name.length >= 3 && out.invoice.issuer.taxId.length >= 8 && out.invoice.issuer.address.length >= 8)) throw new HttpError(400, 'issuer_incomplete');
  }
  if (body.verifactu) {
    const v = body.verifactu, p = v.producer || {}, cur = current.verifactu;
    const text = (x, max) => String(x ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
    const signedOn = v.signedOn === undefined ? cur.signedOn : String(v.signedOn || '');
    if (signedOn && (!isDay(signedOn) || signedOn > madrid().day)) throw new HttpError(400, 'bad_signed_date');
    out.verifactu = {
      enabled: v.enabled === undefined ? cur.enabled === true : v.enabled === true,
      producer: { name: text(p.name ?? cur.producer.name, 200), taxId: text(p.taxId ?? cur.producer.taxId, 20).replace(/[\s.-]/g, '').toUpperCase(), address: text(p.address ?? cur.producer.address, 300), contact: text(p.contact ?? cur.producer.contact, 200) },
      place: text(v.place ?? cur.place, 80), signedOn
    };
  }
  return { ...current, ...out, _changed: Object.keys(out) };
}
