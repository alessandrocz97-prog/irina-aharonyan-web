// Única función del servidor: enruta todas las llamadas /api/*.
import { HttpError, json, readJson, dbConfigured, q, getSettings, saveSetting, audit, madrid, addDays, isDay } from '../lib/core.js';
import * as auth from '../lib/auth.js';
import * as bk from '../lib/bookings.js';
import { stripeMode, webhookConfigured, verifyWebhook } from '../lib/payments.js';
import * as inv from '../lib/invoices.js';
import { mailConfigured } from '../lib/mail.js';
import { vfMode } from '../lib/verifactu.js';

async function setupStatus() {
  const out = {
    db: false,
    sessionSecret: (process.env.SESSION_SECRET || '').length >= 24,
    setupOpen: (process.env.PANEL_SETUP_CODE || '').length >= 8,
    stripe: stripeMode(),
    webhook: webhookConfigured(),
    hasAccounts: false,
    pricesSet: false
  };
  if (!dbConfigured()) return out;
  try {
    const r = await q('select count(*)::int as n from admins');
    out.db = true;
    out.hasAccounts = r.rows[0].n > 0;
    const s = await getSettings();
    out.pricesSet = Object.values(s.modes).some((m) => m.enabled && Number.isInteger(m.priceCents));
  } catch (e) {
    out.dbError = true;
    console.error('db_check_failed', e && e.message);
  }
  return out;
}

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new HttpError(400, 'bad_request');
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
}

const routes = {
  /* ------------------------------ Público ------------------------------ */
  'GET /config': async () => json(await bk.publicConfig()),
  'GET /setup-status': async () => json(await setupStatus()),
  'GET /availability': async (req, url) => {
    let from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!isDay(from) || !isDay(to) || to < from || addDays(from, 70) < to) throw new HttpError(400, 'bad_request');
    return json({ days: await bk.publicAvailability(from, to) });
  },
  'POST /bookings': async (req) => json(await bk.createHold(req, await readJson(req)), 201),
  'POST /bookings/release': async (req) => json(await bk.releaseHold(await readJson(req))),
  'GET /bookings/status': async (req, url) => json(await bk.statusBySession(url.searchParams.get('session_id'))),
  'POST /stripe/webhook': async (req) => {
    const raw = await req.text();
    const event = await verifyWebhook(raw, req.headers.get('stripe-signature'));
    const result = await bk.handleStripeEvent(event);
    return json({ received: true, result });
  },

  /* ------------------------------- Panel ------------------------------- */
  'POST /admin/login': async (req) => {
    auth.requirePanelHeader(req);
    const r = await auth.login(req, await readJson(req));
    return json({ admin: r.admin }, 200, { 'set-cookie': r.cookie });
  },
  'POST /admin/logout': async (req) => json({ ok: true }, 200, { 'set-cookie': auth.logoutCookie(req) }),
  'POST /admin/setup': async (req) => {
    auth.requirePanelHeader(req);
    return json({ account: await auth.setupAccount(await readJson(req)) }, 201);
  },
  'GET /admin/me': async (req) => {
    const a = await auth.requireAdmin(req);
    return json({ admin: { email: a.email, name: a.name, role: a.role }, today: madrid().day });
  },
  'POST /admin/password': async (req) => {
    auth.requirePanelHeader(req);
    await auth.changePassword(await auth.requireAdmin(req), await readJson(req));
    return json({ ok: true });
  },
  'GET /admin/month': async (req, url) => {
    await auth.requireAdmin(req);
    const [from, to] = monthRange(url.searchParams.get('month'));
    const states = await bk.slotStates(from, to);
    const days = {};
    for (const d of Object.values(states)) {
      const c = { closed: d.closed, free: 0, booked: 0, hold: 0, blocked: 0 };
      for (const x of d.slots) c[x.state === 'closed' ? 'blocked' : x.state]++;
      days[d.day] = c;
    }
    return json({ days });
  },
  'GET /admin/day': async (req, url) => {
    await auth.requireAdmin(req);
    const day = url.searchParams.get('day');
    if (!isDay(day)) throw new HttpError(400, 'bad_request');
    const states = await bk.slotStates(day, day);
    const all = await bk.listBookings({ from: day, to: day });
    return json({ day: states[day], bookings: all });
  },
  'GET /admin/bookings': async (req, url) => {
    await auth.requireAdmin(req);
    return json({ bookings: await bk.listBookings({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), status: url.searchParams.get('status') }) });
  },
  'POST /admin/bookings': async (req) => {
    auth.requirePanelHeader(req);
    return json(await bk.createManual(await auth.requireAdmin(req), await readJson(req)), 201);
  },
  'POST /admin/bookings/cancel': async (req) => {
    auth.requirePanelHeader(req);
    const admin = await auth.requireAdmin(req);
    const body = await readJson(req);
    return json(await bk.cancelBooking(admin, String(body.id || ''), { refundPayment: body.refund === true, reason: body.reason }));
  },
  'POST /admin/bookings/move': async (req) => {
    auth.requirePanelHeader(req);
    const admin = await auth.requireAdmin(req);
    const body = await readJson(req);
    return json(await bk.moveBooking(admin, String(body.id || ''), { day: body.day, time: body.time }));
  },
  'GET /admin/closures': async (req, url) => {
    await auth.requireAdmin(req);
    return json({ closures: await bk.listClosures(url.searchParams.get('from')) });
  },
  'POST /admin/closures': async (req) => {
    auth.requirePanelHeader(req);
    return json(await bk.closeRange(await auth.requireAdmin(req), await readJson(req)), 201);
  },
  'POST /admin/closures/open': async (req) => {
    auth.requirePanelHeader(req);
    return json(await bk.openRange(await auth.requireAdmin(req), await readJson(req)));
  },
  'POST /admin/overrides': async (req) => {
    auth.requirePanelHeader(req);
    return json(await bk.setOverride(await auth.requireAdmin(req), await readJson(req)));
  },
  'GET /admin/settings': async (req) => {
    await auth.requireAdmin(req);
    return json({ settings: await getSettings(), stripe: stripeMode(), webhook: webhookConfigured(), mail: mailConfigured(), verifactu: vfMode(), cron: (process.env.CRON_SECRET || '').length >= 16 });
  },
  'PUT /admin/settings': async (req) => {
    auth.requirePanelHeader(req);
    const admin = await auth.requireAdmin(req);
    const current = await getSettings();
    const next = bk.validateSettings(await readJson(req), current);
    await inv.guardVerifactuSettings(next, current);
    for (const k of next._changed) await saveSetting(k, next[k]);
    await audit(admin.email, 'settings_changed', null, { keys: next._changed });
    return json({ settings: await getSettings() });
  },
  'GET /admin/invoice': async (req, url) => {
    await auth.requireAdmin(req);
    const r = await inv.invoicePdf(String(url.searchParams.get('id') || ''));
    return new Response(r.pdf, { status: 200, headers: {
      'content-type': 'application/pdf', 'content-disposition': `inline; filename="${r.invoice.code}.pdf"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  },
  'POST /admin/invoices/send': async (req) => {
    auth.requirePanelHeader(req);
    const admin = await auth.requireAdmin(req);
    const body = await readJson(req);
    return json(await inv.sendFromPanel(admin, { bookingId: body.bookingId ? String(body.bookingId) : '', invoiceId: body.invoiceId ? String(body.invoiceId) : '', kind: body.kind === 'R' ? 'R' : 'F' }));
  },
  'GET /admin/invoices': async (req, url) => {
    await auth.requireAdmin(req);
    return json(await inv.listInvoices(url.searchParams.get('year')));
  },
  'POST /admin/invoices': async (req) => {
    auth.requirePanelHeader(req);
    return json(await inv.createManualInvoice(await auth.requireAdmin(req), await readJson(req)), 201);
  },
  'POST /admin/invoices/rectify': async (req) => {
    auth.requirePanelHeader(req);
    const admin = await auth.requireAdmin(req);
    const body = await readJson(req);
    return json(await inv.rectifyManual(admin, String(body.id || ''), body.reason, body.send === true, body.rectType), 201);
  },
  'POST /admin/invoices/paid': async (req) => {
    auth.requirePanelHeader(req);
    const admin = await auth.requireAdmin(req);
    const body = await readJson(req);
    return json(await inv.setPaid(admin, String(body.id || ''), body.paidOn || null));
  },
  'GET /admin/invoices/export': async (req, url) => {
    await auth.requireAdmin(req);
    const r = await inv.exportCsv(url.searchParams.get('year'));
    return new Response(r.csv, { status: 200, headers: {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${r.filename}"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  },
  'POST /admin/invoices/fix': async (req) => {
    auth.requirePanelHeader(req);
    const admin = await auth.requireAdmin(req);
    const body = await readJson(req);
    return json(await inv.fixInvalid(admin, String(body.id || ''), body));
  },
  'POST /admin/verifactu/retry': async (req) => {
    auth.requirePanelHeader(req);
    return json(await inv.retryVerifactu(await auth.requireAdmin(req)));
  },
  'GET /admin/verifactu/declaration': async (req) => {
    await auth.requireAdmin(req);
    return json(await inv.declaration());
  },
  // Tarea programada de Vercel (cada hora): reintenta envíos y consulta estados. Vercel la firma con CRON_SECRET.
  'GET /cron/verifactu': async (req) => {
    const secret = process.env.CRON_SECRET || '';
    if (secret.length < 16 || req.headers.get('authorization') !== `Bearer ${secret}`) throw new HttpError(401, 'not_allowed');
    return json(await inv.cronVerifactu());
  },
  'GET /admin/audit': async (req) => {
    await auth.requireAdmin(req);
    const { rows } = await q(`select a.at, a.actor, a.action, a.detail, b.ref
                                from audit a left join bookings b on b.id = a.booking_id
                               order by a.id desc limit 200`);
    return json({ entries: rows });
  }
};

export async function handle(request) {
  try {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/+$/, '');
    if (path === '/api/index' || path === '/api') path = '/api/' + (url.searchParams.get('__path') || '');
    path = path.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
    const route = routes[`${request.method} ${path}`];
    if (!route) throw new HttpError(Object.keys(routes).some((k) => k.endsWith(' ' + path)) ? 405 : 404, 'not_found');
    return await route(request, url);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, ...e.extra }, e.status);
    console.error('server_error', e && e.stack ? e.stack : e);
    return json({ error: 'server_error' }, 500);
  }
}

export default { fetch: handle };
