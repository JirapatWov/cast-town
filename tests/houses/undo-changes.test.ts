// Round 3 final check: after a chat turn edited files there was no way to undo it (the place dialog promised "Every
// edit then shows on the TV and can be undone"). Changes → Undo changes / Undo all put a git house's files back as the
// last commit has them (new files deleted, staged changes unstaged), after keeping what was there under
// refs/rlt/discarded/<ms>; Bring back merges it back exactly (3-way, like Bring in). Real git repositories in temp
// folders: modified, deleted, new, renamed, binary, nested folders, a name with spaces, symlinks (put back as links,
// never followed out of the house), ignored files and files outside the house left alone.
// Run: bun test tests/houses/undo-changes.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

const BINARY = Uint8Array.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0]);
const BINARY2 = Uint8Array.from([0, 9, 9, 9, 0, 0, 7]);

/** A house in a real repository: `sub` puts the house in a subfolder of the repo (a file beside it is outside). */
async function world(opts: { sub?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cast-undo-'));
  dirs.push(root);
  const dataDir = join(root, 'data');
  const ws = join(root, 'ws');
  mkdirSync(dataDir);
  mkdirSync(ws);
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'd'), { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'outside — never touched\n');
  writeFileSync(join(outside, 'd', 'a.txt'), 'outside a\n');
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
  const repo = join(root, 'repo');
  const dir = opts.sub ? join(repo, 'app') : repo;
  mkdirSync(join(dir, 'src', 'deep', 'er'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Shop\n\nline 2\nline 3\nline 4\n');
  writeFileSync(join(dir, 'old name.txt'), 'renamed later\n');
  writeFileSync(join(dir, 'gone.txt'), 'deleted later\n');
  writeFileSync(join(dir, 'logo.bin'), BINARY);
  writeFileSync(join(dir, 'src', 'deep', 'er', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(join(dir, 'run.sh'), 0o755);
  writeFileSync(join(dir, 'plain.txt'), 'a plain file\n');
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'a.txt'), 'inside a\n');
  symlinkSync('README.md', join(dir, 'link-to-readme'));
  if (opts.sub) writeFileSync(join(repo, 'beside.txt'), 'outside the house, same repo\n');
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'start');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n'); // ignored: never touched
  const house = await projects.place({ path: dir, name: 'Shop', lotId: city.freeLots()[0]!, style: 'house' });
  return { root, repo, dir, outside, house, jobService, snap };
}

/** An agent's turn: every kind of change. */
function agentEdits(dir: string, outside: string): void {
  writeFileSync(join(dir, 'README.md'), '# Shop\n\nline 2 (agent)\nline 3\nline 4\n');
  rmSync(join(dir, 'gone.txt'));
  writeFileSync(join(dir, 'new file.md'), 'brand new\n');
  mkdirSync(join(dir, 'brand', 'new', 'dir'), { recursive: true });
  writeFileSync(join(dir, 'brand', 'new', 'dir', 'n.ts'), 'export {};\n');
  writeFileSync(join(dir, 'logo.bin'), BINARY2);
  writeFileSync(join(dir, 'src', 'deep', 'er', 'x.ts'), 'export const x = 2;\n');
  chmodSync(join(dir, 'run.sh'), 0o644);
  sh(dir, 'mv', 'old name.txt', 'new name.txt'); // a staged rename
  rmSync(join(dir, 'link-to-readme'));
  symlinkSync('plain.txt', join(dir, 'link-to-readme')); // a link pointed elsewhere
  rmSync(join(dir, 'plain.txt'));
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'plain.txt')); // a file turned into a link out of the house
  symlinkSync(join(outside, 'd'), join(dir, 'escape')); // a new link to a folder outside
  writeFileSync(join(dir, '.env'), 'SECRET=2\n'); // ignored
}

function expectStart(dir: string, outside: string): void {
  expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# Shop\n\nline 2\nline 3\nline 4\n');
  expect(readFileSync(join(dir, 'gone.txt'), 'utf8')).toBe('deleted later\n');
  expect(existsSync(join(dir, 'new file.md'))).toBe(false);
  expect(existsSync(join(dir, 'brand'))).toBe(false); // the new folders went with their file
  expect(new Uint8Array(readFileSync(join(dir, 'logo.bin')))).toEqual(BINARY);
  expect(readFileSync(join(dir, 'src', 'deep', 'er', 'x.ts'), 'utf8')).toBe('export const x = 1;\n');
  expect(statSync(join(dir, 'run.sh')).mode & 0o111).not.toBe(0);
  expect(readFileSync(join(dir, 'old name.txt'), 'utf8')).toBe('renamed later\n');
  expect(existsSync(join(dir, 'new name.txt'))).toBe(false);
  expect(lstatSync(join(dir, 'link-to-readme')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(dir, 'link-to-readme'))).toBe('README.md');
  expect(lstatSync(join(dir, 'plain.txt')).isFile()).toBe(true);
  expect(readFileSync(join(dir, 'plain.txt'), 'utf8')).toBe('a plain file\n');
  expect(existsSync(join(dir, 'escape'))).toBe(false);
  // nothing outside the house changed, nothing was followed
  expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside — never touched\n');
  expect(readFileSync(join(outside, 'd', 'a.txt'), 'utf8')).toBe('outside a\n');
}

describe('Changes → Undo changes (git house)', () => {
  test('Undo all puts every kind of change back, keeps what it removed, and Bring back restores it exactly', async () => {
    const w = await world();
    agentEdits(w.dir, w.outside);
    const summary = await createGitService().summary(w.house);
    const paths = summary.files.map((f) => f.path);
    expect(paths).toContain('new name.txt');
    expect(paths).not.toContain('.env');

    const preview = await w.jobService.discard(w.house.id, paths, { preview: true });
    expect(preview.saved).toBeUndefined();
    expect(preview.skipped).toEqual([]);
    expect(preview.files.sort()).toEqual([...paths].sort());
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toContain('(agent)'); // a preview changes nothing

    const r = await w.jobService.discard(w.house.id, paths);
    expect(r.skipped).toEqual([]);
    expect(r.files.sort()).toEqual([...paths].sort());
    expectStart(w.dir, w.outside);
    expect(readFileSync(join(w.dir, '.env'), 'utf8')).toBe('SECRET=2\n'); // ignored: left alone
    expect(sh(w.dir, 'status', '--porcelain')).toBe(''); // clean, staged rename unstaged too
    expect(sh(w.dir, 'log', '--format=%s')).toBe('start'); // HEAD and branch untouched
    expect(r.saved?.id).toMatch(/^\d+$/);
    expect(sh(w.dir, 'for-each-ref', '--format=%(refname)', 'refs/rlt/discarded/')).toBe(`refs/rlt/discarded/${r.saved!.id}`);

    const listed = await w.jobService.undone(w.house.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.files.sort()).toEqual([...paths].sort());

    const back = await w.jobService.bringBack(w.house.id, r.saved!.id);
    expect(back.plan.conflicts).toEqual([]);
    expect(back.plan.skipped).toEqual([]);
    // exactly the agent's state again: contents, bytes, modes, links, deletions, the staged rename
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toContain('(agent)');
    expect(existsSync(join(w.dir, 'gone.txt'))).toBe(false);
    expect(readFileSync(join(w.dir, 'new file.md'), 'utf8')).toBe('brand new\n');
    expect(readFileSync(join(w.dir, 'brand', 'new', 'dir', 'n.ts'), 'utf8')).toBe('export {};\n');
    expect(new Uint8Array(readFileSync(join(w.dir, 'logo.bin')))).toEqual(BINARY2);
    expect(statSync(join(w.dir, 'run.sh')).mode & 0o111).toBe(0);
    expect(readlinkSync(join(w.dir, 'link-to-readme'))).toBe('plain.txt');
    expect(readlinkSync(join(w.dir, 'plain.txt'))).toBe(join(w.outside, 'secret.txt'));
    expect(readlinkSync(join(w.dir, 'escape'))).toBe(join(w.outside, 'd'));
    expect(readFileSync(join(w.outside, 'secret.txt'), 'utf8')).toBe('outside — never touched\n');
    const status = sh(w.dir, 'status', '--porcelain', '--no-renames');
    expect(status).toContain('A  "new name.txt"'); // staged again
    expect(status).toContain('D  "old name.txt"');
    // a complete bring back forgets the undo
    expect(await w.jobService.undone(w.house.id)).toEqual([]);
  }, GIT_MS);

  test('one file at a time; a file changed again since its undo is merged on Bring back', async () => {
    const w = await world();
    writeFileSync(join(w.dir, 'README.md'), '# Shop\n\nline 2 (agent)\nline 3\nline 4\n');
    writeFileSync(join(w.dir, 'new file.md'), 'brand new\n');
    const one = await w.jobService.discard(w.house.id, ['README.md']);
    expect(one.files).toEqual(['README.md']);
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('# Shop\n\nline 2\nline 3\nline 4\n');
    expect(readFileSync(join(w.dir, 'new file.md'), 'utf8')).toBe('brand new\n'); // not asked for: stays
    const two = await w.jobService.discard(w.house.id, ['new file.md']);
    expect(existsSync(join(w.dir, 'new file.md'))).toBe(false);
    expect((await w.jobService.undone(w.house.id)).map((u) => u.id)).toEqual([two.saved!.id, one.saved!.id]); // newest first

    // the user edits another line meanwhile: Bring back merges both
    writeFileSync(join(w.dir, 'README.md'), '# Shop\n\nline 2\nline 3\nline 4 (user)\n');
    const preview = await w.jobService.bringBack(w.house.id, one.saved!.id, { preview: true });
    expect(preview.plan.files).toEqual(['README.md']);
    await w.jobService.bringBack(w.house.id, one.saved!.id);
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('# Shop\n\nline 2 (agent)\nline 3\nline 4 (user)\n');
    // the house's own version before the merge is kept too
    expect(sh(w.dir, 'for-each-ref', '--format=%(refname)', 'refs/rlt/checkpoints/')).toMatch(/pre-bring-back-/);

    // same lines changed on both sides: conflict markers, and the undo stays listed
    await w.jobService.discard(w.house.id, ['README.md']);
    const [latest] = await w.jobService.undone(w.house.id);
    writeFileSync(join(w.dir, 'README.md'), '# Shop\n\nline 2 (user again)\nline 3\nline 4\n');
    const c = await w.jobService.bringBack(w.house.id, latest!.id);
    expect(c.plan.conflicts).toEqual(['README.md']);
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toContain('<<<<<<< now');
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toContain('>>>>>>> brought back');
    expect((await w.jobService.undone(w.house.id)).map((u) => u.id)).toContain(latest!.id);
  }, GIT_MS);

  test('never touches ignored files, files outside the house, .git, nested repositories or unlisted paths', async () => {
    const w = await world({ sub: true });
    writeFileSync(join(w.repo, 'beside.txt'), 'changed outside the house\n');
    writeFileSync(join(w.dir, 'README.md'), 'agent\n');
    mkdirSync(join(w.dir, 'vendor', 'lib'), { recursive: true });
    sh(join(w.dir, 'vendor', 'lib'), 'init', '-q', '-b', 'main'); // a nested repository
    writeFileSync(join(w.dir, 'vendor', 'lib', 'mine.txt'), 'someone else’s repo\n');
    const summary = await createGitService().summary(w.house);
    expect(summary.files.map((f) => f.path)).toEqual(['README.md', 'vendor/lib/']);
    const r = await w.jobService.discard(w.house.id, ['README.md', 'vendor/lib/', '../beside.txt', '.env', '.git/config', 'plain.txt', '/etc/hosts', 'a/../README.md']);
    expect(r.files).toEqual(['README.md']);
    const why = Object.fromEntries(r.skipped.map((s) => [s.path, s.why]));
    expect(why['vendor/lib/']).toMatch(/another git repository/);
    expect(why['../beside.txt']).toMatch(/isn’t a file of this house/);
    expect(why['.git/config']).toMatch(/isn’t a file of this house/);
    expect(why['/etc/hosts']).toMatch(/isn’t a file of this house/);
    expect(why['.env']).toMatch(/no changes/);
    expect(why['plain.txt']).toMatch(/no changes/);
    expect(readFileSync(join(w.repo, 'beside.txt'), 'utf8')).toBe('changed outside the house\n');
    expect(readFileSync(join(w.dir, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(readFileSync(join(w.dir, 'vendor', 'lib', 'mine.txt'), 'utf8')).toBe('someone else’s repo\n');
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('# Shop\n\nline 2\nline 3\nline 4\n');
    // the undo lists only this house's files and brings them back
    const [u] = await w.jobService.undone(w.house.id);
    expect(u!.files).toEqual(['README.md']);
    await w.jobService.bringBack(w.house.id, u!.id);
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('agent\n');
  }, GIT_MS);

  test('a folder on the way that became a link to outside: refused alone, undone with the link, outside untouched', async () => {
    const w = await world();
    rmSync(join(w.dir, 'lib'), { recursive: true });
    symlinkSync(join(w.outside, 'd'), join(w.dir, 'lib')); // lib/a.txt now "is" the outside a.txt
    const alone = await w.jobService.discard(w.house.id, ['lib/a.txt']);
    expect(alone.files).toEqual([]);
    expect(alone.skipped[0]!.why).toMatch(/the folder lib is a link or a file now/);
    expect(readFileSync(join(w.outside, 'd', 'a.txt'), 'utf8')).toBe('outside a\n');
    const both = await w.jobService.discard(w.house.id, ['lib/a.txt', 'lib']);
    expect(both.files.sort()).toEqual(['lib', 'lib/a.txt']);
    expect(lstatSync(join(w.dir, 'lib')).isDirectory()).toBe(true);
    expect(readFileSync(join(w.dir, 'lib', 'a.txt'), 'utf8')).toBe('inside a\n');
    expect(readFileSync(join(w.outside, 'd', 'a.txt'), 'utf8')).toBe('outside a\n');
    // Bring back puts the link back as a link (and never writes through it)
    expect((await w.jobService.bringBack(w.house.id, both.saved!.id, { preview: true })).plan).toEqual({ files: ['lib', 'lib/a.txt'], conflicts: [], skipped: [] });
    await w.jobService.bringBack(w.house.id, both.saved!.id);
    expect(readlinkSync(join(w.dir, 'lib'))).toBe(join(w.outside, 'd'));
    expect(readFileSync(join(w.outside, 'd', 'a.txt'), 'utf8')).toBe('outside a\n');
  }, GIT_MS);

  test('a file that became a folder of new files goes back to a file with them', async () => {
    const w = await world();
    rmSync(join(w.dir, 'plain.txt'));
    mkdirSync(join(w.dir, 'plain.txt'));
    writeFileSync(join(w.dir, 'plain.txt', 'inner.md'), 'x\n');
    const alone = await w.jobService.discard(w.house.id, ['plain.txt']);
    expect(alone.files).toEqual([]);
    expect(alone.skipped[0]!.why).toMatch(/folder with other files/);
    expect(existsSync(join(w.dir, 'plain.txt', 'inner.md'))).toBe(true);
    const all = await w.jobService.discard(w.house.id, ['plain.txt', 'plain.txt/inner.md']);
    expect(all.files.sort()).toEqual(['plain.txt', 'plain.txt/inner.md']);
    expect(readFileSync(join(w.dir, 'plain.txt'), 'utf8')).toBe('a plain file\n');
  }, GIT_MS);

  test('refused while someone works in the house folder; a job with its own copy doesn’t count', async () => {
    const w = await world();
    writeFileSync(join(w.dir, 'README.md'), 'agent\n');
    w.snap.agents = [{ id: 'a', projectId: w.house.id, jobId: 'main', name: 'Developer', status: 'busy' } as AgentSnapshot['agents'][number]];
    await expect(w.jobService.discard(w.house.id, ['README.md'])).rejects.toThrow(/Developer .*still working/);
    expect((await w.jobService.discard(w.house.id, ['README.md'], { preview: true })).files).toEqual(['README.md']); // a preview may
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('agent\n');
    w.snap.agents = [];
    w.snap.runs = [{ id: 'r', projectId: w.house.id, jobId: 'main', status: 'running' } as AgentSnapshot['runs'][number]];
    await expect(w.jobService.discard(w.house.id, ['README.md'])).rejects.toThrow(/A team is working/);
    w.snap.runs = [];
    const r = await w.jobService.discard(w.house.id, ['README.md']);
    w.snap.agents = [{ id: 'a', projectId: w.house.id, jobId: 'main', name: 'Developer', status: 'busy' } as AgentSnapshot['agents'][number]];
    await expect(w.jobService.bringBack(w.house.id, r.saved!.id)).rejects.toThrow(/still working/);
  }, GIT_MS);

  test('keeps the last 20 undos; a forgotten one says so', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      writeFileSync(join(w.dir, 'README.md'), `edit ${i}\n`);
      ids.push((await w.jobService.discard(w.house.id, ['README.md'])).saved!.id);
    }
    const refs = sh(w.dir, 'for-each-ref', '--format=%(refname)', 'refs/rlt/discarded/').split('\n');
    expect(refs).toHaveLength(20);
    expect(refs).not.toContain(`refs/rlt/discarded/${ids[0]}`);
    expect(refs).toContain(`refs/rlt/discarded/${ids[21]}`);
    await expect(w.jobService.bringBack(w.house.id, ids[0]!)).rejects.toThrow(/no longer kept/);
    await expect(w.jobService.bringBack(w.house.id, '../../heads/main')).rejects.toThrow(/isn’t an undo CAST kept/);
    await w.jobService.bringBack(w.house.id, ids[21]!);
    expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('edit 21\n');
  }, GIT_MS);

  test('a repository without commits yet: new files are deleted and come back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cast-undo-empty-'));
    dirs.push(root);
    sh(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    writeFileSync(join(root, 'b.txt'), 'b\n');
    sh(root, 'add', 'b.txt');
    const git = createGitService();
    const project = { id: 'e', name: 'Empty', path: root } as Parameters<typeof git.discardChanges>[0];
    const r = await git.discardChanges(project, ['a.txt', 'b.txt']);
    expect(r.files).toEqual(['a.txt', 'b.txt']);
    expect(existsSync(join(root, 'a.txt')) || existsSync(join(root, 'b.txt'))).toBe(false);
    expect(sh(root, 'status', '--porcelain')).toBe('');
    await git.bringBackUndone(project, r.saved!.id);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a\n');
    expect(sh(root, 'status', '--porcelain')).toBe('A  b.txt\n?? a.txt'); // b.txt staged again
  }, GIT_MS);

  test('a non-git house refuses with what is true', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cast-undo-nogit-'));
    dirs.push(root);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    const git = createGitService();
    const project = { id: 'n', name: 'Notes', path: root } as Parameters<typeof git.discardChanges>[0];
    await expect(git.discardChanges(project, ['a.txt'])).rejects.toThrow(/isn’t a git repository, so CAST can’t undo changes/);
    expect(await git.listUndone(project)).toEqual([]);
  });

  test('the validator takes the three messages and refuses junk', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'discard_changes', reqId: 'r', projectId: 'p', paths: ['a b.txt'], preview: true })).ok).toBe(true);
    expect(parseClientMsg(JSON.stringify({ t: 'discard_changes', reqId: 'r', projectId: 'p', paths: [] })).ok).toBe(false);
    expect(parseClientMsg(JSON.stringify({ t: 'discard_changes', reqId: 'r', projectId: 'p', paths: 'a.txt' })).ok).toBe(false);
    expect(parseClientMsg(JSON.stringify({ t: 'list_undone', reqId: 'r', projectId: 'p' })).ok).toBe(true);
    expect(parseClientMsg(JSON.stringify({ t: 'bring_back_undone', reqId: 'r', projectId: 'p', id: '1762041600000' })).ok).toBe(true);
    expect(parseClientMsg(JSON.stringify({ t: 'bring_back_undone', reqId: 'r', projectId: 'p' })).ok).toBe(false);
  });
});

describe('the Changes tab’s words for an undo', () => {
  test('names the file, splits new files (deleted) from the rest (back to the last commit), dates Undone recently', async () => {
    const { splitUndo, undoTitle, undoneMeta } = await import('../../web/src/ui/undo-changes');
    expect(undoTitle(['docs/README.md'])).toBe('Undo changes to README.md?');
    expect(undoTitle(['a', 'b', 'c'])).toBe('Undo changes to 3 files?');
    expect(splitUndo([{ path: 'a.md', status: 'M' }, { path: 'n.md', status: '??' }, { path: 's.md', status: 'A' }, { path: 'g.md', status: 'D' }])).toEqual({ back: ['a.md', 'g.md'], deleted: ['n.md', 's.md'] });
    const now = Date.parse('2026-11-02T12:00:00Z');
    expect(undoneMeta({ files: ['src/a.ts', 'README.md', 'x', 'y'], at: now - 120_000 }, now)).toBe('a.ts, README.md and 2 more · 2m ago');
    expect(undoneMeta({ files: ['README.md'], at: now - 1000 }, now)).toBe('README.md · just now');
  });

  test('a toast with a Bring back button stays long enough to reach it', async () => {
    const { toastTtl } = await import('../../web/src/ui/toasts');
    expect(toastTtl('success', true)).toBeGreaterThanOrEqual(12_000);
  });

  test('on a phone the toast (and its Bring back) shows above the chat sheet, and the buttons fit a finger', () => {
    const css = (p: string) => readFileSync(join(import.meta.dir, '../../web/src/ui/css', p), 'utf8');
    /** The body of `selector`'s rule inside the first `@media (query)` block that has one. */
    const inMedia = (src: string, query: string, selector: string) => {
      for (let at = src.indexOf(`@media ${query}`); at >= 0; at = src.indexOf(`@media ${query}`, at + 1)) {
        const body = src.slice(src.indexOf('{', at) + 1);
        const end = body.search(/\n\}/);
        const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{([^}]*)\\}`).exec(body.slice(0, end));
        if (m) return m[1]!;
      }
      return '';
    };
    const hud = css('hud.css');
    expect(inMedia(hud, '(max-width: 820px)', '.rlt-ui .toasts')).toMatch(/z-index:\s*[1-9]/);
    expect(inMedia(hud, '(pointer: coarse)', '.rlt-ui .toast-action')).toContain('min-height: 2.75rem');
    expect(inMedia(css('viewer.css'), '(pointer: coarse)', '.rlt-ui .file-undo')).toContain('height: 2.75rem');
  });

  test('the non-git texts promise no undo; the git ones say it can be undone', () => {
    const read = (p: string) => readFileSync(join(import.meta.dir, '../../web/src/ui', p), 'utf8');
    const changes = read('changes-tab.ts');
    expect(changes).toContain('is not a git repository, so CAST can’t show what people change in it, and nothing they do can be undone');
    const placement = read('placement.ts');
    expect(placement).toContain('Without git, CAST can’t show what agents change here, and nothing they do can be undone.');
    // unchecked "Set up git": no promise of undo
    expect(placement).toMatch(/'People in this house will ask before every edit \(Ask first\)\. You can set up git later in the Changes tab\.'/);
  });
});
