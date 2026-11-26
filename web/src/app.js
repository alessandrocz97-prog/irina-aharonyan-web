(function () {
  'use strict';

  var I18N = window.IA_I18N;
  var ICONS = window.IA_ICONS;

  /* ------------------------------------------------------------------
     Datos del despacho: un único lugar para cambiarlos
  ------------------------------------------------------------------ */
  var SITE = {
    name: 'Irina Aharonyan',
    phone: '(+34) 688 222 133',
    tel: 'tel:+34688222133',
    email: 'info@irinaaharonyan.es',
    street: "Carrer del Comte d'Altea, 20, pta. 12",
    city: '46005 Valencia',
    maps: 'https://www.google.com/maps/search/?api=1&query=Carrer+del+Comte+d%27Altea+20%2C+46005+Valencia',
    gandia: 'Calle San Carlos, 1',
    hoursAm: '09:00–14:00',
    hoursPm: '16:00–19:00',
    barNumber: '',            /* n.º de colegiada: pendiente */
    langs: ['es', 'va', 'ru', 'hy', 'it'],          /* idiomas de la web */
    consultLangs: ['es', 'ru', 'hy', 'it'],          /* idiomas en los que se atiende la consulta */
    langNames: { es: 'Español', va: 'Valencià', ru: 'Русский', hy: 'Հայերեն', it: 'Italiano' },
    locale: { va: 'ca-ES-valencia' },                /* fechas e importes */
    htmlLang: { va: 'ca-valencia' },                 /* etiqueta de idioma del documento */
    slotsAm: ['09:00', '10:00', '11:00', '12:00', '13:00'],
    slotsPm: ['16:00', '17:00', '18:00'],
    bookDaysAhead: 90
  };

  var AREAS = [
    ['derecho-penal-economico', 'coins'], ['delitos-contra-el-patrimonio', 'key'],
    ['fraudes-por-internet', 'laptop'], ['delitos-contra-las-personas', 'pulse'],
    ['libertad-sexual', 'shieldUser'], ['libertad-y-seguridad', 'lockOpen'],
    ['salud-publica', 'capsule'], ['administracion-publica', 'pediment'],
    ['seguridad-vial', 'wheel'], ['intimidad-y-honor', 'eyeOff'],
    ['falsedades-documentales', 'document'], ['derecho-procesal-penal', 'gavel']
  ];
  var NAV = [
    ['inicio', 'home'], ['sobre-mi', 'about'], ['especialidades', 'areas'],
    ['metodologia', 'method'], ['publicaciones', 'pubs'], ['contacto', 'contact']
  ];
  var LEGAL = ['aviso-legal', 'privacidad', 'cookies', 'condiciones'];
  var LEGAL_KEY = { 'aviso-legal': 'legal', 'privacidad': 'privacy', 'cookies': 'cookies', 'condiciones': 'terms' };

  /* ------------------------------------------------------------------
     Estado
  ------------------------------------------------------------------ */
  var state = {
    lang: 'es',
    route: 'inicio',
    first: true,
    book: {
      mode: null, date: null, time: null, month: null, done: false,
      form: { name: '', phone: '', email: '', clang: '', msg: '', tax: '', addr: '', ok: false, terms: false }
    }
  };
  try {
    var saved = window.localStorage.getItem('ia-lang');
    if (saved && I18N[saved]) state.lang = saved;
  } catch (e) { /* sin almacenamiento: se queda en español */ }

  function tr() { return I18N[state.lang] || I18N.es; }
  function loc() { return SITE.locale[state.lang] || state.lang; }
  function tag(l) { return SITE.htmlLang[l] || l; }
  /* Idioma de la consulta por defecto: el de la web si se atiende en él; si no, español */
  function consultLang() { return SITE.consultLangs.indexOf(state.lang) > -1 ? state.lang : 'es'; }

  /* ------------------------------------------------------------------
     Utilidades
  ------------------------------------------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ic(name, cls) {
    var i = ICONS[name];
    return '<svg class="' + (cls || 'ic') + '" viewBox="0 0 ' + i.s + ' ' + i.s + '" aria-hidden="true" focusable="false">' + i.d + '</svg>';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromIso(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function fmt(d, opts) {
    try { return new Intl.DateTimeFormat(loc(), opts).format(d); }
    catch (e) { return d.toLocaleDateString(); }
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function areaIndex(slug) {
    for (var i = 0; i < AREAS.length; i++) if (AREAS[i][0] === slug) return i;
    return -1;
  }
  function arrow() { return ic('arrow', 'ui arr'); }

  /* ------------------------------------------------------------------
     Piezas comunes
  ------------------------------------------------------------------ */
  /* Banderas del selector de idioma, simplificadas para leerse a 18 px de ancho */
  var FLAGS = {
    es: '<path fill="#AA151B" d="M0 0h30v20H0z"/><path fill="#F1BF00" d="M0 5h30v10H0z"/>',
    va: '<path fill="#FCDD09" d="M0 0h30v20H0z"/><path fill="#DA121A" d="M8 2.220h22v2.220H8zm0 4.450h22v2.220H8zm0 4.440h22v2.220H8zm0 4.450h22v2.220H8z"/>' +
      '<path fill="#0D5EAF" d="M0 0h6.200v20H0z"/><path fill="#DA121A" d="M6.200 0h1.800v20H6.200z"/><path fill="#FCDD09" d="M5.850 0h.7v20h-.7zM7.650 0h.7v20h-.7z"/>',
    ru: '<path fill="#fff" d="M0 0h30v20H0z"/><path fill="#0039A6" d="M0 6.670h30v6.660H0z"/><path fill="#D52B1E" d="M0 13.330h30V20H0z"/>',
    hy: '<path fill="#D90012" d="M0 0h30v20H0z"/><path fill="#0033A0" d="M0 6.670h30v6.660H0z"/><path fill="#F2A800" d="M0 13.330h30V20H0z"/>',
    it: '<path fill="#fff" d="M0 0h30v20H0z"/><path fill="#009246" d="M0 0h10v20H0z"/><path fill="#CE2B37" d="M20 0h10v20H20z"/>'
  };
  function langHTML(T) {
    return '<div class="lang" role="group" aria-label="' + T.nav.lang + '">' + SITE.langs.map(function (l) {
      return '<button type="button" data-lang="' + l + '" lang="' + tag(l) + '" title="' + SITE.langNames[l] +
        '" aria-label="' + SITE.langNames[l] + '" aria-pressed="' + (state.lang === l) + '">' +
        '<svg class="flag" viewBox="0 0 30 20" aria-hidden="true" focusable="false">' + FLAGS[l] + '</svg><span>' + l.toUpperCase() + '</span></button>';
    }).join('') + '</div>';
  }

  function monoHTML() {
    return '<div class="mono" aria-hidden="true"><span class="mono__line"></span>' +
      '<span class="mono__mark"><span>IA</span>' +
      '<svg viewBox="0 0 120 20" preserveAspectRatio="none"><path d="M2 17C40 17 82 12 118 2 88 13 48 19.500 2 17z"/></svg></span>' +
      '<span class="mono__line"></span></div>';
  }

  function topHTML(T) {
    return '<div class="util"><div class="wrap util__in">' +
      '<div class="util__contact"><a href="' + SITE.tel + '">' + ic('phone', 'ui') + '<span>' + SITE.phone + '</span></a>' +
      '<span class="util__hours">' + T.common.hoursDays + ' · ' + SITE.hoursAm + ' · ' + SITE.hoursPm + '</span></div>' +
      langHTML(T) + '</div></div>' +
      '<div class="mast"><img class="mast__col" src="img/column.jpg" alt="" width="600" height="900">' +
      '<div class="wrap">' + monoHTML() +
      '<p class="mast__name">' + SITE.name + '</p>' +
      '<p class="mast__role">' + T.brand.role + '</p>' +
      '<p class="mast__tag">' + T.brand.tagline + '</p></div></div>';
  }

  function barHTML(T) {
    return '<div class="wrap bar__in">' +
      '<a class="brand" href="#inicio" aria-label="' + SITE.name + '"><span class="brand__mono" aria-hidden="true">IA</span>' +
      '<span class="brand__name">' + SITE.name + '</span></a>' +
      '<nav class="bar__nav" aria-label="' + T.nav.menu + '"><ul class="nav">' + NAV.map(function (n) {
        return '<li><a href="#' + n[0] + '" data-nav="' + n[0] + '">' + T.nav[n[1]] + '</a></li>';
      }).join('') + '</ul></nav>' +
      '<a class="btn bar__cta" href="#reserva">' + ic('calendar', 'ui') + '<span>' + T.nav.bookShort + '</span></a>' +
      '<button class="bar__menu" type="button" aria-expanded="false" aria-controls="menu"><span>' + T.nav.menu + '</span>' + ic('menu', 'ui') + '</button>' +
      '</div>';
  }

  function menuHTML(T) {
    return '<div class="menu__top"><a class="brand brand--static" href="#inicio"><span class="brand__mono" aria-hidden="true">IA</span>' +
      '<span class="brand__name">' + SITE.name + '</span></a>' +
      '<button class="bar__menu" type="button" data-menu-close><span>' + T.nav.close + '</span>' + ic('close', 'ui') + '</button></div>' +
      '<nav aria-label="' + T.nav.menu + '">' + NAV.map(function (n) {
        return '<a href="#' + n[0] + '" data-nav="' + n[0] + '">' + T.nav[n[1]] + '</a>';
      }).join('') + '</nav>' +
      '<div class="menu__foot">' + langHTML(T) +
      '<a class="btn" href="' + SITE.tel + '">' + ic('phone', 'ui') + '<span>' + SITE.phone + '</span></a>' +
      '<a class="btn btn--solid" href="#reserva">' + ic('calendar', 'ui') + '<span>' + T.nav.book + '</span></a></div>';
  }

  function dockHTML(T) {
    return '<a class="btn" href="' + SITE.tel + '">' + ic('phone', 'ui') + '<span>' + T.nav.call + '</span></a>' +
      '<a class="btn btn--solid" href="#reserva">' + ic('calendar', 'ui') + '<span>' + T.nav.bookShort + '</span></a>';
  }

  function footHTML(T) {
    var F = T.foot;
    return '<div class="wrap foot__grid">' +
      '<div class="foot__brand"><a class="brand brand--static" href="#inicio"><span class="brand__mono" aria-hidden="true">IA</span>' +
      '<span class="brand__name">' + SITE.name + '</span></a>' +
      '<p>' + F.about + '</p>' +
      '<p class="foot__bar">' + F.bar + ' <span class="todo">' + (SITE.barNumber || '—') + '</span></p></div>' +
      '<div><h3>' + F.office + '</h3><ul>' + NAV.map(function (n) {
        return '<li><a href="#' + n[0] + '">' + T.nav[n[1]] + '</a></li>';
      }).join('') + '<li><a href="#reserva">' + T.nav.book + '</a></li></ul></div>' +
      '<div><h3>' + F.areas + '</h3><ul class="foot__areas">' + AREAS.map(function (a) {
        return '<li><a href="#' + a[0] + '">' + T.areas[a[0]].name + '</a></li>';
      }).join('') + '</ul></div>' +
      '<div><h3>' + F.contact + '</h3><ul>' +
      '<li><a href="' + SITE.tel + '">' + SITE.phone + '</a></li>' +
      '<li><a href="mailto:' + SITE.email + '">' + SITE.email + '</a></li>' +
      '<li>' + SITE.street + '<br>' + (T.common.city || SITE.city) + '</li>' +
      '<li>' + T.common.hoursDays + '<br>' + SITE.hoursAm + ' · ' + SITE.hoursPm + '</li></ul></div>' +
      '</div>' +
      '<div class="wrap"><div class="foot__base"><span>© ' + new Date().getFullYear() + ' ' + SITE.name + '. ' + F.rights + '</span>' +
      '<span class="foot__legal"><a href="#aviso-legal">' + F.legal + '</a><a href="#privacidad">' + F.privacy + '</a><a href="#cookies">' + F.cookies + '</a><a href="#condiciones">' + F.terms + '</a></span></div></div>';
  }

  function pageHead(title, lead, crumbs) {
    return '<section class="phead"><img class="phead__col" src="img/column.jpg" alt="" width="600" height="900">' +
      '<div class="wrap"><div class="phead__in">' + (crumbs || '') +
      '<h1 class="h-page">' + title + '</h1>' +
      (lead ? '<p class="phead__lead">' + lead + '</p>' : '') + '</div></div></section>';
  }

  function ctaRow(T) {
    return '<section class="cta"><div class="wrap cta__in"><div><h2>' + T.common.ctaTitle + '</h2><p>' + T.common.ctaText + '</p></div>' +
      '<div class="cta__actions"><a class="btn btn--solid" href="#reserva"><span>' + T.nav.book + '</span>' + arrow() + '</a>' +
      '<a class="tel" href="' + SITE.tel + '">' + ic('phone', 'ui') + '<span>' + SITE.phone + '</span></a></div></div></section>';
  }

  function pubMeta(p) {
    return '<span class="pub__meta"><time datetime="' + p.date + '">' + fmt(fromIso(p.date), { day: 'numeric', month: 'long', year: 'numeric' }) + '</time><b>' + p.cat + '</b></span>';
  }

  /* ------------------------------------------------------------------
     Vistas
  ------------------------------------------------------------------ */
  function vHome(T) {
    var H = T.home;
    return '<section class="hero"><div class="hero__media"><img src="img/hero.jpg" alt="' + esc(H.imgAlt) + '" width="1872" height="1482" fetchpriority="high"></div>' +
      '<div class="wrap hero__in"><div class="hero__copy">' +
      '<h1 class="h-display">' + H.h1 + '</h1><span class="rule"></span>' +
      '<p class="hero__lead">' + H.lead + '</p>' +
      '<div class="hero__actions"><a class="btn btn--solid" href="#reserva"><span>' + T.nav.book + '</span>' + arrow() + '</a>' +
      '<a class="tel" href="' + SITE.tel + '">' + ic('phone', 'ui') + '<span>' + H.call + '</span></a></div>' +
      '</div></div></section>' +

      '<section class="facts"><div class="wrap facts__grid">' + H.facts.map(function (f) {
        return '<div class="fact"><h2 class="fact__t">' + f.t + '</h2><p class="fact__d">' + f.d + '</p></div>';
      }).join('') + '</div></section>' +

      '<section class="section"><div class="wrap"><h2 class="ruled"><span>' + H.areasTitle + '</span></h2>' +
      '<div class="areas">' + AREAS.map(function (a) {
        return '<a class="area" href="#' + a[0] + '">' + ic(a[1]) + '<span>' + T.areas[a[0]].name + '</span></a>';
      }).join('') + '</div></div></section>' +

      '<section class="method"><img class="method__img" src="img/books.jpg" alt="" width="645" height="534" loading="lazy">' +
      '<div class="wrap"><div class="method__in"><h2 class="h-section">' + H.methodTitle + '</h2>' +
      '<div class="method__txt"><p>' + H.methodText + '</p><a class="more" href="#metodologia"><span>' + H.methodLink + '</span>' + arrow() + '</a></div></div>' +
      '<ol class="msum">' + T.method.steps.map(function (s, i) {
        return '<li><span class="msum__n">' + pad(i + 1) + '</span><span class="msum__t">' + s.t + '</span></li>';
      }).join('') + '</ol></div></section>' +

      '<section class="section"><div class="wrap"><div class="shead"><h2 class="h-section">' + H.pubsTitle + '</h2>' +
      '<a class="more" href="#publicaciones"><span>' + H.pubsLink + '</span>' + arrow() + '</a></div>' +
      '<div class="pubs3">' + T.pubs.items.slice(0, 3).map(function (p) {
        return '<article class="pub">' + pubMeta(p) + '<h3 class="pub__t">' + p.t + '</h3><p class="pub__d">' + p.d + '</p></article>';
      }).join('') + '</div></div></section>' +

      '<section class="urgent"><div class="wrap urgent__in"><div><h2>' + H.urgentTitle + '</h2><p>' + H.urgentText + '</p></div>' +
      '<div class="urgent__act"><a class="urgent__tel" href="' + SITE.tel + '">' + SITE.phone + '</a>' +
      '<span class="urgent__hours">' + T.common.hoursDays + ' · ' + SITE.hoursAm + ' · ' + SITE.hoursPm + '</span>' +
      '<a class="btn btn--light" href="#reserva">' + ic('calendar', 'ui') + '<span>' + T.nav.book + '</span></a></div></div></section>';
  }

  function vAbout(T) {
    var A = T.about;
    return pageHead(A.title, A.lead) +
      '<section class="section"><div class="wrap about"><div class="about__text"><p>' + A.p1 + '</p><p>' + A.p2 + '</p></div>' +
      '<div class="duo"><img class="duo__main" src="img/portrait.jpg" alt="' + esc(A.imgAlt) + '" width="1200" height="1425">' +
      '<img class="duo__over" src="img/statue.jpg" alt="' + esc(A.imgAlt2) + '" width="537" height="915" loading="lazy"></div></div></section>' +

      '<section class="section section--linen"><div class="wrap split"><div><h2 class="h-section">' + A.eduTitle + '</h2><ul class="rows">' +
      A.edu.map(function (e) { return '<li>' + ic('check', 'ui') + '<span>' + e + '</span></li>'; }).join('') + '</ul></div>' +
      '<div><h2 class="h-section">' + A.approachTitle + '</h2><p class="split__p">' + A.approach + '</p>' +
      '<p class="split__meta"><b>' + A.langsTitle + '</b>' + T.common.langs + '</p></div></div></section>' +

      '<section class="section"><div class="wrap"><h2 class="ruled"><span>' + A.valuesTitle + '</span></h2><div class="quad">' +
      A.values.map(function (v) { return '<div><h3>' + v.t + '</h3><p>' + v.d + '</p></div>'; }).join('') + '</div></div></section>' +
      ctaRow(T);
  }

  function vAreas(T) {
    var P = T.areasPage, half = AREAS.length / 2;
    function col(list) {
      return '<div class="alist__col">' + list.map(function (a) {
        var d = T.areas[a[0]];
        return '<a class="arow" href="#' + a[0] + '">' + ic(a[1]) + '<span><b class="arow__t">' + d.name + '</b><span class="arow__d">' + d.short + '</span></span>' + arrow() + '</a>';
      }).join('') + '</div>';
    }
    return pageHead(P.title, P.lead) +
      '<section class="section"><div class="wrap alist">' + col(AREAS.slice(0, half)) + col(AREAS.slice(half)) + '</div></section>' + ctaRow(T);
  }

  function vArea(T, slug) {
    var P = T.areasPage, d = T.areas[slug], i = areaIndex(slug);
    var prev = AREAS[(i + AREAS.length - 1) % AREAS.length], next = AREAS[(i + 1) % AREAS.length];
    var crumbs = '<nav class="crumbs" aria-label="' + P.title + '"><a href="#especialidades">' + P.title + '</a><span aria-hidden="true">/</span><span>' + d.name + '</span></nav>';
    return pageHead(d.name, d.lead, crumbs) +
      '<section class="section"><div class="wrap">' +
      '<h2 class="label">' + (d.acts ? P.actsLabel : P.itemsLabel) + '</h2><ul class="chips">' +
      d.items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' +
      '<div class="tri"><div><h2>' + P.focus + '</h2><p>' + d.focus + '</p></div><div><h2>' + P.proof + '</h2><p>' + d.proof + '</p></div><div><h2>' + P.defense + '</h2><p>' + d.defense + '</p></div></div>' +
      '</div></section>' +
      '<section class="section section--linen"><div class="wrap"><h2 class="h-section">' + P.firstTitle + '</h2><ol class="first">' +
      P.first.map(function (s, n) { return '<li><span class="first__n">' + (n + 1) + '</span><h3>' + s.t + '</h3><p>' + s.d + '</p></li>'; }).join('') +
      '</ol></div></section>' +
      '<nav class="pager" aria-label="' + P.title + '"><div class="wrap pager__in">' +
      '<a href="#' + prev[0] + '">' + ic('prev', 'ui') + '<span><small>' + P.prev + '</small>' + T.areas[prev[0]].name + '</span></a>' +
      '<a class="pager__next" href="#' + next[0] + '"><span><small>' + P.next + '</small>' + T.areas[next[0]].name + '</span>' + ic('next', 'ui') + '</a>' +
      '</div></nav>' + ctaRow(T);
  }

  function vMethod(T) {
    var M = T.method;
    return pageHead(M.title, M.lead) +
      '<section class="section"><div class="wrap"><ol class="msteps">' + M.steps.map(function (s, i) {
        return '<li><span class="msteps__n" aria-hidden="true">' + pad(i + 1) + '</span><h2>' + s.t + '</h2><p>' + s.d + '</p></li>';
      }).join('') + '</ol></div></section>' +
      '<section class="section section--linen"><div class="wrap"><div class="shead shead--stack"><h2 class="h-section">' + M.phasesTitle + '</h2><p>' + M.phasesLead + '</p></div>' +
      '<ol class="phases">' + M.phases.map(function (p) { return '<li><b>' + p.t + '</b><span>' + p.d + '</span></li>'; }).join('') + '</ol></div></section>' +
      ctaRow(T);
  }

  function vPubs(T) {
    var P = T.pubs;
    return pageHead(P.title, P.lead) +
      '<section class="section"><div class="wrap"><div class="plist">' + P.items.map(function (p) {
        return '<article class="prow">' + pubMeta(p) + '<div><h2>' + p.t + '</h2><p>' + p.d + '</p></div></article>';
      }).join('') + '</div></div></section>' + ctaRow(T);
  }

  function vContact(T) {
    var C = T.contact;
    return pageHead(C.title, C.lead) +
      '<section class="section"><div class="wrap">' +
      '<div class="cgrid">' +
      '<div class="ccell">' + ic('phone', 'ui') + '<h2>' + C.phone + '</h2><a href="' + SITE.tel + '">' + SITE.phone + '</a></div>' +
      '<div class="ccell">' + ic('mail', 'ui') + '<h2>' + C.email + '</h2><a href="mailto:' + SITE.email + '">' + SITE.email + '</a></div>' +
      '<div class="ccell">' + ic('clock', 'ui') + '<h2>' + C.hours + '</h2><p>' + T.common.hoursDays + '<br>' + SITE.hoursAm + ' · ' + SITE.hoursPm + '</p></div>' +
      '<div class="ccell">' + ic('globe', 'ui') + '<h2>' + C.langs + '</h2><p>' + T.common.langs + '</p></div>' +
      '</div>' +
      '<div class="sedes">' +
      '<div class="sede"><span class="sede__tag">' + C.main + '</span><h2>' + T.book.officeValencia + '</h2><p>' + SITE.street + '<br>' + (T.common.city || SITE.city) + '</p>' +
      '<div class="sede__act"><a class="btn" href="' + SITE.maps + '" target="_blank" rel="noopener">' + ic('pin', 'ui') + '<span>' + C.route + '</span></a>' +
      '<a class="btn" href="mailto:' + SITE.email + '">' + ic('mail', 'ui') + '<span>' + C.write + '</span></a></div></div>' +
      '<div class="sede sede--soon"><span class="sede__tag">' + T.common.soon + '</span><h2>' + T.book.officeGandia + '</h2><p>' + SITE.gandia + '</p><p class="sede__note">' + C.gandiaText + '</p></div>' +
      '</div></div></section>' + ctaRow(T);
  }

  function vLegal(T, key) {
    var L = I18N.es.legal[key];
    var title = T.foot[LEGAL_KEY[key]];
    var note = state.lang !== 'es' && T.common.legalOnlyEs ? '<p class="prose__note">' + T.common.legalOnlyEs + '</p>' : '';
    return pageHead(state.lang === 'es' ? L.title : title, '') +
      '<section class="section"><div class="wrap"><div class="prose" lang="es">' + note + L.body + '</div></div></section>';
  }

  /* ------------------------------------------------------------------
     Reserva de consulta
     Con servidor (IA_CONFIG.api): disponibilidad real y pago por adelantado;
     la hora solo queda reservada cuando el pago se confirma.
     Sin servidor (vista previa): se prepara la solicitud para enviarla por correo.
  ------------------------------------------------------------------ */
  var API = (window.IA_CONFIG && window.IA_CONFIG.api) || null;
  var online = { cfg: null, state: API ? 'idle' : 'none', avail: {}, months: {}, ret: null, busy: false };

  var today = new Date(); today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  var minDate = addDays(today, 1);
  var maxDate = addDays(today, SITE.bookDaysAhead);
  function bookable(d) { var w = d.getDay(); return w !== 0 && w !== 6 && d >= minDate && d <= maxDate; }
  function firstBookable() { var d = minDate; while (!bookable(d)) d = addDays(d, 1); return d; }
  function dayOpen(d) { return API ? Boolean(online.avail[iso(d)]) : bookable(d); }
  function calBounds() {
    return API ? [today, addDays(today, (online.cfg && online.cfg.maxDaysAhead) || SITE.bookDaysAhead)] : [minDate, maxDate];
  }

  function money(cents) {
    var cur = ((online.cfg && online.cfg.currency) || 'eur').toUpperCase();
    try { return new Intl.NumberFormat(loc(), { style: 'currency', currency: cur, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100); }
    catch (e) { return (cents / 100) + ' ' + cur; }
  }
  function price() { var b = state.book; return API && online.cfg && b.mode && online.cfg.modes[b.mode] ? online.cfg.modes[b.mode].priceCents : null; }

  function call(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || 'error'); e.code = d.error; e.status = r.status; throw e; }
        return d;
      });
    });
  }

  function loadMonth(y, m) {
    var key = y + '-' + pad(m + 1);
    if (online.months[key]) return Promise.resolve();
    var last = new Date(y, m + 1, 0).getDate();
    return call('GET', '/availability?from=' + key + '-01&to=' + key + '-' + pad(last)).then(function (d) {
      online.months[key] = true;
      Object.keys(d.days).forEach(function (k) { online.avail[k] = d.days[k]; });
    });
  }

  function loadOnline() {
    if (online.state !== 'idle') return;
    online.state = 'loading';
    call('GET', '/config').then(function (cfg) {
      online.cfg = cfg;
      if (!cfg.payments) { online.state = 'off'; return null; }
      var next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      return loadMonth(today.getFullYear(), today.getMonth())
        .then(function () { return loadMonth(next.getFullYear(), next.getMonth()); })
        .then(function () {
          var b = state.book, days = Object.keys(online.avail).sort();
          var first = days.length ? fromIso(days[0]) : today;
          b.month = { y: first.getFullYear(), m: first.getMonth() };
          if (b.mode && !cfg.modes[b.mode]) b.mode = null;
          if (b.date && !(online.avail[b.date] || []).length) { b.date = null; b.time = null; }
          online.state = 'ready';
        });
    }).catch(function () { online.state = 'error'; }).then(function () {
      if (state.route === 'reserva') paintView();
    });
  }

  function stepHead(n, title) {
    return '<div class="bstep__h"><span class="bstep__n" aria-hidden="true">' + n + '</span><h2 class="bstep__t">' + title + '</h2></div>';
  }

  function calHTML(T) {
    var B = T.book, b = state.book, y = b.month.y, m = b.month.m, lim = calBounds();
    var first = new Date(y, m, 1), off = (first.getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate();
    var prevOff = y === lim[0].getFullYear() && m === lim[0].getMonth();
    var nextOff = y === lim[1].getFullYear() && m === lim[1].getMonth();
    var h = '<div class="cal"><div class="cal__head">' +
      '<button type="button" class="cal__nav" data-cal="-1" aria-label="' + B.prevMonth + '"' + (prevOff ? ' disabled' : '') + '>' + ic('prev', 'ui') + '</button>' +
      '<div class="cal__title" aria-live="polite">' + cap(fmt(first, { month: 'long', year: 'numeric' })) + '</div>' +
      '<button type="button" class="cal__nav" data-cal="1" aria-label="' + B.nextMonth + '"' + (nextOff ? ' disabled' : '') + '>' + ic('next', 'ui') + '</button></div>' +
      '<div class="cal__grid">';
    for (var i = 0; i < 7; i++) h += '<div class="cal__dow">' + fmt(new Date(2024, 0, 1 + i), { weekday: 'short' }).replace('.', '') + '</div>';
    for (i = 0; i < off; i++) h += '<span></span>';
    for (var day = 1; day <= dim; day++) {
      var d = new Date(y, m, day), k = iso(d);
      h += '<button type="button" class="day' + (k === iso(today) ? ' day--today' : '') + '" data-day="' + k + '" aria-pressed="' + (b.date === k) + '"' +
        (dayOpen(d) ? '' : ' disabled') + ' aria-label="' + fmt(d, { weekday: 'long', day: 'numeric', month: 'long' }) + '">' + day + '</button>';
    }
    return h + '</div><p class="note">' + B.todayNote + '</p></div>';
  }

  function slotsHTML(T) {
    var B = T.book, b = state.book;
    if (!b.date) return '<p class="note">' + B.pickDate + '</p>';
    var am = SITE.slotsAm, pm = SITE.slotsPm;
    if (API) {
      var list = online.avail[b.date] || [];
      am = list.filter(function (t) { return t < '14:00'; });
      pm = list.filter(function (t) { return t >= '14:00'; });
    }
    function col(label, list) {
      if (!list.length) return '';
      return '<div class="slots__col"><span class="slots__label">' + label + '</span>' + list.map(function (s) {
        return '<button type="button" class="slot" data-slot="' + s + '" aria-pressed="' + (b.time === s) + '">' + s + '</button>';
      }).join('') + '</div>';
    }
    return '<div class="slots">' + col(B.morning, am) + col(B.afternoon, pm) + '</div>';
  }

  function stepsHTML(T) {
    var B = T.book, b = state.book, n = 0;
    var modes = [['presencial', 'office'], ['video', 'video'], ['telefono', 'phone']].filter(function (m) {
      return !API || (online.cfg && online.cfg.modes[m[0]]);
    });
    var h = '<section class="bstep">' + stepHead(++n, B.sMode) + '<div class="opts opts--' + Math.max(2, modes.length) + '">' +
      modes.map(function (m) {
        var sub = API ? '<small class="opt__price">' + money(online.cfg.modes[m[0]].priceCents) + '</small>' : '';
        return '<button type="button" class="opt" data-mode="' + m[0] + '" aria-pressed="' + (b.mode === m[0]) + '">' + ic(m[1], 'ui') +
          '<b>' + B.modes[m[0]].t + '</b><small>' + B.modes[m[0]].d + '</small>' + sub + '</button>';
      }).join('') + '</div></section>';
    if (b.mode === 'presencial') {
      h += '<section class="bstep">' + stepHead(++n, B.sOffice) + '<div class="opts opts--2">' +
        '<button type="button" class="opt" aria-pressed="true">' + ic('pin', 'ui') + '<b>' + B.officeValencia + '</b><small>' + SITE.street + '</small></button>' +
        '<button type="button" class="opt" disabled>' + ic('pin', 'ui') + '<b>' + B.officeGandia + '</b><small>' + T.common.soon + '</small></button>' +
        '</div></section>';
    }
    h += '<section class="bstep bstep--when"><div>' + stepHead(++n, B.sDate) + calHTML(T) + '</div>' +
      '<div>' + stepHead(++n, B.sTime) + slotsHTML(T) + '</div></section>';
    state.book.dataStep = n + 1;
    return h;
  }

  function whenText(isoDay) {
    var d = isoDay || state.book.date;
    return d ? cap(fmt(fromIso(d), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) : '';
  }

  function sumHTML(T) {
    var B = T.book, b = state.book, p = price();
    function row(k, v) { return '<dt>' + k + '</dt><dd' + (v ? '' : ' class="is-empty"') + '>' + (v || B.none) + '</dd>'; }
    return row(B.sMode, b.mode ? B.modes[b.mode].t : '') +
      (b.mode === 'presencial' ? row(B.sOffice, B.officeValencia) : '') +
      row(B.sDate, whenText()) + row(B.sTime, b.time || '') +
      (API ? '<dt class="sum__total">' + B.price + '</dt><dd class="sum__total' + (p ? '' : ' is-empty') + '">' + (p ? money(p) : B.none) + '</dd>' : '');
  }

  function payLabel(T) { var p = price(); return T.book.pay + (p ? ' · ' + money(p) : ''); }

  function requestText(T) {
    var B = T.book, b = state.book, f = b.form, L = [];
    L.push(B.mailSubject);
    L.push(B.sMode + ': ' + B.modes[b.mode].t + (b.mode === 'presencial' ? ' · ' + B.officeValencia : ''));
    L.push(B.sDate + ': ' + whenText());
    L.push(B.sTime + ': ' + b.time);
    L.push(B.fName + ': ' + f.name);
    L.push(B.fPhone + ': ' + f.phone);
    L.push(B.fEmail + ': ' + f.email);
    if (f.clang) L.push(B.fLang + ': ' + SITE.langNames[f.clang]);
    if (f.msg) L.push(B.fMsg.replace(/\s*\(.*\)/, '') + ': ' + f.msg);
    return L.join('\n');
  }

  function sideHTML(T) {
    var B = T.book, b = state.book, f = b.form;
    if (!API && b.done) {
      var text = requestText(T);
      return '<div class="card card--sticky done"><span class="done__ic">' + ic('check', 'ui') + '</span>' +
        '<h2 class="bstep__t" id="done-title" tabindex="-1">' + B.doneTitle + '</h2><p>' + B.doneText + '</p>' +
        '<pre class="done__text" id="done-text">' + esc(text) + '</pre>' +
        '<div class="done__act"><a class="btn btn--solid" href="mailto:' + SITE.email + '?subject=' + encodeURIComponent(B.mailSubject) + '&body=' + encodeURIComponent(text) + '">' + ic('mail', 'ui') + '<span>' + B.send + '</span></a>' +
        '<button type="button" class="btn" data-copy>' + B.copy + '</button></div>' +
        '<p class="note">' + SITE.email + ' · ' + SITE.phone + '</p>' +
        '<button type="button" class="textbtn" data-edit>' + B.edit + '</button></div>';
    }
    function field(id, label, input, extra) {
      return '<div class="field"><label for="' + id + '">' + label + '</label>' + input + (extra || '') + '<span class="err" id="' + id + '-err" role="alert"></span></div>';
    }
    var tail = API
      ? '<label class="check"><input id="bk-terms" name="terms" type="checkbox"' + (f.terms ? ' checked' : '') + '><span>' + B.terms + '</span></label>' +
        (online.cfg.policy ? '<p class="note policy">' + esc(online.cfg.policy) + '</p>' : '') +
        '<p class="err err--form" id="bk-form-err" role="alert"></p>' +
        '<button class="btn btn--solid btn--block" type="submit" id="bk-submit"><span id="pay-label">' + payLabel(T) + '</span>' + arrow() + '</button>' +
        '<p class="note pay-note">' + B.payNote + '</p>' +
        (online.cfg.test ? '<p class="testflag">' + B.testMode + '</p>' : '')
      : '<p class="err err--form" id="bk-form-err" role="alert"></p>' +
        '<button class="btn btn--solid btn--block" type="submit"><span>' + B.submit + '</span>' + arrow() + '</button>';
    return '<form class="card card--sticky" id="book-form" novalidate>' +
      '<div class="bstep__h"><span class="bstep__n" id="data-n" aria-hidden="true">' + b.dataStep + '</span><h2 class="bstep__t">' + B.sData + '</h2></div>' +
      '<dl class="sum" id="book-sum" aria-label="' + B.sumTitle + '">' + sumHTML(T) + '</dl>' +
      field('bk-name', B.fName, '<input id="bk-name" name="name" type="text" autocomplete="name" value="' + esc(f.name) + '">') +
      '<div class="field-row">' +
      field('bk-phone', B.fPhone, '<input id="bk-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" value="' + esc(f.phone) + '">') +
      field('bk-email', B.fEmail, '<input id="bk-email" name="email" type="email" autocomplete="email" value="' + esc(f.email) + '">') +
      '</div>' +
      field('bk-lang', B.fLang, '<select id="bk-lang" name="clang">' + SITE.consultLangs.map(function (l) {
        return '<option value="' + l + '"' + ((f.clang || consultLang()) === l ? ' selected' : '') + '>' + SITE.langNames[l] + '</option>';
      }).join('') + '</select>') +
      field('bk-msg', B.fMsg, '<textarea id="bk-msg" name="msg" rows="3">' + esc(f.msg) + '</textarea>', '<span class="hint">' + B.msgHint + '</span>') +
      (API ? '<div class="field-row field-row--bill">' +
        field('bk-tax', B.fTax, '<input id="bk-tax" name="tax" type="text" autocomplete="off" maxlength="20" value="' + esc(f.tax || '') + '">') +
        field('bk-addr', B.fAddr, '<input id="bk-addr" name="addr" type="text" autocomplete="street-address" maxlength="300" value="' + esc(f.addr || '') + '">') +
        '</div><p class="note inv-note">' + B.invHint + '</p>' : '') +
      '<label class="check"><input id="bk-ok" name="ok" type="checkbox"' + (f.ok ? ' checked' : '') + '><span>' + B.consent + '</span></label>' +
      tail + '</form>';
  }

  /* Vuelta desde la página de pago */
  function returnHTML(T) {
    var B = T.book, r = online.ret, d = r.data || {};
    function box(icon, title, text, extra) {
      return '<div class="card ret"><span class="done__ic' + (icon === 'clock' ? ' is-wait' : '') + '">' + ic(icon, 'ui') + '</span>' +
        '<h2 class="bstep__t" id="ret-title" tabindex="-1">' + title + '</h2><p>' + text + '</p>' + (extra || '') + '</div>';
    }
    var again = '<div class="done__act"><button type="button" class="btn btn--solid" data-again>' + B.again + '</button>' +
      '<a class="tel" href="' + SITE.tel + '">' + ic('phone', 'ui') + '<span>' + SITE.phone + '</span></a></div>';
    if (r.type === 'check') return box('clock', B.checkTitle, B.checkText);
    if (r.type === 'ok') {
      return box('check', B.okTitle, B.okText,
        '<dl class="sum"><dt>' + B.ref + '</dt><dd>' + esc(d.ref) + '</dd>' +
        '<dt>' + B.sMode + '</dt><dd>' + B.modes[d.mode].t + '</dd>' +
        '<dt>' + B.sDate + '</dt><dd>' + whenText(d.day) + '</dd>' +
        '<dt>' + B.sTime + '</dt><dd>' + esc(d.time) + '</dd>' +
        '<dt class="sum__total">' + B.price + '</dt><dd class="sum__total">' + money(d.amount_cents) + '</dd></dl>' +
        '<div class="done__act"><button type="button" class="btn btn--solid" data-ics>' + ic('calendar', 'ui') + '<span>' + B.addCal + '</span></button>' +
        '<a class="btn" href="#inicio">' + T.nav.home + '</a></div>');
    }
    if (r.type === 'conflict') return box('clock', B.conflictTitle, B.conflictText, again);
    if (r.type === 'cancel') return box('close', B.cancelTitle, B.cancelText, again);
    return box('clock', B.pendingTitle, B.pendingText, '<div class="done__act"><a class="tel" href="' + SITE.tel + '">' + ic('phone', 'ui') + '<span>' + SITE.phone + '</span></a></div>');
  }

  function pollStatus() {
    var r = online.ret;
    function repaint() { if (state.route === 'reserva') paintView(); }
    call('GET', '/bookings/status?session_id=' + encodeURIComponent(r.session)).then(function (d) {
      r.data = d;
      if (d.status === 'confirmed') r.type = 'ok';
      else if (d.status === 'refunded') r.type = 'conflict';
      else if (d.status === 'hold' && r.tries++ < 20) { window.setTimeout(pollStatus, 2000); return; }
      else r.type = 'pending';
      repaint();
    }).catch(function () {
      if (r.tries++ < 5) window.setTimeout(pollStatus, 2500);
      else { r.type = 'pending'; repaint(); }
    });
  }

  function readReturn() {
    if (!API) return;
    var p;
    try { p = new URLSearchParams(window.location.search); } catch (e) { return; }
    var pago = p.get('pago');
    if (!pago) return;
    if (pago === 'ok' && p.get('session_id')) {
      online.ret = { type: 'check', session: p.get('session_id'), tries: 0 };
      pollStatus();
    } else if (pago === 'cancelado') {
      online.ret = { type: 'cancel' };
      if (p.get('rid') && p.get('k')) call('POST', '/bookings/release', { id: p.get('rid'), key: p.get('k') }).catch(function () {});
    }
    try { window.history.replaceState(null, '', window.location.pathname + '#reserva'); } catch (e) { /* la dirección se queda como está */ }
  }

  function downloadIcs() {
    var d = online.ret && online.ret.data; if (!d) return;
    function stamp(x) { return x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
    var start = new Date(d.starts_at), end = new Date(start.getTime() + (d.durationMin || 60) * 60000), T = tr();
    var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Irina Aharonyan//Reservas//ES', 'BEGIN:VEVENT',
      'UID:' + d.ref + '@irinaaharonyan.es', 'DTSTAMP:' + stamp(new Date()), 'DTSTART:' + stamp(start), 'DTEND:' + stamp(end),
      'SUMMARY:' + T.book.icsTitle, 'DESCRIPTION:' + T.book.ref + ' ' + d.ref + ' · ' + T.book.modes[d.mode].t + ' · ' + SITE.phone,
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    try {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
      a.download = 'consulta-' + d.ref + '.ics';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { /* sin descarga disponible */ }
  }

  function vBook(T) {
    var B = T.book, b = state.book;
    function shell(lead, inner) { return pageHead(B.title, lead) + '<section class="section"><div class="wrap">' + inner + '</div></section>'; }
    if (API) {
      if (online.ret) return shell('', returnHTML(T));
      if (online.state === 'idle') loadOnline();
      if (online.state === 'idle' || online.state === 'loading') return shell(B.lead, '<p class="loading" role="status">' + B.loading + '</p>');
      if (online.state !== 'ready') {
        return shell('', '<div class="card ret"><h2 class="bstep__t">' + B.offTitle + '</h2><p>' + B.offText + '</p>' +
          '<div class="done__act"><a class="btn btn--solid" href="' + SITE.tel + '">' + ic('phone', 'ui') + '<span>' + SITE.phone + '</span></a>' +
          '<a class="btn" href="mailto:' + SITE.email + '">' + ic('mail', 'ui') + '<span>' + SITE.email + '</span></a></div></div>');
      }
    }
    if (!b.month) { var f = firstBookable(); b.month = { y: f.getFullYear(), m: f.getMonth() }; }
    var steps = stepsHTML(T);
    return pageHead(B.title, B.lead) +
      '<section class="section"><div class="wrap book"><div id="book-steps">' + steps + '</div><div id="book-side">' + sideHTML(T) + '</div></div></section>';
  }

  function refreshSteps() {
    var el = $('#book-steps'); if (!el) return;
    el.innerHTML = stepsHTML(tr());
    var n = $('#data-n'); if (n) n.textContent = state.book.dataStep;
    var s = $('#book-sum'); if (s) s.innerHTML = sumHTML(tr());
    var p = $('#pay-label'); if (p) p.textContent = payLabel(tr());
    if (state.book.done) { var side = $('#book-side'); if (side) side.innerHTML = sideHTML(tr()); }
  }

  function readForm() {
    var f = state.book.form, g = function (id) { return $('#' + id); };
    if (!g('bk-name')) return;
    f.name = g('bk-name').value.trim();
    f.phone = g('bk-phone').value.trim();
    f.email = g('bk-email').value.trim();
    f.clang = g('bk-lang').value;
    f.msg = g('bk-msg').value.trim();
    if (g('bk-tax')) { f.tax = g('bk-tax').value.trim(); f.addr = g('bk-addr').value.trim(); }
    f.ok = g('bk-ok').checked;
    if (g('bk-terms')) f.terms = g('bk-terms').checked;
  }

  function submitBooking() {
    var B = tr().book, b = state.book, f = b.form, firstBad = null;
    readForm();
    function set(id, msg) {
      var e = $('#' + id + '-err'), inp = $('#' + id);
      if (e) e.textContent = msg || '';
      if (inp) { if (msg) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
      if (msg && !firstBad) firstBad = inp;
    }
    set('bk-name', f.name.length < 3 ? B.eName : '');
    set('bk-phone', f.phone.replace(/\D/g, '').length < 9 ? B.ePhone : '');
    set('bk-email', /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email) ? '' : B.eEmail);
    if ($('#bk-tax')) set('bk-tax', !f.tax || /^[A-Za-z0-9]{7,15}$/.test(f.tax.replace(/[\s.-]/g, '')) ? '' : B.eTax);
    var formErr = '', focusId = null;
    if (!b.mode || !b.date || !b.time) formErr = B.eWhen;
    else if (!f.ok) { formErr = B.eConsent; focusId = 'bk-ok'; }
    else if (API && !f.terms) { formErr = B.eTerms; focusId = 'bk-terms'; }
    var errBox = $('#bk-form-err');
    errBox.textContent = formErr;
    if (firstBad) { firstBad.focus(); return; }
    if (formErr) { if (focusId) $('#' + focusId).focus(); return; }

    if (!API) {
      b.done = true;
      $('#book-side').innerHTML = sideHTML(tr());
      var t = $('#done-title'); if (t) t.focus({ preventScroll: true });
      var side = $('#book-side'), top = side.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight * 0.6) side.scrollIntoView({ block: 'start', behavior: 'auto' });
      return;
    }

    if (online.busy) return;
    online.busy = true;
    var btn = $('#bk-submit'), label = $('#pay-label');
    btn.disabled = true; label.textContent = B.going;
    call('POST', '/bookings', {
      day: b.date, time: b.time, mode: b.mode, name: f.name, phone: f.phone, email: f.email,
      lang: f.clang || consultLang(), note: f.msg, taxId: f.tax || '', billAddress: f.addr || '', consent: true, terms: true
    }).then(function (d) {
      window.location.href = d.url;
    }).catch(function (e) {
      online.busy = false;
      btn.disabled = false; label.textContent = payLabel(tr());
      errBox.textContent = e.code === 'slot_taken' ? B.eTaken : e.code === 'too_many_holds' ? B.eBusy : e.status ? B.ePay : B.eNet;
      if (e.code === 'slot_taken') {
        online.months = {}; online.avail = {}; b.time = null;
        loadMonth(b.month.y, b.month.m).then(function () {
          if (!(online.avail[b.date] || []).length) b.date = null;
          refreshSteps();
        }).catch(function () {});
      }
    });
  }

  /* ------------------------------------------------------------------
     Enrutado y pintado
  ------------------------------------------------------------------ */
  var VIEWS = {
    'inicio': vHome, 'sobre-mi': vAbout, 'especialidades': vAreas, 'metodologia': vMethod,
    'publicaciones': vPubs, 'reserva': vBook, 'contacto': vContact
  };

  function parseRoute() {
    var h = (window.location.hash || '').replace(/^#/, '');
    if (VIEWS[h] || areaIndex(h) > -1 || LEGAL.indexOf(h) > -1) return h;
    return 'inicio';
  }

  function titleFor(T, r) {
    var map = { 'sobre-mi': T.about.title, 'especialidades': T.areasPage.title, 'metodologia': T.method.title, 'publicaciones': T.pubs.title, 'reserva': T.book.title, 'contacto': T.contact.title };
    if (r === 'inicio') return SITE.name + ' · ' + T.home.title;
    var name = map[r] || (T.areas[r] && T.areas[r].name) || (I18N.es.legal[r] && I18N.es.legal[r].title) || '';
    return name + ' · ' + SITE.name;
  }

  function paintChrome() {
    var T = tr();
    document.documentElement.lang = tag(state.lang);
    $('#top').innerHTML = topHTML(T);
    $('#bar').innerHTML = barHTML(T);
    $('#menu').innerHTML = menuHTML(T);
    $('#dock').innerHTML = dockHTML(T);
    $('#foot').innerHTML = footHTML(T);
    $('.skip').textContent = T.nav.skip;
  }

  function paintView() {
    var T = tr(), r = state.route, html;
    if (VIEWS[r]) html = VIEWS[r](T);
    else if (areaIndex(r) > -1) html = vArea(T, r);
    else html = vLegal(T, r);
    $('#app').innerHTML = html;
    document.body.setAttribute('data-route', r);
    document.body.setAttribute('data-kind', r === 'inicio' ? 'home' : 'inner');
    document.title = titleFor(T, r);
    var current = areaIndex(r) > -1 ? 'especialidades' : r;
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (a) {
      if (a.getAttribute('data-nav') === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function go(opts) {
    var next = parseRoute(), changed = next !== state.route;
    state.route = next;
    closeMenu();
    var run = function () {
      paintView();
      if (!opts || !opts.keepScroll) window.scrollTo(0, 0);
    };
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (changed && document.startViewTransition && !reduce && !state.first) document.startViewTransition(run);
    else run();
    if (changed && !state.first) { var app = $('#app'); app.focus({ preventScroll: true }); }
  }

  function setLang(l) {
    if (!I18N[l] || l === state.lang) return;
    readForm();
    state.lang = l;
    try { window.localStorage.setItem('ia-lang', l); } catch (e) { /* preferencia no guardada */ }
    document.body.classList.remove('intro');
    var open = $('#menu').classList.contains('is-open');
    paintChrome();
    paintView();
    watchBar();
    fitBar();
    if (open) openMenu();
  }

  /* ------------------------------------------------------------------
     Menú móvil y barra fija
  ------------------------------------------------------------------ */
  function setInert(on) {
    ['#top', '#bar', '#app', '#foot', '#dock'].forEach(function (sel) {
      var el = $(sel); if (!el) return;
      if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
  }
  function openMenu() {
    $('#menu').classList.add('is-open');
    document.documentElement.classList.add('menu-open');
    setInert(true);
    var b = $('#bar .bar__menu'); if (b) b.setAttribute('aria-expanded', 'true');
    var c = $('#menu [data-menu-close]'); if (c) c.focus({ preventScroll: true });
  }
  function closeMenu(refocus) {
    var m = $('#menu'); if (!m || !m.classList.contains('is-open')) return;
    m.classList.remove('is-open');
    document.documentElement.classList.remove('menu-open');
    setInert(false);
    var b = $('#bar .bar__menu');
    if (b) { b.setAttribute('aria-expanded', 'false'); if (refocus) b.focus({ preventScroll: true }); }
  }

  /* ¿Cabe la navegación? Si no, marca reducida al monograma; si tampoco, menú. */
  function fitBar() {
    var bar = $('#bar'), inn = $('.bar__in', bar);
    if (!inn) return;
    bar.classList.remove('bar--tight', 'bar--menu');
    if (window.innerWidth < 1024) return;
    var cs = window.getComputedStyle(inn);
    var avail = inn.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var gap = parseFloat(cs.columnGap) || 24;
    var brand = $('.brand', bar), items = bar.querySelectorAll('.nav li'), cta = $('.bar__cta', bar);
    function need() {
      var nav = items[items.length - 1].getBoundingClientRect().right - items[0].getBoundingClientRect().left;
      return brand.scrollWidth + nav + cta.offsetWidth + 2 * gap + 6;
    }
    if (need() <= avail) return;
    bar.classList.add('bar--tight');
    if (need() > avail) bar.classList.add('bar--menu');
  }

  var barObserver;
  function watchBar() {
    var s = $('.bar-sentinel'), bar = $('#bar');
    if (!s || !bar || !('IntersectionObserver' in window)) { if (bar) bar.classList.add('is-stuck'); return; }
    if (barObserver) barObserver.disconnect();
    barObserver = new IntersectionObserver(function (en) {
      bar.classList.toggle('is-stuck', !en[0].isIntersecting && en[0].boundingClientRect.top < 0);
    }, { threshold: 0 });
    barObserver.observe(s);
  }

  /* ------------------------------------------------------------------
     Eventos
  ------------------------------------------------------------------ */
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-lang],[data-mode],[data-day],[data-slot],[data-cal],[data-copy],[data-edit],[data-ics],[data-again],[data-menu-close],.bar__menu,a[href^="#"]');
    if (!el) return;
    var b = state.book;
    if (el.hasAttribute('data-lang')) { setLang(el.getAttribute('data-lang')); return; }
    if (el.hasAttribute('data-menu-close')) { closeMenu(true); return; }
    if (el.classList.contains('bar__menu')) { if ($('#menu').classList.contains('is-open')) closeMenu(); else openMenu(); return; }
    if (el.hasAttribute('data-mode')) { b.mode = el.getAttribute('data-mode'); refreshSteps(); focusBack('[data-mode="' + b.mode + '"]'); return; }
    if (el.hasAttribute('data-day')) { b.date = el.getAttribute('data-day'); b.time = null; refreshSteps(); focusBack('[data-day="' + b.date + '"]'); return; }
    if (el.hasAttribute('data-slot')) { b.time = el.getAttribute('data-slot'); refreshSteps(); focusBack('[data-slot="' + b.time + '"]'); return; }
    if (el.hasAttribute('data-cal')) {
      var m = b.month.m + (+el.getAttribute('data-cal')), y = b.month.y;
      if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
      b.month = { y: y, m: m };
      var dir = el.getAttribute('data-cal');
      if (API) loadMonth(y, m).catch(function () {}).then(function () { refreshSteps(); focusBack('[data-cal="' + dir + '"]'); });
      else { refreshSteps(); focusBack('[data-cal="' + dir + '"]'); }
      return;
    }
    if (el.hasAttribute('data-edit')) { b.done = false; $('#book-side').innerHTML = sideHTML(tr()); return; }
    if (el.hasAttribute('data-ics')) { downloadIcs(); return; }
    if (el.hasAttribute('data-again')) {
      online.ret = null; online.months = {}; online.avail = {}; online.state = 'idle'; b.date = null; b.time = null;
      paintView(); return;
    }
    if (el.hasAttribute('data-copy')) {
      var text = $('#done-text').textContent, done = function () { el.textContent = tr().book.copied; };
      try { navigator.clipboard.writeText(text).then(done, selectText); } catch (e) { selectText(); }
      return;
    }
    if (el.matches('a[href^="#"]')) {
      if (el.getAttribute('href') === '#app') { ev.preventDefault(); $('#app').focus(); return; }
      closeMenu();
      if (el.getAttribute('href') === window.location.hash || (el.getAttribute('href') === '#inicio' && !window.location.hash)) {
        window.scrollTo(0, 0);
      }
    }
  });

  function selectText() {
    var pre = $('#done-text'); if (!pre || !window.getSelection) return;
    var r = document.createRange(); r.selectNodeContents(pre);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function focusBack(sel) {
    var el = $('#book-steps ' + sel);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  document.addEventListener('submit', function (ev) {
    if (ev.target && ev.target.id === 'book-form') { ev.preventDefault(); submitBooking(); }
  });
  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest('#book-form')) readForm();
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeMenu(true); });
  window.addEventListener('hashchange', function () { go(); });

  /* ------------------------------------------------------------------
     Arranque
  ------------------------------------------------------------------ */
  readReturn();
  state.route = parseRoute();
  paintChrome();
  paintView();
  watchBar();
  fitBar();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitBar);
  var fitTimer;
  window.addEventListener('resize', function () {
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(function () { fitBar(); if (window.innerWidth >= 1024) closeMenu(); }, 120);
  });
  if (state.route === 'inicio') document.body.classList.add('intro');
  state.first = false;
})();
