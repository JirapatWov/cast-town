// The splash's driver (web/src/boot.ts createBootScreen) against the ids of web/index.html's #boot, on a small fake DOM
// (like tests/a11y/theme.test.ts): it writes --boot-p for the town's windows and sky, says "still working" in words,
// and after fail() the error stays — no caption, no "still working" over it — while done() still lifts the splash.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// boot.ts → ui/dom.ts → net/base.ts reads location once at import time; leave no stub behind for other test files
const g = globalThis as Record<string, unknown>;
const stub = g.location === undefined;
if (stub) g.location = { pathname: '/', search: '', protocol: 'http:', host: 'localhost' };
const { createBootScreen, STALL_MS, STILL_WORKING } = await import('../../web/src/boot');
if (stub) delete g.location;

class El {
  textContent = '';
  removed = false;
  readonly attrs = new Map<string, string>();
  readonly props = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly on = new Map<string, (() => void)[]>();
  readonly style = { transform: '', setProperty: (k: string, v: string) => void this.props.set(k, v) };
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(type: string, fn: () => void) {
    this.on.set(type, [...(this.on.get(type) ?? []), fn]);
  }
  click() {
    for (const fn of this.on.get('click') ?? []) fn();
  }
  remove() {
    this.removed = true;
  }
}

const IDS = ['boot', 'boot-fill', 'boot-step', 'boot-pct', 'boot-foot', 'boot-bar', 'boot-error', 'boot-error-text', 'boot-reload', 'boot-2d'];
let els: Record<string, El> = {};
/** <html> (the installed app's night: data-launch) and the bar colour, for done()'s end of the night (theme.ts). */
const html = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
const bar = { content: '', setAttribute: (_: string, v: string) => void (bar.content = v) };
let frames = new Map<number, () => void>();
let frameId = 0;
let now = 0;
const saved = { document: g.document, localStorage: g.localStorage, requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame };
let clock: ReturnType<typeof spyOn>;

beforeAll(() => {
  g.document = {
    getElementById: (id: string) => els[id] ?? null,
    documentElement: html,
    querySelector: (sel: string) => (sel === 'meta[name="theme-color"]' ? bar : null),
  };
  g.requestAnimationFrame = (fn: () => void) => {
    frames.set(++frameId, fn);
    return frameId;
  };
  g.cancelAnimationFrame = (id: number) => void frames.delete(id);
  clock = spyOn(performance, 'now').mockImplementation(() => now);
});
afterAll(() => {
  clock.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});
beforeEach(() => {
  els = Object.fromEntries(IDS.map((id) => [id, new El()]));
  frames = new Map();
  now = 0;
  html.dataset = {};
  bar.content = '';
  if (saved.localStorage === undefined) delete g.localStorage;
  else g.localStorage = saved.localStorage;
});

/** Run the animation frames asked for so far (and those they ask for), `n` rounds, `ms` apart. */
function run(n = 1, ms = 16) {
  for (let i = 0; i < n; i++) {
    now += ms;
    const due = [...frames.values()];
    frames = new Map();
    for (const fn of due) fn();
  }
}

function fakeTracker() {
  let frac = 0;
  let label: string | null = null;
  const fns = new Set<() => void>();
  return {
    set(f: number, l: string | null = label) {
      frac = f;
      label = l;
      fns.forEach((fn) => fn());
    },
    attach() {},
    progress: () => frac,
    weight: () => 0,
    current: (groups: string[]) => (groups.length && frac < 1 ? label : null),
    onChange(fn: () => void) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}

const actions = () => {
  const seen: string[] = [];
  return { seen, reload: () => seen.push('reload'), continue2d: () => seen.push('2d') };
};

describe('createBootScreen', () => {
  test('writes the progress as --boot-p on #boot (the windows and the sky), with the horizon line and the bar values', () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    boot.phase('Building the town…', 0.12, 0.8, ['city']);
    tr.set(0.5, 'Laying the streets');
    run(80);
    // 0.12 + (0.8 - 0.12) × 0.5
    expect(els.boot.props.get('--boot-p')).toBe('0.460');
    expect(els['boot-fill'].style.transform).toBe('scaleX(0.4600)');
    expect(els['boot-bar'].getAttribute('aria-valuenow')).toBe('46');
    expect(els['boot-step'].textContent).toBe('Laying the streets…');
    expect(els['boot-pct'].textContent).toBe('46%');
    expect(els.boot.classes.has('is-waiting')).toBe(false);
  });

  test('--boot-p only moves forward, as the meter does', () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    boot.phase('Building the town…', 0.12, 0.8, ['city']);
    const seen: number[] = [];
    for (const f of [0.2, 0.6, 0.3, 0.9]) {
      tr.set(f);
      run(6);
      seen.push(Number(els.boot.props.get('--boot-p')));
    }
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true);
    expect(seen.at(-1)!).toBeLessThanOrEqual(0.8);
  });

  test('a step with nothing to measure says "still working" in words, with the seconds, at once', () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    now = 6000;
    boot.phase('Preparing graphics…', 0.8, 0.8, []);
    expect(els.boot.classes.has('is-waiting')).toBe(true);
    expect(els['boot-step'].textContent).toBe('Preparing graphics…');
    expect(els['boot-pct'].textContent).toBe(`· ${STILL_WORKING} 6s`);
    expect(els['boot-pct'].textContent).toBe('· still working 6s');
    expect(els['boot-bar'].getAttribute('aria-valuetext')).toBe('Preparing graphics… still working, 6 seconds');
    run(1, 1000);
    expect(els['boot-pct'].textContent).toBe('· still working 7s');
  });

  test('a measurable step says it too once nothing has moved for STALL_MS, and stops saying it when files arrive', () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    boot.phase('Building the town…', 0.12, 0.8, ['city']);
    tr.set(0.2);
    run(40);
    expect(els.boot.classes.has('is-waiting')).toBe(false);
    run(1, STALL_MS + 100);
    expect(els.boot.classes.has('is-waiting')).toBe(true);
    expect(els['boot-pct'].textContent).toMatch(/^· still working \d+s$/);
    tr.set(0.4);
    run(1);
    expect(els.boot.classes.has('is-waiting')).toBe(false);
    expect(els['boot-pct'].textContent).toMatch(/^\d+%$/);
  });

  test('fail(): the error stays — no caption over it, no "still working", not in the progressbar either', () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    now = 4000;
    boot.phase('Preparing graphics…', 0.8, 0.8, []);
    expect(els.boot.classes.has('is-waiting')).toBe(true);
    const a = actions();
    boot.fail('The 3D town could not be built on this device.', a);
    expect(els.boot.classes.has('is-error')).toBe(true);
    expect(els.boot.classes.has('is-waiting')).toBe(false);
    expect(els['boot-error-text'].textContent).toBe('The 3D town could not be built on this device.');
    const after = () => {
      expect(els['boot-step'].textContent).toBe('Could not finish loading');
      expect(els['boot-pct'].textContent).toBe('');
      expect(els.boot.classes.has('is-waiting')).toBe(false);
      expect(els['boot-bar'].getAttribute('aria-valuetext')).toBe('Could not finish loading');
    };
    after();
    // the frames, the clock, a late file and a new step all go on: nothing writes over the error
    run(5, STALL_MS);
    tr.set(0.7, 'Lighting the streets');
    run(3);
    boot.phase('Preparing graphics…', 0.92, 0.92, []);
    run(3, 1000);
    after();
    els['boot-reload'].click();
    els['boot-2d'].click();
    expect(a.seen).toEqual(['reload', '2d']);
  });

  test('done(): the caption says it at once, in the frame of the flare — the next frames may be the 3D town’s', () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    now = 31_000;
    boot.phase('Preparing graphics…', 0.92, 0.92, []);
    expect(els['boot-pct'].textContent).toBe('· still working 31s');
    void boot.done();
    // no frame has run: the words are already the ready ones, not a stale "still working" in the number's style
    expect(els['boot-step'].textContent).toBe('Welcome to town');
    expect(els['boot-pct'].textContent).toMatch(/^\d+%$/);
    expect(els['boot-bar'].getAttribute('aria-valuetext')).toMatch(/^Welcome to town \d+%$/);
    expect(els.boot.classes.has('is-waiting')).toBe(false);
  });

  test('done({quick}): ready and done at once, marked quick so the flare rides the dive (CSS); not after fail()', async () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    boot.phase('Building the town…', 0.12, 0.8, ['city']);
    const done = boot.done({ quick: true });
    expect([...els.boot.classes].sort()).toEqual(['is-done', 'is-quick', 'is-ready']);
    // it lifts onto the Town board while the 3D town still loads: no "Welcome to town 35%" that the board's own
    // number (from 0%) would contradict
    expect(els['boot-step'].textContent).toBe('Welcome to town');
    expect(els['boot-pct'].textContent).toBe('');
    expect(els['boot-bar'].getAttribute('aria-valuetext')).toBe('Welcome to town');
    await done;
    const tr2 = fakeTracker();
    els = Object.fromEntries(IDS.map((id) => [id, new El()]));
    const failed = createBootScreen(tr2);
    failed.fail('boom', actions());
    const done2 = failed.done({ quick: true });
    expect(els.boot.classes.has('is-quick')).toBe(false);
    await done2;
  });

  test('done() ends the installed app’s night once the splash is gone (a quick hand-off goes before the sunrise ends)', async () => {
    g.localStorage = { getItem: (k: string) => (k === 'rlt.theme' ? 'light' : null), setItem() {}, removeItem() {} };
    html.dataset.launch = 'night';
    html.dataset.theme = 'light';
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    const done = boot.done({ quick: true });
    expect(html.dataset.launch).toBe('night'); // not while the splash (and its night) is still on screen
    await done;
    expect(els.boot.removed).toBe(true);
    expect(html.dataset.launch).toBe('day');
    expect(html.dataset.theme).toBe('light');
    expect(bar.content).toBe('#f1ece4'); // the light theme's bar: the night's is over
  });

  test('done() after fail() still lifts the splash (Continue without 3D), without the lamp flare', async () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    boot.phase('Building the town…', 0.12, 0.8, ['city']);
    boot.fail('boom', actions());
    const done = boot.done({ quick: true });
    expect(els.boot.classes.has('is-done')).toBe(true);
    expect(els.boot.classes.has('is-ready')).toBe(false);
    run(3);
    expect(els['boot-step'].textContent).toBe('Could not finish loading');
    await done;
    expect(els.boot.removed).toBe(true);
  });

  test('done(): the lamp flares (is-ready) and "still working" ends at once, the dive comes after the 380 ms beat', async () => {
    const tr = fakeTracker();
    const boot = createBootScreen(tr);
    now = 3000;
    boot.phase('Preparing graphics…', 0.92, 0.92, []);
    expect(els.boot.classes.has('is-waiting')).toBe(true);
    const done = boot.done();
    expect(els.boot.classes.has('is-ready')).toBe(true);
    expect(els.boot.classes.has('is-waiting')).toBe(false);
    expect(els.boot.classes.has('is-done')).toBe(false); // the beat before the dive
    run(60);
    expect(els['boot-step'].textContent).toBe('Welcome to town');
    expect(els.boot.props.get('--boot-p')).toBe('1.000');
    await new Promise((r) => setTimeout(r, 420));
    expect(els.boot.classes.has('is-done')).toBe(true);
    await done;
    expect(els.boot.removed).toBe(true);
  });
});

describe('web/index.html has what boot.ts drives', () => {
  const html = readFileSync(join(import.meta.dir, '../../web/index.html'), 'utf8');

  test('every id, the progressbar on the town, and the classes it sets', () => {
    for (const id of [...IDS, 'curtain-note', 'curtain-text']) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<div class="boot-town" id="boot-bar" role="progressbar" aria-label="Loading CAST" aria-valuemin="0" aria-valuemax="100"/);
    for (const c of ['is-waiting', 'is-error', 'is-ready', 'is-done']) expect(html).toContain(`#boot.${c}`);
    expect(html).toContain('var(--boot-p, 0)');
  });

  test('still working: the lit windows breathe, a steady and a breathing light cross-faded (never frozen half-way)', () => {
    expect(html).toContain('#boot.is-waiting:not(.is-error) .boot-win s {');
    expect(html).toContain('#boot.is-waiting:not(.is-error) .boot-win b::after {');
    // the breath runs all along (out of sight), so turning "still working" off never stops it mid-way
    expect(html).toMatch(/\.boot-win s::after \{\s*animation: boot-wave [\d.]+s ease-in-out infinite;/);
    expect(html).not.toMatch(/boot-wave[^;]*paused/);
    expect(html).not.toContain('boot-walker');
  });

  test('still working runs the whole row: an unlit window breathes too, faintly (its breath is not inside its light)', () => {
    const wins = [...html.matchAll(/<i class="boot-win"[^>]*>(.*?)<\/i>/g)].map((m) => m[1]);
    expect(wins.length).toBe(12);
    for (const w of wins) expect(w).toBe('<b></b><s></s>');
    expect(html).toMatch(/#boot\.is-waiting:not\(\.is-error\) \.boot-win s \{\s*opacity: calc\(0\.2 \+ 0\.8 \* clamp\(0, \(var\(--boot-p, 0\) - var\(--at\)\) \* 1000, 1\)\);/);
  });

  test('the lamp never starts over: the reduced-motion breath is added to its coming-on, and an error leaves it out', () => {
    const rm = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toMatch(/#boot\.is-waiting:not\(\.is-error\) \.boot-lamp \{\s*animation:\s*boot-in 0\.9s linear 0\.16s both,\s*boot-breathe [^;]+;/);
    // …the same coming-on as the lamp's own (reduced motion swaps only its name)
    expect(html).toMatch(/\.boot-lamp \{\s*animation: boot-lamp 0\.9s linear 0\.16s both;/);
    expect(rm).toMatch(/\.boot-lamp \{\s*animation-name: boot-in;/);
    // done()'s fade replaces the error's lamp-out: it must start from an unlit lamp
    expect(html).toMatch(/#boot\.is-error \.boot-lamp \{\s*opacity: 0;[^}]*animation: boot-lamp-out/);
  });

  test('the quick hand-off flares too, inside the dive (reduced motion: a fade, no flare)', () => {
    expect(html).toMatch(/#boot\.is-quick \.boot-flare,\s*#boot\.is-quick \.boot-core \{\s*animation: boot-flash [\d.]+s ease-out both;/);
    const rm = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toMatch(/#boot\.is-quick \.boot-flare,\s*#boot\.is-quick \.boot-core \{\s*animation: none;/);
  });

  test('the caption wraps rather than cut the step (a 320 px phone, "· still working 128s")', () => {
    expect(html).toMatch(/\.boot-cap \{[^}]*flex-wrap: wrap;[^}]*column-gap: 0\.625rem;/);
    expect(html).toMatch(/#boot\.is-waiting \.boot-cap \{\s*column-gap: 0\.3em;/);
  });

  test('every animation and transition of the splash is transform or opacity (the main thread may be busy)', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1].replace(/\/\*[\s\S]*?\*\//g, '');
    const frames = [...css.matchAll(/@keyframes [\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].flatMap((m) => [...m[1].matchAll(/([\w-]+)\s*:/g)].map((p) => p[1]));
    expect(frames.length).toBeGreaterThan(20);
    expect([...new Set(frames)].sort()).toEqual(['opacity', 'transform']);
    // a transition list, split at its top-level commas (not those inside cubic-bezier() or linear())
    const items = (v: string) => v.replace(/\([^()]*\)/g, '()').split(',').map((t) => t.trim().split(/\s+/)[0]);
    const transitions = [...css.matchAll(/transition:\s*([^;]+);/g)].flatMap((m) => items(m[1]));
    // filter: the paused 3D town behind the board (#scene), not the splash; visibility: #boot's discrete flip
    expect([...new Set(transitions)].sort()).toEqual(['filter', 'none', 'opacity', 'transform', 'visibility']);
  });

  test('the error buttons: a valid font, and a focus ring of 3:1 or more on both themes', () => {
    // `font: 500 13px/1 inherit` is not a font shorthand at all (inherit stands alone): the browser drops it
    expect(html).not.toMatch(/\bfont:\s*[^;{}]*\S\s+inherit\s*;/);
    const contrast = (a: string, b: string) => {
      const lum = (h: string) => {
        const [r, g2, b2] = [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g2 + 0.0722 * b2;
      };
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const token = (block: RegExp, name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block.exec(html)![1])![1];
    for (const theme of [/:root\s*\{([^}]*)\}/, /:root\[data-theme='light'\]\s*\{([^}]*)\}/]) {
      expect(contrast(token(theme, '--boot-focus'), token(theme, '--boot-bg'))).toBeGreaterThanOrEqual(3);
    }
    expect(html).toMatch(/\.boot-actions button:focus-visible \{\s*outline: 2px solid var\(--boot-focus\);/);
  });
});
