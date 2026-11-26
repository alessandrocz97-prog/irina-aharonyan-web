// Factura en PDF con la identidad de la web: marfil, tinta y bronce; Cormorant Garamond y EB Garamond.
// Recibe la factura tal como quedó guardada (fila de `invoices`) y devuelve el PDF en memoria.
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const font = (f) => fileURLToPath(new URL(`./fonts/${f}.ttf`, import.meta.url));
const FONTS = {
  disp: font('Cormorant-Medium'),
  dispIt: font('Cormorant-MediumItalic'),
  text: font('EBGaramond-Regular'),
  textIt: font('EBGaramond-Italic'),
  textB: font('EBGaramond-SemiBold'),
  hy: font('NotoSerifArmenian-Regular')
};
const C = { page: '#FDFCFA', ink: '#262321', ink2: '#514A43', ink3: '#766C62', bronze: '#8A6748', line: '#D9CDBE', soft: '#C2A98F', band: '#F4EFE7' };
const NUM = ['lnum', 'tnum'];                 // cifras alineadas y de ancho fijo, como en la web
const ARMENIAN = /[԰-֏ﬓ-ﬗ]/;

export const MODE_ES = { presencial: 'presencial', video: 'por videollamada', telefono: 'por teléfono' };

export function money(cents) {
  const s = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Math.abs(cents) / 100);
  return (cents < 0 ? '−' : '') + s;
}
export function longDate(day, withWeekday) {
  const d = new Date(`${day}T12:00:00Z`);
  const s = new Intl.DateTimeFormat('es-ES', { weekday: withWeekday ? 'long' : undefined, day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  return withWeekday ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
const pct = (bp) => `${String(bp / 100).replace('.', ',')} %`;

const MM = 72 / 25.4;
const ID_LABEL = { '02': 'NIF-IVA', '03': 'Pasaporte', '04': 'Documento de identidad', '06': 'Documento' };
const idLine = (rec) => (rec.taxId ? `${rec.idType && ID_LABEL[rec.idType] ? `${ID_LABEL[rec.idType]}${rec.idCountry ? ` (${rec.idCountry})` : ''}` : 'NIF'} ${rec.taxId}` : '');

/** QR tributario dibujado a partir de la URL de cotejo: nivel M y lado de 32 mm (la norma pide entre 30 y 40). */
function drawQr(doc, url, x, y, side) {
  const qr = QRCode.create(String(url), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size, cell = side / n;
  doc.fillColor('#000000');
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.data[r * n + c]) doc.rect(x + c * cell, y + r * cell, cell + 0.03, cell + 0.03);
  doc.fill();
}

export function invoiceTitle(inv) {
  if (inv.kind === 'R') return 'Factura rectificativa';
  return inv.simplified ? 'Factura simplificada' : 'Factura';
}

export function renderInvoicePdf(inv) {
  const d = inv.data || {};
  const issuer = d.issuer || {}, rec = d.recipient || {}, svc = d.service || {};
  const W = 595.28, H = 841.89, L = 60, R = W - 60, CW = R - L;

  const doc = new PDFDocument({
    size: 'A4', margin: 0, lang: 'es-ES',
    info: { Title: `${invoiceTitle(inv)} ${inv.code}`, Author: issuer.name || '', Subject: 'Factura', Creator: issuer.name || '' }
  });
  for (const [k, v] of Object.entries(FONTS)) doc.registerFont(k, v);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  // Utilidades de composición
  // Un nombre puede venir en armenio: esos tramos usan su propia fuente y el resto, la de la web.
  const runs = (s) => s.split(/([\u0530-\u058F\uFB13-\uFB17]+(?: +[\u0530-\u058F\uFB13-\uFB17]+)*)/).filter((x) => x !== '');
  const T = (str, x, y, o = {}) => {
    const s = String(str ?? ''), base = o.font || 'text', size = o.size || 10.5;
    const opt = { width: o.width, align: o.align || 'left', characterSpacing: o.track || 0, features: NUM, lineGap: o.gap ?? 2.2, lineBreak: o.width !== undefined };
    doc.fillColor(o.color || C.ink);
    if (!ARMENIAN.test(s)) { doc.font(base).fontSize(size).text(s, x, y, opt); return doc.y; }
    const parts = runs(s);
    parts.forEach((p, i) => {
      const hy = ARMENIAN.test(p), more = i < parts.length - 1;
      doc.font(hy ? 'hy' : base).fontSize(hy ? size * 0.88 : size);
      if (i === 0) doc.text(p, x, y, { ...opt, continued: more }); else doc.text(p, { ...opt, continued: more });
    });
    return doc.y;
  };
  const label = (str, x, y, o = {}) => T(String(str).toUpperCase(), x, y, { font: 'textB', size: 7.6, track: 1.5, color: C.bronze, ...o });
  const rule = (y, x1 = L, x2 = R, color = C.line, w = 0.6) => { doc.moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(color).stroke(); };
  const widthOf = (str, o = {}) => { doc.font(o.font || 'text').fontSize(o.size || 10.5); return doc.widthOfString(String(str), { characterSpacing: o.track || 0, features: NUM }); };

  // Fondo
  doc.rect(0, 0, W, H).fill(C.page);

  // Cabecera: monograma y nombre, como en la web
  let y = 58;
  T('IA', L, y - 7, { font: 'disp', size: 30, color: C.bronze });
  const mw = widthOf('IA', { font: 'disp', size: 30 });
  doc.moveTo(L + mw + 13, y - 2).lineTo(L + mw + 13, y + 27).lineWidth(0.6).strokeColor(C.soft).stroke();
  const bx = L + mw + 27;
  T((issuer.brand || issuer.name || '').toUpperCase(), bx, y + 1, { font: 'textB', size: 10.4, track: 2.6 });
  T(issuer.tagline || '', bx, y + 16.5, { font: 'textIt', size: 10, color: C.ink3 });
  const contact = String(issuer.contact || '').split(/\s*[·|\n]\s*/).filter(Boolean);
  contact.slice(0, 3).forEach((ln, i) => T(ln, L, y + 1 + i * 13, { size: 9.2, color: C.ink3, width: CW, align: 'right' }));
  y += 52;
  rule(y, L, R, C.soft, 0.6);

  // Título y datos de la factura
  const registered = Boolean(inv.vf_state && (inv.vf_url || inv.vf_qr) && inv.vf_state !== 'queued' && inv.vf_state !== 'sending' && inv.vf_state !== 'invalid');
  if (inv.vf_state) {
    // Con VERI*FACTU el QR es lo primero que se lee bajo el membrete, en el margen izquierdo.
    y += 24;
    const Q = 32 * MM, qy = y + 13;
    label('QR tributario', L, y, { color: C.ink3 });
    let drawn = false;
    if (registered && inv.vf_url) { try { drawQr(doc, inv.vf_url, L, qy, Q); drawn = true; } catch { /* se intenta con la imagen del proveedor */ } }
    if (registered && !drawn && inv.vf_qr) { try { doc.image(Buffer.from(inv.vf_qr, 'base64'), L - 2 * MM, qy - 2 * MM, { width: 36 * MM }); drawn = true; } catch { /* sin QR legible */ } }
    if (!drawn) {
      doc.rect(L, qy, Q, Q).lineWidth(0.6).dash(2.5, { space: 2.5 }).strokeColor(C.soft).stroke().undash();
      const py = T('Pendiente de registro en la AEAT', L + 8, qy + 17, { size: 9.2, color: C.ink2, width: Q - 16, align: 'center', font: 'textB', gap: 1.4 });
      T('No entregar al cliente', L + 8, py + 6, { size: 8.6, color: C.ink3, width: Q - 16, align: 'center', font: 'textIt', gap: 1.4 });
    }
    if (drawn) T('VERI*FACTU', L, qy + Q + 7, { font: 'textB', size: 8.4, track: 1.6, color: C.ink, width: Q, align: 'center' });
    const hx = L + Q + 30;
    T(invoiceTitle(inv), hx, qy + 8, { font: 'dispIt', size: 33 });
    let my = qy + 62;
    label('Número', hx, my + 3);
    T(inv.code, hx + 50, my, { font: 'textB', size: 11.5 });
    const nx = hx + 50 + widthOf(inv.code, { font: 'textB', size: 11.5 }) + 24;
    label('Fecha', nx, my + 3);
    T(longDate(inv.issued_on), nx + 38, my, { size: 11 });
    if (d.operationOn && d.operationOn !== inv.issued_on) {
      my += 17;
      label('Operación', hx, my + 3);
      T(longDate(d.operationOn), hx + 62, my, { size: 11 });
    }
    y = qy + Q + 46;
  } else {
    y += 34;
    T(invoiceTitle(inv), L, y, { font: 'dispIt', size: 33 });
    const mx = R - 190;
    label('Número', mx, y + 4);
    T(inv.code, mx + 62, y + 1.2, { font: 'textB', size: 11.5, width: 128, align: 'right' });
    label('Fecha', mx, y + 23);
    T(longDate(inv.issued_on), mx + 62, y + 20.2, { size: 11, width: 128, align: 'right' });
    if (d.operationOn && d.operationOn !== inv.issued_on) {
      label('Operación', mx, y + 42);
      T(longDate(d.operationOn), mx + 62, y + 39.2, { size: 11, width: 128, align: 'right' });
    }
    y += 70;
  }

  // Emisor y cliente
  const colW = (CW - 36) / 2, c2 = L + colW + 36;
  label('Emisor', L, y);
  label(inv.simplified && !rec.taxId ? 'Cliente' : 'Destinatario', c2, y);
  y += 15;
  const block = (lines, x) => {
    let yy = y;
    lines.filter((l) => l && l.text).forEach((l) => { yy = T(l.text, x, yy, { width: colW, size: l.size || 10.3, font: l.font, color: l.color || C.ink2 }) + 0.5; });
    return yy;
  };
  const y1 = block([
    { text: issuer.name, font: 'textB', size: 11.2, color: C.ink },
    { text: issuer.taxId ? `NIF ${issuer.taxId}` : '' },
    { text: issuer.address },
    { text: issuer.extra }
  ], L);
  const y2 = block([
    { text: rec.name, font: 'textB', size: 11.2, color: C.ink },
    { text: idLine(rec) },
    { text: rec.address },
    { text: rec.email, color: C.ink3 }
  ], c2);
  y = Math.max(y1, y2) + 30;

  // Pie de cada página y salto a una hoja de continuación cuando el detalle no cabe
  const fy = H - 74, limit = fy - 18;
  function footer() {
    rule(fy, L, R, C.soft, 0.6);
    const foot = [issuer.name, issuer.taxId ? `NIF ${issuer.taxId}` : '', issuer.extra].filter(Boolean).join('  ·  ');
    T(foot, L, fy + 12, { size: 8.8, color: C.ink3, width: CW, align: 'center' });
    const legend = !inv.vf_state ? d.footer
      : !registered ? 'Factura pendiente de registro en la AEAT.'
      : inv.vf_env === 'test' ? 'Entorno de pruebas de la AEAT: documento sin validez fiscal.'
      : 'Factura verificable en la sede electrónica de la AEAT.';
    if (legend) T(legend, L, fy + 26, { size: 8.4, color: C.ink3, width: CW, align: 'center', font: 'textIt' });
  }
  function nextPage() {
    footer();
    doc.addPage({ size: 'A4', margin: 0 });
    doc.rect(0, 0, W, H).fill(C.page);
    T(invoiceTitle(inv), L, 54, { font: 'dispIt', size: 19 });
    T(`${inv.code}  ·  continuación`, L, 60, { size: 10.2, color: C.ink3, width: CW, align: 'right' });
    rule(88, L, R, C.soft, 0.6);
    return 112;
  }
  const heightOf = (str, width, size) => { doc.font('text').fontSize(size); return doc.heightOfString(String(str ?? ''), { width, lineGap: 2.2, features: NUM }); };

  // Detalle
  const lines = Array.isArray(d.lines) && d.lines.length ? d.lines : null;
  const xb = R - 232, xv = R - 148, xt = R - 76, cw = 76;   // columnas de importes
  const sign = inv.kind === 'R' ? -1 : 1;
  doc.rect(L, y, CW, 24).fill(C.band);
  label('Concepto', L + 12, y + 8.5, { color: C.ink3 });
  if (lines) {
    label('Cantidad', xb, y + 8.5, { color: C.ink3, width: cw, align: 'right' });
    label('Precio', xv, y + 8.5, { color: C.ink3, width: cw - 4, align: 'right' });
    label('Importe', xt - 12, y + 8.5, { color: C.ink3, width: cw, align: 'right' });
  } else {
    label('Base', xb, y + 8.5, { color: C.ink3, width: cw, align: 'right' });
    label(`IVA ${pct(inv.vat_bp)}`, xv, y + 8.5, { color: C.ink3, width: cw - 4, align: 'right' });
    label('Total', xt - 12, y + 8.5, { color: C.ink3, width: cw, align: 'right' });
  }
  y += 24 + 14;
  const conceptW = xb - L - 12 - 14;
  if (lines) {
    const qtyTxt = (n) => String(Math.round(n * 100) / 100).replace('.', ',');
    lines.forEach((ln, i) => {
      if (i && y + heightOf(ln.concept, conceptW, 11.2) > limit) { rule(y - 7); y = nextPage(); }
      else if (i) { rule(y - 7, L + 12, R - 12, C.line, 0.4); }
      const yl = T(ln.concept, L + 12, y, { size: 11.2, width: conceptW });
      T(qtyTxt(ln.qty), xb, y + 0.4, { size: 10.8, width: cw, align: 'right', color: C.ink2 });
      T(money(ln.unitCents), xv, y + 0.4, { size: 10.8, width: cw - 4, align: 'right', color: C.ink2 });
      T(money(sign * ln.baseCents), xt - 12, y + 0.4, { size: 10.8, width: cw, align: 'right' });
      y = yl + 13;
    });
    y += 1;
  } else {
    let yc = T(d.concept || 'Consulta jurídica', L + 12, y, { size: 11.6, width: conceptW });
    const when = [svc.day ? `${longDate(svc.day, true)}${svc.time ? `, ${svc.time} h` : ''}` : '', svc.durationMin ? `${svc.durationMin} min` : ''].filter(Boolean).join('  ·  ');
    if (when) yc = T(when, L + 12, yc + 1.5, { size: 9.4, color: C.ink3, width: conceptW });
    if (svc.ref) yc = T(`Reserva ${svc.ref}`, L + 12, yc, { size: 9.4, color: C.ink3, width: conceptW });
    T(money(inv.base_cents), xb, y + 0.6, { size: 11, width: cw, align: 'right' });
    T(money(inv.vat_cents), xv, y + 0.6, { size: 11, width: cw - 4, align: 'right' });
    T(money(inv.total_cents), xt - 12, y + 0.6, { font: 'textB', size: 11, width: cw, align: 'right' });
    y = yc + 14;
  }
  rule(y);

  // Totales
  y += 20;
  if (y + ((inv.irpf_cents || 0) ? 118 : 86) > limit) y = nextPage();
  const tx = R - 232, tw = 232 - 12;
  const row = (k, v, yy, o = {}) => {
    T(k, tx, yy, { size: o.size || 10.4, color: o.kc || C.ink3 });
    T(v, tx, yy, { size: o.size || 10.4, width: tw, align: 'right', color: o.vc || C.ink2, font: o.font });
  };
  const irpf = inv.irpf_cents || 0, payable = inv.total_cents - irpf;
  row('Base imponible', money(inv.base_cents), y);
  row(`IVA ${pct(inv.vat_bp)}`, money(inv.vat_cents), y + 17);
  let ty = y + 34;
  if (irpf) {
    row(`Retención IRPF ${pct(inv.irpf_bp)}`, money(-irpf), ty);
    ty += 17;
  }
  rule(ty + 6, tx, R, C.soft, 0.6);
  T(irpf ? 'A pagar' : 'Total', tx, ty + 19, { font: 'dispIt', size: 15, color: C.ink });
  T(money(payable), tx, ty + 12, { font: 'disp', size: 25, width: tw, align: 'right' });
  if (irpf) T(`Total de la factura (base más IVA): ${money(inv.total_cents)}`, tx, ty + 47, { size: 9.2, color: C.ink3, width: tw, align: 'right' });

  // Nota: pago o rectificación
  const notes = [];
  if (inv.kind === 'R' && d.rectifies) {
    notes.push(`Rectifica la factura ${d.rectifies.code}, de ${longDate(d.rectifies.issued_on)}.`);
    notes.push(`Motivo: ${d.reason || 'cancelación de la consulta y devolución íntegra del importe'}.`);
  } else if (d.paid && d.paid.on) {
    notes.push(`Pagada el ${longDate(d.paid.on)} con tarjeta, a través de la pasarela de pago de la web.`);
  } else if (lines && inv.paid_on) {
    notes.push(`Pagada el ${longDate(inv.paid_on)}.`);
  } else if (lines && d.payNote) {
    String(d.payNote).split('\n').filter(Boolean).forEach((n) => notes.push(n));
  }
  if (lines && d.note) String(d.note).split('\n').filter(Boolean).forEach((n) => notes.push(n));
  if (inv.kind !== 'R' && inv.simplified && !lines) notes.push('IVA incluido en el total.');
  let yn = y;
  if (notes.length) {
    label(inv.kind === 'R' ? 'Rectificación' : 'Pago', L, yn);
    yn += 15;
    notes.forEach((n) => { yn = T(n, L, yn, { size: 10.2, color: C.ink2, width: tx - L - 30 }) + 1; });
  }

  footer();
  doc.end();
  return done;
}
