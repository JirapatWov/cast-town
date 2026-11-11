// Minimal DOM helpers — no framework, just a typed hyperscript and a few utilities.
import { CITY_ID } from '../net/base';

export type Child = Node | string | number | null | undefined | false | Child[];

type Listener = (ev: never) => void;
export interface Attrs {
  class?: string | (string | false | null | undefined)[];
  style?: string | Record<string, string | number | undefined>;
  /** Trusted markup only (icons, rendered markdown). Never user text. */
  html?: string;
  [key: string]: unknown;
}

function applyAttrs(el: HTMLElement | SVGElement, attrs: Attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else
        for (const [prop, v] of Object.entries(value as Record<string, string | number | undefined>)) {
          if (v === undefined) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
          else (el.style as unknown as Record<string, string>)[prop] = String(v);
        }
    } else if (key === 'html') {
      el.innerHTML = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(value);
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function append(parent: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

/** Replace all children. */
export function setChildren(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(type);
  }
  return false;
}

/** Change detector: returns true only when the signature differs from the previous call. Lets
 *  components skip re-rendering (and restarting CSS animations) when nothing visible changed. */
export function memo(): (sig: unknown) => boolean {
  let last: string | undefined;
  return (sig) => {
    const s = typeof sig === 'string' ? sig : JSON.stringify(sig);
    if (s === last) return false;
    last = s;
    return true;
  };
}

/** Coalesce many state notifications into one render per animation frame. */
export function frameScheduler() {
  const queued = new Map<string, () => void>();
  let raf = 0;
  const run = () => {
    raf = 0;
    const jobs = [...queued.values()];
    queued.clear();
    for (const job of jobs) {
      try {
        job();
      } catch (err) {
        console.error('[ui] render failed', err);
      }
    }
  };
  return (key: string, fn: () => void) => {
    queued.set(key, fn);
    if (!raf) raf = requestAnimationFrame(run);
  };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' }, text);
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** The page's root font size over the 16 px default: 1 normally, 1.5 or 2 when the browser is set to larger text.
 *  The UI is sized in rem so it follows that setting (#55); sizes that script sets in px multiply by this. */
export function rootFontScale(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 1;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px / 16 : 1;
}

/** Grow a textarea with its content up to maxPx (at the default text size; it grows with a larger one). */
export function autosize(ta: HTMLTextAreaElement, maxPx = 200) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(maxPx * rootFontScale(), ta.scrollHeight)}px`;
}

function scopedStorage(prefix: string) {
  return {
    get(key: string): string | null {
      try {
        return localStorage.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string) {
      try {
        localStorage.setItem(prefix + key, value);
      } catch {
        /* private mode / blocked storage: the UI still works */
      }
    },
    remove(key: string) {
      try {
        localStorage.removeItem(prefix + key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** The storage prefix of a city's keys: `city:<id>:`, none for the home city (id null or 'home'). */
export const cityPrefix = (id: string | null): string => (id && id !== 'home' ? `city:${id}:` : '');
/** Per-city browser storage: anything keyed by this city's data (agents, houses, chats, drafts, recents).
 *  Cities opened through a hub share its origin, so their keys get a `city:<id>:` prefix; the home city keeps bare keys. */
export const storage = scopedStorage(cityPrefix(CITY_ID));
/** Another city's storage, seen from this page (switching cities reads where the user was in the city it opens). */
export const cityStorage = (id: string) => scopedStorage(cityPrefix(id));
/** Per-device browser storage shared by every city: graphics quality, time of day, look, onboarding, accessibility. */
export const deviceStorage = scopedStorage('');
