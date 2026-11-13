// FINDING: a city.json with more projects than the town has lots (or with an entry that isn't a project) lost them
// silently: the load dropped them and the next save wrote the town without them. Now each one is logged and kept in
// city-overflow.json beside city.json, as city.json had it, so it can be put back.
import { afterAll, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CITY_OVERFLOW_FILE, createCityStore, type CoreCityStore, type OverflowEntry } from '../../server/city-store';
import { LOTS } from '../../shared/city-layout';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function dataDirWith(projects: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cast-overflow-'));
  dirs.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'city.json'), JSON.stringify({ version: 1, projects }));
  return dataDir;
}

const project = (i: number, lotId: string) => ({ id: `p${i}`, name: `Project ${i}`, path: `/work/p${i}`, lotId, style: 'office', isGit: true, workflowId: null, approvalMode: 'write', floors: 2, createdAt: 1000 + i });

function load(dataDir: string): { city: CoreCityStore; lines: string[] } {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
  try {
    return { city: createCityStore(dataDir, '/work'), lines };
  } finally {
    spy.mockRestore();
  }
}

const overflowOf = (dataDir: string) => (JSON.parse(readFileSync(join(dataDir, CITY_OVERFLOW_FILE), 'utf8')) as { projects: OverflowEntry[] }).projects;

test('projects beyond the last lot are logged and kept in city-overflow.json, as city.json had them', () => {
  // every lot taken, plus two more: one on a lot that doesn't exist, one doubled up on the first lot
  const all = [...LOTS.map((l, i) => project(i, l.id)), project(100, 'lot-gone'), project(101, LOTS[0]!.id)];
  const dataDir = dataDirWith(all);
  const { city, lines } = load(dataDir);

  expect(city.get().projects.map((p) => p.id)).toEqual(LOTS.map((_, i) => `p${i}`));
  const kept = overflowOf(dataDir);
  expect(kept.map((e) => e.reason)).toEqual(['no-free-lot', 'no-free-lot']);
  expect(kept.map((e) => e.project)).toEqual([project(100, 'lot-gone'), project(101, LOTS[0]!.id)]);
  for (const id of ['p100', 'p101']) expect(lines.some((l) => l.includes(id) && l.includes(CITY_OVERFLOW_FILE))).toBe(true);

  // the next save of the town no longer has them; the overflow file still does
  city.removeProject('p3');
  expect(overflowOf(dataDir)).toHaveLength(2);
});

test('loading the same city.json again does not double the overflow', () => {
  const dataDir = dataDirWith([...LOTS.map((l, i) => project(i, l.id)), project(100, 'x')]);
  load(dataDir);
  load(dataDir);
  expect(overflowOf(dataDir).map((e) => (e.project as { id: string }).id)).toEqual(['p100']);
});

test('an entry that is not a project is kept too, and a lot that is gone moves to a free one with a log line', () => {
  const dataDir = dataDirWith([project(1, 'lot-gone'), { name: 'no id or folder' }]);
  const { city, lines } = load(dataDir);
  expect(city.get().projects).toEqual([{ ...project(1, LOTS[0]!.id), approvalMode: 'write' } as never]);
  expect(lines.some((l) => l.includes('p1') && l.includes(LOTS[0]!.id))).toBe(true);
  expect(overflowOf(dataDir)).toEqual([{ reason: 'unreadable', movedAt: expect.any(Number), project: { name: 'no id or folder' } }]);
});

test('a town that fits writes no overflow file', () => {
  const dataDir = dataDirWith([project(1, LOTS[2]!.id)]);
  load(dataDir);
  expect(existsSync(join(dataDir, CITY_OVERFLOW_FILE))).toBe(false);
});
