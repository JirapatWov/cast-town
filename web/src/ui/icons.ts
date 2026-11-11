// Stroke icons on a 24px grid (1.75 stroke, round caps). Inline SVG keeps them crisp and themeable.

const P: Record<string, string> = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronUp: '<path d="M6 14.5l6-6 6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  send: '<path d="M4.5 12L20 4.5 15.5 20l-3-6.5z"/><path d="M12.5 13.5L20 4.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  play: '<path d="M7.5 5.5v13l11-6.5z"/>',
  alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 17v.5"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.8 2.8L16 9.8"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  circleDashed: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  revert: '<path d="M4.5 9h10a5 5 0 010 10H9"/><path d="M8.5 5l-4 4 4 4"/>',
  loop: '<path d="M17 4.5l3 3-3 3"/><path d="M20 7.5H9a5 5 0 00-5 5"/><path d="M7 19.5l-3-3 3-3"/><path d="M4 16.5h11a5 5 0 005-5"/>',
  save: '<path d="M5 4.5h11l3.5 3.5V19a.5.5 0 01-.5.5H5a.5.5 0 01-.5-.5V5a.5.5 0 01.5-.5z"/><path d="M8 4.5V9h7V4.5M8 19.5v-6h8v6"/>',
  tv: '<rect x="3" y="5.5" width="18" height="12" rx="2"/><path d="M8.5 21h7M12 17.5V21"/>',
  branch: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9M17.5 9.5c0 4-5 3.5-9.5 7.5"/>',
  inbox: '<path d="M3.5 13.5l2.6-7.2a1 1 0 01.9-.6h10a1 1 0 01.9.6l2.6 7.2V18a1 1 0 01-1 1H4.5a1 1 0 01-1-1z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
  chat: '<path d="M5 5.5h14a1.5 1.5 0 011.5 1.5v8.5A1.5 1.5 0 0119 17h-7l-4.5 3.5V17H5a1.5 1.5 0 01-1.5-1.5V7A1.5 1.5 0 015 5.5z"/>',
  workflow: '<rect x="3.5" y="4" width="6" height="5" rx="1.2"/><rect x="14.5" y="4" width="6" height="5" rx="1.2"/><rect x="9" y="15" width="6" height="5" rx="1.2"/><path d="M9.5 6.5h5M17.5 9v2.5a1 1 0 01-1 1h-9a1 1 0 01-1-1V9M12 12.5V15"/>',
  diff: '<path d="M12 4v7M8.5 7.5h7M8.5 17.5h7"/><rect x="4" y="2.5" width="16" height="19" rx="2"/>',
  file: '<path d="M6 3.5h8l4.5 4.5v12a.5.5 0 01-.5.5H6a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5z"/><path d="M13.5 3.5V8.5h5"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 011.5-1.5h4.2l2 2.2H19A1.5 1.5 0 0120.5 9.2V17.5A1.5 1.5 0 0119 19H5a1.5 1.5 0 01-1.5-1.5z"/>',
  folderPlus: '<path d="M3.5 7a1.5 1.5 0 011.5-1.5h4.2l2 2.2H19A1.5 1.5 0 0120.5 9.2V17.5A1.5 1.5 0 0119 19H5a1.5 1.5 0 01-1.5-1.5z"/><path d="M12 10.5v5M9.5 13h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  command: '<path d="M9 6.5A2.5 2.5 0 106.5 9H9zm0 0v11m0-11h6m-6 11A2.5 2.5 0 116.5 15H9zm0 0h6m0 0v-11m0 11a2.5 2.5 0 102.5-2.5H15zm0-11A2.5 2.5 0 1117.5 9H15z"/>',
  car: '<path d="M5 15.5V12l1.8-4.2A1.5 1.5 0 018.2 7h7.6a1.5 1.5 0 011.4.8L19 12v3.5"/><path d="M3.5 12h17v4.5a1 1 0 01-1 1h-15a1 1 0 01-1-1z"/><circle cx="7.5" cy="17.5" r="1.6"/><circle cx="16.5" cy="17.5" r="1.6"/>',
  pin: '<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 00-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 01-13.2 4.9M4.5 12a7.5 7.5 0 0113.2-4.9"/><path d="M18 3.5v4h-4M6 20.5v-4h4"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  pencil: '<path d="M15.5 4.5l4 4L8.5 19.5H4.5v-4z"/><path d="M13 7l4 4"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.5 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.5-3.5-8.5s1-5.9 3.5-8.5z"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.4-3.3 2.8-5.5 6-5.5s5.6 2.2 6 5.5"/><path d="M15.5 5.5a3 3 0 010 6M17.5 14.3c2 .8 3.2 2.6 3.5 5.2"/>',
  hand: '<path d="M8 12.5V6a1.5 1.5 0 013 0v5.5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6.5 7-2.5 0-4-1.2-5.3-3.2L3.5 13.3a1.4 1.4 0 012.3-1.6L8 14.5"/>',
  focus: '<path d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15"/><circle cx="12" cy="12" r="2.5"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1115 0"/><path d="M12 13l3.5-4"/><circle cx="12" cy="13.5" r="1.3"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 00-1.5-1.5H6A1.5 1.5 0 004.5 6v8A1.5 1.5 0 006 15.5h2.5"/>',
  home: '<path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.5v10h12v-10"/><path d="M10 19.5v-5h4v5"/>',
  building: '<rect x="5" y="3.5" width="14" height="17" rx="1"/><path d="M9 7.5h1.5M13.5 7.5H15M9 11h1.5M13.5 11H15M9 14.5h1.5M13.5 14.5H15M10.5 20.5v-3h3v3"/>',
  exit: '<path d="M14 4.5h4a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5h-4"/><path d="M10 8l-4 4 4 4M6 12h9.5"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>',
  rows: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 12h17"/>',
  coins: '<ellipse cx="9" cy="7" rx="5.5" ry="2.5"/><path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7"/><path d="M9.5 16.3c.9.1 1.8.2 2.5.2 3 0 5.5-1.1 5.5-2.5v-4"/><path d="M14.5 10.6c1.7.3 3 1 3 1.9"/><path d="M6 15.5v2c0 1.4 2.5 2.5 5.5 2.5s6-1.1 6-2.5v-2"/>',
  trash: '<path d="M4.5 7h15M10 4.5h4M6.5 7l.8 12a1.5 1.5 0 001.5 1.5h6.4a1.5 1.5 0 001.5-1.5L17.5 7"/>',
  brain: '<path d="M9 4.5a3 3 0 00-3 3 3 3 0 00-1.5 5.5A3 3 0 007 18a2.5 2.5 0 005 .5V6.5a2 2 0 00-3-2z"/><path d="M15 4.5a3 3 0 013 3 3 3 0 011.5 5.5A3 3 0 0117 18a2.5 2.5 0 01-5 .5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13"/><path d="M17.5 14v4.5a1 1 0 01-1 1h-11a1 1 0 01-1-1v-11a1 1 0 011-1H10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  grip: '<path d="M8 12h8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>',
  wand: '<path d="M4.5 19.5l11-11M14 5l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM18.5 12l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 014.85.85c0 1.65-2.45 2.15-2.45 3.8M12 16.9v.1"/>',
  book: '<path d="M4.5 5.5A1.5 1.5 0 016 4h12.5v14H6a1.5 1.5 0 00-1.5 1.5z"/><path d="M4.5 19.5A1.5 1.5 0 006 21h12.5v-3"/>',
  agency: '<path d="M3.5 20.5h17M5 20.5V9l7-4.5L19 9v11.5"/><path d="M9 20.5v-6h6v6M9 10.5h6"/>',
  spinner: '<path d="M12 3.5a8.5 8.5 0 108.5 8.5" />',
  dots: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 102.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/><path d="M12 8v4.2l2.8 1.8"/>',
  chatPlus: '<path d="M5 5.5h14a1.5 1.5 0 011.5 1.5v8.5A1.5 1.5 0 0119 17h-7l-4.5 3.5V17H5a1.5 1.5 0 01-1.5-1.5V7A1.5 1.5 0 015 5.5z"/><path d="M12 8.5v5M9.5 11h5"/>',
  door: '<path d="M6 20.5V4.5a1 1 0 011-1h10a1 1 0 011 1v16"/><path d="M3.5 20.5h17"/><circle cx="14.5" cy="12.5" r=".9" fill="currentColor" stroke="none"/>',
  stairs: '<path d="M3.5 19.5h4v-4h4v-4h4v-4h5"/>',
  // view switch (Board / 3D town) and Settings
  board: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  cube: '<path d="M12 3.5l7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5z"/><path d="M4.5 7.75L12 12l7.5-4.25M12 12v8.5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  reader: '<path d="M4 6.5h9M4 11h9M4 15.5h6"/><path d="M16 10.5v5M19 8.5v9"/>',
  // Settings → Theme
  monitor: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16v4"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',
  sun: '<circle cx="12" cy="12" r="3.75"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
};

export type IconName = keyof typeof P;

export function iconSvg(name: IconName | string, size = 16, extraClass = ''): string {
  const body = P[name] ?? P.circle;
  return `<svg class="ic ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function icon(name: IconName | string, size = 16, extraClass = ''): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = iconSvg(name, size, extraClass);
  return tpl.content.firstElementChild as SVGSVGElement;
}
