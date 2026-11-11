// Icons of the built-in viewer, drawn like icons.ts (24px grid, 1.75 stroke, round caps). Names icons.ts already has
// (file, folder, eye, external, copy, refresh, x, globe, search…) fall through to it.
import { icon as baseIcon } from './icons';

const P: Record<string, string> = {
  download: '<path d="M12 4.5v11M7 11l5 5 5-5"/><path d="M4.5 19.5h15"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5"/>',
  doc: '<path d="M6 3.5h8l4.5 4.5v12a.5.5 0 01-.5.5H6a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5z"/><path d="M13.5 3.5V8.5h5M8.5 12.5h7M8.5 16h7"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-5-4.8-8.7 8.3"/>',
  table: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 10h17M3.5 14.5h17M9.5 10v9"/>',
  audio: '<path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  video: '<rect x="3.5" y="6" width="12" height="12" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3z"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M8.5 20h7M12 16.5V20"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  up: '<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15"/>',
  actual: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9.5l1.5-1v7M14 9.5l1.5-1v7"/>',
  wrap: '<path d="M4 7h16M4 12h12.5a3 3 0 010 6H12"/><path d="M14 15.5L11.5 18l2.5 2.5M4 17h4"/>',
  source: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14"/>',
  view: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
};

export function vIcon(name: string, size = 16, extraClass = ''): SVGSVGElement {
  const body = P[name];
  if (!body) return baseIcon(name, size, extraClass);
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="ic ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}
