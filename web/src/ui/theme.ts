// Light or dark (#77). Settings → View → Theme offers System / Dark / Light, stored per device like the other
// look-and-feel choices. "System" follows the OS's prefers-color-scheme, live. The resolved theme goes on
// <html data-theme="dark|light">, which swaps the colour tokens (css/base.css); the 3D town keeps its own look.
//
// index.html runs the same resolution in a tiny inline script before the first paint, so a stored "Light" never
// flashes dark while the bundle loads — keep THEME_KEY and the attribute in step with that script.
import { deviceStorage } from './dom';

export type ThemePref = 'system' | 'dark' | 'light';
export type Theme = 'dark' | 'light';

export const THEME_KEY = 'rlt.theme';
export const THEME_PREFS: readonly ThemePref[] = ['system', 'dark', 'light'];

/** The browser's top bar / PWA title bar colour per theme: the page background (--bg). */
export const THEME_COLOR: Record<Theme, string> = { dark: '#0e0d0c', light: '#f1ece4' };

/** The installed app starts at night: index.html sets data-launch="night" on a window's first page (the OS launch screen
 *  before it is dark for everyone), and on the light theme the splash's sunrise lifts it. Until the night is over the
 *  status bar keeps its colour, or Android's bar turns light over the dark sky. The sunrise itself says when: its
 *  animationend (index.html's pre-paint script, which then sets data-launch="day"), not a clock — the curtain starts
 *  with the first frame, which waits for the network, the stylesheet and the app's code. */
export function themeColor(theme: Theme, night: boolean): string {
  return theme === 'light' && night ? THEME_COLOR.dark : THEME_COLOR[theme];
}

/** sessionStorage: "day" once this window's night is over, so its next pages (a reload, a city switch, the update's
 *  Reload) start in the theme instead of a second night. index.html's pre-paint script and the offline page read it. */
export const LAUNCH_KEY = 'rlt.launch';

/** A stored value as a preference: anything unknown (or nothing) is "system". */
export function parseThemePref(raw: string | null | undefined): ThemePref {
  return raw === 'dark' || raw === 'light' ? raw : 'system';
}

/** What a preference means right now, given whether the OS asks for light. */
export function resolveTheme(pref: ThemePref, systemLight: boolean): Theme {
  if (pref === 'system') return systemLight ? 'light' : 'dark';
  return pref;
}

const LIGHT_QUERY = '(prefers-color-scheme: light)';
const listeners = new Set<(theme: Theme) => void>();
let media: MediaQueryList | null = null;

function systemLight(): boolean {
  if (typeof matchMedia !== 'function') return false;
  media ??= matchMedia(LIGHT_QUERY);
  return media.matches;
}

export function themePref(): ThemePref {
  return parseThemePref(deviceStorage.get(THEME_KEY));
}

/** The theme on screen now. */
export function currentTheme(): Theme {
  return resolveTheme(themePref(), systemLight());
}

/** Put a theme on the page: the token switch, the native controls' scheme, the browser's bar colour (the night's while
 *  the installed app's night is up, then the theme's). */
export function applyTheme(theme: Theme = currentTheme()): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor(theme, root.dataset.launch === 'night'));
  if (changed) for (const fn of listeners) fn(theme);
}

/** The installed app's night is over without its sunrise having ended: the splash went first (boot.ts done(); a quick
 *  hand-off removes it mid-sunrise, and a dark start has no sunrise at all). The bar follows the theme, and the
 *  window's next pages start in the day. */
export function endNight(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.launch !== 'night') return;
  root.dataset.launch = 'day';
  try {
    sessionStorage.setItem(LAUNCH_KEY, 'day');
  } catch {
    // no session storage (a private window): a reload starts at night again, as before
  }
  applyTheme();
}

export function setThemePref(pref: ThemePref): void {
  if (pref === 'system') deviceStorage.remove(THEME_KEY);
  else deviceStorage.set(THEME_KEY, pref);
  applyTheme();
}

/** Called with the new theme whenever it changes (a Settings choice, or the OS switching while on "System").
 *  Returns unsubscribe. For things CSS can't reach: the terminal's palette, canvas colours. */
export function onThemeChange(fn: (theme: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let installed = false;

/** Apply the theme now and follow the OS while the choice is "System". Once, at start-up. */
export function installTheme(): void {
  applyTheme();
  if (installed || typeof matchMedia !== 'function') return;
  installed = true;
  media ??= matchMedia(LIGHT_QUERY);
  media.addEventListener?.('change', () => {
    if (themePref() === 'system') applyTheme();
  });
  // another tab (or city) of this browser changed it: device prefs are shared, so follow
  window.addEventListener?.('storage', (ev) => {
    if (ev.key === null || ev.key === THEME_KEY) applyTheme();
  });
}
