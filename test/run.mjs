// Pruebas del motor de reservas con una base de datos Postgres real en memoria y Stripe simulado.
// La firma de los avisos de Stripe se genera y se verifica con la librería oficial.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import Stripe from 'stripe';

process.env.SESSION_SECRET = 'secreto-de-pruebas-con-mas-de-24-caracteres';
process.env.PANEL_SETUP_CODE = 'codigo-de-alta';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_pruebas_locales';

const { useDb, SCHEMA, madrid, addDays, weekday, q } = await import('../lib/core.js');
const { useStripe } = await import('../lib/payments.js');
const { handle } = await import('../api/index.js');

const pg = new PGlite();
await pg.exec(SCHEMA);
useDb({ query: (sql, params) => pg.query(sql, params) });

const stripeCalls = { sessions: [], refunds: [], expired: [] };
let failCheckout = false, n = 0;
useStripe({
  checkout: {
    sessions: {
      create: async (params) => {
        if (failCheckout) throw new Error('stripe caído');
        const s = { id: `cs_test_${++n}`, url: `https://checkout.stripe.test/c/pay/${n}`, ...params };
        stripeCalls.sessions.push(s);
        return s;
      },
      expire: async (id) => { stripeCalls.expired.push(id); }
    }
  },
  refunds: { create: async (p) => { stripeCalls.refunds.push(p); return { id: `re_${stripeCalls.refunds.length}` }; } }
});

let cookie = '', ipSeq = 0;
async function api(method, path, body, opts = {}) {
  const headers = { 'x-forwarded-for': opts.ip || '10.0.0.1', 'x-forwarded-proto': 'https', host: 'web.test' };
  if (body !== undefined && !opts.raw) headers['content-type'] = 'application/json';
  if (opts.panel !== false) headers['x-panel'] = '1';
  if (cookie && opts.auth !== false) headers.cookie = cookie;
  Object.assign(headers, opts.headers || {});
  const res = await handle(new Request(`https://web.test/api${path}`, {
    method, headers, body: body === undefined ? undefined : (opts.raw ? body : JSON.stringify(body))
  }));
  const data = await res.json();
  return { status: res.status, data, res };
}
async function stripeEvent(type, object) {
  const payload = JSON.stringify({ id: `evt_${++n}`, type, data: { object } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return api('POST', '/stripe/webhook', payload, { raw: true, panel: false, auth: false, headers: { 'stripe-signature': sig } });
}
const person = (i) => ({ name: `Cliente Prueba ${i}`, phone: '600 000 00' + (i % 10), email: `cliente${i}@example.com`, lang: 'es', consent: true, terms: true });
const book = (day, time, i, extra = {}) => api('POST', '/bookings', { day, time, mode: 'video', ...person(i), ...extra }, { ip: `10.1.0.${++ipSeq}`, auth: false, panel: false });
const statusOf = async (id) => (await q('select status, flag from bookings where id = $1', [id])).rows[0];

// Un lunes con margen suficiente respecto a hoy, y el sábado de esa semana.
let monday = addDays(madrid().day, 4);
while (weekday(monday) !== 1) monday = addDays(monday, 1);
const tuesday = addDays(monday, 1), saturday = addDays(monday, 5);

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FALLO', name, e.message]); }
}

await test('estado inicial: base de datos lista, sin cuentas ni precios', async () => {
  const r = await api('GET', '/setup-status');
  assert.equal(r.data.db, true); assert.equal(r.data.hasAccounts, false); assert.equal(r.data.pricesSet, false);
  const c = await api('GET', '/config');
  assert.equal(c.data.payments, false, 'sin precios no se puede cobrar');
});

await test('el panel exige sesión y la cabecera propia', async () => {
  assert.equal((await api('GET', '/admin/bookings')).status, 401);
  assert.equal((await api('POST', '/admin/login', { email: 'a@b.es', password: 'x' }, { panel: false })).status, 403);
});

await test('alta de cuentas solo con el código correcto', async () => {
  assert.equal((await api('POST', '/admin/setup', { code: 'otro-codigo', name: 'X', email: 'x@y.es', password: 'una-clave-larga' })).status, 403);
  assert.equal((await api('POST', '/admin/setup', { code: 'codigo-de-alta', name: 'Irina', email: 'irina@example.com', password: 'corta' })).status, 400);
  const a = await api('POST', '/admin/setup', { code: 'codigo-de-alta', name: 'Irina', email: 'irina@example.com', password: 'clave-de-la-titular', role: 'titular' });
  assert.equal(a.status, 201);
  const b = await api('POST', '/admin/setup', { code: 'codigo-de-alta', name: 'Alessandro', email: 'gestor@example.com', password: 'clave-del-gestor-1' });
  assert.equal(b.data.account.role, 'gestor');
});

await test('inicio de sesión: clave incorrecta rechazada, correcta aceptada', async () => {
  assert.equal((await api('POST', '/admin/login', { email: 'irina@example.com', password: 'no-es-esta-clave' })).status, 401);
  const r = await api('POST', '/admin/login', { email: 'irina@example.com', password: 'clave-de-la-titular' });
  assert.equal(r.status, 200);
  const set = r.res.headers.get('set-cookie');
  assert.match(set, /HttpOnly/); assert.match(set, /Secure/); assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  assert.equal((await api('GET', '/admin/me')).data.admin.role, 'titular');
});

await test('cinco fallos seguidos bloquean el acceso un rato', async () => {
  for (let i = 0; i < 5; i++) await api('POST', '/admin/login', { email: 'gestor@example.com', password: 'mal-mal-mal-mal' }, { ip: '10.9.9.9', auth: false });
  const r = await api('POST', '/admin/login', { email: 'gestor@example.com', password: 'clave-del-gestor-1' }, { ip: '10.9.9.9', auth: false });
  assert.equal(r.status, 429);
});

await test('al fijar precios se activa el cobro', async () => {
  const bad = await api('PUT', '/admin/settings', { modes: { video: { priceCents: 10 } } });
  assert.equal(bad.status, 400);
  const r = await api('PUT', '/admin/settings', { modes: { presencial: { priceCents: 9000 }, video: { priceCents: 8000 }, telefono: { enabled: false } }, minNoticeHours: 12 });
  assert.equal(r.status, 200);
  const c = await api('GET', '/config');
  assert.equal(c.data.payments, true); assert.equal(c.data.test, true);
  assert.deepEqual(Object.keys(c.data.modes).sort(), ['presencial', 'video']);
});

await test('el aviso previo al pago se guarda como texto y llega a la web', async () => {
  const r = await api('PUT', '/admin/settings', { policy: 'Puede cancelar hasta 24 horas antes.\nSe devuelve el importe.', durationMin: 45 });
  assert.equal(r.status, 200);
  const c = await api('GET', '/config');
  assert.equal(c.data.policy, 'Puede cancelar hasta 24 horas antes.\nSe devuelve el importe.');
  assert.equal(c.data.durationMin, 45);
  assert.equal((await api('PUT', '/admin/settings', { durationMin: 5 })).status, 400);
});

await test('disponibilidad: ocho horas un lunes, ninguna el sábado ni dentro del preaviso', async () => {
  const r = await api('GET', `/availability?from=${monday}&to=${saturday}`);
  assert.equal(r.data.days[monday].length, 8);
  assert.equal(r.data.days[saturday], undefined);
  const today = madrid().day;
  const t = await api('GET', `/availability?from=${today}&to=${today}`);
  const soon = (t.data.days[today] || []).filter((x) => x <= madrid().time);
  assert.equal(soon.length, 0, 'no se ofrecen horas ya pasadas');
});

await test('validación: sin consentimiento, correo o modalidad válida no hay reserva', async () => {
  assert.equal((await book(monday, '09:00', 1, { consent: false })).data.error, 'consent_required');
  assert.equal((await book(monday, '09:00', 1, { terms: false })).data.error, 'consent_required');
  assert.equal((await book(monday, '09:00', 1, { email: 'no-es-correo' })).data.error, 'bad_email');
  assert.equal((await book(monday, '09:00', 1, { mode: 'telefono' })).data.error, 'mode_unavailable');
  assert.equal((await book(monday, '09:30', 1)).data.error, 'slot_taken', 'hora fuera de la agenda');
});

let b1;
await test('reservar retiene la hora y devuelve la página de pago; nadie más puede cogerla', async () => {
  b1 = await book(monday, '09:00', 1);
  assert.equal(b1.status, 201); assert.match(b1.data.url, /^https:\/\/checkout\.stripe\.test/);
  const s = stripeCalls.sessions.at(-1);
  assert.equal(s.line_items[0].price_data.unit_amount, 8000);
  assert.equal(s.client_reference_id, b1.data.id);
  assert.ok(s.expires_at - Date.now() / 1000 >= 30 * 60, 'la sesión dura al menos 30 minutos');
  assert.equal((await statusOf(b1.data.id)).status, 'hold');
  const av = await api('GET', `/availability?from=${monday}&to=${monday}`);
  assert.ok(!av.data.days[monday].includes('09:00'));
  assert.equal((await book(monday, '09:00', 2)).status, 409);
});

await test('SIN COBRO NO HAY RESERVA: sin aviso de pago sigue sin confirmarse', async () => {
  const s = await api('GET', `/bookings/status?session_id=${stripeCalls.sessions.at(-1).id}`);
  assert.equal(s.data.status, 'hold');
  const unpaid = await stripeEvent('checkout.session.completed', { id: stripeCalls.sessions.at(-1).id, client_reference_id: b1.data.id, payment_status: 'unpaid' });
  assert.equal(unpaid.data.result, 'awaiting_payment');
  assert.equal((await statusOf(b1.data.id)).status, 'hold');
});

await test('un aviso con firma falsa se rechaza', async () => {
  const payload = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { client_reference_id: b1.data.id, payment_status: 'paid' } } });
  const r = await api('POST', '/stripe/webhook', payload, { raw: true, headers: { 'stripe-signature': 't=1,v1=deadbeef' } });
  assert.equal(r.status, 400);
  assert.equal((await statusOf(b1.data.id)).status, 'hold');
});

await test('el aviso de pago de Stripe confirma la reserva (y repetirlo no cambia nada)', async () => {
  const ev = { id: stripeCalls.sessions.at(-1).id, client_reference_id: b1.data.id, payment_status: 'paid', payment_intent: 'pi_1' };
  assert.equal((await stripeEvent('checkout.session.completed', ev)).data.result, 'confirmed');
  assert.equal((await statusOf(b1.data.id)).status, 'confirmed');
  assert.equal((await stripeEvent('checkout.session.completed', ev)).data.result, 'already');
  const s = await api('GET', `/bookings/status?session_id=${ev.id}`);
  assert.equal(s.data.status, 'confirmed'); assert.match(s.data.ref, /^IA-/);
  assert.equal(s.data.name, undefined, 'la consulta pública de estado no expone datos personales');
});

await test('retención caducada: la hora vuelve a ofrecerse', async () => {
  const h = await book(monday, '10:00', 3);
  await q(`update bookings set hold_expires_at = now() - interval '1 minute' where id = $1`, [h.data.id]);
  const av = await api('GET', `/availability?from=${monday}&to=${monday}`);
  assert.ok(av.data.days[monday].includes('10:00'));
  // Otra persona la ocupa…
  const other = await book(monday, '10:00', 4);
  assert.equal(other.status, 201);
  assert.equal((await statusOf(h.data.id)).status, 'expired');
  // …y el primer cliente paga tarde: se le devuelve el dinero y la segunda retención sigue intacta.
  const late = await stripeEvent('checkout.session.completed', { id: 'cs_late', client_reference_id: h.data.id, payment_status: 'paid', payment_intent: 'pi_late' });
  assert.equal(late.data.result, 'refunded_conflict');
  assert.deepEqual(stripeCalls.refunds.at(-1).payment_intent, 'pi_late');
  const st = await statusOf(h.data.id);
  assert.equal(st.status, 'refunded'); assert.equal(st.flag, 'conflict_refund');
  assert.equal((await statusOf(other.data.id)).status, 'hold');
});

await test('pago tardío con la hora aún libre: se recupera la reserva', async () => {
  const h = await book(monday, '11:00', 5);
  await q(`update bookings set status = 'expired' where id = $1`, [h.data.id]);
  const r = await stripeEvent('checkout.session.completed', { id: 'cs_late2', client_reference_id: h.data.id, payment_status: 'paid', payment_intent: 'pi_late2' });
  assert.equal(r.data.result, 'confirmed_late');
  assert.equal((await statusOf(h.data.id)).status, 'confirmed');
});

await test('volver de Stripe sin pagar libera la hora al momento (solo con su clave)', async () => {
  const h = await book(monday, '12:00', 6);
  const key = new URL(stripeCalls.sessions.at(-1).cancel_url).searchParams.get('k');
  assert.equal((await api('POST', '/bookings/release', { id: h.data.id, key: 'clave-falsa' }, { auth: false })).data.released, false);
  assert.equal((await api('POST', '/bookings/release', { id: h.data.id, key }, { auth: false })).data.released, true);
  assert.equal((await statusOf(h.data.id)).status, 'expired');
  assert.ok(stripeCalls.expired.includes(stripeCalls.sessions.at(-1).id), 'se anula la sesión de pago');
});

await test('sesión de pago caducada en Stripe: la retención se libera', async () => {
  const h = await book(monday, '13:00', 7);
  const r = await stripeEvent('checkout.session.expired', { id: stripeCalls.sessions.at(-1).id, client_reference_id: h.data.id });
  assert.equal(r.data.result, 'expired');
  assert.equal((await statusOf(h.data.id)).status, 'expired');
});

await test('si Stripe falla al crear el pago, la hora no queda bloqueada', async () => {
  failCheckout = true;
  const r = await book(monday, '16:00', 8);
  failCheckout = false;
  assert.equal(r.status, 502);
  const av = await api('GET', `/availability?from=${monday}&to=${monday}`);
  assert.ok(av.data.days[monday].includes('16:00'));
});

await test('panel: cerrar y reabrir una hora, cerrar un día, abrir una hora extra', async () => {
  await api('POST', '/admin/overrides', { day: tuesday, time: '09:00', open: false });
  let av = await api('GET', `/availability?from=${tuesday}&to=${tuesday}`);
  assert.ok(!av.data.days[tuesday].includes('09:00'));
  await api('POST', '/admin/overrides', { day: tuesday, time: '09:00', open: null });
  av = await api('GET', `/availability?from=${tuesday}&to=${tuesday}`);
  assert.ok(av.data.days[tuesday].includes('09:00'));
  await api('POST', '/admin/overrides', { day: tuesday, time: '', open: false, note: 'Señalamientos' });
  av = await api('GET', `/availability?from=${tuesday}&to=${tuesday}`);
  assert.equal(av.data.days[tuesday], undefined);
  await api('POST', '/admin/overrides', { day: tuesday, time: '', open: null });
  await api('POST', '/admin/overrides', { day: saturday, time: '10:30', open: true });
  av = await api('GET', `/availability?from=${saturday}&to=${saturday}`);
  assert.deepEqual(av.data.days[saturday], ['10:30']);
  const m = await api('GET', `/admin/month?month=${saturday.slice(0, 7)}`);
  assert.equal(m.data.days[saturday].free, 1);
});

await test('panel: reserva manual ocupa la hora y no admite duplicados', async () => {
  const r = await api('POST', '/admin/bookings', { day: tuesday, time: '17:00', mode: 'presencial', name: 'Cliente de teléfono', phone: '611 111 111', payment: 'manual', amountCents: 9000 });
  assert.equal(r.status, 201);
  const av = await api('GET', `/availability?from=${tuesday}&to=${tuesday}`);
  assert.ok(!av.data.days[tuesday].includes('17:00'));
  assert.equal((await api('POST', '/admin/bookings', { day: tuesday, time: '17:00', mode: 'video', name: 'Otro', phone: '622 222 222' })).status, 409);
  assert.equal((await book(tuesday, '17:00', 9)).status, 409);
  const d = await api('GET', `/admin/day?day=${tuesday}`);
  assert.equal(d.data.day.slots.find((x) => x.time === '17:00').state, 'booked');
});

await test('panel: cancelar con devolución llama a Stripe y libera la hora', async () => {
  const r = await api('POST', '/admin/bookings/cancel', { id: b1.data.id, refund: true, reason: 'Petición del cliente' });
  assert.equal(r.data.status, 'refunded');
  assert.equal(stripeCalls.refunds.at(-1).payment_intent, 'pi_1');
  const av = await api('GET', `/availability?from=${monday}&to=${monday}`);
  assert.ok(av.data.days[monday].includes('09:00'));
  assert.equal((await api('POST', '/admin/bookings/cancel', { id: b1.data.id })).status, 409, 'no se cancela dos veces');
});

await test('devolución hecha desde Stripe: la reserva pasa a devuelta', async () => {
  const h = await book(tuesday, '10:00', 10);
  await stripeEvent('checkout.session.completed', { id: 'cs_r', client_reference_id: h.data.id, payment_status: 'paid', payment_intent: 'pi_r' });
  const r = await stripeEvent('charge.refunded', { refunded: true, payment_intent: 'pi_r' });
  assert.equal(r.data.result, 'refunded');
  assert.equal((await statusOf(h.data.id)).status, 'refunded');
});

await test('freno al abuso: la misma persona no puede retener horas sin límite', async () => {
  let last;
  for (const t of ['09:00', '11:00', '12:00', '13:00', '16:00']) last = await api('POST', '/bookings', { day: addDays(monday, 2), time: t, mode: 'video', ...person(77) }, { ip: '10.7.7.7', auth: false });
  assert.equal(last.status, 429);
});

await test('listado y registro de actividad', async () => {
  const l = await api('GET', `/admin/bookings?from=${monday}&to=${saturday}`);
  assert.ok(l.data.bookings.length >= 5);
  assert.ok(l.data.bookings.every((b) => b.status !== 'expired'));
  const a = await api('GET', '/admin/audit');
  const actions = a.data.entries.map((e) => e.action);
  for (const x of ['paid_confirmed', 'paid_conflict_refunded', 'manual_booking', 'cancelled_refunded', 'slot_closed', 'settings_changed', 'login']) assert.ok(actions.includes(x), 'falta ' + x);
});

await test('cambiar la contraseña exige la actual', async () => {
  assert.equal((await api('POST', '/admin/password', { current: 'no-es', next: 'otra-clave-bien-larga' })).status, 401);
  assert.equal((await api('POST', '/admin/password', { current: 'clave-de-la-titular', next: 'otra-clave-bien-larga' })).status, 200);
});

/* ------------------------------ Facturación ------------------------------ */
const { useMailer } = await import('../lib/mail.js');
const { composeEmail } = await import('../lib/invoices.js');
const mails = []; let mailDown = false;
useMailer(async (m) => { if (mailDown) throw new Error('smtp caído'); mails.push(m); return { messageId: 'x' }; });
const invDay = addDays(monday, 7), year = madrid().day.slice(0, 4);
let piSeq = 0;
const pay = async (h) => { const pi = `pi_inv_${++piSeq}`; const r = await stripeEvent('checkout.session.completed', { id: `cs_inv_${piSeq}`, client_reference_id: h.data.id, payment_status: 'paid', payment_intent: pi }); return { pi, r }; };
const invoicesOf = async (id) => (await q('select * from invoices where booking_id = $1 order by kind', [id])).rows;
const issuer = { name: 'Titular De Prueba', taxId: '00000000-T', address: 'Calle de Ejemplo, 1, 46001 Valencia', extra: 'Colegiada n.º 00000', contact: '600 000 000 · titular@example.com' };
let first;

await test('facturación apagada: se cobra y se confirma sin factura', async () => {
  const h = await book(invDay, '09:00', 60);
  assert.equal(h.status, 201);
  assert.equal((await pay(h)).r.data.result, 'confirmed');
  assert.equal((await invoicesOf(h.data.id)).length, 0);
  assert.equal(mails.length, 0);
  first = h;
});

await test('no se puede activar la facturación sin los datos fiscales de la titular', async () => {
  const bad = await api('PUT', '/admin/settings', { invoice: { enabled: true, issuer: { name: 'X' } } });
  assert.equal(bad.status, 400); assert.equal(bad.data.error, 'issuer_incomplete');
  assert.equal((await api('PUT', '/admin/settings', { invoice: { enabled: true, series: 'R', issuer } })).data.error, 'bad_series');
  const ok = await api('PUT', '/admin/settings', { invoice: { enabled: true, series: 'a', vatBp: 2100, copyTo: 'gestoria@example.com', issuer } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.invoice.series, 'A');
  assert.equal(ok.data.settings.invoice.issuer.taxId, '00000000T');
});

await test('al cobrar se expide la factura simplificada, con IVA desglosado, y se envía con el PDF', async () => {
  const h = await book(invDay, '10:00', 61, { lang: 'ru' });
  await pay(h);
  const [inv] = await invoicesOf(h.data.id);
  assert.equal(inv.code, `A${year}-0001`);
  assert.equal(inv.simplified, true);
  assert.equal(inv.total_cents, 8000); assert.equal(inv.base_cents, 6612); assert.equal(inv.vat_cents, 1388);
  assert.equal(inv.base_cents + inv.vat_cents, inv.total_cents);
  assert.equal(inv.data.issuer.taxId, '00000000T');
  assert.ok(inv.sent_at, 'queda marcada como enviada');
  const m = mails.at(-1);
  assert.equal(m.to, 'cliente61@example.com'); assert.equal(m.bcc, 'gestoria@example.com');
  assert.match(m.subject, /Счёт-фактура A\d{4}-0001/);
  assert.equal(m.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.ok(m.attachments[0].content.length > 8000);
  assert.match(m.html, /A\d{4}-0001/);
});

await test('un aviso de pago repetido no duplica la factura ni el correo', async () => {
  const h = await book(invDay, '11:00', 62);
  const { pi } = await pay(h);
  const before = mails.length;
  const again = await stripeEvent('checkout.session.completed', { id: 'cs_dup', client_reference_id: h.data.id, payment_status: 'paid', payment_intent: pi });
  assert.equal(again.data.result, 'already');
  assert.equal((await invoicesOf(h.data.id)).length, 1);
  assert.equal(mails.length, before);
});

await test('con NIF y domicilio del cliente la factura es completa; un NIF mal escrito se rechaza', async () => {
  assert.equal((await book(invDay, '12:00', 63, { taxId: '!!' })).data.error, 'bad_tax_id');
  const h = await book(invDay, '12:00', 64, { taxId: 'x-0000000 t', billAddress: 'Calle Mayor, 2, 46002 Valencia' });
  await pay(h);
  const [inv] = await invoicesOf(h.data.id);
  assert.equal(inv.simplified, false);
  assert.equal(inv.data.recipient.taxId, 'X0000000T');
  assert.equal(inv.code, `A${year}-0003`, 'numeración correlativa');
});

await test('si el correo falla, la reserva sigue confirmada y la factura queda pendiente de envío', async () => {
  mailDown = true;
  const h = await book(invDay, '13:00', 65);
  assert.equal((await pay(h)).r.data.result, 'confirmed');
  assert.equal((await statusOf(h.data.id)).status, 'confirmed');
  let [inv] = await invoicesOf(h.data.id);
  assert.equal(inv.sent_at, null); assert.match(inv.send_error, /smtp/);
  const fail = await api('POST', '/admin/invoices/send', { bookingId: h.data.id });
  assert.equal(fail.status, 502); assert.equal(fail.data.error, 'mail_failed');
  mailDown = false;
  const ok = await api('POST', '/admin/invoices/send', { bookingId: h.data.id });
  assert.equal(ok.status, 200); assert.equal(ok.data.code, inv.code);
  [inv] = await invoicesOf(h.data.id);
  assert.ok(inv.sent_at); assert.equal(inv.send_error, null);
});

await test('una reserva cobrada antes de activar la facturación se factura desde el panel, sin huecos', async () => {
  const r = await api('POST', '/admin/invoices/send', { bookingId: first.data.id });
  assert.equal(r.status, 200); assert.equal(r.data.code, `A${year}-0005`);
  const nums = (await q(`select number from invoices where series = $1 order by number`, [`A${year}`])).rows.map((x) => x.number);
  assert.deepEqual(nums, [1, 2, 3, 4, 5]);
});

await test('cancelar con devolución expide la factura rectificativa en su propia serie', async () => {
  const h = await book(invDay, '16:00', 66);
  await pay(h);
  const c = await api('POST', '/admin/bookings/cancel', { id: h.data.id, refund: true, reason: 'Petición del cliente' });
  assert.equal(c.data.status, 'refunded'); assert.equal(c.data.rectification, `R${year}-0001`);
  const [f, r] = await invoicesOf(h.data.id);
  assert.equal(r.kind, 'R'); assert.equal(r.rectifies, f.id);
  assert.equal(r.total_cents, -f.total_cents); assert.equal(r.base_cents, -f.base_cents); assert.equal(r.vat_cents, -f.vat_cents);
  assert.equal(r.data.rectifies.code, f.code);
  assert.match(mails.at(-1).subject, /Factura rectificativa R\d{4}-0001/);
});

await test('devolución hecha desde Stripe: rectificativa una sola vez', async () => {
  const h = await book(invDay, '17:00', 67);
  const { pi } = await pay(h);
  await stripeEvent('charge.refunded', { refunded: true, payment_intent: pi });
  await stripeEvent('charge.refunded', { refunded: true, payment_intent: pi });
  const list = await invoicesOf(h.data.id);
  assert.equal(list.length, 2); assert.equal(list[1].code, `R${year}-0002`);
});

await test('cancelar sin devolver el dinero no rectifica la factura', async () => {
  const h = await book(invDay, '18:00', 68);
  await pay(h);
  const c = await api('POST', '/admin/bookings/cancel', { id: h.data.id, refund: false });
  assert.equal(c.data.status, 'cancelled'); assert.equal(c.data.rectification, null);
  assert.equal((await invoicesOf(h.data.id)).length, 1);
});

await test('más de 400 € sin NIF ni domicilio: no hay factura simplificada posible y se avisa', async () => {
  await api('PUT', '/admin/settings', { modes: { presencial: { priceCents: 9000 }, video: { priceCents: 45000 }, telefono: { enabled: false } } });
  const h = await book(addDays(invDay, 1), '09:00', 69);
  assert.equal((await pay(h)).r.data.result, 'confirmed');
  assert.equal((await invoicesOf(h.data.id)).length, 0);
  const r = await api('POST', '/admin/invoices/send', { bookingId: h.data.id });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'invoice_recipient_data_required');
  await api('PUT', '/admin/settings', { modes: { presencial: { priceCents: 9000 }, video: { priceCents: 8000 }, telefono: { enabled: false } } });
});

await test('el PDF solo se descarga con sesión y el listado del panel trae la factura', async () => {
  const id = (await q(`select id from invoices where code = $1`, [`A${year}-0001`])).rows[0].id;
  const anon = await handle(new Request(`https://web.test/api/admin/invoice?id=${id}`, { headers: { host: 'web.test' } }));
  assert.equal(anon.status, 401);
  const res = await handle(new Request(`https://web.test/api/admin/invoice?id=${id}`, { headers: { host: 'web.test', cookie, 'x-forwarded-proto': 'https' } }));
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api('GET', '/admin/invoice?id=no-es-un-id')).status, 404);
  const day = await api('GET', `/admin/day?day=${invDay}`);
  const withInv = day.data.bookings.find((b) => b.invoice && b.invoice.code === `A${year}-0001`);
  assert.ok(withInv && withInv.invoice.sent_at);
  assert.ok(day.data.bookings.some((b) => b.rectification && b.rectification.code === `R${year}-0001`));
});

await test('el correo sale en el idioma del cliente', async () => {
  const inv = (await q(`select * from invoices where code = $1`, [`A${year}-0001`])).rows[0];
  for (const [lang, word] of [['es', 'Factura'], ['it', 'Fattura'], ['ru', 'Счёт-фактура'], ['hy', 'Հաշիվ']]) {
    const m = composeEmail({ ...inv, data: { ...inv.data, lang } });
    assert.ok(m.subject.startsWith(word), lang); assert.ok(m.html.includes(inv.code)); assert.ok(m.text.includes(inv.code));
  }
});

/* ------------------- Facturas emitidas desde el panel ------------------- */
const today = madrid().day;
const empresa = { name: 'Empresa Ejemplo SL', taxId: 'b-00000000', address: 'Calle Uno, 1, 46001 Valencia', email: 'empresa@example.com' };
const rowOf = async (id) => (await q('select * from invoices where id = $1', [id])).rows[0];
let manual, simple;

await test('factura a mano: misma numeración que las de la web, con IVA y retención de IRPF', async () => {
  const before = mails.length;
  const r = await api('POST', '/admin/invoices', { recipient: empresa, irpfBp: 1500, send: true, lines: [
    { concept: 'Asistencia letrada en declaración', qty: 1, unitCents: 30000 }, { concept: 'Estudio de la causa', qty: 2.5, unitCents: 8000 }] });
  assert.equal(r.status, 201); assert.equal(r.data.code, `A${year}-0009`, 'sigue a la última factura de la web'); assert.equal(r.data.sent, true);
  const inv = await rowOf(r.data.id);
  assert.equal(inv.base_cents, 50000); assert.equal(inv.vat_cents, 10500); assert.equal(inv.total_cents, 60500); assert.equal(inv.irpf_cents, 7500);
  assert.equal(inv.origin, 'panel'); assert.equal(inv.simplified, false); assert.equal(inv.paid_on, null); assert.equal(inv.booking_id, null);
  assert.equal(inv.data.recipient.taxId, 'B00000000'); assert.equal(inv.data.lines[1].baseCents, 20000);
  assert.equal(mails.length, before + 1);
  assert.ok(mails.at(-1).html.includes('530,00'), 'el correo indica el importe a pagar');
  assert.equal(mails.at(-1).attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  manual = r.data;
});

await test('factura a mano: validaciones de datos, importe y fecha', async () => {
  const line = [{ concept: 'Consulta', qty: 1, unitCents: 10000 }];
  const post = (b) => api('POST', '/admin/invoices', b);
  assert.equal((await post({ recipient: { name: 'X Y' }, lines: [] })).data.error, 'bad_lines');
  assert.equal((await post({ recipient: { name: 'X Y' }, lines: [{ concept: 'Consulta', qty: 0, unitCents: 100 }] })).data.error, 'bad_lines');
  assert.equal((await post({ recipient: { name: '' }, lines: line })).data.error, 'bad_recipient');
  assert.equal((await post({ recipient: { name: 'X Y', taxId: '??' }, lines: line })).data.error, 'bad_tax_id');
  assert.equal((await post({ recipient: { name: 'X Y' }, lines: [{ concept: 'Juicio', qty: 1, unitCents: 50000 }] })).data.error, 'recipient_data_required', 'más de 400 € exige NIF y domicilio');
  assert.equal((await post({ recipient: { name: 'X Y' }, lines: line, irpfBp: 1500 })).data.error, 'recipient_data_required', 'la retención exige NIF y domicilio');
  assert.equal((await post({ recipient: { name: 'X Y' }, lines: line, issuedOn: addDays(today, 1) })).data.error, 'bad_date', 'no admite fecha futura');
  assert.equal((await post({ recipient: { name: 'X Y' }, lines: line, issuedOn: addDays(today, -1) })).data.error, 'bad_date', 'no admite fecha anterior a la última de la serie');
  assert.equal((await api('POST', '/admin/invoices', { recipient: { name: 'X Y' }, lines: line }, { auth: false })).status, 401);
  const n = (await q(`select count(*)::int as n from invoices where series = $1`, [`A${year}`])).rows[0].n;
  assert.equal(n, 9, 'ningún intento fallido consume número');
});

await test('factura simplificada a mano, cobrada y vuelta a pendiente', async () => {
  const r = await api('POST', '/admin/invoices', { recipient: { name: 'Particular Ejemplo' }, lines: [{ concept: 'Consulta', qty: 1, unitCents: 10000 }] });
  assert.equal(r.data.code, `A${year}-0010`); assert.equal(r.data.sent, false);
  let inv = await rowOf(r.data.id);
  assert.equal(inv.simplified, true); assert.equal(inv.total_cents, 12100);
  assert.equal((await api('POST', '/admin/invoices/paid', { id: r.data.id, paidOn: addDays(today, 1) })).data.error, 'bad_paid_date');
  assert.equal((await api('POST', '/admin/invoices/paid', { id: r.data.id, paidOn: today })).data.paid_on, today);
  assert.equal((await rowOf(r.data.id)).paid_on, today);
  assert.equal((await api('POST', '/admin/invoices/paid', { id: r.data.id, paidOn: null })).data.paid_on, null);
  const web = (await q(`select id from invoices where origin = 'web' and kind = 'F' limit 1`)).rows[0].id;
  assert.equal((await api('POST', '/admin/invoices/paid', { id: web, paidOn: today })).data.error, 'not_editable', 'las de la web ya nacen cobradas');
  assert.equal((await api('POST', '/admin/invoices/send', { invoiceId: r.data.id })).data.error, 'no_client_email');
  simple = r.data;
});

await test('rectificar una factura a mano: una sola vez, con los importes en negativo', async () => {
  const r = await api('POST', '/admin/invoices/rectify', { id: manual.id, reason: 'Error en el concepto' });
  assert.equal(r.status, 201); assert.equal(r.data.code, `R${year}-0003`);
  const rec = await rowOf(r.data.id);
  assert.equal(rec.total_cents, -60500); assert.equal(rec.irpf_cents, -7500); assert.equal(rec.rectifies, manual.id);
  assert.equal((await api('POST', '/admin/invoices/rectify', { id: manual.id })).data.error, 'already_rectified');
  assert.equal((await api('POST', '/admin/invoices/rectify', { id: r.data.id })).data.error, 'not_rectifiable');
  const web = (await q(`select id from invoices where origin = 'web' and kind = 'F' limit 1`)).rows[0].id;
  assert.equal((await api('POST', '/admin/invoices/rectify', { id: web })).data.error, 'rectify_via_booking');
});

await test('libro de facturas: web y panel juntas, totales por trimestre y pendiente de cobro', async () => {
  const r = await api('GET', `/admin/invoices?year=${year}`);
  assert.equal(r.status, 200);
  const db = (await q(`select count(*)::int as n, sum(base_cents)::int as base, sum(vat_cents)::int as vat, sum(irpf_cents)::int as irpf, sum(total_cents)::int as total from invoices where issued_on like $1`, [`${year}-%`])).rows[0];
  assert.equal(r.data.invoices.length, db.n);
  assert.deepEqual([r.data.totals.base, r.data.totals.vat, r.data.totals.irpf, r.data.totals.total], [db.base, db.vat, db.irpf, db.total]);
  assert.equal(r.data.quarters.reduce((a, x) => a + x.total, 0), db.total);
  assert.ok(r.data.invoices.some((i) => i.origin === 'web' && i.booking_ref) && r.data.invoices.some((i) => i.origin === 'panel'));
  const m = r.data.invoices.find((i) => i.id === manual.id);
  assert.equal(m.rectified_by, `R${year}-0003`); assert.equal(m.client, 'Empresa Ejemplo SL');
  assert.deepEqual(r.data.pending, { count: 1, cents: 12100 }, 'solo la simplificada sigue pendiente; la rectificada no cuenta');
  assert.ok(r.data.years.includes(year));
  assert.equal((await api('GET', '/admin/invoices', undefined, { auth: false })).status, 401);
});

await test('exportación para la gestoría y PDF de una factura a mano', async () => {
  await api('POST', '/admin/invoices', { recipient: { name: '=HYPERLINK("http://x")' }, lines: [{ concept: 'Consulta; con punto y coma', qty: 1, unitCents: 5000 }] });
  const res = await handle(new Request(`https://web.test/api/admin/invoices/export?year=${year}`, { headers: { host: 'web.test', cookie, 'x-forwarded-proto': 'https' } }));
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/csv/); assert.match(res.headers.get('content-disposition'), new RegExp(`facturas-${year}\\.csv`));
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'marca para que Excel lea los acentos');
  const csv = bytes.subarray(3).toString('utf8');
  assert.ok(csv.startsWith('Número;Fecha;Tipo;NIF cliente;Cliente'));
  const line = csv.split('\r\n').find((l) => l.startsWith(`A${year}-0009;`));
  assert.ok(line.includes(';B00000000;Empresa Ejemplo SL;') && line.includes(';500,00;21;105,00;15;75,00;605,00;530,00;'), line);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), 'una celda que empieza por = no se ejecuta como fórmula');
  assert.ok(csv.includes('"Consulta; con punto y coma"'));
  assert.equal(csv.trim().split('\r\n').length - 1, (await q(`select count(*)::int as n from invoices where issued_on like $1`, [`${year}-%`])).rows[0].n);
  const anon = await handle(new Request(`https://web.test/api/admin/invoices/export?year=${year}`, { headers: { host: 'web.test' } }));
  assert.equal(anon.status, 401);
  const pdf = await handle(new Request(`https://web.test/api/admin/invoice?id=${manual.id}`, { headers: { host: 'web.test', cookie, 'x-forwarded-proto': 'https' } }));
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

/* ------------------------------ VERI*FACTU ------------------------------ */
const { useVerifactu, spanishTaxId } = await import('../lib/verifactu.js');
const vfTries = []; let vfDown = false, vfReject = null, vfSeq = 0;
const vfStatus = new Map();
const provider = async ({ method, path, body, headers }) => {
  if (path === '/verifactu/declaracion') return { status: 200, data: { url: 'https://proveedor.test/declaracion', url_version: 'https://proveedor.test/declaracion/1.0.3', sistema_informatico: { nombre: 'proveedor', id: 'A1', version: '1.0.3' } } };
  if (method === 'POST' && path === '/verifactu/create') {
    vfTries.push({ body, key: headers['Idempotency-Key'], down: vfDown });
    if (vfDown) return { status: 503, data: {} };
    if (vfReject && vfReject(body)) return { status: 400, data: { error: 'El NIF no está identificado en el censo de la AEAT', codigo: 'vf-verifactu-nif_no_censado' } };
    const uuid = `uuid-${++vfSeq}`; vfStatus.set(uuid, { estado: 'Pendiente' });
    return { status: 200, data: { uuid, estado: 'Pendiente', qr: 'AAAA', huella: 'F'.repeat(64),
      url: `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=00000000T&numserie=${encodeURIComponent(body.serie + body.numero)}&fecha=${body.fecha_expedicion}&importe=${body.importe_total}` } };
  }
  if (vfDown) return { status: 503, data: {} };
  if (method === 'GET' && path.startsWith('/verifactu/status')) return { status: 200, data: vfStatus.get(new URL('https://x' + path).searchParams.get('uuid')) || { estado: 'No registrado' } };
  return { status: 404, data: {} };
};
const sent = () => vfTries.filter((t) => !t.down);
const esToday = today.split('-').reverse().join('-');
const euros = (c) => (c / 100).toFixed(2);
const recheck = () => q(`update invoices set vf_checked_at = null where vf_state = 'pending'`);
const declarationData = { producer: { name: 'Productor De Prueba', taxId: '12345678Z', address: 'Calle Dos, 2, 46001 Valencia', contact: 'productor@example.com' }, place: 'Valencia', signedOn: today };
let vfWeb, vfFull;

await test('VERI*FACTU: validación del NIF, NIE y NIF de entidad', async () => {
  for (const ok of ['00000000T', '12345678Z', 'x1234567l', 'B00000000', 'B12345674']) assert.equal(spanishTaxId(ok), true, ok);
  for (const bad of ['12345678A', 'X1234567A', 'B12345678', 'YA1234567', '', '1234']) assert.equal(spanishTaxId(bad), false, bad);
});

await test('VERI*FACTU: no se enciende sin clave ni, con la clave real, sin declaración responsable', async () => {
  const none = await api('PUT', '/admin/settings', { verifactu: { enabled: true } });
  assert.equal(none.status, 409); assert.equal(none.data.error, 'vf_not_configured');
  useVerifactu(provider, 'prod');
  const noDecl = await api('PUT', '/admin/settings', { verifactu: { enabled: true } });
  assert.equal(noDecl.status, 409); assert.equal(noDecl.data.error, 'vf_declaration_incomplete');
  assert.equal((await api('PUT', '/admin/settings', { verifactu: { enabled: false, signedOn: addDays(today, 1) } })).data.error, 'bad_signed_date');
  useVerifactu(provider, 'test');
  const ok = await api('PUT', '/admin/settings', { verifactu: { enabled: true } });
  assert.equal(ok.status, 200); assert.equal(ok.data.settings.verifactu.enabled, true);
  const st = await api('GET', '/admin/settings');
  assert.equal(st.data.verifactu, 'test'); assert.equal(st.data.cron, false);
});

await test('VERI*FACTU: al cobrar se registra la factura (F2) y solo entonces sale el correo', async () => {
  const before = mails.length, tries = vfTries.length;
  const h = await book(addDays(invDay, 2), '16:00', 80);
  assert.equal(h.status, 201);
  assert.equal((await pay(h)).r.data.result, 'confirmed');
  const inv = (await invoicesOf(h.data.id))[0];
  assert.equal(inv.vf_state, 'pending'); assert.equal(inv.vf_env, 'test'); assert.ok(inv.vf_uuid); assert.equal(inv.vf_error, null);
  assert.equal(vfTries.length, tries + 1);
  const t = vfTries.at(-1);
  assert.equal(t.key, `ia-${inv.id}-0`);
  assert.deepEqual(t.body, {
    serie: `A${year}-`, numero: String(inv.number).padStart(4, '0'), fecha_expedicion: esToday, tipo_factura: 'F2', descripcion: 'Consulta jurídica por videollamada',
    lineas: [{ base_imponible: euros(inv.base_cents), tipo_impositivo: '21', cuota_repercutida: euros(inv.vat_cents) }], importe_total: euros(inv.total_cents)
  });
  assert.equal(new URL(inv.vf_url).searchParams.get('numserie'), inv.code, 'el número registrado es el impreso en la factura');
  assert.equal(mails.length, before + 1); assert.ok(inv.sent_at);
  vfStatus.set(inv.vf_uuid, { estado: 'Correcto' });
  const list = await api('GET', `/admin/invoices?year=${year}`);
  const row = list.data.invoices.find((x) => x.id === inv.id);
  assert.equal(row.vf_state, 'ok'); assert.equal(list.data.verifactu.enabled, true); assert.equal(list.data.verifactu.mode, 'test');
  vfWeb = { booking: h.data.id, id: inv.id, code: inv.code, number: inv.number };
});

await test('VERI*FACTU: proveedor caído. La reserva se confirma, la factura queda en cola y no se entrega', async () => {
  vfDown = true;
  const before = mails.length;
  const h = await book(addDays(invDay, 2), '17:00', 81);
  assert.equal(h.status, 201);
  assert.equal((await pay(h)).r.data.result, 'confirmed', 'el cobro no depende de la AEAT');
  const a = (await invoicesOf(h.data.id))[0];
  assert.equal(a.vf_state, 'queued'); assert.equal(a.sent_at, null); assert.match(a.vf_error, /503/);
  const m = await api('POST', '/admin/invoices', { recipient: { name: 'Cliente En Cola', email: 'cola@example.com' }, send: true, lines: [{ concept: 'Consulta', qty: 1, unitCents: 5000 }] });
  assert.equal(m.status, 201); assert.equal(m.data.vf, 'queued'); assert.equal(m.data.sent, false);
  assert.equal(mails.length, before, 'ninguna sale hacia el cliente sin registro');
  const send = await api('POST', '/admin/invoices/send', { invoiceId: a.id });
  assert.equal(send.status, 409); assert.equal(send.data.error, 'vf_not_registered');
  const list = await api('GET', `/admin/invoices?year=${year}`);
  assert.equal(list.data.verifactu.queued, 2);
  const pdf = await handle(new Request(`https://web.test/api/admin/invoice?id=${a.id}`, { headers: { host: 'web.test', cookie, 'x-forwarded-proto': 'https' } }));
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  // La tarea horaria solo responde a Vercel
  assert.equal((await api('GET', '/cron/verifactu', undefined, { auth: false, panel: false })).status, 401);
  process.env.CRON_SECRET = 'secreto-de-la-tarea-horaria';
  assert.equal((await api('GET', '/cron/verifactu', undefined, { auth: false, panel: false, headers: { authorization: 'Bearer otro' } })).status, 401);
  const still = await api('GET', '/cron/verifactu', undefined, { auth: false, panel: false, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(still.status, 200); assert.equal(still.data.registered, 0); assert.equal(still.data.stopped, true); assert.equal(still.data.queued, 2);

  vfDown = false;
  const okCount = sent().length;
  const run = await api('GET', '/cron/verifactu', undefined, { auth: false, panel: false, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(run.data.registered, 2); assert.equal(run.data.queued, 0);
  const order = sent().slice(okCount).map((t) => t.body.numero);
  assert.deepEqual(order, [String(a.number).padStart(4, '0'), String(a.number + 1).padStart(4, '0')], 'se envían en el orden en que se expidieron');
  const keys = vfTries.filter((t) => t.body.numero === order[0]).map((t) => t.key);
  assert.ok(keys.length >= 3 && new Set(keys).size === 1, 'los reintentos repiten la misma clave: no puede haber dos registros de una factura');
  assert.equal(mails.length, before + 2, 'al quedar registradas, salen solas');
  assert.equal((await rowOf(a.id)).vf_state, 'pending'); assert.ok((await rowOf(m.data.id)).sent_at);
});

await test('VERI*FACTU: datos que la AEAT no admite. No sale nada, se corrigen y se registra con el mismo número', async () => {
  vfReject = (b) => b.nif === '12345678Z';
  const before = mails.length;
  const r = await api('POST', '/admin/invoices', { recipient: { name: 'Nombre Mal Escrito', taxId: '12345678Z', address: 'Calle Tres, 3, 46001 Valencia', email: 'mal@example.com' }, send: true, lines: [{ concept: 'Consulta', qty: 1, unitCents: 10000 }] });
  assert.equal(r.status, 201); assert.equal(r.data.vf, 'invalid'); assert.equal(r.data.sent, false); assert.equal(mails.length, before);
  const bad = await rowOf(r.data.id);
  assert.match(bad.vf_error, /censo/); assert.equal(bad.vf_uuid, null);
  assert.equal((await api('GET', `/admin/invoices?year=${year}`)).data.verifactu.invalid, 1);
  assert.equal((await api('POST', '/admin/invoices/fix', { id: r.data.id, recipient: { name: 'Nombre Correcto', taxId: '12345678A', address: 'Calle Tres, 3' } })).data.error, 'bad_tax_id_es');
  const fix = await api('POST', '/admin/invoices/fix', { id: r.data.id, recipient: { name: 'Nombre Correcto', taxId: '00000000T', address: 'Calle Tres, 3, 46001 Valencia' } });
  assert.equal(fix.status, 200); assert.equal(fix.data.code, r.data.code); assert.equal(fix.data.vf, 'pending');
  const t = vfTries.at(-1);
  assert.equal(t.key, `ia-${r.data.id}-1`, 'el contenido ha cambiado: clave nueva'); assert.equal(t.body.nif, '00000000T'); assert.equal(t.body.nombre, 'Nombre Correcto');
  assert.equal(mails.length, before + 1, 'registrada, sale hacia el cliente');
  assert.equal((await api('POST', '/admin/invoices/fix', { id: r.data.id, simplified: true })).data.error, 'not_fixable');
  vfReject = null;
});

await test('VERI*FACTU: factura completa con retención. F1 con NIF; el IRPF no forma parte del registro', async () => {
  const yesterday = addDays(today, -1);
  const r = await api('POST', '/admin/invoices', { recipient: empresa, irpfBp: 1500, operationOn: yesterday, lines: [{ concept: 'Defensa en juicio', qty: 1, unitCents: 50000 }, { concept: 'Desplazamiento', qty: 1, unitCents: 0 }] });
  assert.equal(r.status, 201); assert.equal(r.data.vf, 'pending'); assert.equal(r.data.sent, false);
  const b = vfTries.at(-1).body;
  assert.equal(b.tipo_factura, 'F1'); assert.equal(b.nif, 'B00000000'); assert.equal(b.nombre, 'Empresa Ejemplo SL'); assert.equal(b.id_otro, undefined);
  assert.equal(b.importe_total, '605.00'); assert.deepEqual(b.lineas, [{ base_imponible: '500.00', tipo_impositivo: '21', cuota_repercutida: '105.00' }]);
  assert.equal(b.fecha_expedicion, esToday); assert.equal(b.fecha_operacion, yesterday.split('-').reverse().join('-'));
  assert.equal(b.descripcion, 'Defensa en juicio y 1 concepto más'); assert.equal(JSON.stringify(b).includes('75'), false, 'ni rastro de la retención');
  vfFull = { id: r.data.id, code: r.data.code };
});

await test('VERI*FACTU: cliente sin NIF español, con pasaporte y país', async () => {
  const base = { lines: [{ concept: 'Consulta', qty: 1, unitCents: 60000 }] };
  assert.equal((await api('POST', '/admin/invoices', { ...base, recipient: { name: 'Mario Rossi', taxId: 'YA1234567', address: 'Via Roma 1, Milano' } })).data.error, 'bad_tax_id_es');
  assert.equal((await api('POST', '/admin/invoices', { ...base, recipient: { name: 'Mario Rossi', taxId: 'YA1234567', address: 'Via Roma 1, Milano', idType: '03' } })).data.error, 'bad_id_doc');
  const r = await api('POST', '/admin/invoices', { ...base, recipient: { name: 'Mario Rossi', taxId: 'YA1234567', address: 'Via Roma 1, Milano', idType: '03', idCountry: 'it' } });
  assert.equal(r.status, 201);
  const b = vfTries.at(-1).body;
  assert.equal(b.tipo_factura, 'F1'); assert.equal(b.nif, undefined); assert.deepEqual(b.id_otro, { id_type: '03', id: 'YA1234567', codigo_pais: 'IT' });
});

await test('VERI*FACTU: la factura lleva la fecha de hoy y no se emite sin IVA', async () => {
  const base = { recipient: { name: 'Cliente Reglas' }, lines: [{ concept: 'Consulta', qty: 1, unitCents: 5000 }] };
  assert.equal((await api('POST', '/admin/invoices', { ...base, issuedOn: addDays(today, -1) })).data.error, 'vf_date_today');
  assert.equal((await api('POST', '/admin/invoices', { ...base, vatBp: 0 })).data.error, 'vf_vat_zero');
  assert.equal((await api('POST', '/admin/invoices', { ...base, operationOn: addDays(today, 1) })).data.error, 'bad_operation_date');
});

await test('VERI*FACTU: rectificativas. R4 o R1 para la completa, R5 para la simplificada, en negativo y con la referencia', async () => {
  const r = await api('POST', '/admin/invoices/rectify', { id: vfFull.id, reason: 'error en el concepto', rectType: 'R4' });
  assert.equal(r.status, 201); assert.equal(r.data.vf, 'pending');
  let b = vfTries.at(-1).body;
  assert.equal(b.tipo_factura, 'R4'); assert.equal(b.tipo_rectificativa, 'I'); assert.equal(b.serie, `R${year}-`); assert.equal(b.nif, 'B00000000');
  assert.equal(b.importe_total, '-605.00'); assert.deepEqual(b.lineas, [{ base_imponible: '-500.00', tipo_impositivo: '21', cuota_repercutida: '-105.00' }]);
  assert.deepEqual(b.facturas_rectificadas, [{ serie: `A${year}-`, numero: vfFull.code.split('-')[1], fecha_expedicion: esToday }]);
  assert.equal(b.fecha_operacion, undefined); assert.match(b.descripcion, new RegExp(`Rectificación de la factura ${vfFull.code}: error en el concepto`));

  const before = mails.length;
  const c = await api('POST', '/admin/bookings/cancel', { id: vfWeb.booking, refund: true, reason: 'No puede asistir' });
  assert.equal(c.status, 200); assert.equal(c.data.status, 'refunded');
  b = vfTries.at(-1).body;
  assert.equal(b.tipo_factura, 'R5'); assert.equal(b.nombre, undefined); assert.equal(b.nif, undefined);
  assert.deepEqual(b.facturas_rectificadas, [{ serie: `A${year}-`, numero: String(vfWeb.number).padStart(4, '0'), fecha_expedicion: esToday }]);
  assert.ok(Number(b.importe_total) < 0);
  assert.equal(mails.length, before + 1, 'la rectificativa registrada sale hacia el cliente');
});

await test('VERI*FACTU: respuesta de la AEAT. Rechazada o con errores, se ve en el libro', async () => {
  const full = await rowOf(vfFull.id);
  vfStatus.set(full.vf_uuid, { estado: 'Incorrecto', codigo_error: '4104', mensaje_error: 'NIF del destinatario no identificado' });
  const other = (await q(`select id, vf_uuid from invoices where vf_state = 'pending' and id <> $1 order by created_at limit 1`, [vfFull.id])).rows[0];
  vfStatus.set(other.vf_uuid, { estado: 'Aceptado con errores', mensaje_error: 'Aviso de prueba' });
  await recheck();
  const list = await api('GET', `/admin/invoices?year=${year}`);
  const a = list.data.invoices.find((x) => x.id === vfFull.id), b = list.data.invoices.find((x) => x.id === other.id);
  assert.equal(a.vf_state, 'rejected'); assert.match(a.vf_error, /4104/); assert.equal(b.vf_state, 'ok_errors'); assert.match(b.vf_error, /Aviso de prueba/);
  assert.equal(list.data.verifactu.rejected, 1); assert.equal(list.data.verifactu.okErrors, 1);
  await q(`update invoices set data = jsonb_set(data, '{recipient,email}', '"empresa@example.com"') where id = $1`, [vfFull.id]);
  assert.equal((await api('POST', '/admin/invoices/send', { invoiceId: vfFull.id })).data.error, 'vf_not_registered', 'una factura rechazada no se envía');
});

await test('VERI*FACTU: con la clave real hace falta la declaración y, tras el primer envío, ya no se apaga', async () => {
  useVerifactu(provider, 'prod');
  const before = sent().length;
  const held = await api('POST', '/admin/invoices', { recipient: { name: 'Cliente Real' }, lines: [{ concept: 'Consulta', qty: 1, unitCents: 5000 }] });
  assert.equal(held.data.vf, 'queued'); assert.equal(sent().length, before, 'sin declaración responsable no sale ningún registro real');
  assert.match((await rowOf(held.data.id)).vf_error, /declaración responsable/);
  const draft = await api('GET', '/admin/verifactu/declaration');
  assert.equal(draft.data.complete, false); assert.equal(draft.data.provider.version, '1.0.3'); assert.equal(draft.data.system.version, '1.0.0');
  const ok = await api('PUT', '/admin/settings', { verifactu: { enabled: true, ...declarationData } });
  assert.equal(ok.status, 200); assert.equal(ok.data.settings.verifactu.producer.taxId, '12345678Z');
  const retry = await api('POST', '/admin/verifactu/retry');
  assert.equal(retry.status, 200); assert.equal(retry.data.registered, 1);
  const real = await rowOf(held.data.id);
  assert.equal(real.vf_env, 'prod'); assert.equal(real.vf_state, 'pending');
  assert.equal((await api('GET', '/admin/verifactu/declaration')).data.complete, true);
  const off = await api('PUT', '/admin/settings', { verifactu: { enabled: false } });
  assert.equal(off.status, 409); assert.equal(off.data.error, 'vf_locked');
  assert.equal((await api('PUT', '/admin/settings', { verifactu: { enabled: true, place: '' } })).data.error, 'vf_declaration_incomplete');
});

await test('VERI*FACTU: sin sesión no se toca nada', async () => {
  for (const [m, p] of [['POST', '/admin/verifactu/retry'], ['POST', '/admin/invoices/fix'], ['GET', '/admin/verifactu/declaration']]) assert.equal((await api(m, p, m === 'POST' ? {} : undefined, { auth: false })).status, 401);
});

/* ------------------- Días libres, vacaciones y cambio de hora ------------------- */
const vacFrom = addDays(monday, 28), vacTo = addDays(vacFrom, 9), moveDay = addDays(monday, 21);

await test('vacaciones: un tramo cierra todos sus días y se puede reabrir', async () => {
  assert.equal((await api('POST', '/admin/closures', { from: vacTo, to: vacFrom })).data.error, 'bad_range');
  assert.equal((await api('POST', '/admin/closures', { from: addDays(today, -20), to: addDays(today, -10) })).data.error, 'bad_range');
  assert.equal((await api('POST', '/admin/closures', { from: vacFrom, to: addDays(vacFrom, 200) })).data.error, 'range_too_long');
  assert.equal((await api('POST', '/admin/closures', { from: vacFrom, to: vacTo, note: 'Vacaciones' }, { auth: false })).status, 401);
  // una reserva ya confirmada dentro del tramo se mantiene y se avisa
  const kept = await api('POST', '/admin/bookings', { day: addDays(vacFrom, 1), time: '10:00', mode: 'video', name: 'Cliente Antes De Vacaciones', phone: '600 111 222' });
  assert.equal(kept.status, 201);
  const r = await api('POST', '/admin/closures', { from: vacFrom, to: vacTo, note: 'Vacaciones' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data, { days: 10, bookings: 1 });
  const av = await api('GET', `/availability?from=${vacFrom}&to=${vacTo}`);
  assert.deepEqual(av.data.days, {});
  const list = await api('GET', `/admin/closures?from=${vacFrom}`);
  assert.deepEqual(list.data.closures, [{ from: vacFrom, to: vacTo, note: 'Vacaciones', days: 10, bookings: 1 }]);
  const d = await api('GET', `/admin/day?day=${addDays(vacFrom, 1)}`);
  assert.equal(d.data.day.closed, true);
  assert.equal(d.data.day.slots.find((x) => x.time === '10:00').state, 'booked');
  // repetir el cierre no duplica nada; un día suelto con otro motivo forma tramo aparte
  await api('POST', '/admin/closures', { from: vacFrom, to: vacTo, note: 'Vacaciones' });
  await api('POST', '/admin/closures', { from: addDays(vacTo, 1), to: addDays(vacTo, 1), note: 'Señalamiento' });
  const two = (await api('GET', `/admin/closures?from=${vacFrom}`)).data.closures;
  assert.deepEqual(two.map((c) => [c.from, c.to, c.note, c.days]), [[vacFrom, vacTo, 'Vacaciones', 10], [addDays(vacTo, 1), addDays(vacTo, 1), 'Señalamiento', 1]]);
  assert.equal((await api('POST', '/admin/closures/open', { from: vacFrom, to: addDays(vacTo, 1) })).status, 200);
  assert.deepEqual((await api('GET', `/admin/closures?from=${vacFrom}`)).data.closures, []);
  const back = await api('GET', `/availability?from=${vacFrom}&to=${vacTo}`);
  assert.ok(Object.keys(back.data.days).length >= 6);
  const log = (await api('GET', '/admin/audit')).data.entries.map((e) => e.action);
  assert.ok(log.includes('range_closed') && log.includes('range_opened'));
  await api('POST', '/admin/bookings/cancel', { id: kept.data.id });
});

await test('cambiar una reserva de día u hora libera la antigua y ocupa la nueva', async () => {
  const a = await api('POST', '/admin/bookings', { day: moveDay, time: '10:00', mode: 'presencial', name: 'Cliente Que Cambia', phone: '600 333 444', email: 'cambia@example.com' });
  const b = await api('POST', '/admin/bookings', { day: moveDay, time: '11:00', mode: 'video', name: 'Cliente Fijo', phone: '600 555 666' });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal((await api('POST', '/admin/bookings/move', { id: a.data.id, day: moveDay, time: '11:00' })).data.error, 'slot_taken');
  assert.equal((await api('POST', '/admin/bookings/move', { id: a.data.id, day: moveDay, time: '10:00' })).data.error, 'same_slot');
  assert.equal((await api('POST', '/admin/bookings/move', { id: a.data.id, day: addDays(today, -3), time: '10:00' })).data.error, 'slot_past');
  assert.equal((await api('POST', '/admin/bookings/move', { id: a.data.id, day: 'mañana', time: '10:00' })).data.error, 'bad_request');
  assert.equal((await api('POST', '/admin/bookings/move', { id: '00000000-0000-4000-8000-000000000000', day: moveDay, time: '12:00' })).status, 404);
  assert.equal((await api('POST', '/admin/bookings/move', { id: a.data.id, day: moveDay, time: '12:00' }, { auth: false })).status, 401);
  const target = addDays(moveDay, 1);
  const r = await api('POST', '/admin/bookings/move', { id: a.data.id, day: target, time: '16:00' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { id: a.data.id, ref: a.data.ref, day: target, time: '16:00', was: { day: moveDay, time: '10:00' } });
  const av = await api('GET', `/availability?from=${moveDay}&to=${target}`);
  assert.ok(av.data.days[moveDay].includes('10:00'));
  assert.ok(!av.data.days[target].includes('16:00'));
  const moved = (await api('GET', `/admin/bookings?from=${target}&to=${target}`)).data.bookings.find((x) => x.id === a.data.id);
  assert.equal(moved.time, '16:00');
  assert.equal(moved.status, 'confirmed');
  assert.equal(new Date(moved.starts_at).toISOString(), (await q('select starts_at from bookings where id = $1', [a.data.id])).rows[0].starts_at.toISOString());
  // una reserva cancelada ya no se mueve
  await api('POST', '/admin/bookings/cancel', { id: b.data.id });
  assert.equal((await api('POST', '/admin/bookings/move', { id: b.data.id, day: target, time: '17:00' })).data.error, 'not_active');
  const entry = (await api('GET', '/admin/audit')).data.entries.find((e) => e.action === 'booking_moved');
  assert.equal(entry.detail.was, `${moveDay} 10:00`);
  await api('POST', '/admin/bookings/cancel', { id: a.data.id });
});

await test('el horario se guarda sin tocar el resto de los ajustes', async () => {
  const before = (await api('GET', '/admin/settings')).data.settings;
  const schedule = { ...before.schedule, 6: ['10:00', '11:00'] };
  const r = await api('PUT', '/admin/settings', { schedule, durationMin: before.durationMin, minNoticeHours: 24, maxDaysAhead: 45 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.settings.schedule[6], ['10:00', '11:00']);
  assert.equal(r.data.settings.minNoticeHours, 24);
  assert.equal(r.data.settings.maxDaysAhead, 45);
  assert.deepEqual(r.data.settings.modes, before.modes);
  assert.deepEqual(r.data.settings.invoice, before.invoice);
  assert.deepEqual(r.data.settings.verifactu, before.verifactu);
  await api('PUT', '/admin/settings', { schedule: before.schedule, minNoticeHours: before.minNoticeHours, maxDaysAhead: before.maxDaysAhead });
});

await test('sin SESSION_SECRET, el servidor crea su clave de sesión, la conserva y no la enseña', async () => {
  const { sessionSecret, forgetSessionSecret } = await import('../lib/core.js');
  const env = process.env.SESSION_SECRET, before = cookie;
  delete process.env.SESSION_SECRET;
  try {
    const made = await sessionSecret();
    assert.ok(made.length >= 48 && made !== env);
    forgetSessionSecret();
    assert.equal(await sessionSecret(), made);                 // tras un arranque en frío sale la misma, de la base de datos
    assert.equal((await q('select count(*)::int as n from secrets')).rows[0].n, 1);
    assert.equal((await api('GET', '/setup-status')).data.sessionSecret, true);
    assert.equal((await api('GET', '/admin/me')).status, 401);    // la sesión firmada con la clave anterior deja de valer
    const r = await api('POST', '/admin/login', { email: 'irina@example.com', password: 'otra-clave-bien-larga' }, { auth: false, ip: '10.7.7.7' });
    assert.equal(r.status, 200);
    cookie = r.res.headers.get('set-cookie').split(';')[0];
    assert.equal((await api('GET', '/admin/me')).status, 200);
    const s = await api('GET', '/admin/settings');
    assert.ok(!JSON.stringify(s.data).includes(made));
    const h = await book(addDays(monday, 14), '09:00', 991);     // el freno por IP de la web sigue funcionando
    assert.equal(h.status, 201);
  } finally {
    process.env.SESSION_SECRET = env; forgetSessionSecret(); cookie = before;
  }
  assert.equal((await api('GET', '/admin/me')).status, 200);
});

await test('rutas desconocidas y cierre de sesión', async () => {
  assert.equal((await api('GET', '/nada')).status, 404);
  const out = await api('POST', '/admin/logout');
  assert.match(out.res.headers.get('set-cookie'), /Max-Age=0/);
});

let failed = 0;
for (const [st, name, msg] of results) { if (st !== 'ok') failed++; console.log(`${st === 'ok' ? '  ✓' : '  ✗'} ${name}${msg ? '\n      ' + msg : ''}`); }
console.log(`\n${results.length - failed} de ${results.length} pruebas correctas`);
process.exit(failed ? 1 : 0);
