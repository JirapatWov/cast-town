// #70: the 2D shell (top bar, chat, panels, Town board) starts before the 3D engine and the town. That only holds
// while nothing the app's first chunk imports pulls in three: one static `import … from 'three'` anywhere under
// main.ts makes the whole UI wait for three's 630 KB chunk (and a Board start download it for nothing).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../../web/src');

/** Runtime imports of a module (type-only imports are erased by the build and don't count). */
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const what = (m[1] ?? '').trim();
    if (/^type\s/.test(what)) continue; // import type … / export type …
    if (/^\{[^}]*\}$/.test(what) && what.slice(1, -1).split(',').every((s) => !s.trim() || /^type\s/.test(s.trim()))) continue; // { type A, type B }
    out.push(m[2] ?? m[3]!);
  }
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const f of [base, `${base}.ts`, join(base, 'index.ts')]) if (f.endsWith('.ts') && existsSync(f)) return f;
  return null;
}

/** Every module main.ts reaches through static imports, with the chain that reached it. */
function firstChunk(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.set(file, chain);
    for (const spec of runtimeImports(file)) {
      const next = resolveLocal(file, spec);
      if (next) walk(next, [...chain, relative(SRC, next)]);
    }
  };
  walk(join(SRC, 'main.ts'), ['main.ts']);
  return seen;
}

describe('the first chunk (#70)', () => {
  test('nothing main.ts imports statically pulls in three', () => {
    const offenders: string[] = [];
    for (const [file, chain] of firstChunk()) {
      if (runtimeImports(file).some((s) => s === 'three' || s.startsWith('three/'))) offenders.push(chain.join(' → '));
    }
    expect(offenders).toEqual([]);
  });

  test('the renderer, the town and the interior stay out of it (dynamic chunks)', () => {
    const files = [...firstChunk().keys()].map((f) => relative(SRC, f));
    expect(files).toContain('ui/index.ts'); // the walk works
    // pure helpers next to them may come along (the frame-pacing maths, the player's saved look): the test above keeps
    // three out of those; the 3D modules themselves load with the town
    for (const f of ['engine/index.ts', 'city/index.ts', 'house/index.ts', 'player/index.ts', 'interior.ts', 'people/tag.ts']) expect(files).not.toContain(f);
    expect(files.filter((f) => f.startsWith('city/') || f.startsWith('house/'))).toEqual([]);
  });
});

describe('boot tracker without three', () => {
  test('counts a loading manager only once it is attached (main.ts attaches three’s when the town starts)', async () => {
    const g = globalThis as { location?: unknown };
    const stub = g.location === undefined;
    if (stub) g.location = { pathname: '/', search: '', protocol: 'http:', host: 'localhost' };
    const { trackAssets } = await import('../../web/src/boot');
    if (stub) delete g.location;
    const calls: string[] = [];
    const manager = {
      itemStart: (u: string) => void calls.push(`start ${u}`),
      itemEnd: (u: string) => void calls.push(`end ${u}`),
      itemError: (u: string) => void calls.push(`error ${u}`),
    };
    const t = trackAssets();
    manager.itemStart('/assets/hdri/day.hdr'); // before attach: not ours to count
    expect(t.weight(['city'])).toBe(0);
    t.attach(manager);
    t.attach(manager); // twice: still one hook
    manager.itemStart('/assets/props-city/bench.glb');
    expect(t.weight(['city'])).toBe(6);
    expect(t.progress(['city'])).toBe(0);
    expect(t.current(['city'])).toBe('Lighting the streets');
    manager.itemEnd('/assets/props-city/bench.glb');
    expect(t.progress(['city'])).toBe(1);
    // the original handlers still run (three's own bookkeeping)
    expect(calls).toEqual(['start /assets/hdri/day.hdr', 'start /assets/props-city/bench.glb', 'end /assets/props-city/bench.glb']);
  });
});
