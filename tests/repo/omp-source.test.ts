// tests/helpers/omp-source.ts: tests that need the agent's own source find it in agent/, without any machine-specific path.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ompSourceFile, ompSourceRoots } from '../helpers/omp-source';

const tmp = mkdtempSync(join(tmpdir(), 'cast-test-ompsrc-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fakeSource(dir: string): string {
  mkdirSync(join(dir, 'src', 'task'), { recursive: true });
  writeFileSync(join(dir, 'src', 'task', 'agents.ts'), 'export const parseAgent = () => null;\n');
  return join(dir, 'src', 'task', 'agents.ts');
}

describe('omp source lookup', () => {
  const repo = join(tmp, 'work', 'cast');
  const empty = { HOME: join(tmp, 'nohome') };

  test('no agent/ and nothing set: null, so the test that needs it is skipped instead of failing to import', () => {
    expect(ompSourceFile('src/task/agents.ts', empty, repo)).toBeNull();
  });

  test('CAST_OMP_SRC as the package folder or as the root of an omp checkout', () => {
    const pkg = join(tmp, 'pkg');
    expect(ompSourceFile('src/task/agents.ts', { ...empty, CAST_OMP_SRC: pkg }, repo)).toBeNull();
    const file = fakeSource(pkg);
    expect(ompSourceFile('src/task/agents.ts', { ...empty, CAST_OMP_SRC: pkg }, repo)).toBe(file);
    const checkout = join(tmp, 'checkout');
    const inner = fakeSource(join(checkout, 'packages', 'coding-agent'));
    expect(ompSourceFile('src/task/agents.ts', { ...empty, CAST_OMP_SRC: checkout }, repo)).toBe(inner);
  });

  test('agent/packages/coding-agent of the repository; never a global install or a checkout next to the repo', () => {
    const home = join(tmp, 'home');
    fakeSource(join(home, '.bun', 'install', 'global', 'node_modules', '@oh-my-pi', 'pi-coding-agent'));
    fakeSource(join(tmp, 'work', 'omp-fork', 'packages', 'coding-agent'));
    expect(ompSourceFile('src/task/agents.ts', { HOME: home }, repo)).toBeNull();
    const own = fakeSource(join(repo, 'agent', 'packages', 'coding-agent'));
    expect(ompSourceFile('src/task/agents.ts', { HOME: home }, repo)).toBe(own);
  });

  test('no root is tied to a particular machine', () => {
    for (const r of ompSourceRoots({ HOME: '/home/someone' }, '/src/cast')) expect(r.startsWith('/root')).toBe(false);
  });
});
