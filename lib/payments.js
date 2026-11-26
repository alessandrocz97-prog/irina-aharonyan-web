// Stripe: sesión de pago, verificación del aviso (webhook), devoluciones.
import { HttpError } from './core.js';

let client = null;
let forcedMode = null;

/** Para pruebas: inyecta un cliente de Stripe simulado. */
export function useStripe(fake, mode = 'test') { client = fake; forcedMode = mode; }

/** 'live', 'test' o null si no hay clave. Nunca devuelve la clave. */
export function stripeMode() {
  if (forcedMode) return forcedMode;
  const k = process.env.STRIPE_SECRET_KEY || '';
  if (/^(sk|rk)_live_/.test(k)) return 'live';
  if (/^(sk|rk)_test_/.test(k)) return 'test';
  return null;
}

export const webhookConfigured = () => Boolean(forcedMode || (process.env.STRIPE_WEBHOOK_SECRET || '').startsWith('whsec_'));

export async function stripe() {
  if (client) return client;
  if (!stripeMode()) throw new HttpError(503, 'payments_off');
  const { default: Stripe } = await import('stripe');
  client = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 15000 });
  return client;
}

const LOCALE = { es: 'es', it: 'it', ru: 'ru', hy: 'auto' };
const MODE_LABEL = {
  es: { presencial: 'Presencial', video: 'Videollamada', telefono: 'Teléfono' },
  it: { presencial: 'In studio', video: 'Videochiamata', telefono: 'Telefono' },
  ru: { presencial: 'Лично', video: 'Видеосвязь', telefono: 'Телефон' },
  hy: { presencial: 'Անձամբ', video: 'Տեսազանգ', telefono: 'Հեռախոս' }
};
const PRODUCT = { es: 'Consulta jurídica', it: 'Consulenza legale', ru: 'Юридическая консультация', hy: 'Իրավաբանական խորհրդատվություն' };

export async function createCheckout({ booking, base, releaseKey }) {
  const s = await stripe();
  const lang = MODE_LABEL[booking.lang] ? booking.lang : 'es';
  const when = new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(booking.day + 'T12:00:00Z'));
  return s.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: booking.id,
    customer_email: booking.email,
    locale: LOCALE[lang],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: booking.currency,
        unit_amount: booking.amount_cents,
        product_data: {
          name: `${PRODUCT[lang]} · ${MODE_LABEL[lang][booking.mode]}`,
          description: `${when}, ${booking.time} h · Ref. ${booking.ref}`
        }
      }
    }],
    // 30 minutos es el mínimo que admite Stripe; la hora se retiene un minuto más que la sesión.
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60 + 20,
    success_url: `${base}/?pago=ok&session_id={CHECKOUT_SESSION_ID}#reserva`,
    cancel_url: `${base}/?pago=cancelado&rid=${booking.id}&k=${releaseKey}#reserva`,
    metadata: { booking_id: booking.id, ref: booking.ref, day: booking.day, time: booking.time, mode: booking.mode },
    payment_intent_data: {
      description: `Consulta ${booking.ref} · ${booking.day} ${booking.time}`,
      receipt_email: booking.email,
      metadata: { booking_id: booking.id, ref: booking.ref }
    }
  }, { idempotencyKey: `checkout_${booking.id}` });
}

export async function verifyWebhook(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, 'webhook_secret_missing');
  const { default: Stripe } = await import('stripe');
  try {
    return await Stripe.webhooks.constructEventAsync(rawBody, signature || '', secret);
  } catch {
    throw new HttpError(400, 'bad_signature');
  }
}

export async function refund(paymentIntent, bookingId) {
  const s = await stripe();
  return s.refunds.create({ payment_intent: paymentIntent, metadata: { booking_id: bookingId } },
    { idempotencyKey: `refund_${bookingId}` });
}

export async function expireSession(sessionId) {
  try { const s = await stripe(); await s.checkout.sessions.expire(sessionId); } catch { /* ya pagada o ya caducada */ }
}
