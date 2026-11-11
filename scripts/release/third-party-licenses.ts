// Writes THIRD-PARTY-LICENSES.txt: the full licence and notice text of every npm package built into the web app, plus
// the licences of the third-party code vendored into web/src. The licence of each of them asks for its text to travel
// with copies, and a minified bundle drops the comments that carried it.
//
//   bun run scripts/release/third-party-licenses.ts [--out <file>]     (default: web/dist/THIRD-PARTY-LICENSES.txt)
//
// `bun run build:web` runs it after the Vite build, so web/dist, the Mac kit and the dmg (which copy web/dist
// wholesale) always carry the file. Which packages: the root package.json's `dependencies` and, transitively, their
// own `dependencies`, each resolved from node_modules the way a bundler resolves it. devDependencies (Vite, TypeScript)
// never reach the output. The compiled server imports no npm package, so it adds none.
//
// Fails, writing nothing, when a package is not installed or ships no licence file: a `license` field names a licence
// but is not its text or the copyright line, which are what the licence requires to travel with copies.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..');

interface Manifest {
  name: string;
  version: string;
  license?: unknown;
  licenses?: unknown;
  homepage?: string;
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
}

const fail = (msg: string): never => {
  console.error(`third-party-licenses: ${msg}`);
  process.exit(1);
};

/** The folder of `name` as seen from `from`: node_modules next to it or in any parent, nearest first. */
function resolvePackage(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return fail(`${name} (needed from ${from}) is not installed: run bun install`);
  }
}

const readManifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;

/** The licence expression from `license` (string or {type}) or the legacy `licenses` array, or null. */
function declaredLicense(m: Manifest): string | null {
  const one = (v: unknown): string | null => {
    if (typeof v === 'string') return v.trim() || null;
    if (v && typeof v === 'object' && 'type' in v && typeof v.type === 'string') return v.type.trim() || null;
    return null;
  };
  const direct = one(m.license);
  if (direct) return direct;
  if (Array.isArray(m.licenses)) {
    const all = m.licenses.map(one).filter((x): x is string => !!x);
    if (all.length) return all.join(' OR ');
  }
  return null;
}

const LICENSE_FILE = /^(licen[sc]e|notice|copying|copyright|unlicense)([-_. ].*)?$/i;

function licenseFiles(dir: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((n) => LICENSE_FILE.test(n) && statSync(join(dir, n)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').trim() }))
    .filter((f) => f.text);
}

/** The full licence text and copyright line of a package that ships none of its own, keyed `name@version` and copied
 *  by hand from its source repository. Empty today: every bundled package ships its licence file. */
const AUDITED_TEXTS: Record<string, string> = {};

interface Entry { name: string; version: string; declared: string | null; url: string | null; files: { name: string; text: string }[] }

/** Every production package reachable from the root's `dependencies`, keyed by name@version. */
function collect(): Entry[] {
  const seen = new Map<string, Entry>();
  const visit = (name: string, from: string): void => {
    const dir = resolvePackage(name, from);
    const m = readManifest(dir);
    const key = `${m.name}@${m.version}`;
    if (seen.has(key)) return;
    const declared = declaredLicense(m);
    const files = licenseFiles(dir);
    const audited = AUDITED_TEXTS[key];
    if (audited) files.push({ name: 'audited text', text: audited });
    if (!files.length) {
      fail(`${key} ships no licence file (declared: ${declared ?? 'nothing'}). A "license" field is not the licence text: add the package's full text and copyright line to AUDITED_TEXTS (${dir})`);
    }
    const repo = typeof m.repository === 'string' ? m.repository : m.repository?.url;
    const url = m.homepage || (repo ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : null);
    seen.set(key, { name: m.name, version: m.version, declared, url, files });
    for (const dep of Object.keys(m.dependencies ?? {})) visit(dep, dir);
  };
  for (const dep of Object.keys(readManifest(root).dependencies ?? {})) visit(dep, root);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Licence blocks that live in the header of a vendored source file; they have no package to read them from. */
function vendored(): { name: string; url: string; text: string }[] {
  const src = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const qr = src('web/src/vendor/qrcodegen.ts').match(/^\s*\/\*([\s\S]*?)\*\//)?.[1];
  const ez = src('web/src/city/trees/generator.ts').split('\n');
  const start = ez.findIndex((l) => l.startsWith('// EZ-Tree licence'));
  const block: string[] = [];
  for (let i = start + 1; start >= 0 && ez[i]?.startsWith('//'); i++) block.push(ez[i]!);
  if (!qr || !block.length) return fail('the licence header of web/src/vendor/qrcodegen.ts or web/src/city/trees/generator.ts is missing');
  const strip = (lines: string[], prefix: RegExp) => lines.map((l) => l.replace(prefix, '').trimEnd()).join('\n').trim();
  return [
    { name: 'QR Code generator library (web/src/vendor/qrcodegen.ts)', url: 'https://www.nayuki.io/page/qr-code-generator-library', text: strip(qr.split('\n'), /^\s*\* ?/) },
    { name: 'EZ-Tree 1.1.0, ported in web/src/city/trees/ (generator.ts, species.ts)', url: 'https://github.com/dgreenheck/ez-tree', text: strip(block, /^\/\/ ?/) },
  ];
}

const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
if (argv.length && (outFlag < 0 || !argv[outFlag + 1] || argv.length !== 2)) fail('usage: third-party-licenses.ts [--out <file>]');
const out = resolve(outFlag >= 0 ? argv[outFlag + 1]! : join(root, 'web', 'dist', 'THIRD-PARTY-LICENSES.txt'));

const entries = collect();
const extra = vendored();
const rule = '='.repeat(78);
const parts: string[] = [
  `THIRD-PARTY LICENSES`,
  '',
  `CAST is MIT-licensed (LICENSE). Its web app bundles the ${entries.length} npm packages below and the two pieces of`,
  `vendored code after them; their full licence and notice texts follow. The 3D models, textures, skies and fonts`,
  `served with the app keep their own licence files next to them in assets/ and fonts/, and THIRD-PARTY-NOTICES.md`,
  `lists them all.`,
  '',
  'Packages:',
  ...entries.map((e) => `  ${e.name} ${e.version}  (${e.declared ?? 'see licence file'})`),
];
for (const e of entries) {
  parts.push('', rule, `${e.name} ${e.version}`, `Licence: ${e.declared ?? 'not declared in package.json; see the file below'}`);
  if (e.url) parts.push(`Source: ${e.url}`);
  for (const f of e.files) parts.push('', `--- ${f.name} ---`, '', f.text);
}
for (const v of extra) parts.push('', rule, v.name, `Source: ${v.url}`, '', v.text);
parts.push('');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, parts.join('\n'));
console.log(`third-party-licenses: ${entries.length} packages + ${extra.length} vendored → ${out}`);
