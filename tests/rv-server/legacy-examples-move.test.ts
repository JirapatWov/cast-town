// The one-time move of the two old example teams (workflows.json v3, server/agents/workflow-store.ts): CAST no longer
// has workflows of its own, so on the first start after the update each house that uses "decode-implement-review" or
// "novel" (as its team, a job's team, or in a run kept on disk) gets its own unchanged copy, before anyone is placed —
// no house loses its team. Nothing else changes: edited copies, other houses, the library. It runs once (v3 is the
// marker), keeps the old file as workflows.v2.json, and never writes over a file it can't read.
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowUsers } from '../../server/agents/index.ts';
import type { WorkflowMigration, WorkflowStore as Store } from '../../server/agents/workflow-store.ts';
import { normalizeWorkflow, WorkflowStore } from '../../server/agents/workflow-store.ts';
import { createCityStore } from '../../server/city-store.ts';
import { agentIdFor } from '../../server/data-layout.ts';
import { createJobStore } from '../../server/job-store.ts';
import { LOTS } from '../../shared/city-layout.ts';
import type { Workflow } from '../../shared/protocol.ts';
import { CODE_EXAMPLE, NOVEL_EXAMPLE } from '../legacy-examples';
import { cleanup, makeSys } from './sys-world';

const roots: string[] = [];
afterAll(() => {
  cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const CODE = 'decode-implement-review';
const NOVEL = 'novel';
const OPUS = 'anthropic/claude-opus-5-5';
const MINE: Workflow = { id: 'mine', name: 'Mine', description: '', icon: '🧪', steps: [{ id: 'maker', name: 'Maker', model: OPUS, kind: 'work', persona: 'You make it.', instruction: '{{task}}' }] };
/** How an older CAST stored a house's edited example team: under the example's id, normalized, stamped builtin. */
const EDITED_CODE: Workflow = { ...normalizeWorkflow({ ...structuredClone(CODE_EXAMPLE), name: 'Decode → Implement → Review (ours)' }), builtin: true };
const plain = (w: Workflow): Workflow => {
  const c = structuredClone(w);
  delete c.builtin;
  return c;
};

/** A run of `workflowId` kept on disk under `folder` (as the engine writes them). */
function runOnDisk(folder: string, id: string, workflowId: string): void {
  mkdirSync(join(folder, '.rlt', 'runs', id), { recursive: true });
  const r = { id, workflowId, workflowName: 'x', projectId: 'whatever', jobId: 'main', task: 't', status: 'completed', currentStepId: null, loop: 0, steps: [], startedAt: 1, endedAt: 2, costUsd: 0 };
  writeFileSync(join(folder, '.rlt', 'runs', id, 'run.json'), `${JSON.stringify(r, null, 2)}\n`);
}

/** A data folder from before the update: six houses, and (unless `file: false`) a v2 workflows.json.
 *  - team:     the house's team is the code example
 *  - jobonly:  only a second job uses the novel example; it has a workflow of its own
 *  - ran:      a run of the code example in the house folder
 *  - copyran:  a run of the novel example in a job's own copy (<data>/worktrees/<house>/<job>)
 *  - nobody:   uses neither
 *  - edited:   its team is the code example, which it had edited (stored under that id) */
function town(o: { file?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cast-test-tmp-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  mkdirSync(dataDir, { recursive: true });
  const city = createCityStore(dataDir, ws);
  const names = ['team', 'jobonly', 'ran', 'copyran', 'nobody', 'edited'] as const;
  const teams: Record<string, string | null> = { team: CODE, edited: CODE };
  const id: Record<(typeof names)[number], string> = {} as never;
  names.forEach((n, i) => {
    mkdirSync(join(ws, n), { recursive: true });
    id[n] = city.addProject({ name: n, path: join(ws, n), lotId: LOTS[i]!.id, style: 'house', isGit: false, workflowId: teams[n] ?? null, approvalMode: 'bypass' }).id;
  });
  const jobs = createJobStore(dataDir, city);
  for (const n of names) jobs.list(id[n]);
  city.updateProject(id.jobonly, { floors: 2 });
  jobs.create(id.jobonly, { name: 'Side', kind: 'write', room: { floor: 1, slot: 0 }, leadModel: OPUS, workflowId: NOVEL });
  runOnDisk(join(ws, 'ran'), 'run-1', CODE);
  runOnDisk(join(dataDir, 'worktrees', id.copyran, 'side'), 'run-2', NOVEL);
  const libraryEntry = { workflow: { ...structuredClone(NOVEL_EXAMPLE), name: 'Novel (library)', builtin: true }, from: { projectId: id.edited, house: 'edited' }, at: 5 };
  const v2 = `${JSON.stringify({ version: 2, houses: { [id.jobonly]: [MINE], [id.edited]: [EDITED_CODE] }, library: [libraryEntry], workflows: [MINE, EDITED_CODE] }, null, 2)}\n`;
  if (o.file !== false) writeFileSync(join(dataDir, 'workflows.json'), v2);
  const file = join(dataDir, 'workflows.json');
  const basesFile = join(dataDir, 'workflow-bases.json');
  const migrate = workflowUsers({ city, jobs, dataDir });
  return { root, dataDir, city, jobs, id, v2, file, basesFile, migrate, open: (m: WorkflowMigration | undefined = migrate) => new WorkflowStore(dataDir, { migrate: m }) };
}

const ids = (s: Store, p: string) => s.list(p).map((w) => w.id);
const fileOf = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { version: number; houses: Record<string, Workflow[]>; library: { workflow: Workflow }[] };
/** What `f` logged (log() writes to console.log). */
function logged<T>(f: () => T): { value: T; lines: string[] } {
  const spy = spyOn(console, 'log');
  try {
    const value = f();
    return { value, lines: spy.mock.calls.map((c) => c.join(' ')) };
  } finally {
    spy.mockRestore();
  }
}

describe('who gets a copy', () => {
  test('the houses that use an example get it unchanged, first in their list, with a fresh base; the rest nothing', () => {
    const t = town();
    const { value: s, lines } = logged(() => t.open());
    // the house's team
    expect(ids(s, t.id.team)).toEqual([CODE]);
    const copy = s.get(t.id.team, CODE)!;
    expect(copy).toEqual(plain(CODE_EXAMPLE)); // same id, name, icon, steps (so the people and runs keep matching)
    expect(copy.builtin).toBeUndefined();
    expect(s.chatBase(t.id.team, CODE)).toEqual(plain(CODE_EXAMPLE));
    expect(s.chatBaseSeeded(t.id.team, CODE)).toBe(false); // fresh, not seeded: the lead's first save isn't refused
    // only a job's team: first, before the house's own
    expect(ids(s, t.id.jobonly)).toEqual([NOVEL, 'mine']);
    expect(s.get(t.id.jobonly, NOVEL)).toEqual(plain(NOVEL_EXAMPLE));
    // only a run on disk: in the house folder, and in a job's own copy
    expect(ids(s, t.id.ran)).toEqual([CODE]);
    expect(ids(s, t.id.copyran)).toEqual([NOVEL]);
    // a house that uses neither
    expect(ids(s, t.id.nobody)).toEqual([]);
    // the edited copy stays as it was (only the old builtin stamp is gone), and gets nothing more
    expect(ids(s, t.id.edited)).toEqual([CODE]);
    expect(JSON.stringify(s.get(t.id.edited, CODE))).toBe(JSON.stringify(plain(EDITED_CODE)));
    // the library is untouched
    expect(s.library().map((e) => [e.workflow.id, e.workflow.name, e.from?.house, e.at])).toEqual([[NOVEL, 'Novel (library)', 'edited', 5]]);
    // the log says where each went
    expect(lines.filter((l) => l.includes('example teams now belong'))).toEqual([
      expect.stringContaining(`example teams now belong to the houses that use them: ${CODE} → ${t.id.team}, ${t.id.ran}; ${NOVEL} → ${t.id.jobonly}, ${t.id.copyran} (the old file is in workflows.v2.json)`),
    ]);
  });

  test('on disk: the old file kept as workflows.v2.json, the new one v3 with no builtin stamps; nothing else is written', () => {
    const t = town();
    const city = readFileSync(join(t.dataDir, 'city.json'), 'utf8');
    const jobs = readFileSync(join(t.dataDir, 'jobs.json'), 'utf8');
    const s = t.open();
    expect(readFileSync(join(t.dataDir, 'workflows.v2.json'), 'utf8')).toBe(t.v2);
    const f = fileOf(t.file);
    expect(f.version).toBe(3);
    expect(readFileSync(t.file, 'utf8')).not.toContain('"builtin"');
    expect(Object.keys(f.houses).sort()).toEqual([t.id.team, t.id.jobonly, t.id.ran, t.id.copyran, t.id.edited].sort());
    expect(existsSync(t.basesFile)).toBe(true);
    expect(readFileSync(join(t.dataDir, 'city.json'), 'utf8')).toBe(city);
    expect(readFileSync(join(t.dataDir, 'jobs.json'), 'utf8')).toBe(jobs);
    expect(s.get(t.id.nobody, CODE)).toBeUndefined();
  });
});

describe('once', () => {
  test('a second start changes nothing (both files byte for byte); workflows.v2.json is written once', () => {
    const t = town();
    t.open();
    const files = { w: readFileSync(t.file, 'utf8'), b: readFileSync(t.basesFile, 'utf8'), v2: readFileSync(join(t.dataDir, 'workflows.v2.json'), 'utf8') };
    const { lines } = logged(() => t.open());
    expect(readFileSync(t.file, 'utf8')).toBe(files.w);
    expect(readFileSync(t.basesFile, 'utf8')).toBe(files.b);
    expect(lines.some((l) => l.includes('example teams'))).toBe(false);
    // going back to an older CAST rewrites a v2 file; the next start moves again — only filling what is missing — and
    // keeps the first backup
    const s = t.open();
    s.remove(t.id.team, CODE);
    const downgraded = fileOf(t.file);
    writeFileSync(t.file, JSON.stringify({ ...downgraded, version: 2 }));
    const again = t.open();
    expect(ids(again, t.id.team)).toEqual([CODE]); // its team is still the code example: given again
    expect(ids(again, t.id.jobonly)).toEqual([NOVEL, 'mine']);
    expect(fileOf(t.file).version).toBe(3);
    expect(readFileSync(join(t.dataDir, 'workflows.v2.json'), 'utf8')).toBe(files.v2);
  });

  test('a copy deleted after the move stays deleted after a restart, even with runs of it on disk', () => {
    const t = town();
    const s = t.open();
    expect(s.remove(t.id.ran, CODE)).toBe(true); // the house with a run of it on disk
    t.city.updateProject(t.id.team, { workflowId: null });
    t.jobs.update(t.id.team, 'main', { workflowId: null });
    expect(s.remove(t.id.team, CODE)).toBe(true);
    const again = t.open();
    expect(again.get(t.id.ran, CODE)).toBeUndefined();
    expect(again.get(t.id.team, CODE)).toBeUndefined();
    expect(ids(again, t.id.copyran)).toEqual([NOVEL]);
  });
});

describe('older files and odd starts', () => {
  test('a v1 file (before houses) goes through both moves; stopped between them, the file stays v2 and moves on the next start', () => {
    const t = town({ file: false });
    const pair: Workflow = { ...structuredClone(MINE), id: 'pair', name: 'Pair' };
    t.city.updateProject(t.id.nobody, { workflowId: 'pair' });
    t.jobs.update(t.id.nobody, 'main', { workflowId: 'pair' });
    const v1 = `${JSON.stringify({ workflows: [pair, EDITED_CODE] }, null, 2)}\n`;
    writeFileSync(t.file, v1);
    // stopped after the v1 move was written (here: the city couldn't be read for the examples)
    const stops: WorkflowMigration = { houses: t.migrate.houses, usersOf: (id) => (id === CODE || id === NOVEL ? (() => { throw new Error('stopped'); })() : t.migrate.usersOf(id)) };
    const first = t.open(stops);
    expect(readFileSync(join(t.dataDir, 'workflows.v1.json'), 'utf8')).toBe(v1);
    expect(fileOf(t.file).version).toBe(2);
    expect(existsSync(join(t.dataDir, 'workflows.v2.json'))).toBe(false);
    expect(ids(first, t.id.nobody)).toEqual(['pair', CODE]); // the v1 move: an edited example went to every house
    expect(first.get(t.id.copyran, NOVEL)).toBeUndefined();
    // the next start: the v3 move
    const s = t.open();
    expect(fileOf(t.file).version).toBe(3);
    expect(fileOf(join(t.dataDir, 'workflows.v2.json')).version).toBe(2);
    for (const p of Object.values(t.id)) expect(s.get(p, CODE)?.name).toBe('Decode → Implement → Review (ours)'); // kept, not replaced
    expect(s.get(t.id.copyran, NOVEL)).toEqual(plain(NOVEL_EXAMPLE));
    expect(ids(s, t.id.jobonly)).toEqual([NOVEL, CODE]);
    expect(s.get(t.id.nobody, NOVEL)).toBeUndefined();
    expect(readFileSync(t.file, 'utf8')).not.toContain('"builtin"');
  });

  test('an example stored unchanged in a v1 file goes only to the houses that use it (not to every house)', () => {
    const t = town({ file: false });
    const pair: Workflow = { ...structuredClone(MINE), id: 'pair', name: 'Pair' };
    t.city.updateProject(t.id.nobody, { workflowId: 'pair' });
    t.jobs.update(t.id.nobody, 'main', { workflowId: 'pair' });
    // as an older CAST wrote them: stamped builtin, keys in its own order
    const stamped = (w: Workflow) => ({ builtin: true, ...structuredClone(w) });
    writeFileSync(t.file, `${JSON.stringify({ workflows: [pair, stamped(NOVEL_EXAMPLE), stamped(CODE_EXAMPLE)] }, null, 2)}\n`);
    const { value: s, lines } = logged(() => t.open());
    expect(ids(s, t.id.jobonly)).toEqual([NOVEL]);
    expect(ids(s, t.id.copyran)).toEqual([NOVEL]);
    expect(ids(s, t.id.team)).toEqual([CODE]);
    expect(ids(s, t.id.ran)).toEqual([CODE]);
    expect(ids(s, t.id.edited)).toEqual([CODE]);
    expect(ids(s, t.id.nobody)).toEqual(['pair']);
    expect(s.get(t.id.jobonly, NOVEL)).toEqual(plain(NOVEL_EXAMPLE));
    expect(s.chatBaseSeeded(t.id.jobonly, NOVEL)).toBe(false);
    expect(s.library()).toEqual([]);
    expect(fileOf(t.file).version).toBe(3);
    expect(lines.some((l) => l.includes(`${NOVEL} → ${t.id.jobonly}, ${t.id.copyran}`))).toBe(true);
    expect(lines.some((l) => l.includes('workflows now belong to houses') && l.includes(NOVEL))).toBe(false);
  });

  test('going back to a CAST from before houses and saving there: the next update still gives the examples only to the houses that use them', () => {
    const t = town({ file: false });
    const before = t.open();
    const lists = Object.fromEntries(Object.values(t.id).map((p) => [p, ids(before, p)]));
    expect(lists[t.id.nobody]).toEqual([]);
    // the older CAST reads the flat list (the copies look like edited built-ins to it) and writes it back unversioned
    const flat = (JSON.parse(readFileSync(t.file, 'utf8')) as { workflows: Workflow[] }).workflows;
    writeFileSync(t.file, `${JSON.stringify({ workflows: flat.map((w) => ({ ...w, builtin: true })) }, null, 2)}\n`);
    const after = t.open();
    expect(Object.fromEntries(Object.values(t.id).map((p) => [p, ids(after, p)]))).toEqual(lists);
    expect(fileOf(t.file).version).toBe(3);
  });

  test('a workflows.json that can’t be read is neither moved nor written over: the first save moves it aside', () => {
    const t = town({ file: false });
    writeFileSync(t.file, '{ not json');
    const bases = `${JSON.stringify({ version: 2, bases: [{ projectId: t.id.team, workflow: MINE, at: 7 }] })}\n`;
    writeFileSync(t.basesFile, bases);
    const s = t.open();
    expect(readFileSync(t.file, 'utf8')).toBe('{ not json');
    expect(readFileSync(t.basesFile, 'utf8')).toBe(bases);
    expect(existsSync(join(t.dataDir, 'workflows.v2.json'))).toBe(false);
    expect(s.get(t.id.team, CODE)).toBeUndefined();
    t.open();
    expect(readFileSync(t.file, 'utf8')).toBe('{ not json');
    // a save (a lead, the Workflow tab, a run card): the old bytes are kept next to the new file, with their bases
    const { lines } = logged(() => s.save(t.id.nobody, MINE));
    const aside = readdirSync(t.dataDir).filter((f) => f.startsWith('workflows.json.corrupt-'));
    expect(aside.length).toBe(1);
    expect(readFileSync(join(t.dataDir, aside[0]!), 'utf8')).toBe('{ not json');
    expect(readFileSync(join(t.dataDir, aside[0]!.replace('workflows.json', 'workflow-bases.json')), 'utf8')).toBe(bases);
    expect(lines.some((l) => l.includes('moved it to') && l.includes(aside[0]!))).toBe(true);
    expect(fileOf(t.file)).toMatchObject({ version: 2, houses: { [t.id.nobody]: [MINE] } });
    s.save(t.id.nobody, { ...MINE, name: 'Mine 2' });
    expect(readdirSync(t.dataDir).filter((f) => f.includes('.corrupt-')).length).toBe(2); // once each
    // the file is v2 now: the next start gives the examples to the houses that use them
    const again = t.open();
    expect(ids(again, t.id.team)).toEqual([CODE]);
    expect(ids(again, t.id.nobody)).toEqual(['mine']);
    expect(fileOf(t.file).version).toBe(3);
  });

  test('a workflow-bases.json that can’t be read is moved aside, not written over', () => {
    const t = town();
    writeFileSync(t.basesFile, '[1, 2');
    t.open();
    const aside = readdirSync(t.dataDir).filter((f) => f.startsWith('workflow-bases.json.corrupt-'));
    expect(aside.length).toBe(1);
    expect(readFileSync(join(t.dataDir, aside[0]!), 'utf8')).toBe('[1, 2');
    expect(JSON.parse(readFileSync(t.basesFile, 'utf8')).bases.length).toBeGreaterThan(0);
  });

  test('no migrate (not the real server): no move, no file', () => {
    const t = town({ file: false });
    const s = new WorkflowStore(t.dataDir);
    expect(s.get(t.id.team, CODE)).toBeUndefined();
    expect(existsSync(t.file)).toBe(false);
    const u = town();
    new WorkflowStore(u.dataDir);
    expect(readFileSync(u.file, 'utf8')).toBe(u.v2);
    expect(existsSync(join(u.dataDir, 'workflows.v2.json'))).toBe(false);
  });

  test('no workflows.json yet while the city and the jobs name the examples: copies, and a v3 file', () => {
    const t = town({ file: false });
    const { value: s, lines } = logged(() => t.open());
    expect(ids(s, t.id.jobonly)).toEqual([NOVEL]);
    expect(ids(s, t.id.team)).toEqual([CODE]);
    expect(ids(s, t.id.edited)).toEqual([CODE]);
    expect(s.get(t.id.edited, CODE)).toEqual(plain(CODE_EXAMPLE));
    expect(fileOf(t.file).version).toBe(3);
    expect(existsSync(join(t.dataDir, 'workflows.v2.json'))).toBe(false); // there was no old file to keep
    expect(lines.some((l) => l.includes(`${NOVEL} → ${t.id.jobonly}, ${t.id.copyran}`) && !l.includes('workflows.v2.json'))).toBe(true);
  });

  test('a fresh data folder: an empty v3 file, nothing logged', () => {
    const root = mkdtempSync(join(tmpdir(), 'cast-test-tmp-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const city = createCityStore(dataDir, join(root, 'ws'));
    const jobs = createJobStore(dataDir, city);
    const { value: s, lines } = logged(() => new WorkflowStore(dataDir, { migrate: workflowUsers({ city, jobs, dataDir }) }));
    expect(s.all()).toEqual([]);
    expect(fileOf(join(dataDir, 'workflows.json'))).toMatchObject({ version: 3, houses: {}, library: [] });
    expect(lines.some((l) => l.includes('example teams'))).toBe(false);
  });
});

describe('through the whole system', () => {
  test('an install from before the update: the house keeps its team, its people and its runs; the page gets no built-ins', async () => {
    // before: the house's team is the old built-in, a run of it finished (an older CAST stored no copy of it)
    const w1 = makeSys();
    const pid = w1.projectId;
    const run = (await w1.handle({ t: 'run_workflow', projectId: pid, workflowId: CODE, task: 'tidy up' })) as { ok: boolean; data: { runId: string } };
    expect(run.ok).toBe(true);
    await w1.until(() => w1.sys.engine.get(run.data.runId)?.status === 'completed', 3000, 'run done');
    await w1.dispose();
    const dataDir = join(w1.root, 'data');
    const old = `${JSON.stringify({ version: 2, houses: {}, library: [], workflows: [] }, null, 2)}\n`;
    writeFileSync(join(dataDir, 'workflows.json'), old);
    rmSync(join(dataDir, 'workflow-bases.json'), { force: true });

    // the update: production defaults, nothing given by the test
    const w2 = makeSys({ root: w1.root, scripted: false, examples: false });
    expect(w2.city.project(pid)?.workflowId).toBe(CODE);
    expect(w2.jobs.get(pid, 'main')?.workflowId).toBe(CODE);
    const snap = w2.sys.snapshot();
    expect(snap.workflows).toEqual([]);
    expect(snap.houseWorkflows[pid]?.map((x) => x.id)).toEqual([CODE]);
    expect(snap.houseWorkflows[pid]?.[0]?.builtin).toBeUndefined();
    const people = snap.agents.filter((a) => a.projectId === pid && a.kind === 'role').map((a) => a.id);
    expect(people.sort()).toEqual(['decoder', 'implementer', 'reviewer'].map((r) => agentIdFor(pid, 'main', r)).sort());
    expect(snap.agents.every((a) => !a.demo)).toBe(true);
    expect(w2.sys.engine.get(run.data.runId)?.workflowId).toBe(CODE); // the old run still reads
    expect(readFileSync(join(dataDir, 'workflows.v2.json'), 'utf8')).toBe(old);
    expect(fileOf(join(dataDir, 'workflows.json')).version).toBe(3);
    await w2.dispose();
  });
});
