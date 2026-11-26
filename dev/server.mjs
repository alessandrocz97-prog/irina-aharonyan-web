// Servidor local de pruebas. No se despliega.
// Postgres en memoria, Stripe simulado con una página de «pago» local que envía el aviso firmado.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import Stripe from 'stripe';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const fonts = path.join(here, '..', '..', 'node_modules', '@fontsource');
const PORT = Number(process.env.PORT || 8790);
const SEED = process.env.SEED !== '0';

process.env.SESSION_SECRET = 'secreto-local-de-pruebas-0123456789';
process.env.PANEL_SETUP_CODE = process.env.PANEL_SETUP_CODE ?? 'alta-local-1234';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local';

const { useDb, SCHEMA, madrid, addDays, weekday, q, saveSetting } = await import('../lib/core.js');
const { useStripe } = await import('../lib/payments.js');
const { handle } = await import('../api/index.js');
const { setupAccount } = await import('../lib/auth.js');
const { useMailer } = await import('../lib/mail.js');

// Correo simulado: no sale nada; lo enviado se puede ver en /__mail y /__mail.json
const outbox = [];
if (process.env.NO_MAIL !== '1') useMailer(async (m) => { outbox.push(m); return { messageId: `local-${outbox.length}` }; });

// Proveedor de VERI*FACTU simulado: no se envía nada a ninguna parte. /__vf?down=1 simula una caída y /__vf?down=0 la termina.
// El NIF 12345678Z se rechaza siempre, para ver cómo se corrige una factura con datos no admitidos.
const { useVerifactu } = await import('../lib/verifactu.js');
const vfSim = { down: false, seq: 0, seen: new Map() };
if (process.env.NO_VF !== '1') {
  const { default: QRCode } = await import('qrcode');
  useVerifactu(async ({ method, path: p, body }) => {
    if (p === '/verifactu/declaracion') return { status: 200, data: { url: 'https://proveedor.ejemplo.test/declaracion', url_version: 'https://proveedor.ejemplo.test/declaracion/1.0.0', sistema_informatico: { nombre: 'proveedor simulado', id: 'A1', version: '1.0.0' } } };
    if (vfSim.down) return { status: 503, data: {} };
    if (method === 'POST' && p === '/verifactu/create') {
      if (body.nif === '12345678Z') return { status: 400, data: { error: 'El NIF y el nombre no coinciden con el censo de la AEAT', codigo: 'vf-simulado-nif' } };
      const uuid = `sim-${++vfSim.seq}`;
      const url = `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=00000000T&numserie=${encodeURIComponent(body.serie + body.numero)}&fecha=${body.fecha_expedicion}&importe=${body.importe_total}`;
      vfSim.seen.set(uuid, { url });
      return { status: 200, data: { uuid, estado: 'Pendiente', url, qr: (await QRCode.toBuffer(url, { errorCorrectionLevel: 'M', margin: 4, width: 420 })).toString('base64'), huella: 'SIMULADA' } };
    }
    if (method === 'GET' && p.startsWith('/verifactu/status')) return { status: 200, data: { estado: 'Correcto' } };
    return { status: 404, data: {} };
  }, 'test');
}

const pg = new PGlite();
await pg.exec(SCHEMA);
useDb({ query: (sql, params) => pg.query(sql, params) });

const sessions = new Map();
let n = 0;
if (process.env.NO_STRIPE !== '1') {
  useStripe({
    checkout: {
      sessions: {
        create: async (p) => { const id = `cs_test_local${++n}`; const s = { id, url: `http://localhost:${PORT}/__pay?sid=${id}`, ...p }; sessions.set(id, s); return s; },
        expire: async () => {}
      }
    },
    refunds: { create: async () => ({ id: 're_local' }) }
  });
}

async function sendEvent(type, object) {
  const payload = JSON.stringify({ id: `evt_${++n}`, type, data: { object } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const r = await handle(new Request(`http://localhost:${PORT}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': sig }, body: payload }));
  return r.json();
}

if (SEED) {
  await setupAccount({ code: process.env.PANEL_SETUP_CODE, name: 'Irina Aharonyan', email: 'titular@ejemplo.test', password: 'clave-de-ejemplo', role: 'titular' });
  await setupAccount({ code: process.env.PANEL_SETUP_CODE, name: 'Alessandro', email: 'gestor@ejemplo.test', password: 'clave-de-ejemplo', role: 'gestor' });
  await saveSetting('modes', { presencial: { enabled: true, priceCents: 9000 }, video: { enabled: true, priceCents: 8000 }, telefono: { enabled: true, priceCents: 6000 } });
  await saveSetting('policy', 'Texto de ejemplo: puede cambiar o cancelar su cita hasta 24 horas antes y se le devuelve el importe.');
  if (process.env.NO_INVOICE !== '1' && process.env.NO_VF !== '1') await saveSetting('verifactu', { enabled: true, producer: { name: '', taxId: '', address: '', contact: '' }, place: '', signedOn: '' });
  if (process.env.NO_INVOICE !== '1') await saveSetting('invoice', { enabled: true, series: 'A', vatBp: 2100, copyTo: '', issuer: { name: 'Irina Aharonyan', taxId: '00000000T', address: "Carrer del Comte d'Altea, 20, pta. 12\n46005 Valencia", extra: 'Colegiada n.º 00000', contact: '(+34) 688 222 133 · info@irinaaharonyan.es' } });
  let d = addDays(madrid().day, 3);
  while (weekday(d) !== 1) d = addDays(d, 1);
  const mk = async (day, time, i, mode, pay) => {
    const r = await handle(new Request(`http://localhost:${PORT}/api/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.2.0.${i}` },
      body: JSON.stringify({ day, time, mode, name: ['Cliente Ejemplo Uno', 'Cliente Ejemplo Dos', 'Cliente Ejemplo Tres', 'Cliente Ejemplo Cuatro', 'Cliente Ejemplo Cinco'][i % 5], phone: `600 000 00${i}`, email: `ejemplo${i}@ejemplo.test`, lang: ['es', 'ru', 'it', 'hy'][i % 4], consent: true, terms: true })
    }));
    const b = await r.json();
    if (pay) await sendEvent('checkout.session.completed', { id: `cs_test_local${n}`, client_reference_id: b.id, payment_status: 'paid', payment_intent: `pi_seed_${i}` });
    return b;
  };
  await mk(d, '09:00', 1, 'presencial', true);
  await mk(d, '11:00', 2, 'video', true);
  await mk(d, '16:00', 3, 'telefono', false);                 // pago en curso
  const c = await mk(d, '12:00', 4, 'video', true);
  await q(`update bookings set status = 'refunded', cancelled_at = now(), cancelled_by = 'titular@ejemplo.test', cancel_reason = 'Ejemplo de cancelación' where id = $1`, [c.id]);
  await q(`insert into overrides (day, time, open, created_by) values ($1, '13:00', false, 'titular@ejemplo.test')`, [d]);
  await mk(addDays(d, 1), '10:00', 5, 'presencial', true);
  await mk(addDays(d, 2), '17:00', 6, 'video', true);
  await q(`insert into overrides (day, time, open, note, created_by) values ($1, '', false, 'Ejemplo: señalamientos', 'titular@ejemplo.test')`, [addDays(d, 3)]);
  await q(`insert into overrides (day, time, open, created_by) values ($1, '10:30', true, 'titular@ejemplo.test')`, [addDays(d, 5)]);
  if (process.env.NO_INVOICE !== '1' && process.env.NO_VF !== '1') {
    const { createManualInvoice } = await import('../lib/invoices.js');
    const admin = { email: 'titular@ejemplo.test' };
    await createManualInvoice(admin, { recipient: { name: 'Sociedad de Ejemplo, S. L.', taxId: 'B00000000', address: 'Calle de Ejemplo, 1, 46001 Valencia', email: 'administracion@ejemplo.test' }, irpfBp: 1500, lines: [{ concept: 'Asistencia letrada', qty: 1, unitCents: 60000 }] });
    await createManualInvoice(admin, { recipient: { name: 'Cliente Ejemplo Seis', taxId: '12345678Z', address: 'Calle de Ejemplo, 6, 46001 Valencia', email: 'ejemplo6@ejemplo.test' }, send: true, lines: [{ concept: 'Consulta', qty: 1, unitCents: 10000 }] });
    vfSim.down = true;
    await createManualInvoice(admin, { recipient: { name: 'Cliente Ejemplo Siete', email: 'ejemplo7@ejemplo.test' }, send: true, lines: [{ concept: 'Consulta', qty: 1, unitCents: 7438 }] });
    vfSim.down = false;
  }
  console.log('datos de ejemplo cargados; lunes de ejemplo:', d);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const LOCAL_FONTS = ['cormorant-garamond/400', 'cormorant-garamond/500', 'cormorant-garamond/600', 'cormorant-garamond/400-italic', 'cormorant-garamond/500-italic', 'eb-garamond/400', 'eb-garamond/500', 'eb-garamond/400-italic', 'noto-serif-armenian/400', 'noto-serif-armenian/500', 'noto-serif-armenian/600']
  .map((f) => `<link rel="stylesheet" href="/__fonts/${f}.css">`).join('');

function payPage(s) {
  const item = s.line_items[0].price_data;
  return `<!DOCTYPE html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pago simulado</title>
<body style="font:16px/1.5 system-ui,sans-serif;background:#f6f8fa;margin:0;display:grid;place-items:center;min-height:100vh">
<main style="background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px;max-width:420px;width:calc(100% - 32px)">
<p style="margin:0 0 14px;padding:8px 12px;background:#fff8c5;border:1px solid #d4a72c;border-radius:8px;font-size:14px"><b>PAGO SIMULADO.</b> Esta pantalla solo existe en el servidor local de pruebas y sustituye a la página de pago de Stripe.</p>
<h1 style="font-size:20px;margin:0 0 4px">${item.product_data.name}</h1><p style="margin:0;color:#57606a">${item.product_data.description}</p>
<p style="font-size:30px;margin:18px 0">${(item.unit_amount / 100).toFixed(2)} €</p>
<form method="post" action="/__pay/done?sid=${s.id}"><button id="pay" style="width:100%;padding:12px;border:0;border-radius:8px;background:#1f883d;color:#fff;font:inherit;cursor:pointer">Pagar (simulado)</button></form>
<p style="margin:12px 0 0;text-align:center"><a id="back" href="${s.cancel_url}">Volver sin pagar</a></p></main></body></html>`;
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/__vf') { if (url.searchParams.has('down')) vfSim.down = url.searchParams.get('down') === '1'; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ down: vfSim.down, registered: vfSim.seq })); return; }
    if (url.pathname === '/__mail.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(outbox.map((m) => ({ to: m.to, bcc: m.bcc, subject: m.subject, attachments: (m.attachments || []).map((a) => ({ filename: a.filename, bytes: a.content.length })) })))); return; }
    if (url.pathname === '/__mail') { const m = outbox[Number(url.searchParams.get('n') ?? outbox.length - 1)]; res.writeHead(m ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }); res.end(m ? m.html : 'sin correos'); return; }
    if (url.pathname.startsWith('/api')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
      const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(r.status, headers); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/__pay') { res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(payPage(sessions.get(url.searchParams.get('sid')))); return; }
    if (url.pathname === '/__pay/done') {
      const s = sessions.get(url.searchParams.get('sid'));
      if (process.env.SLOW_WEBHOOK !== '1') await sendEvent('checkout.session.completed', { id: s.id, client_reference_id: s.client_reference_id, payment_status: 'paid', payment_intent: `pi_${s.id}` });
      res.writeHead(303, { location: s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) }); res.end(); return;
    }
    if (url.pathname.startsWith('/__fonts/')) {
      const f = path.join(fonts, url.pathname.slice('/__fonts/'.length));
      if (!f.startsWith(fonts) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'text/css' }); res.end(fs.readFileSync(f)); return;
    }
    let f = path.join(pub, decodeURIComponent(url.pathname));
    if (!f.startsWith(pub)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('no encontrado'); return; }
    let data = fs.readFileSync(f);
    if (f.endsWith('.html')) data = Buffer.from(data.toString('utf8').replace(/<link rel="preconnect"[^>]*>\s*/g, '').replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, LOCAL_FONTS));
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(data);
  } catch (e) {
    console.error(e); res.writeHead(500); res.end('error');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`servidor local en http://localhost:${PORT}`));
