# Web de Irina Aharonyan · reservas con pago por adelantado

Web pública (5 idiomas: español, valenciano, ruso, armenio e italiano), motor de reservas y panel de gestión. Una consulta solo queda reservada cuando Stripe confirma el cobro.

## Qué hay en esta carpeta

| Ruta | Qué es |
| --- | --- |
| `public/index.html`, `public/img/` | La web pública |
| `public/panel/index.html` | El panel de reservas (`/panel/`) |
| `api/index.js`, `lib/` | El servidor: agenda, reservas, cobro, facturas, acceso al panel |
| `lib/invoice-pdf.js`, `lib/fonts/` | La factura en PDF con el estilo de la web (fuentes con licencia abierta) |
| `lib/verifactu.js` | La conexión con VERI*FACTU: registro de cada factura en la AEAT a través de Verifacti |
| `vercel.json`, `package.json` | Configuración de Vercel (región Fráncfort, Node 22) |
| `test/` | 61 pruebas automáticas (`npm install && node test/run.mjs`) |
| `dev/` | Servidor local de pruebas con datos de ejemplo (`node dev/server.mjs`) |
| `web/` | Fuente de la web pública: textos por idioma (`web/src/content/`), estilos, imágenes y `web/build.py`, que regenera `public/index.html` |

## Puesta en marcha (una sola vez)

Los valores secretos se escriben en Vercel (Project → Settings → Environment Variables). Nunca en un chat ni en un correo.

1. **Proyecto en Vercel.** Importar este repositorio como proyecto nuevo. Sin framework; no hay que tocar ningún ajuste de compilación.
2. **Base de datos.** En el proyecto: Storage → Create Database → Neon (Postgres) → región Frankfurt → Connect. Vercel añade sola la variable `DATABASE_URL`. Las tablas se crean solas en el primer uso.
3. **Clave de sesión.** No hay que hacer nada: el servidor crea la suya al conectar la base de datos y la guarda en ella. Quien prefiera fijarla a mano puede definir la variable `SESSION_SECRET` (cadena aleatoria de 32 caracteres o más), que tiene preferencia.
4. **Código de alta.** Variable `PANEL_SETUP_CODE`: un código de 8 caracteres o más. Sirve para crear las cuentas del panel.
5. **Stripe (cuenta de la abogada).** En Stripe, en modo de pruebas:
   - Developers → API keys → copiar la clave secreta a la variable `STRIPE_SECRET_KEY`.
   - Developers → Webhooks → Add endpoint → `https://<dominio>/api/stripe/webhook`, con estos eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`. Copiar el «signing secret» a la variable `STRIPE_WEBHOOK_SECRET`.
6. **Redeploy** del proyecto para que lea las variables.
7. **Cuentas.** Abrir `/panel/`, crear la cuenta de la abogada (titular) y la del gestor con el código de alta. Después, borrar `PANEL_SETUP_CODE` en Vercel y hacer Redeploy: así nadie más puede crear cuentas.
8. **Precios y horario.** En Ajustes, fijar el precio de cada modalidad y el texto que se muestra antes de pagar; sin precio, la web no ofrece esa modalidad. En la pestaña Horario, marcar los días y las horas de atención y revisar las reglas de reserva.
9. **Probar** una reserva con la tarjeta de pruebas de Stripe `4242 4242 4242 4242` y cancelarla desde el panel con devolución.
10. **Correo para las facturas.** Cuatro variables con los datos SMTP de la cuenta desde la que saldrán: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` y `MAIL_FROM` (por ejemplo `Irina Aharonyan <facturas@dominio.es>`); `SMTP_PORT` solo si no es el 465. Mejor una cuenta o una contraseña de aplicación dedicada, no la contraseña personal. Redeploy.
11. **Facturación.** En Ajustes → Facturación: nombre, NIF, domicilio fiscal, IVA y serie; marcar «Enviar factura automática al cobrar». Mientras esté apagada o falten datos, se cobra y se reserva igual, pero no se expide nada.
12. **Pasar a real.** Sustituir las dos variables de Stripe por las de modo real (clave `sk_live_…` y el secreto del webhook creado en modo real) y Redeploy.
13. **VERI*FACTU en pruebas.** Crear una cuenta gratuita en Verifacti y copiar la clave del NIF de pruebas (`vf_test_…`) a la variable `VERIFACTI_API_KEY`. Añadir `CRON_SECRET` (cadena aleatoria de 16 caracteres o más) para el reintento horario. Redeploy. En Ajustes → VERI*FACTU, marcar «Registrar cada factura en la AEAT» y emitir una factura simplificada, una completa y una rectificativa. Ver la lista de comprobación de más abajo.
14. **VERI*FACTU en real.** Contratar en Verifacti el NIF de la abogada en producción; ella firma el modelo de representación que autoriza a Verifacti a remitir en su nombre. Completar y guardar en el panel la declaración responsable del programa. Sustituir la clave por la de producción (`vf_prod_…`) y Redeploy.

## El panel, pestaña a pestaña

- **Agenda.** Calendario del mes, el día elegido hora a hora y las próximas reservas. Desde aquí se añade una reserva acordada por teléfono («Nueva reserva»), se bloquea una hora o un día entero y se añade una hora extra a un día concreto.
- **Reservas.** Listado con buscador por nombre, teléfono o referencia. Al abrir una reserva se puede llamar o escribir al cliente, cambiarla de día u hora y cancelarla, con devolución por Stripe si se pagó en la web.
- **Horario.** El horario habitual se indica por tramos («de 09:00 a 14:00»); el panel los reparte en consultas según la duración fijada. También están aquí las reglas de reserva (duración, antelación mínima y con cuántos días se abre la agenda) y los días libres o vacaciones, que se bloquean por fechas.
- **Facturas**, **Ajustes** y **Actividad**: facturación, cobro y registro de quién hizo qué.

Cambiar una reserva de día u hora no avisa al cliente ni modifica la factura ya expedida: el panel ofrece un correo ya redactado para confirmárselo. Bloquear días no cancela las reservas confirmadas que caigan dentro; el panel avisa de cuántas hay.

## Idiomas

La web se muestra en español, valenciano, ruso, armenio e italiano. La consulta se atiende en español, ruso, armenio o italiano: quien navega en valenciano elige uno de esos cuatro como idioma de la consulta, y en ese idioma recibe el correo y la factura sigue en español. Los textos legales se muestran en español en todos los idiomas. Para añadir el valenciano como idioma de atención basta con incluirlo en `consultLangs` (`web/src/app.js`) y en `LANGS` (`lib/bookings.js`), y traducir los textos del correo en `lib/invoices.js` y `lib/payments.js`.

## Dirección de pruebas en Vercel

Mientras la web se sirva desde una dirección `*.vercel.app`, lleva la cabecera `X-Robots-Tag: noindex` (`vercel.json`): los buscadores no la indexan. Con el dominio definitivo la cabecera deja de enviarse sola.

## Cómo funciona el cobro

- Al elegir hora y pulsar pagar, la hora queda retenida 31 minutos y el cliente pasa a la página de pago de Stripe.
- La reserva pasa a «Confirmada» solo cuando Stripe avisa al servidor de que el pago se ha cobrado. Si el cliente no paga, la hora vuelve a quedar libre.
- Dos personas no pueden quedarse la misma hora: lo impide la propia base de datos.
- Si un pago llega tarde y la hora ya es de otra persona, el importe se devuelve solo y queda anotado.
- Desde el panel se puede cancelar una reserva y devolver el importe por Stripe en el mismo paso.

## Facturación centralizada (pestaña «Facturas» del panel)

- Un solo libro: las facturas que nacen de los cobros de la web y las que la titular emite a mano comparten serie y numeración.
- **Nueva factura:** cliente, NIF, domicilio, varias líneas (concepto, cantidad, precio sin IVA), IVA, retención de IRPF (0, 7 o 15 %), fecha, nota y envío por correo. La fecha no puede ser futura ni anterior a la última factura de la serie.
- **Cobros:** las de la web nacen cobradas; las emitidas a mano se marcan como cobradas con su fecha. El resumen muestra lo pendiente de cobro.
- **Rectificar:** una factura emitida no se edita ni se borra; se rectifica (serie `R`). Las de la web se rectifican solas al cancelar la reserva con devolución.
- **Totales:** base, IVA e IRPF retenido por trimestre y por año, para cuadrar con los modelos que presenta la gestoría.
- **Exportar para la gestoría:** un CSV por año con todas las facturas (se abre en Excel tal cual).
- No registra gastos ni facturas recibidas, y no presenta impuestos: es el libro de facturas expedidas, no la contabilidad completa.

## Facturas

- Al confirmarse el cobro se expide la factura y se envía al cliente en PDF, en un correo con el estilo de la web y en su idioma. La factura va en español.
- Numeración correlativa y sin huecos por serie y año: `A2026-0001`, `A2026-0002`… Las rectificativas llevan serie propia: `R2026-0001`.
- Sin NIF ni domicilio del cliente se expide factura simplificada (hasta 400 € con IVA incluido). Si el cliente los escribe al reservar, la factura es completa. Por encima de 400 € sin esos datos no se expide: hay que hacerla aparte.
- El IVA se desglosa a partir del precio, que es IVA incluido: base = total / 1,21; cuota = total − base.
- Si se devuelve el importe (desde el panel o desde Stripe), se expide y envía la factura rectificativa.
- Si el correo falla, la reserva sigue confirmada y la factura queda «pendiente de envío» en la ficha, con botón para enviarla.
- Desde la ficha de cada reserva se puede ver el PDF y reenviarlo.
- No aplica retención de IRPF: si el cliente es una empresa o un profesional obligado a retener, la factura debe hacerse aparte.

## VERI*FACTU

Con la facturación centralizada, este panel es el programa de facturación de la titular y le aplica el Reglamento de sistemas informáticos de facturación (Real Decreto 1007/2023). La titular es autónoma: su fecha de obligación es el 1 de julio de 2027 (Real Decreto-ley 15/2025). El panel cumple en la modalidad VERI*FACTU a través de la API de Verifacti (Bilbabit, S. L.), colaborador social de la AEAT.

**Reparto.** El panel expide la factura (número, importes, PDF). Verifacti genera el registro de facturación, su huella y su encadenamiento, lo remite a la AEAT con su propio certificado y devuelve la URL del QR. La clave de Verifacti vive solo en Vercel.

**Qué hace el panel cuando VERI*FACTU está encendido**

- Cada factura (de la web, a mano y rectificativa) nace «en cola» y se envía a Verifacti en el mismo momento, en orden de expedición.
- El correo al cliente sale después de quedar registrada, con el QR de 32 mm y la leyenda «VERI*FACTU» en el PDF. Sin registro no se entrega nada.
- Si Verifacti o la red fallan, la reserva se confirma igual, la factura se queda en cola y se reintenta cada hora (tarea programada de Vercel en `/api/cron/verifactu`). El panel muestra cuántas hay pendientes y permite reintentar a mano.
- Si Verifacti no admite los datos del cliente (NIF o nombre que no coinciden con el censo), no se envía nada: la factura queda marcada y se corrige desde su ficha, con el mismo número.
- La respuesta de la AEAT (registrada, aceptada con errores, rechazada) se consulta sola y se ve en el libro de facturas.
- La factura lleva siempre la fecha de hoy; lo ocurrido antes se indica como fecha de la operación.
- La retención de IRPF no forma parte del registro: el importe comunicado es base más IVA.
- Tipos de registro: F1 (completa), F2 (simplificada), R1 (rectificativa porque la operación se anula o se devuelve), R4 (rectificativa por error en la factura), R5 (rectificativa de simplificada).
- Con la clave real no sale ningún registro mientras la declaración responsable no esté completa, y tras la primera factura real ya no se puede apagar.

**Lista de comprobación en el entorno de pruebas (obligatoria antes de pasar a real).** La conexión está escrita contra la documentación pública de Verifacti y probada contra un simulador; no se ha ejecutado contra el servicio real.

1. Las tres facturas de prueba acaban en «Registrada».
2. El enlace «Comprobar en la AEAT» abre la factura en el entorno de pruebas de la AEAT y el número que muestra es exactamente el impreso (por ejemplo `A2027-0001`). El panel avisa en la ficha si no coincide.
3. Quitar la clave un momento (o poner una incorrecta), emitir una factura y ver que queda en cola y no se envía al cliente; restaurar la clave y pulsar «Reintentar ahora».
4. Emitir una factura completa con un NIF inventado y ver que queda como «Datos no admitidos» y se puede corregir.

**Declaración responsable.** Verifacti publica la de su componente. Este panel es el componente principal y necesita la suya, suscrita por quien lo ha desarrollado (persona o empresa), no por la abogada. Se rellena en Ajustes → VERI*FACTU y se consulta desde ahí. Cada cambio en el código de facturación es una versión nueva: hay que subir `SIF.version` en `lib/verifactu.js` y volver a suscribirla. Según las preguntas frecuentes de la AEAT, producir un programa que no cumple se sanciona con 150.000 € por ejercicio y tenerlo, con 50.000 €.

**Lo que esta conexión no cubre**

- Facturas sin IVA (exentas, no sujetas o con inversión del sujeto pasivo): el panel las rechaza con VERI*FACTU encendido.
- En la web, la factura completa exige NIF o NIE español; con otro documento sale simplificada. Desde el panel sí se admite pasaporte u otro documento con su país.
- Subsanación y anulación de registros: una factura rechazada o aceptada con errores se resuelve con una rectificativa o desde la cuenta de Verifacti.
- El reintento horario usa las tareas programadas de Vercel (`crons` en `vercel.json`) y la variable `CRON_SECRET`. Hay que comprobar en el proyecto, tras publicar, que la tarea aparece y se ejecuta cada hora con el plan contratado.
- Los conceptos de las facturas se comunican a la AEAT dentro del registro: conviene redactarlos sin datos del asunto.

## Lo que esta versión no hace

- El único correo propio es el de la factura. No hay recordatorios de cita ni aviso a la abogada por cada reserva: sus avisos son los de Stripe, la copia de la factura y el propio panel.
- No registra gastos ni facturas recibidas.
- No sincroniza con Google Calendar ni Outlook.

## Pendiente antes de publicar

- Número de colegiada y colegio en el pie de la web.
- Texto de condiciones de contratación y de cancelación, redactado por la abogada.
- Revisión de las traducciones (ruso, armenio, italiano) por un hablante nativo.
- Fotografías reales en lugar de las imágenes provisionales.
- Si el gestor accede a datos de clientes, contrato de encargo de tratamiento entre la abogada y el gestor.
- Plan Pro de Vercel: el plan gratuito es solo para uso no comercial.
- VERI*FACTU: pasar la lista de comprobación en pruebas, decidir quién suscribe la declaración responsable, contratar Verifacti y firmar el modelo de representación y el acuerdo de encargo de tratamiento.
