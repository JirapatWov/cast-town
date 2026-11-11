// The repository is fit to publish (findings #4, #41, #42): nothing from the machine it was developed on (home
// folders, scratch paths, tailnet host names, e-mail addresses) in what ships, every bundled asset accounted for in
// MANIFEST.json, the docs' links and anchors resolve, and the release files exist.
//
// agent/ is cast-agent: omp's tree as its authors publish it (third-party code, MIT). It keeps their e-mail addresses,
// links and example paths (`/root` in Dockerfiles and fixtures, `memory://root`, the word scratchpad), so the checks of
// what CAST itself writes skip it. What only this machine has (its project folders, its scratch paths, its tailnet and
// host names) must not be anywhere, agent/ included.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import pkg from '../../package.json';

const repo = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(repo, rel), 'utf8');

const BINARY = /\.(glb|gltf|bin|png|jpe?g|webp|avif|gif|ico|hdr|exr|ktx2|basis|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|zip|gz|tgz|zst|wasm|node)$/i;

/** The files that ship: what git would publish from this folder, whether or not it is a checkout. A throwaway git
 *  dir with an empty index makes git list every file `.gitignore` allows, and never writes into the repo. */
function shippedFiles(): string[] {
  const gitDir = mkdtempSync(join(tmpdir(), 'cast-hygiene-'));
  try {
    const run = (...args: string[]) =>
      Bun.spawnSync(['git', `--git-dir=${gitDir}`, `--work-tree=${repo}`, ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const init = Bun.spawnSync(['git', 'init', '--quiet', '--bare', gitDir], { stdout: 'pipe', stderr: 'pipe' });
    if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
    const list = run('ls-files', '-z', '--others', '--exclude-standard');
    if (list.exitCode !== 0) throw new Error(`git ls-files failed: ${list.stderr.toString()}`);
    return list.stdout.toString().split('\0').filter(Boolean).filter((f) => existsSync(join(repo, f)));
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

const files = shippedFiles();
const textFiles = files.filter((f) => !BINARY.test(f) && f !== 'bun.lock' && statSync(join(repo, f)).isFile());
const ownFiles = textFiles.filter((f) => !f.startsWith('agent/'));

/** What only the development machine has: its folders, Claude's scratch folder, its tailnet and host names. */
const MACHINE = /\/root\/terminal\b|\/tmp\/claude|\b[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b|\bvmi\d{5,}\b/i;

describe('nothing from the development machine ships', () => {
  test('the file list is real', () => {
    expect(textFiles.length).toBeGreaterThan(200);
    expect(textFiles).toContain('README.md');
  });

  test('no scratch paths, folders of this machine or tailnet host names, agent/ included', () => {
    const hits = textFiles.flatMap((f) => {
      const text = read(f);
      const m = text.match(MACHINE) ?? (f.startsWith('agent/') ? null : text.match(/scratch[p]ad\//i));
      return m ? [`${f}: ${m[0]}`] : [];
    });
    expect(hits).toEqual([]);
  }, 60_000);

  test('no root-owned paths outside tests (which name them only to assert they are gone)', () => {
    const bad = /(?<![\w.~-])\/root(?=[/'"`\s)]|$)/m;
    const hits = ownFiles
      .filter((f) => !f.startsWith('tests/'))
      .filter((f) => bad.test(read(f)))
      .map((f) => `${f}: ${read(f).split('\n').find((l) => bad.test(l))!.trim().slice(0, 120)}`);
    expect(hits).toEqual([]);
  });

  test('no e-mail addresses except placeholders and the published project contact', () => {
    const allowed = /@(example\.(com|org|net)|invalid|localhost)$|^git@github\.com$|^noreply@|users\.noreply\.github\.com$/i;
    // The maintainer's published contact, for security and conduct reports: only on those two pages (and here).
    const contact = { address: 'jirapat.wov@gmail.com', files: ['SECURITY.md', 'CODE_OF_CONDUCT.md', 'tests/repo/hygiene.test.ts'] };
    const hits: string[] = [];
    for (const f of ownFiles) {
      for (const m of read(f).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
        if (allowed.test(m[0]) || (m[0] === contact.address && contact.files.includes(f))) continue;
        hits.push(`${f}: ${m[0].replace(/^[^@]+/, '<user>')}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('internal briefs and local links are not tracked', () => {
    for (const f of ['NEXT.md', 'JOBS.md', 'GRAPHICS.md', 'node_modules', 'data/token', 'data/city.json']) expect(files).not.toContain(f);
    expect(files.some((f) => f.startsWith('web/dist/'))).toBe(false);
  });
});

describe('bundled assets', () => {
  interface Entry { path: string; size: number; source?: string; license?: string; date?: string }
  const manifest = JSON.parse(read('web/public/assets/MANIFEST.json')) as { fileCount: number; totalBytes: number; assets: Entry[] };

  const onDisk: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(repo, rel))) {
      const p = `${rel}/${name}`;
      if (statSync(join(repo, p)).isDirectory()) walk(p);
      else if (p !== 'web/public/assets/MANIFEST.json') onDisk.push(p);
    }
  };
  walk('web/public/assets');

  test('every file under web/public/assets has a manifest entry, and every entry a file', () => {
    const listed = manifest.assets.map((a) => a.path);
    expect(new Set(listed).size).toBe(listed.length);
    expect(onDisk.filter((p) => !listed.includes(p))).toEqual([]);
    expect(listed.filter((p) => !onDisk.includes(p))).toEqual([]);
  });

  test('each entry says where it came from, under which licence, and when', () => {
    const incomplete = manifest.assets.filter((a) => !a.source?.trim() || !a.license?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(a.date ?? ''));
    expect(incomplete.map((a) => a.path)).toEqual([]);
  });

  test('sizes and totals match the files', () => {
    const wrong = manifest.assets.filter((a) => statSync(join(repo, a.path)).size !== a.size).map((a) => a.path);
    expect(wrong).toEqual([]);
    expect(manifest.fileCount).toBe(manifest.assets.length);
    expect(manifest.totalBytes).toBe(manifest.assets.reduce((n, a) => n + a.size, 0));
  });

  test('the manifest names no machine paths', () => {
    expect(read('web/public/assets/MANIFEST.json')).not.toMatch(/"\/(root|home|tmp|Users)\/|[A-Z]:\\\\/);
  });
});

describe('release files', () => {
  test('licence, notices, policies and package metadata', () => {
    for (const f of ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'THIRD-PARTY-NOTICES.md', 'ARCHITECTURE.md', '.github/workflows/ci.yml'])
      expect(existsSync(join(repo, f))).toBe(true);
    expect(read('LICENSE')).toStartWith('MIT License');
    expect(pkg.license).toBe('MIT');
    expect(pkg.name).toBe('cast');
    expect(pkg.engines.bun).toMatch(/^>=\d/);
    for (const s of ['start', 'build', 'typecheck', 'test']) expect(Object.keys(pkg.scripts)).toContain(s);
  });

  test('THIRD-PARTY-NOTICES names every package built into the app', () => {
    const notices = read('THIRD-PARTY-NOTICES.md');
    const missing = Object.keys(pkg.dependencies).filter((d) => !notices.includes(d.replace(/^@xterm\//, '')));
    expect(missing).toEqual([]);
  });

  test('the README has the install section the in-app Help links to', () => {
    expect(read('README.md')).toMatch(/^## Install$/m);
  });
});

describe('docs links', () => {
  // CAST's own docs; licence files shipped with assets keep their authors' text and links as they are
  const docs = ownFiles.filter((f) => f.endsWith('.md') && !f.startsWith('web/public/assets/'));
  /** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
  const slug = (heading: string) => heading.trim().toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\- ]/gu, '').replace(/ /g, '-');
  const anchors = (rel: string) => new Set([...read(rel).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));

  test('relative links point at files that exist, and #anchors at headings', () => {
    const broken: string[] = [];
    for (const doc of docs) {
      const text = read(doc).replace(/```[\s\S]*?```/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [path, anchor] = target.split('#');
        const file = path ? relative(repo, join(repo, dirname(doc), path)) : doc;
        if (!existsSync(join(repo, file))) broken.push(`${doc} → ${target}`);
        else if (anchor && file.endsWith('.md') && !anchors(file).has(anchor)) broken.push(`${doc} → ${target} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });
});
