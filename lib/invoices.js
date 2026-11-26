// Facturación: expide la factura cuando Stripe confirma el cobro, la rectificativa cuando se devuelve,
// y las envía por correo. Un fallo aquí nunca deshace una reserva ya pagada.
import { HttpError, q, audit, getSettings, madrid, isUniqueViolation, isDay } from './core.js';
import { renderInvoicePdf, invoiceTitle, MODE_ES, money, longDate } from './invoice-pdf.js';
import { sendMail, mailConfigured } from './mail.js';
import * as vf from './verifactu.js';

const TAGLINE = 'Abogada penalista · Criminóloga';
export const SIMPLIFIED_MAX_CENTS = 40000;   // art. 4.1.a) del Reglamento de facturación: 400 € con IVA incluido

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function issuerReady(inv) {
  const i = (inv && inv.issuer) || {};
  return clean(i.name, 200).length >= 3 && clean(i.taxId, 20).length >= 8 && clean(i.address, 300).length >= 8;
}

/** VERI*FACTU encendido: ninguna factura sale hacia el cliente sin estar registrada. */
const vfOn = (settings) => Boolean(settings.verifactu && settings.verifactu.enabled === true);
/** Campos con los que nace una factura cuando VERI*FACTU está encendido. */
const vfBirth = (settings, deliver) => (vfOn(settings) ? { vf_state: 'queued', vf_env: vf.vfMode() || 'off', vf_deliver: deliver === true } : {});

export function invoicingStatus(settings) {
  const inv = settings.invoice || {};
  return { enabled: inv.enabled === true, issuerReady: issuerReady(inv), mail: mailConfigured() };
}

/** Inserta con el siguiente número de la serie. La numeración es correlativa y sin huecos: nunca se borra una fila. */
async function insertNumbered(row) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await q(
        `insert into invoices (kind, series, number, code, booking_id, rectifies, issued_on, total_cents, base_cents, vat_cents, vat_bp, simplified, data,
                               origin, irpf_bp, irpf_cents, paid_on, created_by, vf_state, vf_env, vf_deliver)
         select $1, $2, x.n, $2 || '-' || lpad(x.n::text, 4, '0'), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
           from (select coalesce(max(number), 0) + 1 as n from invoices where series = $2) x
         returning *`,
        [row.kind, row.series, row.booking_id || null, row.rectifies || null, row.issued_on, row.total_cents, row.base_cents, row.vat_cents, row.vat_bp, row.simplified, JSON.stringify(row.data),
          row.origin || 'web', row.irpf_bp || 0, row.irpf_cents || 0, row.paid_on || null, row.created_by || null, row.vf_state || null, row.vf_env || null, row.vf_deliver === true]);
      return { invoice: r.rows[0], created: true };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const had = row.booking_id ? await q('select * from invoices where booking_id = $1 and kind = $2', [row.booking_id, row.kind])
        : row.rectifies ? await q('select * from invoices where rectifies = $1', [row.rectifies]) : { rows: [] };
      if (had.rows[0]) return { invoice: had.rows[0], created: false };   // otro aviso se adelantó: es la misma factura
      // si no, dos facturas distintas pidieron el mismo número a la vez: se reintenta con el siguiente
    }
  }
  throw new Error('invoice_number_contention');
}

/** Expide la factura de una reserva cobrada en la web. Devuelve { invoice } o { skipped: motivo }. */
export async function issueInvoice(bookingId) {
  const had = await q(`select * from invoices where booking_id = $1 and kind = 'F'`, [bookingId]);
  if (had.rows[0]) return { invoice: had.rows[0], created: false };

  const { rows } = await q('select * from bookings where id = $1', [bookingId]);
  const b = rows[0];
  if (!b) return { skipped: 'not_found' };
  if (b.status !== 'confirmed' || b.payment !== 'stripe' || !b.stripe_payment_intent || !(b.amount_cents > 0)) return { skipped: 'not_billable' };

  const s = await getSettings();
  const cfg = s.invoice || {};
  if (cfg.enabled !== true) return { skipped: 'invoicing_off' };
  if (!issuerReady(cfg)) return { skipped: 'issuer_incomplete' };

  let taxId = clean(b.tax_id, 20).toUpperCase();
  const address = clean(b.bill_address, 300);
  // Con VERI*FACTU, una factura completa necesita un NIF o NIE español comprobable; si no lo es, sale como simplificada.
  if (vfOn(s) && taxId && !vf.spanishTaxId(taxId)) taxId = '';
  const simplified = !(taxId && address);
  if (simplified && b.amount_cents > SIMPLIFIED_MAX_CENTS) return { skipped: 'recipient_data_required' };

  const vatBp = Number.isInteger(cfg.vatBp) ? cfg.vatBp : 2100;
  const total = b.amount_cents;
  const base = Math.round(total * 10000 / (10000 + vatBp));
  const today = madrid().day;
  const out = await insertNumbered({
    kind: 'F', series: `${clean(cfg.series, 4).toUpperCase() || 'A'}${today.slice(0, 4)}`, booking_id: b.id, issued_on: today,
    total_cents: total, base_cents: base, vat_cents: total - base, vat_bp: vatBp, simplified,
    origin: 'web', paid_on: madrid(b.confirmed_at ? new Date(b.confirmed_at) : new Date()).day, ...vfBirth(s, true),
    data: {
      issuer: { name: clean(cfg.issuer.name, 200), brand: clean(cfg.issuer.name, 200), tagline: TAGLINE, taxId: clean(cfg.issuer.taxId, 20).toUpperCase(), address: clean(cfg.issuer.address, 300), extra: clean(cfg.issuer.extra, 200), contact: clean(cfg.issuer.contact, 200) },
      recipient: { name: b.name, taxId, address, email: b.email },
      concept: `Consulta jurídica ${MODE_ES[b.mode] || ''}`.trim(),
      service: { day: b.day, time: b.time, mode: b.mode, durationMin: s.durationMin, ref: b.ref },
      paid: { on: madrid(b.confirmed_at ? new Date(b.confirmed_at) : new Date()).day },
      lang: b.lang
    }
  });
  if (out.created) await audit('sistema', 'invoice_issued', b.id, { code: out.invoice.code });
  return out;
}

/** Factura rectificativa por la devolución íntegra. Solo si la reserva tenía factura. */
export async function issueRectification(bookingId, reason) {
  const f = await q(`select * from invoices where booking_id = $1 and kind = 'F'`, [bookingId]);
  const orig = f.rows[0];
  if (!orig) return { skipped: 'no_invoice' };
  const had = await q(`select * from invoices where booking_id = $1 and kind = 'R'`, [bookingId]);
  if (had.rows[0]) return { invoice: had.rows[0], created: false };
  const today = madrid().day;
  const out = await insertNumbered({
    kind: 'R', series: `R${today.slice(0, 4)}`, booking_id: bookingId, rectifies: orig.id, issued_on: today,
    total_cents: -orig.total_cents, base_cents: -orig.base_cents, vat_cents: -orig.vat_cents, vat_bp: orig.vat_bp, simplified: orig.simplified,
    ...vfBirth(await getSettings(), true),
    // R1: la operación queda sin efecto (consulta cancelada con devolución), art. 80.Dos de la Ley del IVA.
    data: { ...orig.data, paid: null, rectType: 'R1', rectifies: { code: orig.code, issued_on: orig.issued_on }, reason: clean(reason, 200) || 'cancelación de la consulta y devolución íntegra del importe' }
  });
  if (out.created) await audit('sistema', 'invoice_rectified', bookingId, { code: out.invoice.code, rectifies: orig.code });
  return out;
}

/* ------------------------------- Correo ------------------------------- */

const LOCALE = { es: 'es-ES', it: 'it-IT', ru: 'ru-RU', hy: 'hy-AM' };
const MODE_TXT = {
  es: MODE_ES,
  it: { presencial: 'in studio', video: 'in videochiamata', telefono: 'telefonica' },
  ru: { presencial: 'в офисе', video: 'по видеосвязи', telefono: 'по телефону' },
  hy: { presencial: 'գրասենյակում', video: 'տեսազանգով', telefono: 'հեռախոսով' }
};
const TXT = {
  es: {
    subject: (c) => `Factura ${c}`, subjectR: (c) => `Factura rectificativa ${c}`,
    title: 'Su reserva está confirmada', titleR: 'Consulta cancelada',
    body: (v) => `Le adjuntamos la factura de su consulta ${v.mode} del ${v.date} a las ${v.time} h.`,
    bodyR: 'Le adjuntamos la factura rectificativa de su consulta cancelada. El importe se devuelve al mismo medio de pago y puede tardar unos días en verse.',
    ref: 'Reserva', inv: 'Factura', amount: 'Importe', when: 'Cita', docLang: '',
    foot: 'Si necesita cambiar algún dato de la factura, responda a este correo.'
  },
  it: {
    subject: (c) => `Fattura ${c}`, subjectR: (c) => `Fattura rettificativa ${c}`,
    title: 'La sua prenotazione è confermata', titleR: 'Consulenza annullata',
    body: (v) => `In allegato trova la fattura della consulenza ${v.mode} del ${v.date} alle ${v.time}.`,
    bodyR: "In allegato trova la fattura rettificativa della consulenza annullata. L'importo viene restituito sullo stesso metodo di pagamento; l'accredito può richiedere alcuni giorni.",
    ref: 'Prenotazione', inv: 'Fattura', amount: 'Importo', when: 'Appuntamento', docLang: 'La fattura è emessa in spagnolo.',
    foot: 'Se deve modificare un dato della fattura, risponda a questa e-mail.'
  },
  ru: {
    subject: (c) => `Счёт-фактура ${c}`, subjectR: (c) => `Корректирующий счёт-фактура ${c}`,
    title: 'Ваша запись подтверждена', titleR: 'Консультация отменена',
    body: (v) => `Во вложении — счёт-фактура за консультацию ${v.mode}: ${v.date}, ${v.time}.`,
    bodyR: 'Во вложении — корректирующий счёт-фактура по отменённой консультации. Сумма возвращается тем же способом оплаты; зачисление может занять несколько дней.',
    ref: 'Запись', inv: 'Счёт-фактура', amount: 'Сумма', when: 'Приём', docLang: 'Счёт-фактура оформлен на испанском языке.',
    foot: 'Если нужно изменить данные в счёте-фактуре, ответьте на это письмо.'
  },
  hy: {
    subject: (c) => `Հաշիվ ${c}`, subjectR: (c) => `Ճշգրտող հաշիվ ${c}`,
    title: 'Ձեր ամրագրումը հաստատված է', titleR: 'Խորհրդատվությունը չեղարկվել է',
    body: (v) => `Կցված է Ձեր խորհրդատվության հաշիվը (${v.mode})՝ ${v.date}, ժամը ${v.time}։`,
    bodyR: 'Կցված է չեղարկված խորհրդատվության ճշգրտող հաշիվը։ Գումարը վերադարձվում է նույն վճարման միջոցին և կարող է երևալ մի քանի օրից։',
    ref: 'Ամրագրում', inv: 'Հաշիվ', amount: 'Գումար', when: 'Հանդիպում', docLang: 'Հաշիվը կազմված է իսպաներենով։',
    foot: 'Եթե անհրաժեշտ է փոխել հաշվի տվյալները, պատասխանեք այս նամակին։'
  }
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Correo con el aspecto de la web. Las fuentes de la web se piden; si el programa de correo no las carga, cae en Georgia. */
export function composeEmail(inv) {
  const d = inv.data || {}, svc = d.service || {}, issuer = d.issuer || {};
  const lang = TXT[d.lang] ? d.lang : 'es', t = TXT[lang], rect = inv.kind === 'R';
  const date = svc.day ? new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${svc.day}T12:00:00Z`)) : '';
  const v = { mode: (MODE_TXT[lang] || MODE_ES)[svc.mode] || '', date, time: svc.time || '' };
  const manual = !svc.day;
  const title = manual ? (rect ? 'Factura rectificativa' : 'Su factura') : rect ? t.titleR : t.title;
  const body = manual
    ? (rect ? `Le adjuntamos la factura rectificativa ${inv.code}${d.rectifies ? `, que rectifica la factura ${d.rectifies.code}` : ''}.` : `Le adjuntamos la factura ${inv.code}.`)
    : rect ? t.bodyR : t.body(v);
  const subject = `${rect ? t.subjectR(inv.code) : t.subject(inv.code)} · ${issuer.name}`;
  const rowsData = manual
    ? [[t.inv, inv.code], [t.amount, money(inv.total_cents - (inv.irpf_cents || 0))], ['Fecha', longDate(inv.issued_on)]]
    : [[t.inv, inv.code], [t.amount, money(inv.total_cents)], [t.when, `${date}, ${v.time}`], [t.ref, svc.ref || '']];
  const serif = `'Cormorant Garamond','EB Garamond',Georgia,'Times New Roman',serif`, text = `'EB Garamond',Georgia,'Times New Roman',serif`;
  const rows = rowsData.map(([k, val], i) => `<tr><td style="padding:11px 0;${i ? 'border-top:1px solid #E6DDD0;' : ''}font:600 11px/1.3 ${text};letter-spacing:.14em;text-transform:uppercase;color:#8A6748;width:38%">${esc(k)}</td><td align="right" style="padding:11px 0;${i ? 'border-top:1px solid #E6DDD0;' : ''}font:400 16px/1.4 ${text};color:#262321">${esc(val)}</td></tr>`).join('');
  const contact = String(issuer.contact || '').split(/\s*[·|\n]\s*/).filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,500&family=EB+Garamond:wght@400;600&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#F8F5EF;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8F5EF"><tr><td align="center" style="padding:36px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FDFCFA;border:1px solid #E6DDD0">
<tr><td style="padding:30px 36px 22px;border-bottom:1px solid #C2A98F"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="font:500 30px/1 ${serif};color:#8A6748;padding-right:14px;border-right:1px solid #C2A98F">IA</td>
<td style="padding-left:14px"><div style="font:600 12px/1.3 ${text};letter-spacing:.24em;text-transform:uppercase;color:#262321">${esc(issuer.name)}</div><div style="font:italic 400 14px/1.4 ${text};color:#766C62">${esc(issuer.tagline || '')}</div></td></tr></table></td></tr>
<tr><td style="padding:34px 36px 8px"><h1 style="margin:0 0 14px;font:italic 500 32px/1.15 ${serif};color:#262321">${esc(title)}</h1>
<p style="margin:0 0 22px;font:400 17px/1.55 ${text};color:#514A43">${esc(body)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #C2A98F;border-bottom:1px solid #C2A98F">${rows}</table>
<p style="margin:22px 0 0;font:400 15px/1.55 ${text};color:#766C62">${esc([t.docLang, t.foot].filter(Boolean).join(' '))}</p></td></tr>
<tr><td style="padding:26px 36px 30px"><div style="border-top:1px solid #E6DDD0;padding-top:16px;font:400 13px/1.5 ${text};color:#766C62;text-align:center">${contact}</div></td></tr>
</table></td></tr></table></body></html>`;
  const textBody = [title, '', body, '', ...rowsData.map(([k, val]) => `${k}: ${val}`), '', [t.docLang, t.foot].filter(Boolean).join(' '), '', issuer.name, String(issuer.contact || '')].join('\n');
  return { subject, html, text: textBody, lang };
}

/** Envía la factura por correo con el PDF adjunto. No lanza: deja constancia del resultado en la propia factura. */
export async function deliverInvoice(inv) {
  const to = inv.data && inv.data.recipient && inv.data.recipient.email;
  // Una factura sujeta a VERI*FACTU no se entrega hasta tener su registro y su QR. No es un fallo de envío.
  if (inv.vf_state && !vf.DELIVERABLE.includes(inv.vf_state)) return { sent: false, error: 'vf_not_registered' };
  try {
    if (!to) throw new Error('no_recipient_email');
    if (!mailConfigured()) throw new Error('mail_not_configured');
    const pdf = await renderInvoicePdf(inv);
    const mail = composeEmail(inv);
    const s = await getSettings();
    const copy = clean(s.invoice && s.invoice.copyTo, 160);
    await sendMail({
      to, bcc: copy || undefined, subject: mail.subject, text: mail.text, html: mail.html,
      attachments: [{ filename: `${invoiceTitle(inv).toLowerCase().replace(/ /g, '-')}-${inv.code}.pdf`, content: pdf, contentType: 'application/pdf' }]
    });
    await q('update invoices set sent_at = now(), send_error = null where id = $1', [inv.id]);
    return { sent: true };
  } catch (e) {
    const msg = clean(e && e.message, 200) || 'send_failed';
    console.error('invoice_send_failed', inv.code, msg);
    await q('update invoices set send_error = $2 where id = $1', [inv.id, msg]).catch(() => {});
    return { sent: false, error: msg };
  }
}

/* ------------------------------ VERI*FACTU ------------------------------ */

/** Envía la cola al proveedor y entrega al cliente las facturas que quedan registradas y estaban esperando. */
export async function flushVerifactu(budgetMs) {
  // Con la clave real no sale ningún registro mientras el programa no tenga su declaración responsable.
  if (vf.vfMode() === 'prod' && !declarationReady((await getSettings()).verifactu)) {
    await q(`update invoices set vf_error = 'falta la declaración responsable del programa' where vf_state = 'queued'`);
    return { registered: 0, invalid: 0, stopped: true };
  }
  return vf.flush({ budgetMs, onRegistered: async (inv) => { if (inv.vf_deliver && !inv.sent_at) await deliverInvoice(inv); } });
}

/** Último paso tras expedir: si la factura va por VERI*FACTU, primero se registra; el correo sale después. */
async function finalize(inv, deliver) {
  if (inv.vf_state === 'queued' || inv.vf_state === 'sending') { await flushVerifactu(4000); return fresh(inv.id); }
  if (deliver && !inv.sent_at) await deliverInvoice(inv);
  return fresh(inv.id);
}
async function fresh(id) { const r = await q('select * from invoices where id = $1', [id]); return r.rows[0]; }

/** Tarea horaria: reintenta lo que no se pudo enviar y pregunta por lo que la AEAT aún no había contestado. */
export async function cronVerifactu() {
  const sent = await flushVerifactu(9000);
  const checked = await vf.refresh(25, 6000);
  return { ...sent, ...checked, ...(await vf.summary()) };
}

/** Tras el cobro: factura y correo. Cualquier fallo se registra y no afecta a la reserva. */
export async function afterPaid(bookingId) {
  try {
    const r = await issueInvoice(bookingId);
    if (r.invoice) await finalize(r.invoice, true);
    return r;
  } catch (e) { console.error('invoice_failed', bookingId, e && e.message); return { skipped: 'error' }; }
}

/** Tras una devolución íntegra: rectificativa y correo. */
export async function afterRefund(bookingId, reason) {
  try {
    const r = await issueRectification(bookingId, reason);
    if (r.invoice) await finalize(r.invoice, true);
    return r;
  } catch (e) { console.error('rectification_failed', bookingId, e && e.message); return { skipped: 'error' }; }
}

/* -------------------------------- Panel -------------------------------- */

const isUuid = (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || ''));

export async function invoicePdf(id) {
  if (!isUuid(id)) throw new HttpError(404, 'not_found');
  const { rows } = await q('select * from invoices where id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found');
  return { invoice: rows[0], pdf: await renderInvoicePdf(rows[0]) };
}

/** Desde el panel: expide la factura de una reserva si faltaba y la (re)envía; o reenvía cualquier factura por su id. */
export async function sendFromPanel(admin, { bookingId, invoiceId, kind }) {
  let inv;
  if (invoiceId) {
    if (!isUuid(invoiceId)) throw new HttpError(404, 'not_found');
    const r = await q('select * from invoices where id = $1', [invoiceId]);
    inv = r.rows[0];
    if (!inv) throw new HttpError(404, 'not_found');
  } else {
    if (!isUuid(bookingId)) throw new HttpError(404, 'not_found');
    if (kind === 'R') {
      const r = await q(`select * from invoices where booking_id = $1 and kind = 'R'`, [bookingId]);
      inv = r.rows[0];
      if (!inv) throw new HttpError(404, 'not_found');
    } else {
      const r = await issueInvoice(bookingId);
      if (r.skipped) throw new HttpError(409, `invoice_${r.skipped}`);
      inv = r.invoice;
    }
  }
  if (!(inv.data && inv.data.recipient && inv.data.recipient.email)) throw new HttpError(409, 'no_client_email', { code: inv.code });
  if (inv.vf_state === 'queued' || inv.vf_state === 'sending') { await flushVerifactu(4000); inv = await fresh(inv.id); if (inv.sent_at) return { code: inv.code, sent: true }; }
  const out = await deliverInvoice(inv);
  if (out.error === 'vf_not_registered') throw new HttpError(409, 'vf_not_registered', { code: inv.code });
  await audit(admin.email, out.sent ? 'invoice_sent' : 'invoice_send_failed', inv.booking_id, { code: inv.code });
  if (!out.sent) throw new HttpError(502, out.error === 'mail_not_configured' ? 'mail_off' : 'mail_failed', { code: inv.code });
  return { code: inv.code, sent: true };
}

/* ---------------------- Facturas emitidas desde el panel ---------------------- */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MAX_LINES = 12;   // una página

/** Factura emitida a mano. Comparte serie y numeración con las de la web: un solo libro de facturas. */
export async function createManualInvoice(admin, body) {
  const s = await getSettings();
  const cfg = s.invoice || {};
  if (!issuerReady(cfg)) throw new HttpError(409, 'invoice_issuer_incomplete');

  const rc = body.recipient || {};
  const name = clean(rc.name, 200), taxId = clean(rc.taxId, 20).replace(/[\s.-]/g, '').toUpperCase(), address = clean(rc.address, 300), email = clean(rc.email, 160).toLowerCase();
  if (name.length < 2) throw new HttpError(400, 'bad_recipient');
  if (taxId && !/^[A-Z0-9]{5,20}$/.test(taxId)) throw new HttpError(400, 'bad_tax_id');
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'bad_email');
  // Documento del cliente: NIF o NIE español por defecto; para quien no lo tiene, pasaporte u otro documento y su país.
  const idType = taxId && rc.idType && rc.idType !== 'nif' ? String(rc.idType) : 'nif';
  const idCountry = idType === 'nif' ? '' : clean(rc.idCountry, 2).toUpperCase();
  if (idType !== 'nif' && (!vf.ID_TYPES[idType] || !/^[A-Z]{2}$/.test(idCountry) || (idCountry === 'ES' && idType !== '03'))) throw new HttpError(400, 'bad_id_doc');
  const verifactu = vfOn(s);
  if (verifactu && taxId && idType === 'nif' && !vf.spanishTaxId(taxId)) throw new HttpError(400, 'bad_tax_id_es');

  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (!raw.length || raw.length > MAX_LINES) throw new HttpError(400, 'bad_lines');
  const lines = raw.map((l) => {
    const concept = clean(l && l.concept, 200), qty = Math.round(Number(l && l.qty) * 100) / 100, unitCents = Number(l && l.unitCents);
    if (concept.length < 2 || !(qty > 0) || qty > 100000 || !Number.isInteger(unitCents) || unitCents < 0 || unitCents > 100000000) throw new HttpError(400, 'bad_lines');
    return { concept, qty, unitCents, baseCents: Math.round(qty * unitCents) };
  });
  const base = lines.reduce((a, l) => a + l.baseCents, 0);
  if (!(base > 0)) throw new HttpError(400, 'bad_lines');

  const vatBp = body.vatBp === undefined || body.vatBp === null ? (Number.isInteger(cfg.vatBp) ? cfg.vatBp : 2100) : Number(body.vatBp);
  const irpfBp = body.irpfBp === undefined || body.irpfBp === null ? 0 : Number(body.irpfBp);
  if (!Number.isInteger(vatBp) || vatBp < 0 || vatBp > 3000) throw new HttpError(400, 'bad_vat');
  if (!Number.isInteger(irpfBp) || irpfBp < 0 || irpfBp > 2500) throw new HttpError(400, 'bad_irpf');
  // Sin IVA habría que declarar la causa (exención, no sujeción, inversión del sujeto pasivo): no está cubierto todavía.
  if (verifactu && vatBp === 0) throw new HttpError(400, 'vf_vat_zero');
  const vat = Math.round(base * vatBp / 10000), total = base + vat, irpf = Math.round(base * irpfBp / 10000);

  const simplified = !(taxId && address);
  if (simplified && (total > SIMPLIFIED_MAX_CENTS || irpfBp > 0)) throw new HttpError(400, 'recipient_data_required');

  const today = madrid().day;
  const issuedOn = body.issuedOn === undefined || body.issuedOn === null || body.issuedOn === '' ? today : String(body.issuedOn);
  if (!isDay(issuedOn) || issuedOn > today) throw new HttpError(400, 'bad_date');
  // El registro se remite al expedir: la fecha de expedición es la de hoy. Lo ya ocurrido va como fecha de la operación.
  if (verifactu && issuedOn !== today) throw new HttpError(400, 'vf_date_today');
  const operationOn = body.operationOn ? String(body.operationOn) : '';
  if (operationOn && (!isDay(operationOn) || operationOn > issuedOn)) throw new HttpError(400, 'bad_operation_date');
  const series = `${clean(cfg.series, 4).toUpperCase() || 'A'}${issuedOn.slice(0, 4)}`;
  const last = await q('select max(issued_on) as d from invoices where series = $1', [series]);
  if (last.rows[0] && last.rows[0].d && issuedOn < last.rows[0].d) throw new HttpError(400, 'bad_date', { last: last.rows[0].d });
  const paidOn = body.paidOn ? String(body.paidOn) : null;
  if (paidOn && (!isDay(paidOn) || paidOn > today)) throw new HttpError(400, 'bad_paid_date');

  const out = await insertNumbered({
    kind: 'F', series, booking_id: null, issued_on: issuedOn, total_cents: total, base_cents: base, vat_cents: vat, vat_bp: vatBp, simplified,
    origin: 'panel', irpf_bp: irpfBp, irpf_cents: irpf, paid_on: paidOn, created_by: admin.email, ...vfBirth(s, body.send === true && Boolean(email)),
    data: {
      issuer: { name: clean(cfg.issuer.name, 200), brand: clean(cfg.issuer.name, 200), tagline: TAGLINE, taxId: clean(cfg.issuer.taxId, 20).toUpperCase(), address: clean(cfg.issuer.address, 300), extra: clean(cfg.issuer.extra, 200), contact: clean(cfg.issuer.contact, 200) },
      recipient: { name, taxId, address, email, ...(idType !== 'nif' ? { idType, idCountry } : {}) },
      lines, concept: lines[0].concept, note: clean(body.note, 400), payNote: clean(cfg.payNote, 300), lang: 'es',
      ...(operationOn && operationOn !== issuedOn ? { operationOn } : {})
    }
  });
  await audit(admin.email, 'invoice_issued', null, { code: out.invoice.code });
  const done = await finalize(out.invoice, body.send === true && Boolean(email));
  return { id: done.id, code: done.code, sent: Boolean(done.sent_at), vf: done.vf_state || null };
}

/** Rectificativa íntegra de una factura emitida a mano. Las de la web se rectifican al cancelar la reserva con devolución. */
export async function rectifyManual(admin, id, reason, send, rectType) {
  if (!isUuid(id)) throw new HttpError(404, 'not_found');
  const { rows } = await q('select * from invoices where id = $1', [id]);
  const orig = rows[0];
  if (!orig) throw new HttpError(404, 'not_found');
  if (orig.kind !== 'F') throw new HttpError(409, 'not_rectifiable');
  if (orig.origin !== 'panel') throw new HttpError(409, 'rectify_via_booking');
  const had = await q('select code from invoices where rectifies = $1', [orig.id]);
  if (had.rows[0]) throw new HttpError(409, 'already_rectified', { code: had.rows[0].code });
  const today = madrid().day;
  const out = await insertNumbered({
    kind: 'R', series: `R${today.slice(0, 4)}`, booking_id: null, rectifies: orig.id, issued_on: today,
    total_cents: -orig.total_cents, base_cents: -orig.base_cents, vat_cents: -orig.vat_cents, vat_bp: orig.vat_bp, simplified: orig.simplified,
    origin: 'panel', irpf_bp: orig.irpf_bp, irpf_cents: -orig.irpf_cents, created_by: admin.email,
    ...vfBirth(await getSettings(), send === true && Boolean(orig.data.recipient && orig.data.recipient.email)),
    // R1 si la operación queda sin efecto o se devuelve el importe; R4 si lo que había era un error en la factura.
    data: { ...orig.data, payNote: '', note: '', operationOn: undefined, rectType: rectType === 'R4' ? 'R4' : 'R1', rectifies: { code: orig.code, issued_on: orig.issued_on }, reason: clean(reason, 200) || 'anulación de la factura' }
  });
  if (!out.created) throw new HttpError(409, 'already_rectified', { code: out.invoice.code });
  await audit(admin.email, 'invoice_rectified', null, { code: out.invoice.code, rectifies: orig.code });
  const done = await finalize(out.invoice, send === true && Boolean(orig.data.recipient && orig.data.recipient.email));
  return { id: done.id, code: done.code, sent: Boolean(done.sent_at), vf: done.vf_state || null };
}

/** Marca una factura emitida a mano como cobrada (con fecha) o la devuelve a pendiente. */
export async function setPaid(admin, id, paidOn) {
  if (!isUuid(id)) throw new HttpError(404, 'not_found');
  const today = madrid().day;
  const day = paidOn ? String(paidOn) : null;
  if (day && (!isDay(day) || day > today)) throw new HttpError(400, 'bad_paid_date');
  const r = await q(`update invoices set paid_on = $2 where id = $1 and kind = 'F' and origin = 'panel' returning code`, [id, day]);
  if (!r.rowCount) throw new HttpError(409, 'not_editable');
  await audit(admin.email, day ? 'invoice_paid' : 'invoice_unpaid', null, { code: r.rows[0].code });
  return { code: r.rows[0].code, paid_on: day };
}

const LIST_SQL = `
  select i.id, i.kind, i.code, i.issued_on, i.origin, i.total_cents, i.base_cents, i.vat_cents, i.vat_bp, i.irpf_bp, i.irpf_cents,
         i.simplified, i.paid_on, i.sent_at, i.send_error, i.booking_id,
         i.vf_state, i.vf_env, i.vf_url, i.vf_error, i.vf_tries, i.vf_sent_at, i.vf_registered_at, i.vf_deliver,
         i.data->'recipient'->>'address' as client_address, i.data->'recipient'->>'idType' as client_id_type, i.data->'recipient'->>'idCountry' as client_id_country,
         i.data->'recipient'->>'name' as client, i.data->'recipient'->>'taxId' as client_tax, i.data->'recipient'->>'email' as client_email,
         i.data->>'concept' as concept, i.data->>'reason' as reason,
         b.ref as booking_ref, o.code as rectifies_code, r.code as rectified_by
    from invoices i
    left join bookings b on b.id = i.booking_id
    left join invoices o on o.id = i.rectifies
    left join invoices r on r.rectifies = i.id
   where i.issued_on between $1 and $2
   order by i.issued_on desc, i.created_at desc, i.number desc`;

/** Libro de facturas expedidas de un año: todas, de la web y a mano, con totales por trimestre. */
export async function listInvoices(year) {
  const today = madrid().day;
  const y = /^\d{4}$/.test(String(year || '')) ? String(year) : today.slice(0, 4);
  const s = await getSettings();
  if (vfOn(s)) { try { await vf.refresh(5); } catch (e) { console.error('vf_refresh_failed', e && e.message); } }
  const { rows } = await q(LIST_SQL, [`${y}-01-01`, `${y}-12-31`]);
  const zero = () => ({ count: 0, base: 0, vat: 0, irpf: 0, total: 0 });
  const quarters = [1, 2, 3, 4].map((n) => ({ q: n, ...zero() })), totals = zero(), pending = { count: 0, cents: 0 };
  for (const r of rows) {
    const qt = quarters[Math.floor((Number(r.issued_on.slice(5, 7)) - 1) / 3)];
    for (const t of [qt, totals]) { t.count++; t.base += r.base_cents; t.vat += r.vat_cents; t.irpf += r.irpf_cents; t.total += r.total_cents; }
    if (r.kind === 'F' && !r.paid_on && !r.rectified_by) { pending.count++; pending.cents += r.total_cents - r.irpf_cents; }
  }
  const ys = await q(`select distinct substr(issued_on, 1, 4) as y from invoices order by 1 desc`);
  const years = [...new Set([today.slice(0, 4), ...ys.rows.map((r) => r.y)])].sort().reverse();
  return { year: y, years, invoices: rows, quarters, totals, pending, verifactu: { enabled: vfOn(s), mode: vf.vfMode(), ...(await vf.summary()) } };
}

/** Desde el panel: reintenta ahora mismo lo que estaba en cola. */
export async function retryVerifactu(admin) {
  const r = await flushVerifactu(9000);
  await vf.refresh(10, 4000);
  await audit(admin.email, 'vf_retry', null, { registered: r.registered, stopped: r.stopped });
  return { ...r, ...(await vf.summary()) };
}

/**
 * Corrige una factura que el proveedor no admitió (no se ha enviado nada ni se ha entregado al cliente) y la vuelve a poner en cola.
 * Se puede corregir el destinatario o, si cabe, emitirla como simplificada. El número no cambia.
 */
export async function fixInvalid(admin, id, body) {
  if (!isUuid(id)) throw new HttpError(404, 'not_found');
  const inv = await fresh(id);
  if (!inv) throw new HttpError(404, 'not_found');
  if (inv.vf_state !== 'invalid' || inv.sent_at) throw new HttpError(409, 'not_fixable');
  const data = { ...inv.data }, rec = { ...(data.recipient || {}) };
  let simplified = inv.simplified;
  if (body.simplified === true) {
    if (Math.abs(inv.total_cents) > SIMPLIFIED_MAX_CENTS || inv.irpf_cents) throw new HttpError(400, 'recipient_data_required');
    simplified = true; rec.taxId = ''; delete rec.idType; delete rec.idCountry;
  } else {
    const rc = body.recipient || {};
    const name = clean(rc.name, 200), taxId = clean(rc.taxId, 20).replace(/[\s.-]/g, '').toUpperCase(), address = clean(rc.address, 300);
    const idType = rc.idType && rc.idType !== 'nif' ? String(rc.idType) : 'nif', idCountry = idType === 'nif' ? '' : clean(rc.idCountry, 2).toUpperCase();
    if (name.length < 2) throw new HttpError(400, 'bad_recipient');
    if (!taxId || !address) throw new HttpError(400, 'recipient_data_required');
    if (idType === 'nif' ? !vf.spanishTaxId(taxId) : (!vf.ID_TYPES[idType] || !/^[A-Z]{2}$/.test(idCountry) || (idCountry === 'ES' && idType !== '03'))) throw new HttpError(400, idType === 'nif' ? 'bad_tax_id_es' : 'bad_id_doc');
    rec.name = name; rec.taxId = taxId; rec.address = address; delete rec.idType; delete rec.idCountry;
    if (idType !== 'nif') { rec.idType = idType; rec.idCountry = idCountry; }
    simplified = false;
  }
  data.recipient = rec;
  const up = await q(`update invoices set data = $2, simplified = $3, vf_state = 'queued', vf_error = null, vf_rev = vf_rev + 1 where id = $1 and vf_state = 'invalid' returning code`, [id, JSON.stringify(data), simplified]);
  if (!up.rowCount) throw new HttpError(409, 'not_fixable');
  await audit(admin.email, 'invoice_fixed', inv.booking_id, { code: inv.code });
  const done = await finalize(await fresh(id), false);
  return { id, code: inv.code, vf: done.vf_state, sent: Boolean(done.sent_at) };
}

const declarationReady = (v) => Boolean(v && v.producer && clean(v.producer.name, 200).length >= 3 && clean(v.producer.taxId, 20).length >= 8 && clean(v.producer.address, 300).length >= 8 && clean(v.place, 80).length >= 2 && isDay(v.signedOn));

/** Condiciones para encender o apagar VERI*FACTU. Se comprueban al guardar los ajustes. */
export async function guardVerifactuSettings(next, current) {
  if (!next.verifactu) return;
  const was = vfOn(current), will = next.verifactu.enabled === true, mode = vf.vfMode();
  const invoice = next.invoice || current.invoice;
  if (will && !was) {
    if (!mode) throw new HttpError(409, 'vf_not_configured');
    if (!(invoice && invoice.enabled === true && issuerReady(invoice))) throw new HttpError(409, 'vf_needs_invoicing');
  }
  // En real, el programa necesita su declaración responsable suscrita antes de expedir la primera factura.
  if (will && mode === 'prod' && !declarationReady(next.verifactu)) throw new HttpError(409, 'vf_declaration_incomplete');
  // La opción por VERI*FACTU dura, como mínimo, hasta el final del año natural del primer envío.
  // Desde el 6 de octubre de 2028 es obligatorio (Real Decreto-ley 43/2026): en real ya no se apaga.
  const today = madrid().day;
  if (was && !will && mode === 'prod' && (today >= '2028-10-06' || await vf.lockedYear(today.slice(0, 4)))) throw new HttpError(409, 'vf_locked');
}

/** Datos de la declaración responsable de este programa, con el componente del proveedor que cita. */
export async function declaration() {
  const s = await getSettings(), v = s.verifactu;
  return { system: vf.SIF, producer: v.producer, place: v.place, signedOn: v.signedOn, complete: declarationReady(v), enabled: vfOn(s), mode: vf.vfMode(), provider: await vf.providerComponent() };
}

/** Exportación para la gestoría: separado por punto y coma y con comas decimales, para abrirlo en Excel tal cual. */
export async function exportCsv(year) {
  const { invoices, year: y } = await listInvoices(year);
  const n = (c) => (c / 100).toFixed(2).replace('.', ',');
  const p = (bp) => String(bp / 100).replace('.', ',');
  const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t) && !/^-?\d/.test(t)) t = `'${t}`; return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ['Número', 'Fecha', 'Tipo', 'NIF cliente', 'Cliente', 'Concepto', 'Base imponible', 'Tipo IVA %', 'Cuota IVA', 'IRPF %', 'Retención IRPF', 'Total factura', 'A cobrar', 'Cobrada el', 'Origen', 'Rectifica a', 'Rectificada por', 'Reserva'];
  const body = [...invoices].reverse().map((r) => [
    r.code, r.issued_on.split('-').reverse().join('/'), r.kind === 'R' ? 'Rectificativa' : r.simplified ? 'Simplificada' : 'Completa', r.client_tax || '', r.client || '', r.concept || '',
    n(r.base_cents), p(r.vat_bp), n(r.vat_cents), p(r.irpf_bp), n(r.irpf_cents), n(r.total_cents), n(r.total_cents - r.irpf_cents),
    r.paid_on ? r.paid_on.split('-').reverse().join('/') : '', r.origin === 'web' ? 'Web' : 'Panel', r.rectifies_code || '', r.rectified_by || '', r.booking_ref || ''
  ]);
  return { filename: `facturas-${y}.csv`, csv: '﻿' + [head, ...body].map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n' };
}
