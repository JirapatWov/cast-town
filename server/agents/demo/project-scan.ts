// Read-only views of the project on disk, so demo replies talk about the real files.
// (The mock runs in the RLT server process on the same machine as omp, with the same cwd.)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ProjectFile {
  path: string; // relative, forward slashes
  size: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.rlt', '.omp', 'dist', 'build', '.next', 'coverage', '.cache', 'vendor']);

export function listFiles(cwd: string, max = 300): ProjectFile[] {
  const out: ProjectFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5 || out.length >= max) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') && name !== '.github') continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(abs, depth + 1);
      } else if (st.isFile()) {
        out.push({ path: relative(cwd, abs).split('\\').join('/'), size: st.size });
        if (out.length >= max) return;
      }
    }
  };
  walk(cwd, 0);
  return out;
}

export function readText(cwd: string, rel: string, max = 256 * 1024): string | null {
  try {
    const abs = join(cwd, rel);
    if (!existsSync(abs) || statSync(abs).size > max) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

export const lineCount = (text: string) => (text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length);

/** 1-based line number of the first line matching `re`, or null. */
export function lineOf(text: string, re: RegExp | string): number | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => (typeof re === 'string' ? l.includes(re) : re.test(l)));
  return i < 0 ? null : i + 1;
}

export function pick(files: ProjectFile[], ...candidates: (string | RegExp)[]): string | undefined {
  for (const c of candidates) {
    const hit = files.find((f) => (typeof c === 'string' ? f.path === c : c.test(f.path)));
    if (hit) return hit.path;
  }
  return undefined;
}

export const isCode = (p: string) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt)$/.test(p);
export const isTest = (p: string) => /(\.|_)(test|spec)\.\w+$|(^|\/)(test|tests|__tests__)\//.test(p);

/** Likely entry point of a code project. */
export function entryFile(files: ProjectFile[]): string | undefined {
  return pick(files, 'src/server.ts', 'src/index.ts', 'src/main.ts', 'src/app.ts', 'index.ts', 'main.ts', 'server.ts', 'app.ts', 'src/index.js', 'index.js', 'main.py', 'app.py', /^src\/[^/]+\.(ts|js)$/, /\.(ts|js|py|go|rs)$/);
}

export function mdTitle(md: string): string | undefined {
  return md.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

/** First prose paragraph of a markdown file (skips headings, tables, quotes, code). */
export function firstParagraph(md: string): string {
  const blocks = md.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const t = b.trim();
    if (!t || /^(#|\||>|-|\*\s|\d+\.|<)/.test(t)) continue;
    return t.replace(/\s*\n\s*/g, ' ');
  }
  return '';
}

export function exportsOf(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type)\s+(\w+)/g)) names.add(m[1]);
  // Python / Go / Rust top-level definitions
  for (const m of code.matchAll(/^(?:async\s+)?(?:def|class|func|pub fn|fn)\s+(\w+)/gm)) if (!m[1].startsWith('_')) names.add(m[1]);
  return [...names];
}

/** Methods of a class body, e.g. TodoStore → list/get/create/remove. */
export function classMethods(code: string, className: string): string[] {
  const start = code.indexOf(`class ${className}`);
  if (start < 0) return [];
  const body = code.slice(start, code.indexOf('\n}', start) + 2);
  return [...body.matchAll(/^\s{2}(?:async\s+)?(\w+)\s*\(/gm)].map((m) => m[1]).filter((n) => n !== 'constructor');
}

export function testNames(code: string): { done: string[]; todo: string[] } {
  const done = [
    ...[...code.matchAll(/\b(?:test|it)\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]),
    ...[...code.matchAll(/^\s*(?:async\s+)?def\s+(test_\w+)/gm)].map((m) => m[1]),
    ...[...code.matchAll(/^func\s+(Test\w+)/gm)].map((m) => m[1]),
  ];
  const todo = [...code.matchAll(/\b(?:test|it)\.todo\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  return { done, todo };
}

/** Markdown table rows / bullet routes like "| GET | `/todos` |" or "GET /todos". */
export function documentedRoutes(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`?([^|`\s]+)`?/g)) out.push(`${m[1]} ${m[2]}`);
  if (!out.length) for (const m of md.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/:{}-]*)/g)) out.push(`${m[1]} ${m[2]}`);
  return [...new Set(out)];
}

export const hasThai = (s: string) => /[\u0E00-\u0E7F]/.test(s);

/** Markdown `## Heading` names, e.g. character names. */
export function headings(md: string, level = 2): string[] {
  const re = new RegExp(`^${'#'.repeat(level)}\\s+(.+)$`, 'gm');
  return [...md.matchAll(re)].map((m) => m[1].trim());
}
