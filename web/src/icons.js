/* Line icons. s = viewBox size; d = inner markup. Stroke styling comes from CSS. */
window.IA_ICONS = {
  /* Especialidades (32 grid) */
  coins: { s: 32, d: '<ellipse cx="16" cy="9" rx="9" ry="3.5"/><path d="M7 9v5c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5V9"/><path d="M7 14v5c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5v-5"/><path d="M7 19v4c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5v-4"/>' },
  key: { s: 32, d: '<circle cx="11" cy="21" r="5.2"/><path d="M14.8 17.2 26.5 5.5"/><path d="M22.5 9.5l3.2 3.2"/><path d="M19 13l2.6 2.6"/>' },
  laptop: { s: 32, d: '<rect x="6" y="7" width="20" height="14" rx="1.6"/><path d="M3 25h26"/><path d="M13.5 14l-2 2 2 2M18.5 14l2 2-2 2"/>' },
  pulse: { s: 32, d: '<path d="M3 17h6l2.6-7.5L16 23l3-9.5 1.6 3.5H29"/>' },
  shieldUser: { s: 32, d: '<path d="M16 4l10 3.6v7.1c0 6-4.1 10.6-10 13.3C10.1 25.3 6 20.7 6 14.7V7.6L16 4z"/><circle cx="16" cy="13" r="2.8"/><path d="M11.3 21.2c.7-2.4 2.5-3.8 4.7-3.8s4 1.4 4.7 3.8"/>' },
  lockOpen: { s: 32, d: '<rect x="7" y="14" width="18" height="13" rx="1.6"/><path d="M11 14v-4a5 5 0 0 1 9.7-1.7"/><path d="M16 19v3.5"/>' },
  capsule: { s: 32, d: '<g transform="rotate(-45 16 16)"><rect x="4.5" y="11" width="23" height="10" rx="5"/><path d="M16 11v10"/></g>' },
  pediment: { s: 32, d: '<path d="M4 12l12-7 12 7z"/><path d="M7.5 15v9M13 15v9M19 15v9M24.5 15v9"/><path d="M4 27h24"/>' },
  wheel: { s: 32, d: '<circle cx="16" cy="16" r="11.5"/><circle cx="16" cy="16" r="2.7"/><path d="M16 18.7v8.8M13.5 15.2l-8.3-2.3M18.5 15.2l8.3-2.3"/>' },
  eyeOff: { s: 32, d: '<path d="M3.5 16s4.5-8 12.5-8 12.5 8 12.5 8-4.5 8-12.5 8-12.5-8-12.5-8z"/><circle cx="16" cy="16" r="3.5"/><path d="M6.5 26.5l19-21"/>' },
  document: { s: 32, d: '<path d="M9 4h10l5 5v19H9z"/><path d="M19 4v5h5"/><path d="M12.5 14.5h7M12.5 18.5h7"/><path d="M12.5 24c1.1-2 1.9-2 2.7 0s1.6 2 2.7 0"/>' },
  gavel: { s: 32, d: '<g transform="rotate(-45 12 11)"><rect x="5.5" y="8" width="13" height="6.5" rx="1"/><path d="M12 14.5V29"/></g><path d="M5 27.5h11"/>' },
  /* Interfaz (24 grid) */
  calendar: { s: 24, d: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>' },
  phone: { s: 24, d: '<path d="M6.7 3.5h2.8l1.4 4.3-1.9 1.5a12.5 12.5 0 0 0 5.7 5.7l1.5-1.9 4.3 1.4v2.8a2 2 0 0 1-2.2 2A17.3 17.3 0 0 1 4.7 5.7a2 2 0 0 1 2-2.2z"/>' },
  mail: { s: 24, d: '<rect x="3" y="5.5" width="18" height="13" rx="1.8"/><path d="M3.6 7l8.4 6.5L20.4 7"/>' },
  pin: { s: 24, d: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>' },
  clock: { s: 24, d: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' },
  globe: { s: 24, d: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.1 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.1-3.8-8.5S9.5 5.8 12 3.5z"/>' },
  arrow: { s: 24, d: '<path d="M4 12h16M14 6l6 6-6 6"/>' },
  video: { s: 24, d: '<rect x="3" y="6.5" width="12.5" height="11" rx="1.8"/><path d="M15.5 10.5l5.5-3v9l-5.5-3"/>' },
  office: { s: 24, d: '<path d="M5 20.5v-15a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M15 10h3a1 1 0 0 1 1 1v9.5M3 20.5h18M8.5 8.5h3M8.5 12h3M8.5 15.5h3"/>' },
  check: { s: 24, d: '<path d="M5 12.5l4.5 4.5L19 7.5"/>' },
  menu: { s: 24, d: '<path d="M4 8.5h16M4 15.5h16"/>' },
  close: { s: 24, d: '<path d="M6 6l12 12M18 6L6 18"/>' },
  prev: { s: 24, d: '<path d="M14.5 6l-6 6 6 6"/>' },
  next: { s: 24, d: '<path d="M9.5 6l6 6-6 6"/>' }
};
