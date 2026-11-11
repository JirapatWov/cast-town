// House and job services (server/projects.ts, server/jobs.ts) with real city/job stores and git, fake agents:
// a house can point at another folder (and is refused while busy or with own-copy jobs), new houses start without a
// fixed team, and a job's room on the next floor builds that floor only when the job is made.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo, Project, WorkflowRun } from '../../shared/protocol';
import { createCityStore } from '../../server/city-store';
import type { AgentSnapshot, AgentSystem } from '../../server/contracts';
import { createFsBrowser } from '../../server/fs-browse';
import { createGitService } from '../../server/git';
import { createJobService } from '../../server/jobs';
import { createJobStore } from '../../server/job-store';
import { createProjectService, guessFolderKind } from '../../server/projects';
import { parseClientMsg } from '../../server/validate';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), 'cast-houses-'));
  dirs.push(root);
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  mkdirSync(dataDir);
  mkdirSync(ws);
  const city = createCityStore(dataDir, ws);
  const jobs = createJobStore(dataDir, city);
  const git = createGitService();
  const fs = createFsBrowser([root]);
  const snap: AgentSnapshot = { agents: [], workflows: [{ id: 'decode-implement-review', name: 'D', description: '', icon: '', steps: [] }], houseWorkflows: {}, library: [], runs: [], approvals: [], models: [], providers: [], plans: [] };
  const calls: string[] = [];
  const agents = {
    snapshot: () => snap,
    handle: async () => {},
    onProjectAdded: async () => void calls.push('added'),
    onProjectRemoved: async () => void calls.push('removed'),
    onProjectUpdated: async () => void calls.push('updated'),
    onProjectMoved: async (p: Project) => void calls.push(`moved:${p.path}`),
    onJobsChanged: async () => {},
    onJobRemoved: async () => {},
    defaultLead: () => ({ model: 'anthropic/claude-opus-5-5', connected: true }),
    ompVersion: () => null,
    demoMode: () => true,
    shutdown: async () => {},
  } as unknown as AgentSystem;
  const projects = createProjectService({ city, jobs, git, fs, agents, workspaceRoot: ws });
  const jobService = createJobService({ city, jobs, agents, git, dataDir });
  const folder = (name: string, files: Record<string, string> = {}) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text);
    return d;
  };
  const lot = () => city.freeLots()[0]!;
  return { root, city, jobs, projects, jobService, snap, calls, folder, lot };
}

describe('new houses', () => {
  test('a placed folder gets no fixed team; its Main job follows what the folder looks like', async () => {
    const w = world();
    const code = await w.projects.place({ path: w.folder('app', { 'package.json': '{}' }), name: 'app', lotId: w.lot(), style: 'house' });
    expect(code.workflowId).toBeNull();
    expect(w.jobs.get(code.id, 'main')?.kind).toBe('code');
    expect(w.jobs.get(code.id, 'main')?.workflowId).toBeNull();
    const book = await w.projects.place({ path: w.folder('book', { 'a.md': '#', 'b.md': '#', 'c.md': '#' }), name: 'book', lotId: w.lot(), style: 'cottage' });
    expect(book.workflowId).toBeNull();
    expect(w.jobs.get(book.id, 'main')?.kind).toBe('write');
    const plain = await w.projects.place({ path: w.folder('misc'), name: 'misc', lotId: w.lot(), style: 'house' });
    expect(w.jobs.get(plain.id, 'main')?.kind).toBe('general');
  });

  test('non-code folders (a few notes, research papers) get the general Assistant, never the code team', async () => {
    const w = world();
    const notes = await w.projects.place({ path: w.folder('second-notes', { 'todo.md': '- [ ] call', 'ideas.txt': 'x' }), name: 'notes', lotId: w.lot(), style: 'cottage' });
    const papers = await w.projects.place({ path: w.folder('papers', { 'a.pdf': '%PDF', 'b.pdf': '%PDF', 'data.csv': '1,2', 'summary.md': '#' }), name: 'papers', lotId: w.lot(), style: 'house' });
    for (const p of [notes, papers]) {
      expect(p.workflowId).toBeNull();
      expect(w.jobs.get(p.id, 'main')?.kind).toBe('general');
      expect(w.jobs.get(p.id, 'main')?.workflowId).toBeNull();
    }
    expect(guessFolderKind(w.folder('empty-dir'))).toBe('general');
    expect(guessFolderKind(join(w.root, 'not-there'))).toBe('general');
  });

  test('a created project gets no fixed team either', async () => {
    const w = world();
    const p = await w.projects.create({ name: 'Notes API', lotId: w.lot(), style: 'house', template: 'node-api' });
    expect(p.workflowId).toBeNull();
    expect(w.jobs.get(p.id, 'main')?.kind).toBe('code');
    const n = await w.projects.create({ name: 'My Novel', lotId: w.lot(), style: 'cottage', template: 'novel' });
    expect(n.workflowId).toBeNull();
    expect(w.jobs.get(n.id, 'main')?.kind).toBe('write');
  });
});

describe('use another folder (set_project path)', () => {
  test('moves the house to the new folder, keeps its id and jobs, tells the agents', async () => {
    const w = world();
    const p = await w.projects.place({ path: w.folder('old'), name: 'proj', lotId: w.lot(), style: 'house' });
    const next = w.folder('new');
    const moved = await w.projects.update(p.id, { path: next });
    expect(moved.id).toBe(p.id);
    expect(moved.path).toBe(next);
    expect(moved.name).toBe('proj');
    expect(w.city.project(p.id)?.path).toBe(next);
    expect(w.jobs.list(p.id).map((j) => j.id)).toEqual(['main']);
    expect(w.calls).toContain(`moved:${next}`);
  });

  test('the validator lets a path through set_project', () => {
    const r = parseClientMsg(JSON.stringify({ t: 'set_project', reqId: 'r', projectId: 'p', patch: { path: '/x/y' } }));
    expect(r.ok && r.msg.t === 'set_project' && r.msg.patch.path).toBe('/x/y');
  });

  test('refuses: another house’s folder, a folder outside the roots, while someone works, with a job in its own copy', async () => {
    const w = world();
    const a = await w.projects.place({ path: w.folder('a'), name: 'a', lotId: w.lot(), style: 'house' });
    const b = await w.projects.place({ path: w.folder('b'), name: 'b', lotId: w.lot(), style: 'house' });
    await expect(w.projects.update(a.id, { path: b.path })).rejects.toThrow(/already b/);
    await expect(w.projects.update(a.id, { path: '/' })).rejects.toThrow();
    const free = w.folder('c');
    w.snap.agents = [{ id: 'a:assistant', projectId: a.id, jobId: 'main', name: 'Assistant', status: 'busy' } as AgentInfo];
    await expect(w.projects.update(a.id, { path: free })).rejects.toThrow(/Assistant is still working/);
    w.snap.agents = [];
    w.snap.runs = [{ id: 'r', projectId: a.id, status: 'waiting_approval', workflowName: 'Team' } as WorkflowRun];
    await expect(w.projects.update(a.id, { path: free })).rejects.toThrow(/team is working/);
    w.snap.runs = [];
    // a job with its own copy is tied to the old folder's repository
    await w.jobService.addFloor(a.id);
    w.jobs.create(a.id, { id: 'side', name: 'Side', kind: 'code', room: { floor: 1, slot: 0 }, leadModel: 'anthropic/claude-opus-5-5', brief: '', workflowId: null, worktree: { path: join(w.root, 'wt'), root: join(w.root, 'wt'), branch: 'rlt/a/side', baseRef: 'refs/rlt/jobs/a/side/base', createdAt: 1 } });
    await expect(w.projects.update(a.id, { path: free })).rejects.toThrow(/own copy/);
    expect(w.city.project(a.id)?.path).toBe(a.path);
  });
});

describe('a room on the next floor', () => {
  test('is built when the job is created, not before', async () => {
    const w = world();
    const p = await w.projects.place({ path: w.folder('h'), name: 'h', lotId: w.lot(), style: 'house' });
    expect(w.city.project(p.id)?.floors).toBe(1);
    const job = await w.jobService.create({ projectId: p.id, name: 'Second', kind: 'code', room: { floor: 1, slot: 0 } });
    expect(job.room).toEqual({ floor: 1, slot: 0 });
    expect(w.city.project(p.id)?.floors).toBe(2);
  });

  test('a failed create takes the floor down again', async () => {
    const w = world();
    const p = await w.projects.place({ path: w.folder('h2'), name: 'h2', lotId: w.lot(), style: 'house' });
    await expect(w.jobService.create({ projectId: p.id, name: 'Main', kind: 'code', room: { floor: 1, slot: 0 } })).rejects.toThrow(/already has a job/);
    expect(w.city.project(p.id)?.floors).toBe(1);
  });

  test('two floors up is still refused', async () => {
    const w = world();
    const p = await w.projects.place({ path: w.folder('h3'), name: 'h3', lotId: w.lot(), style: 'house' });
    await expect(w.jobService.create({ projectId: p.id, name: 'Far', kind: 'code', room: { floor: 2, slot: 0 } })).rejects.toThrow(/hasn't been built/);
    expect(w.city.project(p.id)?.floors).toBe(1);
  });

  test('moving a job to the next floor builds it too', async () => {
    const w = world();
    const p = await w.projects.place({ path: w.folder('h4'), name: 'h4', lotId: w.lot(), style: 'house' });
    await w.jobService.addFloor(p.id);
    const side = await w.jobService.create({ projectId: p.id, name: 'Side', kind: 'code', room: { floor: 1, slot: 0 } });
    const moved = await w.jobService.update(p.id, side.id, { room: { floor: 2, slot: 1 } });
    expect(moved.room).toEqual({ floor: 2, slot: 1 });
    expect(w.city.project(p.id)?.floors).toBe(3);
  });
});

describe('the Main job’s team and the house’s team stay in step', () => {
  test('clearing the Main job’s team clears the house’s too, also when the job had none of its own (older data)', async () => {
    const w = world();
    const p = await w.projects.place({ path: w.folder('h5'), name: 'h5', lotId: w.lot(), style: 'house' });
    await w.jobService.update(p.id, 'main', { workflowId: 'decode-implement-review' });
    expect(w.city.project(p.id)?.workflowId).toBe('decode-implement-review');
    await w.jobService.update(p.id, 'main', { workflowId: null });
    expect(w.city.project(p.id)?.workflowId).toBeNull();
    // the house kept a team its Main job no longer has (written before the two were kept in step, or a crash between
    // the two files): "no team" on the Main job still clears it, else the workflow stays someone's team for good
    w.city.updateProject(p.id, { workflowId: 'decode-implement-review' });
    expect(w.jobs.get(p.id, 'main')?.workflowId).toBeNull();
    await w.jobService.update(p.id, 'main', { workflowId: null });
    expect(w.city.project(p.id)?.workflowId).toBeNull();
    // other changes to the Main job leave the house's team alone
    w.city.updateProject(p.id, { workflowId: 'decode-implement-review' });
    await w.jobService.update(p.id, 'main', { name: 'Main' });
    expect(w.city.project(p.id)?.workflowId).toBe('decode-implement-review');
  });
});
