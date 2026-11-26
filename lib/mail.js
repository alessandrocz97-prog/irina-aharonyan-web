// Envío de correo por SMTP. Las credenciales viven en las variables de entorno del servidor:
// SMTP_HOST, SMTP_PORT (465 por defecto), SMTP_USER, SMTP_PASS y MAIL_FROM.
let fake = null;
let transport = null;

/** Para pruebas: sustituye el envío real por una función. */
export function useMailer(fn) { fake = fn; transport = null; }

export function mailConfigured() {
  const e = process.env;
  return Boolean(fake || (e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS && e.MAIL_FROM));
}

export async function sendMail(message) {
  if (fake) return fake(message);
  if (!mailConfigured()) throw new Error('mail_not_configured');
  if (!transport) {
    const { default: nodemailer } = await import('nodemailer');
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000
    });
  }
  return transport.sendMail({ from: process.env.MAIL_FROM, ...message });
}
