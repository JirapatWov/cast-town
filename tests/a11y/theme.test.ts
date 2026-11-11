// #77 (light theme) and #55 (text in rem). The theme choice (System / Dark / Light) and how it reaches the page,
// the contrast of every colour token on the surfaces it sits on in both themes (AA: 4.5:1 for text, 3:1 for UI
// colours), and guards that keep components on the tokens and text sizes in rem.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { forbiddenPage, renderPage } from '../../server/pages';

const ROOT = join(import.meta.dir, '../..');
const CSS_DIR = join(ROOT, 'web/src/ui/css');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// theme.ts → dom.ts → net/base.ts reads location once at import time; leave no stub behind for other test files
const g = globalThis as Record<string, unknown>;
const stubLocation = g.location === undefined;
if (stubLocation) g.location = { pathname: '/', search: '', protocol: 'http:', host: 'localhost' };
const theme = await import('../../web/src/ui/theme');
if (stubLocation) delete g.location;

// ── colour maths (WCAG 2.x relative luminance) ──────────────────────────────────────────────────
type RGB = [number, number, number];
type RGBA = [number, number, number, number];

function parseColor(v: string): RGBA {
  const s = v.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1].split('').map((c) => parseInt(c + c, 16)), 1] as RGBA;
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  m = /^(\d+) (\d+) (\d+)$/.exec(s); // a channel triplet (--x-rgb)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), 1];
  throw new Error(`not a colour: ${v}`);
}
const gradientStops = (v: string): RGBA[] => [...v.matchAll(/rgba?\([^)]*\)|#[0-9a-f]{3,6}\b/gi)].map((m) => parseColor(m[0]));
const over = ([r, g2, b, a]: RGBA, under: RGB): RGB => [r * a + under[0] * (1 - a), g2 * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g2, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g2) + 0.0722 * lin(b);
function contrast(a: RGB, b: RGB): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ── the token blocks in base.css ────────────────────────────────────────────────────────────────
const BASE = readFileSync(join(CSS_DIR, 'base.css'), 'utf8');
const TOKENS = (/\/\* tokens:begin \*\/([\s\S]*?)\/\* tokens:end \*\//.exec(BASE)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
function block(selector: RegExp): Record<string, string> {
  const body = selector.exec(TOKENS)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const SETS = {
  dark: block(/:root\s*\{([^}]*)\}/),
  light: block(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
};
type ThemeName = keyof typeof SETS;
const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

/** Each theme's surfaces as opaque colours. Glass is see-through, so it is judged over what can be behind it: the
 *  light theme's over pure black and pure white (it must hold over a night scene too); the dark theme's over black,
 *  the dark town and board it was drawn for (a bright 3D surface behind dark glass is what Settings → Solid panels
 *  is for, also on with the system's "more contrast" / "less transparency"). */
function surfaces(name: ThemeName): Record<string, RGB> {
  const t = SETS[name];
  const c = (k: string) => parseColor(t[k]);
  const solid = over(c('--solid'), BLACK);
  const s: Record<string, RGB> = {
    bg: over(c('--bg'), BLACK),
    solid,
    'solid-2': over(c('--solid-2'), BLACK),
    'panel-2': over(c('--panel-2'), BLACK),
    'fill-2 on solid': over(c('--fill-2'), solid), // chips, soft buttons
    'glass over black': over(c('--glass'), BLACK),
    'glass-strong over black': over(c('--glass-strong'), BLACK),
    ...Object.fromEntries(gradientStops(t['--attn-head']).map((stop, i) => [`attn-head ${i + 1} over black`, over(stop, BLACK)])), // a waiting question
    'term-bg over black': over(c('--term-bg'), BLACK),
  };
  if (name === 'light') {
    s['glass over white'] = over(c('--glass'), WHITE);
    s['glass-strong over white'] = over(c('--glass-strong'), WHITE);
  }
  return s;
}

const TEXT = ['--text', '--text-2', '--text-3', '--text-soft', '--text-warm', '--amber-text', '--amber-text-2', '--ok-text', '--err-text', '--work-text', '--sun-text', '--code-text'];
const UI = ['--amber', '--ok', '--err', '--work', '--sun'];
const HL = ['--hl-comment', '--hl-keyword', '--hl-string', '--hl-number', '--hl-title', '--hl-type', '--hl-attr', '--hl-tag', '--hl-var', '--hl-meta'];

describe('theme preference (#77)', () => {
  test('a stored value is dark, light or system; anything else means system', () => {
    expect(theme.parseThemePref('dark')).toBe('dark');
    expect(theme.parseThemePref('light')).toBe('light');
    for (const raw of [null, undefined, '', 'system', 'Light', 'auto', 'sepia']) expect(theme.parseThemePref(raw)).toBe('system');
    expect(theme.THEME_PREFS).toEqual(['system', 'dark', 'light']);
  });

  test('system follows the OS; dark and light ignore it', () => {
    expect(theme.resolveTheme('system', true)).toBe('light');
    expect(theme.resolveTheme('system', false)).toBe('dark');
    for (const os of [true, false]) {
      expect(theme.resolveTheme('dark', os)).toBe('dark');
      expect(theme.resolveTheme('light', os)).toBe('light');
    }
  });

  describe('on a page', () => {
    const saved = { document: g.document, localStorage: g.localStorage, matchMedia: g.matchMedia };
    const store = new Map<string, string>();
    let osLight = false;
    const meta = () => {
      const m = { content: '', setAttribute: (_: string, v: string) => (m.content = v) };
      return m;
    };
    const metas: Record<string, ReturnType<typeof meta>> = { 'meta[name="color-scheme"]': meta(), 'meta[name="theme-color"]': meta() };
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    let clock: ReturnType<typeof spyOn> | undefined;

    beforeAll(() => {
      g.localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
      };
      g.matchMedia = () => ({ get matches() { return osLight; }, addEventListener() {} });
      g.document = { documentElement: root, querySelector: (sel: string) => metas[sel] ?? null };
    });
    afterAll(() => {
      clock?.mockRestore();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    });

    test('System (nothing stored) follows the OS', () => {
      osLight = true;
      expect(theme.themePref()).toBe('system');
      theme.applyTheme();
      expect(root.dataset.theme).toBe('light');
      expect(root.style.colorScheme).toBe('light');
      expect(metas['meta[name="color-scheme"]'].content).toBe('light');
      expect(metas['meta[name="theme-color"]'].content).toBe(theme.THEME_COLOR.light);
      osLight = false;
      theme.applyTheme();
      expect(root.dataset.theme).toBe('dark');
      expect(metas['meta[name="theme-color"]'].content).toBe(theme.THEME_COLOR.dark);
    });

    test('a choice is stored per device under rlt.theme and applied; System removes it', () => {
      const seen: string[] = [];
      const off = theme.onThemeChange((t) => seen.push(t));
      theme.setThemePref('light');
      expect(store.get(theme.THEME_KEY)).toBe('light');
      expect(theme.themePref()).toBe('light');
      expect(root.dataset.theme).toBe('light');
      theme.setThemePref('light'); // same theme again: no second notification
      theme.setThemePref('dark');
      expect(store.get(theme.THEME_KEY)).toBe('dark');
      osLight = true;
      expect(theme.currentTheme()).toBe('dark'); // an explicit Dark ignores the OS
      theme.setThemePref('system');
      expect(store.has(theme.THEME_KEY)).toBe(false);
      expect(root.dataset.theme).toBe('light');
      off();
      theme.setThemePref('dark');
      expect(seen).toEqual(['light', 'dark', 'light']);
      theme.setThemePref('system');
      osLight = false;
    });

    test('the installed app starts at night: on the light theme the bar keeps the night until the night is over — whatever the clock says', () => {
      const session = new Map<string, string>();
      g.sessionStorage = { setItem: (k: string, v: string) => void session.set(k, v), getItem: (k: string) => session.get(k) ?? null };
      // no clock in it: the curtain starts with the first frame, however late that is (a slow network, a late bundle)
      clock = spyOn(performance, 'now').mockImplementation(() => 1e7);
      root.dataset.launch = 'night'; // index.html's pre-paint script, in the installed app
      osLight = true;
      theme.applyTheme();
      expect(root.dataset.theme).toBe('light'); // the page is light at once (the splash's morning is under the night)
      expect(metas['meta[name="theme-color"]'].content).toBe(theme.THEME_COLOR.dark);
      theme.setThemePref('light'); // a choice made meanwhile does not let the morning in early either
      expect(metas['meta[name="theme-color"]'].content).toBe(theme.THEME_COLOR.dark);
      theme.setThemePref('system');
      // the splash went (boot.ts done()): day, the bar follows, and the window's next pages start in the day
      theme.endNight();
      expect(root.dataset.launch).toBe('day');
      expect(session.get(theme.LAUNCH_KEY)).toBe('day');
      expect(metas['meta[name="theme-color"]'].content).toBe(theme.THEME_COLOR.light);
      theme.setThemePref('dark');
      expect(metas['meta[name="theme-color"]'].content).toBe(theme.THEME_COLOR.dark);
      theme.setThemePref('light');
      expect(metas['meta[name="theme-color"]'].content).toBe(theme.THEME_COLOR.light);
      // not at night (a browser tab, or the day already): endNight() changes nothing
      session.clear();
      theme.endNight();
      expect(session.size).toBe(0);
      theme.setThemePref('system');
      delete root.dataset.launch;
      delete g.sessionStorage;
      osLight = false;
      clock.mockRestore();
      clock = undefined;
    });
  });

  test('the bar colour: the night while the night is up, only on the light theme (the dark one is night anyway)', () => {
    const { themeColor, THEME_COLOR } = theme;
    expect(themeColor('light', true)).toBe(THEME_COLOR.dark);
    expect(themeColor('light', false)).toBe(THEME_COLOR.light); // a browser tab, or the day: the theme at once
    expect(themeColor('dark', true)).toBe(THEME_COLOR.dark);
    expect(themeColor('dark', false)).toBe(THEME_COLOR.dark);
    expect(theme.themeColor.length).toBe(2); // no time in it
    const html = read('web/index.html');
    expect(html).toMatch(/:root\[data-launch='night'\]\[data-theme='light'\] \.boot-dusk \{\s*display: block;\s*animation: boot-lift 1\.5s [^;]* 0\.4s both;/);
    // reduced motion: the night fades on the same element, so its animationend ends the night too
    expect(html).toMatch(/:root\[data-launch='night'\]\[data-theme='light'\] \.boot-dusk \{\s*height: 100%;[^}]*animation: boot-out [^;]+;/);
  });

  describe("index.html's pre-paint script: the night start", () => {
    const script = /<script>\s*\(function \(\) \{([\s\S]*?)\}\)\(\);\s*<\/script>/.exec(read('web/index.html'))![1];
    type Fn = (e: { target: unknown }) => void;
    /** One page of a window: run the script with this session's storage; `end(cls)` fires an animationend there. */
    function page(o: { stored?: string; osLight?: boolean; standalone?: boolean; iosStandalone?: boolean; session: Map<string, string> }) {
      const attrs: Record<string, string> = {};
      const bar = { content: '#0e0d0c', setAttribute: (_: string, v: string) => (bar.content = v) };
      const scheme = { content: 'dark', setAttribute: (_: string, v: string) => (scheme.content = v) };
      const listeners: Fn[] = [];
      const doc = {
        documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v), getAttribute: (k: string) => attrs[k] ?? null, style: {} },
        querySelector: (sel: string) => (sel.includes('theme-color') ? bar : scheme),
        addEventListener: (type: string, fn: Fn, capture: boolean) => {
          expect([type, capture]).toEqual(['animationend', true]);
          listeners.push(fn);
        },
        removeEventListener: (_: string, fn: Fn) => listeners.splice(listeners.indexOf(fn), 1),
      };
      const win = {
        matchMedia: (q: string) => ({ matches: q.includes('standalone') ? !!o.standalone : q.includes('light') ? !!o.osLight : false }),
      };
      const local = { getItem: () => o.stored ?? null };
      const session = { getItem: (k: string) => o.session.get(k) ?? null, setItem: (k: string, v: string) => void o.session.set(k, v) };
      new Function('window', 'matchMedia', 'document', 'localStorage', 'sessionStorage', 'navigator', script)(
        win, win.matchMedia, doc, local, session, { standalone: o.iosStandalone === true },
      );
      const end = (cls: string) => {
        const target = { classList: { contains: (c: string) => c === cls } };
        for (const fn of [...listeners]) fn({ target });
      };
      return { attrs, bar, end, listeners };
    }

    test('installed, light: night and a dark bar until the night itself has ended, then day and the light bar', () => {
      const session = new Map<string, string>();
      const p = page({ stored: 'light', standalone: true, session });
      expect(p.attrs['data-launch']).toBe('night');
      expect(p.attrs['data-theme']).toBe('light');
      expect(p.bar.content).toBe(theme.THEME_COLOR.dark);
      // the night's mark and band (.boot-dusk-in, .boot-lamp …) end at the same time: only the night itself counts
      for (const cls of ['boot-dusk-in', 'boot-lamp', 'boot-mark', 'boot-house']) p.end(cls);
      expect(p.bar.content).toBe(theme.THEME_COLOR.dark);
      expect(p.attrs['data-launch']).toBe('night');
      p.end('boot-dusk');
      expect(p.attrs['data-launch']).toBe('day');
      expect(p.bar.content).toBe(theme.THEME_COLOR.light);
      expect(session.get(theme.LAUNCH_KEY)).toBe('day');
      expect(p.listeners.length).toBe(0); // once
    });

    test('a reload, a city switch, the update’s Reload: the window has had its morning, so no second night', () => {
      const session = new Map<string, string>();
      page({ osLight: true, iosStandalone: true, session }).end('boot-dusk');
      const again = page({ osLight: true, iosStandalone: true, session });
      expect(again.attrs['data-launch']).toBeUndefined();
      expect(again.bar.content).toBe(theme.THEME_COLOR.light);
      expect(again.listeners.length).toBe(0);
      // a new window (a cold launch) starts at night again
      expect(page({ osLight: true, iosStandalone: true, session: new Map() }).attrs['data-launch']).toBe('night');
      // the session flag as boot.ts's done() leaves it (theme.ts endNight) counts the same
      expect(page({ stored: 'light', standalone: true, session: new Map([[theme.LAUNCH_KEY, 'day']]) }).attrs['data-launch']).toBeUndefined();
    });

    test('a browser tab: the theme at once, no night; the dark theme: night, and the bar dark all along', () => {
      const tab = page({ stored: 'light', session: new Map() });
      expect(tab.attrs['data-launch']).toBeUndefined();
      expect(tab.bar.content).toBe(theme.THEME_COLOR.light);
      expect(tab.listeners.length).toBe(0);
      const dark = page({ stored: 'dark', standalone: true, session: new Map() });
      expect(dark.attrs['data-launch']).toBe('night');
      expect(dark.bar.content).toBe(theme.THEME_COLOR.dark);
    });

    test('no clock in it: no timer turns the bar light', () => {
      expect(script).not.toContain('setTimeout');
      expect(script).toContain(`sessionStorage.getItem('${theme.LAUNCH_KEY}')`);
      expect(read('web/src/ui/theme.ts')).not.toMatch(/performance\.now|setTimeout/);
    });
  });

  test("index.html's pre-paint script and the server's pages use the same key, attribute and bar colours", () => {
    const html = read('web/index.html');
    const script = /<script>\s*\(function \(\) \{([\s\S]*?)\}\)\(\);\s*<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain(`localStorage.getItem('${theme.THEME_KEY}')`);
    expect(script).toContain('(prefers-color-scheme: light)');
    expect(script).toContain("setAttribute('data-theme'");
    expect(script).toContain(theme.THEME_COLOR.light);
    expect(script).toContain(theme.THEME_COLOR.dark);
    expect(html).toContain(":root[data-theme='light']");
    for (const page of [renderPage({ title: 't', heading: 'h', lead: 'l' }), forbiddenPage('no-token')]) {
      expect(page).toContain(`localStorage.getItem('${theme.THEME_KEY}')`);
      expect(page).toContain('@media (prefers-color-scheme: light)');
      expect(page).toContain(":root[data-theme='light']");
      expect(page).toContain('<meta name="color-scheme" content="dark light">');
    }
  });

  test('the bar colour of each theme is its page background', () => {
    expect(SETS.dark['--bg'].toLowerCase()).toBe(theme.THEME_COLOR.dark);
    expect(SETS.light['--bg'].toLowerCase()).toBe(theme.THEME_COLOR.light);
  });
});

describe('colour tokens (#77)', () => {
  test('both themes define the same tokens', () => {
    const dark = Object.keys(SETS.dark).sort();
    expect(dark.length).toBeGreaterThan(60);
    expect(Object.keys(SETS.light).sort()).toEqual(dark);
  });

  test('every *-rgb triplet matches its colour', () => {
    for (const name of ['dark', 'light'] as const) {
      const t = SETS[name];
      for (const k of ['amber', 'ok', 'err', 'work', 'sun', 'text']) {
        expect([name, k, parseColor(t[`--${k}-rgb`]).slice(0, 3)]).toEqual([name, k, parseColor(t[`--${k}`]).slice(0, 3)]);
      }
    }
  });

  for (const name of ['dark', 'light'] as const) {
    describe(name, () => {
      const t = SETS[name];
      const c = (k: string) => parseColor(t[k]);
      const S = surfaces(name);
      const fails = (fg: (bg: RGB) => RGB, min: number, on: Record<string, RGB>) =>
        Object.entries(on)
          .map(([where, bg]) => [where, contrast(fg(bg), bg)] as const)
          .filter(([, r]) => r < min)
          .map(([where, r]) => `${where} ${r.toFixed(2)}`);

      test('text tokens: 4.5:1 on every surface', () => {
        const bad = TEXT.flatMap((k) => fails((bg) => over(c(k), bg), 4.5, S).map((f) => `${k} on ${f}`));
        expect(bad).toEqual([]);
      });

      test('accents (dots, rings, borders, bars): 3:1 on every surface', () => {
        const bad = UI.flatMap((k) => fails((bg) => over(c(k), bg), 3, S).map((f) => `${k} on ${f}`));
        expect(bad).toEqual([]);
      });

      test('text on filled buttons and badges: 4.5:1', () => {
        const pairs: [string, string][] = [
          ['--ink', '--text'], // primary button
          ['--ink', '--primary-hover'],
          ['--on-amber', '--amber'],
          ['--on-amber', '--amber-hover'],
          ['--on-amber', '--sun'],
          ['--on-err', '--err-fill'],
          ['--on-err', '--err-fill-hover'],
          ['--on-work', '--work'],
        ];
        const bad = pairs.map(([fg, bg]) => [fg, bg, contrast(over(c(fg), BLACK), over(c(bg), BLACK))] as const).filter(([, , r]) => r < 4.5);
        expect(bad).toEqual([]);
      });

      test('coloured text on its own tint (chips, notes, diff lines): 4.5:1', () => {
        const solid = S.solid;
        const tint = (rgb: string, a: number): RGB => over([...parseColor(t[rgb]).slice(0, 3), a] as RGBA, solid);
        const bad: string[] = [];
        for (const k of ['amber', 'ok', 'err', 'work', 'sun']) {
          const r = contrast(over(c(`--${k}-text`), solid), tint(`--${k}-rgb`, 0.16));
          if (r < 4.5) bad.push(`${k}-text ${r.toFixed(2)}`);
        }
        for (const [k, hue] of [['--diff-add-text', '--ok-rgb'], ['--diff-del-text', '--err-rgb']]) {
          const r = contrast(over(c(k), solid), tint(hue, 0.34)); // the changed words' highlight
          if (r < 4.5) bad.push(`${k} ${r.toFixed(2)}`);
        }
        const inline = contrast(c('--code-inline').slice(0, 3) as RGB, over(c('--fill-3'), S.solid)); // `code` in a message
        if (inline < 4.5) bad.push(`--code-inline ${inline.toFixed(2)}`);
        expect(bad).toEqual([]);
      });

      test('syntax colours in the file viewer: 4.5:1 on the code surfaces', () => {
        const on = { solid: S.solid, 'glass-strong over black': S['glass-strong over black'], gutter: over(c('--code-gutter'), BLACK) };
        const bad = HL.flatMap((k) => fails((bg) => over(c(k), bg), 4.5, on).map((f) => `${k} on ${f}`));
        expect(bad).toEqual([]);
      });
    });
  }
});

// ── guards over the stylesheets ─────────────────────────────────────────────────────────────────
const SHEETS = readdirSync(CSS_DIR)
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ file: `web/src/ui/css/${f}`, text: readFileSync(join(CSS_DIR, f), 'utf8') }));

/** Each declaration with its line, comments removed but a `theme: fixed` note remembered, the token blocks skipped. */
function declarations(text: string): { line: number; prop: string; value: string; fixed: boolean }[] {
  const out: { line: number; prop: string; value: string; fixed: boolean }[] = [];
  const src = text.replace(/\/\* tokens:begin \*\/[\s\S]*?\/\* tokens:end \*\//, (m) => m.replace(/[^\n]/g, ' '));
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fixed = /theme: fixed/.test(lines[i]);
    const code = lines[i].replace(/\/\*.*?\*\//g, '');
    for (const m of code.matchAll(/(?:^|[{;])\s*(-{0,2}[a-z][\w-]*)\s*:\s*([^;{}]*)/gi)) {
      if (/^\s*[a-z-]+\s*$/i.test(m[2]) && /^[a-z-]+$/i.test(m[1]) && /[{,]\s*$/.test(code)) continue; // a selector like a:hover {
      out.push({ line: i + 1, prop: m[1].toLowerCase(), value: m[2], fixed });
    }
  }
  return out;
}

describe('stylesheets stay on the tokens (#77)', () => {
  test('no colour is written into a component rule: it is a token, a custom property, or marked "theme: fixed"', () => {
    const COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(|(?<![\w-])(white|black)(?![\w-])/i;
    const bad: string[] = [];
    for (const { file, text } of SHEETS) {
      for (const d of declarations(text)) {
        if (d.fixed || d.prop.startsWith('--') || d.prop.includes('mask')) continue; // a mask's colour is only its alpha
        const v = d.value
          .replace(/inset 0 1px 0 rgba\(255, 255, 255, [\d.]+\)/g, '') // the lit top edge of a raised control
          .replace(/color-mix\(in srgb, (?:[^()]|\([^()]*\))*?, #(?:fff|000)\)/g, ''); // a hue's own lighter / darker shade
        if (COLOR.test(v)) bad.push(`${file}:${d.line} ${d.prop}: ${d.value.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('text sizes in rem (#55)', () => {
  const PX = /(?<![\w.])\d*\.?\d+px/;
  const TYPE = /^(font|font-size|line-height|letter-spacing)$/;

  test('the UI stylesheets size text in rem or em, never px', () => {
    const bad: string[] = [];
    for (const { file, text } of SHEETS) {
      for (const d of declarations(text)) {
        if (!TYPE.test(d.prop) || !PX.test(d.value)) continue;
        if (/^\s*0\.\d+px\s*$/.test(d.value)) continue; // labels inside an SVG drawing: user units of its viewBox
        bad.push(`${file}:${d.line} ${d.prop}: ${d.value.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('so do the CSS strings of the town and house labels, the boot screen and the server pages', () => {
    const sources: [string, string][] = [
      ['web/src/city/labels.ts', read('web/src/city/labels.ts')],
      ['web/src/player/marker.ts', read('web/src/player/marker.ts')],
      ['web/src/people/tag.ts', read('web/src/people/tag.ts')],
      ['web/src/house/plates.css', read('web/src/house/plates.css')],
      ['web/index.html', read('web/index.html')],
      ['renderPage', renderPage({ title: 't', heading: 'h', lead: 'l' })],
    ];
    const bad: string[] = [];
    for (const [name, src] of sources) {
      for (const m of src.matchAll(/(font-size|line-height|letter-spacing|font)\s*:\s*([^;}"`]*)/g)) {
        if (/(?<![\w.])\d*\.?\d+px/.test(m[2])) bad.push(`${name}: ${m[0].trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── #56: the keyboard focus ring wins over hover ────────────────────────────────────────────────
/** Every rule of a sheet as selector list + body (comments removed; @media wrappers looked through). */
function rules(text: string): { selectors: string[]; body: string }[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...src.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] }));
}
/** Specificity of a plain selector as one number (ids · 100 + classes / attributes / pseudo-classes · 10 + types). */
function specificity(sel: string): number {
  const s = sel.replace(/::[\w-]+/g, ' ').replace(/:(?:not|is|has)\(/g, '(');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  const types = (s.replace(/\.[\w-]+|\[[^\]]*\]|:[\w-]+|#[\w-]+/g, ' ').match(/(?:^|[\s>+~(])[a-z][\w-]*/gi) ?? []).length;
  return ids * 100 + classes * 10 + types;
}

describe('focus ring on menu and list rows (#56)', () => {
  // the cascade order: the sheets as styles.css imports them (a tie in specificity goes to the later sheet)
  const order = [...read('web/src/ui/styles.css').matchAll(/@import '\.\/css\/([\w-]+\.css)'/g)].map((m) => `web/src/ui/css/${m[1]}`);
  const all = SHEETS.flatMap((s) => rules(s.text).map((r) => ({ ...r, at: order.indexOf(s.file) })));
  for (const row of ['menu-item', 'thread-item']) {
    test(`.${row}: the amber ring outranks every hover rule that drops the outline`, () => {
      const ring = all.flatMap((r) => (/outline\s*:\s*2px solid var\(--sun\)/.test(r.body) ? r.selectors.map((sel) => ({ sel, at: r.at })) : [])).filter((x) => x.sel.includes(`.${row}:focus-visible`));
      expect(ring.length).toBeGreaterThan(0);
      const hovers = all.flatMap((r) => (/outline\s*:\s*none/.test(r.body) ? r.selectors.map((sel) => ({ sel, at: r.at })) : [])).filter((x) => x.sel.includes(`.${row}:hover`));
      expect(hovers.length).toBeGreaterThan(0); // the rule this guards against is still there
      // a pointer resting on the focused row matched the hover rule (0,4,0 against the ring's 0,3,0): the ring vanished
      const beats = (a: { sel: string; at: number }, b: { sel: string; at: number }) => specificity(a.sel) > specificity(b.sel) || (specificity(a.sel) === specificity(b.sel) && a.at > b.at);
      expect(hovers.filter((hv) => !ring.some((rg) => beats(rg, hv))).map((hv) => hv.sel)).toEqual([]);
    });
  }
  test('specificity: classes, pseudo-classes and :not() arguments count, pseudo-elements do not', () => {
    expect(specificity('.rlt-ui .menu-item:focus-visible')).toBe(30);
    expect(specificity('.rlt-ui .menu-item:hover:not(:disabled)')).toBe(40);
    expect(specificity('.rlt-ui .menu-item:focus-visible:not(:disabled)')).toBe(40 + 0);
    expect(specificity('#a .b::before')).toBe(110);
    expect(specificity('aside:focus-visible')).toBe(11);
  });
});
