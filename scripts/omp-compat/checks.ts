// Shape matchers and the PASS/FAIL report of the omp compatibility suite.
//
// A spec describes what CAST reads from omp: literals must be equal, RegExps must match a string, objects list the keys
// CAST reads (extra keys are fine), and T.* builds the rest. match() returns every mismatch with its path; describe()
// prints the spec as "expected", seen() prints what omp actually sent (trimmed), so a FAIL shows both shapes.

export interface Matcher {
  readonly __matcher: true;
  desc: string;
  test(v: unknown, path: string): string[];
}

export type Spec = Matcher | RegExp | string | number | boolean | null | undefined | { [k: string]: Spec } | Spec[];

const isMatcher = (s: unknown): s is Matcher => !!s && typeof s === 'object' && (s as Matcher).__matcher === true;
const m = (desc: string, test: (v: unknown, path: string) => string[]): Matcher => ({ __matcher: true, desc, test });
const where = (path: string) => path || '(value)';

export interface Matchers {
  any: Matcher;
  str: Matcher;
  nonEmpty: Matcher;
  num: Matcher;
  pos: Matcher;
  bool: Matcher;
  absJsonl: Matcher;
  oneOf(...vals: unknown[]): Matcher;
  opt(s: Spec): Matcher;
  arr(of?: Spec, min?: number): Matcher;
  some(s: Spec): Matcher;
  has(sub: string): Matcher;
  not(s: Spec): Matcher;
  pred(desc: string, fn: (v: unknown) => boolean): Matcher;
}

export const T: Matchers = {
  any: m('any', () => []),
  str: m('string', (v, p) => (typeof v === 'string' ? [] : [`${where(p)}: expected string, got ${seen(v, 1)}`])),
  nonEmpty: m('non-empty string', (v, p) => (typeof v === 'string' && v.length > 0 ? [] : [`${where(p)}: expected non-empty string, got ${seen(v, 1)}`])),
  num: m('number', (v, p) => (typeof v === 'number' && Number.isFinite(v) ? [] : [`${where(p)}: expected number, got ${seen(v, 1)}`])),
  pos: m('number > 0', (v, p) => (typeof v === 'number' && v > 0 ? [] : [`${where(p)}: expected number > 0, got ${seen(v, 1)}`])),
  bool: m('boolean', (v, p) => (typeof v === 'boolean' ? [] : [`${where(p)}: expected boolean, got ${seen(v, 1)}`])),
  absJsonl: m('absolute path ending .jsonl', (v, p) => (typeof v === 'string' && v.startsWith('/') && v.endsWith('.jsonl') ? [] : [`${where(p)}: expected absolute .jsonl path, got ${seen(v, 1)}`])),
  oneOf: (...vals: unknown[]) =>
    m(vals.map((v) => JSON.stringify(v)).join('|'), (v, p) => (vals.some((x) => x === v) ? [] : [`${where(p)}: expected one of ${vals.map((x) => JSON.stringify(x)).join('|')}, got ${seen(v, 1)}`])),
  opt: (s: Spec) => m(`${describe(s)}?`, (v, p) => (v === undefined || v === null ? [] : match(v, s, p))),
  /** Array whose every element matches `of` (and at least `min` of them). */
  arr: (of: Spec = T.any, min = 0) =>
    m(`${describe(of)}[]${min ? ` (≥${min})` : ''}`, (v, p) => {
      if (!Array.isArray(v)) return [`${where(p)}: expected array, got ${seen(v, 1)}`];
      if (v.length < min) return [`${where(p)}: expected at least ${min} element(s), got ${v.length}`];
      return v.flatMap((x, i) => match(x, of, `${p}[${i}]`));
    }),
  /** Array with at least one element matching `s`. */
  some: (s: Spec) =>
    m(`[…${describe(s)}…]`, (v, p) => {
      if (!Array.isArray(v)) return [`${where(p)}: expected array, got ${seen(v, 1)}`];
      return v.some((x) => match(x, s, p).length === 0) ? [] : [`${where(p)}: no element matches ${describe(s)}; got ${seen(v, 3)}`];
    }),
  /** A string containing `sub`. */
  has: (sub: string) => m(`string containing ${JSON.stringify(sub)}`, (v, p) => (typeof v === 'string' && v.includes(sub) ? [] : [`${where(p)}: expected a string containing ${JSON.stringify(sub)}, got ${seen(v, 1)}`])),
  not: (s: Spec) => m(`not ${describe(s)}`, (v, p) => (match(v, s, p).length ? [] : [`${where(p)}: expected not ${describe(s)}, got ${seen(v, 1)}`])),
  pred: (desc: string, fn: (v: unknown) => boolean) => m(desc, (v, p) => (fn(v) ? [] : [`${where(p)}: expected ${desc}, got ${seen(v, 1)}`])),
};

export function match(v: unknown, s: Spec, path = ''): string[] {
  if (isMatcher(s)) return s.test(v, path);
  if (s instanceof RegExp) return typeof v === 'string' && s.test(v) ? [] : [`${where(path)}: expected string matching ${s}, got ${seen(v, 1)}`];
  if (Array.isArray(s)) {
    if (!Array.isArray(v)) return [`${where(path)}: expected array, got ${seen(v, 1)}`];
    if (v.length !== s.length) return [`${where(path)}: expected ${s.length} element(s), got ${v.length}: ${seen(v, 2)}`];
    return s.flatMap((x, i) => match(v[i], x, `${path}[${i}]`));
  }
  if (s && typeof s === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${where(path)}: expected object, got ${seen(v, 1)}`];
    return Object.entries(s).flatMap(([k, x]) => match((v as Record<string, unknown>)[k], x, path ? `${path}.${k}` : k));
  }
  return v === s ? [] : [`${where(path)}: expected ${JSON.stringify(s)}, got ${seen(v, 1)}`];
}

export function describe(s: Spec): string {
  if (isMatcher(s)) return s.desc;
  if (s instanceof RegExp) return String(s);
  if (Array.isArray(s)) return `[${s.map(describe).join(', ')}]`;
  if (s && typeof s === 'object') return `{${Object.entries(s).map(([k, x]) => `${k}: ${describe(x)}`).join(', ')}}`;
  return JSON.stringify(s) ?? 'undefined';
}

/** A short rendering of what omp sent: strings cut at 80 chars, arrays at 5 items, objects at `depth`. */
export function seen(v: unknown, depth = 3): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v.length > 80 ? `${v.slice(0, 77)}…(${v.length} chars)` : v);
  if (typeof v !== 'object' || v === null) return JSON.stringify(v);
  if (depth <= 0) return Array.isArray(v) ? `[${v.length} items]` : '{…}';
  if (Array.isArray(v)) {
    const head = v.slice(0, 5).map((x) => seen(x, depth - 1));
    return `[${head.join(', ')}${v.length > 5 ? `, …+${v.length - 5}` : ''}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  const shown = entries.slice(0, 14).map(([k, x]) => `${k}: ${seen(x, depth - 1)}`);
  return `{${shown.join(', ')}${entries.length > 14 ? `, …+${entries.length - 14} keys` : ''}}`;
}

export interface Result {
  group: string;
  name: string;
  ok: boolean;
  expected: string;
  got: string;
  problems: string[];
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export class Report {
  results: Result[] = [];
  group = '';
  verbose = false;

  /** Check `value` against `spec`; prints PASS/FAIL and returns whether it passed. */
  shape(name: string, value: unknown, spec: Spec): boolean {
    const problems = match(value, spec);
    return this.#add(name, problems.length === 0, describe(spec), seen(value), problems);
  }

  /** A plain condition with its own expected/seen texts. */
  ok(name: string, cond: boolean, expected: string, got: unknown): boolean {
    return this.#add(name, cond, expected, typeof got === 'string' ? got : seen(got), cond ? [] : []);
  }

  /** An informational line (not a check). */
  note(text: string): void {
    console.log(paint('2', `      · ${text}`));
  }

  fail(name: string, expected: string, got: string): false {
    this.#add(name, false, expected, got, []);
    return false;
  }

  #add(name: string, ok: boolean, expected: string, got: string, problems: string[]): boolean {
    this.results.push({ group: this.group, name, ok, expected, got, problems });
    const label = `${this.group} · ${name}`;
    if (ok) {
      console.log(`${paint('32', 'PASS')}  ${label}`);
      if (this.verbose) console.log(`        shape: ${expected}`);
    } else {
      console.log(`${paint('31;1', 'FAIL')}  ${label}`);
      console.log(`        expected: ${expected}`);
      console.log(`        seen:     ${got}`);
      for (const p of problems.slice(0, 6)) console.log(`        mismatch: ${p}`);
    }
    return ok;
  }

  get failures(): Result[] {
    return this.results.filter((r) => !r.ok);
  }
}
