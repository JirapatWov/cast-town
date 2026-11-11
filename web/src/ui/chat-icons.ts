// Chat-only icons (attach, send now, compact, goal…), drawn like icons.ts: 24px grid, 1.75 stroke, round caps.

const P = {
  paperclip: '<path d="M19.5 11.5l-7.6 7.6a4.8 4.8 0 01-6.8-6.8l8.3-8.3a3.2 3.2 0 014.5 4.5l-8.3 8.3a1.6 1.6 0 01-2.3-2.3l7.6-7.6"/>',
  bolt: '<path d="M13.5 3.5L5.5 13.5h6l-1 7 8-10h-6z"/>',
  compact: '<path d="M9.5 4.5v5h-5M14.5 4.5v5h5M9.5 19.5v-5h-5M14.5 19.5v-5h5"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9 6.5v11M15 6.5v11"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-5-4.8-8.7 8.3"/>',
  bulb: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3.5a6 6 0 00-3.6 10.8c.7.6 1.1 1.4 1.1 2.2V17h5v-.5c0-.8.4-1.6 1.1-2.2A6 6 0 0012 3.5z"/>',
  queue: '<path d="M4.5 7h10M4.5 12h10M4.5 17h6"/><path d="M17.5 14v6M14.5 17h6"/>',
} as const;

export type ChatIconName = keyof typeof P;

export function chatIcon(name: ChatIconName, size = 16, extraClass = ''): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="ic ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name]}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}
