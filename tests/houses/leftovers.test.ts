// Finding #75: a deleted job's own copy stays as a branch (rlt/<house>/<job>), and CAST used to forget it. Now the
// job's base is kept with the branch (refs/rlt/leftover/<branch>), and the house lists the branch with Bring in (an
// exact 3-way merge into the house's working files, undoable) and Delete. Real git, real stores, fake agents.
// Run: bun test tests/houses/leftovers.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCityStore } from '../../server/city-store';
import type { AgentSnapshot, AgentSystem } from '../../server/contracts';
import { createFsBrowser } from '../../server/fs-browse';
import { createGitService } from '../../server/git';
import { createJobService } from '../../server/jobs';
import { createJobStore } from '../../server/job-store';
import { createProjectService } from '../../server/projects';
import { parseClientMsg } from '../../server/validate';

/** Dozens of git commands per test: a busy machine needs more than bun's 5 s. */
const GIT_MS = 60_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'cast-leftovers-'));
  dirs.push(root);
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  mkdirSync(dataDir);
  mkdirSync(ws);
  const city = createCityStore(dataDir, ws);
  const jobs = createJobStore(dataDir, city);
  const git = createGitService({ worktreesDir: join(dataDir, 'worktrees') });
  const snap: AgentSnapshot = { agents: [], workflows: [], houseWorkflows: {}, library: [], runs: [], approvals: [], models: [], providers: [], plans: [] };
  const agents = {
    snapshot: () => snap,
    handle: async () => {},
    onProjectAdded: async () => {},
    onProjectRemoved: async () => {},
    onProjectUpdated: async () => {},
    onJobsChanged: async () => {},
    onJobRemoved: async () => {},
    defaultLead: () => ({ model: 'anthropic/claude-opus-5-5', connected: true }),
    ompVersion: () => null,
    demoMode: () => true,
    shutdown: async () => {},
  } as unknown as AgentSystem;
  const projects = createProjectService({ city, jobs, git, fs: createFsBrowser([root]), agents, workspaceRoot: ws });
  const jobService = createJobService({ city, jobs, agents, git, dataDir });
  const dir = join(root, 'shop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'app.js'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
  writeFileSync(join(dir, 'README.md'), '# Shop\n');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'start');
  const house = await projects.place({ path: dir, name: 'Shop', lotId: city.freeLots()[0]!, style: 'house' });
  await jobService.addFloor(house.id);
  const job = await jobService.create({ projectId: house.id, name: 'Fix login', kind: 'code', room: { floor: 1, slot: 0 }, worktree: true });
  return { root, dir, house, job, jobs, jobService, snap };
}

describe('a deleted job’s branch (finding #75)', () => {
  test('keeps its base, shows in the house’s list, brings in exactly its changes, undoes, deletes', async () => {
    const w = await world();
    const copy = w.job.worktree!;
    expect(copy.branch).toBe(`rlt/${w.house.id}/${w.job.id}`);
    // the job edits a file and adds one; the house meanwhile edits another line of the same file
    writeFileSync(join(copy.path, 'app.js'), 'line 1\nline 2\nline 3\nline 4 (fixed)\nline 5\n');
    writeFileSync(join(copy.path, 'login.js'), 'export const login = () => true;\n');
    expect(await w.jobService.leftovers(w.house.id)).toEqual([]); // a live job's branch is not a leftover
    await w.jobService.remove(w.house.id, w.job.id);
    expect(existsSync(copy.root)).toBe(false);
    expect(sh(w.dir, 'rev-parse', '--verify', `refs/rlt/leftover/${copy.branch}`)).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(w.dir, 'app.js'), 'line 1 (house)\nline 2\nline 3\nline 4\nline 5\n');

    const [left] = await w.jobService.leftovers(w.house.id);
    expect(left).toMatchObject({ branch: copy.branch, job: 'Fix login', files: 2, exact: true });
    expect(left!.lastBring).toBeUndefined();

    const preview = await w.jobService.leftover(w.house.id, copy.branch, 'bring', { preview: true });
    expect('plan' in preview && preview.plan.files.sort()).toEqual(['app.js', 'login.js']);
    expect(readFileSync(join(w.dir, 'app.js'), 'utf8')).toBe('line 1 (house)\nline 2\nline 3\nline 4\nline 5\n'); // a preview writes nothing

    await w.jobService.leftover(w.house.id, copy.branch, 'bring');
    expect(readFileSync(join(w.dir, 'app.js'), 'utf8')).toBe('line 1 (house)\nline 2\nline 3\nline 4 (fixed)\nline 5\n'); // both kept
    expect(readFileSync(join(w.dir, 'login.js'), 'utf8')).toContain('login');
    expect(sh(w.dir, 'log', '--format=%s', '-1')).toBe('start'); // HEAD untouched
    const after = (await w.jobService.leftovers(w.house.id))[0]!;
    expect(after.files).toBe(0); // all of it is in the house now
    expect(after.lastBring?.files.sort()).toEqual(['app.js', 'login.js']);

    await w.jobService.leftover(w.house.id, copy.branch, 'undo');
    expect(readFileSync(join(w.dir, 'app.js'), 'utf8')).toBe('line 1 (house)\nline 2\nline 3\nline 4\nline 5\n');
    expect(existsSync(join(w.dir, 'login.js'))).toBe(false);
    const undone = (await w.jobService.leftovers(w.house.id))[0]!;
    expect(undone.files).toBe(2);
    expect(undone.lastBring).toBeUndefined();

    await w.jobService.leftover(w.house.id, copy.branch, 'delete');
    expect(await w.jobService.leftovers(w.house.id)).toEqual([]);
    expect(sh(w.dir, 'branch', '--list', copy.branch)).toBe('');
    expect(sh(w.dir, 'for-each-ref', 'refs/rlt/leftover/', 'refs/rlt/leftover-bring/')).toBe('');
  }, GIT_MS);

  test('a branch an older CAST left without its base is still listed and brought in (from the copy’s start)', async () => {
    const w = await world();
    const copy = w.job.worktree!;
    writeFileSync(join(copy.path, 'notes.txt'), 'from the job\n');
    await w.jobService.remove(w.house.id, w.job.id);
    sh(w.dir, 'update-ref', '-d', `refs/rlt/leftover/${copy.branch}`); // as before this change
    const [left] = await w.jobService.leftovers(w.house.id);
    expect(left).toMatchObject({ branch: copy.branch, files: 1, exact: false });
    await w.jobService.leftover(w.house.id, copy.branch, 'bring');
    expect(readFileSync(join(w.dir, 'notes.txt'), 'utf8')).toBe('from the job\n');
  }, GIT_MS);

  test('refuses branches that aren’t this house’s leftovers, and a bring while someone works in the house', async () => {
    const w = await world();
    await expect(w.jobService.leftover(w.house.id, 'main', 'delete')).rejects.toThrow(/isn’t a branch a deleted job/);
    await expect(w.jobService.leftover(w.house.id, `rlt/${w.house.id}/../x`, 'bring')).rejects.toThrow(/isn’t a branch/);
    // the live job's branch is checked out in its copy
    await expect(w.jobService.leftover(w.house.id, w.job.worktree!.branch, 'delete')).rejects.toThrow(/checked out/);
    const branch = w.job.worktree!.branch;
    writeFileSync(join(w.job.worktree!.path, 'x.txt'), 'x\n');
    await w.jobService.remove(w.house.id, w.job.id);
    w.snap.agents = [{ id: 'a', projectId: w.house.id, jobId: 'main', name: 'Developer', status: 'busy' } as AgentSnapshot['agents'][number]];
    await expect(w.jobService.leftover(w.house.id, branch, 'bring')).rejects.toThrow(/still working/);
    expect((await w.jobService.leftover(w.house.id, branch, 'bring', { preview: true }) as { plan: { files: string[] } }).plan.files).toEqual(['x.txt']);
  }, GIT_MS);

  test('the validator takes list_leftovers and leftover_branch', () => {
    const a = parseClientMsg(JSON.stringify({ t: 'list_leftovers', reqId: 'r', projectId: 'p' }));
    expect(a.ok).toBe(true);
    const b = parseClientMsg(JSON.stringify({ t: 'leftover_branch', reqId: 'r', projectId: 'p', branch: 'rlt/p/x', action: 'bring', preview: true }));
    expect(b.ok && b.msg.t === 'leftover_branch' && b.msg.action).toBe('bring');
    expect(parseClientMsg(JSON.stringify({ t: 'leftover_branch', reqId: 'r', projectId: 'p', branch: 'rlt/p/x', action: 'merge' })).ok).toBe(false);
  });
});

describe('the Changes tab line for a leftover', () => {
  test('says what Bring in would look at, and when', async () => {
    const { leftoverMeta } = await import('../../web/src/ui/leftovers');
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(leftoverMeta({ files: 3, at: now - 2 * 3600_000, exact: true }, now)).toBe('3 files changed · 2h ago');
    expect(leftoverMeta({ files: 1, at: now - 5_000, exact: false }, now)).toBe('1 file changed · just now');
    expect(leftoverMeta({ files: 0, at: now - 60_000, exact: true }, now)).toMatch(/^Nothing new — all of it is in the house · /);
  });
});
