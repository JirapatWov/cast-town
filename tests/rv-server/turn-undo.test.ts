// "Undo this turn's changes" (round 3 final check: an agent's chat edit could not be undone). A real AgentSystemImpl
// with a scripted omp and a real git house: the folder is snapshotted before the user's message is sent and after the
// turn settles; a turn that changed files gets a 'changes' card; undo_turn puts exactly those files back (only while none
// changed again since) and keeps a copy for Bring back. Someone else working in the folder meanwhile makes the turn
// "shared" (no per-turn undo). A turn that changed nothing leaves no card and no refs.
// Run: bun test tests/rv-server/turn-undo.test.ts
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitService } from '../../server/git.ts';
import type { ServerMsg, TranscriptItem } from '../../shared/protocol.ts';
import { cleanup, makeSys, type FakeProc, type SysWorld } from './sys-world.ts';

afterAll(cleanup);
const GIT_MS = 60_000;

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A git house whose Main job has a team (so other people live in the same folder). */
async function gitHouse(): Promise<SysWorld> {
  const w = makeSys({ git: createGitService() });
  await w.handle({ t: 'enter_project', projectId: w.projectId });
  writeFileSync(join(w.projectPath, 'README.md'), '# Proj\n');
  writeFileSync(join(w.projectPath, 'app.js'), 'one\n');
  sh(w.projectPath, 'init', '-q', '-b', 'main');
  sh(w.projectPath, 'add', '-A');
  sh(w.projectPath, 'commit', '-q', '-m', 'start');
  return w;
}

type Changes = Extract<TranscriptItem, { kind: 'changes' }>;
const changesOf = (w: SysWorld, id: string) => w.sys.store.transcript(id).filter((i): i is Changes => i.kind === 'changes');
const data = <T>(m: ServerMsg | undefined) => {
  if (!m || m.t !== 'ack') throw new Error(`no ack: ${JSON.stringify(m)}`);
  if (!m.ok) throw new Error(m.error);
  return m.data as T;
};

/** The user's message; the scripted omp does `work` (edits files, reports a tool) and finishes the turn. */
async function turn(w: SysWorld, agentId: string, text: string, work: (p: FakeProc) => void, tool = 'edit'): Promise<void> {
  const before = w.history.find((p) => p.agentId === agentId)?.prompts.length ?? 0;
  await w.handle({ t: 'prompt', agentId, text }); // resolves once omp has it (no ack of its own: the dispatcher sends that)
  const p = await w.until(() => (w.procs.get(agentId)?.prompts.length ?? 0) > before && w.procs.get(agentId), 5000, 'prompt reached omp');
  const id = p.prompts.at(-1)!.id;
  work(p);
  p.emit({ type: 'tool_execution_start', toolCallId: `t-${id}`, toolName: tool, args: { path: 'README.md' } });
  p.emit({ type: 'tool_execution_end', toolCallId: `t-${id}`, toolName: tool, result: { content: [{ type: 'text', text: 'ok' }] } });
  p.finish(id, 'completed', 'done');
}

const turnRefs = (w: SysWorld) => sh(w.projectPath, 'for-each-ref', '--format=%(refname)', 'refs/rlt/turns/').split('\n').filter(Boolean);

test('a turn that edits files gets a card; undo puts exactly those files back and keeps a copy for Bring back', async () => {
  const w = await gitHouse();
  try {
    writeFileSync(join(w.projectPath, 'mine.txt'), 'the user’s own, before the turn\n'); // not the turn's: never undone
    await turn(w, w.lead, 'add a note to the README', () => {
      writeFileSync(join(w.projectPath, 'README.md'), '# Proj\n\n## Notes\n- a note\n');
      writeFileSync(join(w.projectPath, 'notes.md'), 'new\n');
    });
    const [card] = await w.until(() => changesOf(w, w.lead).length && changesOf(w, w.lead), 10_000, 'changes card');
    expect([...card!.files].sort()).toEqual(['README.md', 'notes.md']);
    expect(card!.count).toBe(2);
    expect(card!.shared).toBeUndefined();
    expect(card!.from).toMatch(/^refs\/rlt\/turns\/.+-from$/);
    // it comes after the turn's last message
    expect(w.sys.store.transcript(w.lead).at(-1)?.kind).toBe('changes');

    const pre = data<{ files: string[]; kept: string[] }>(await w.handle({ t: 'undo_turn', agentId: w.lead, itemId: card!.id, preview: true }));
    expect([...pre.files].sort()).toEqual(['README.md', 'notes.md']);
    expect(pre.kept).toEqual([]);
    expect(readFileSync(join(w.projectPath, 'README.md'), 'utf8')).toContain('a note'); // a preview writes nothing

    const r = data<{ files: string[]; saved?: { id: string } }>(await w.handle({ t: 'undo_turn', agentId: w.lead, itemId: card!.id }));
    expect(r.files.sort()).toEqual(['README.md', 'notes.md']);
    expect(readFileSync(join(w.projectPath, 'README.md'), 'utf8')).toBe('# Proj\n');
    expect(existsSync(join(w.projectPath, 'notes.md'))).toBe(false);
    expect(readFileSync(join(w.projectPath, 'mine.txt'), 'utf8')).toBe('the user’s own, before the turn\n');
    expect(changesOf(w, w.lead)[0]!.undoneAt).toBeNumber();
    const again = await w.handle({ t: 'undo_turn', agentId: w.lead, itemId: card!.id });
    expect(again?.t === 'ack' && !again.ok && again.error).toMatch(/undone already/);

    // Bring back (the toast's button) puts the turn's files back
    const house = { id: w.projectId, name: 'proj', path: w.projectPath } as Parameters<ReturnType<typeof createGitService>['bringBackUndone']>[0];
    await createGitService().bringBackUndone(house, r.saved!.id);
    expect(readFileSync(join(w.projectPath, 'README.md'), 'utf8')).toContain('a note');
    expect(readFileSync(join(w.projectPath, 'notes.md'), 'utf8')).toBe('new\n');
  } finally {
    await w.dispose();
  }
}, GIT_MS);

test('a file changed again since the turn: nothing is undone, and the answer names it', async () => {
  const w = await gitHouse();
  try {
    await turn(w, w.lead, 'edit', () => {
      writeFileSync(join(w.projectPath, 'README.md'), '# Proj\nturn\n');
      writeFileSync(join(w.projectPath, 'app.js'), 'two\n');
    });
    const [card] = await w.until(() => changesOf(w, w.lead).length && changesOf(w, w.lead), 10_000, 'changes card');
    writeFileSync(join(w.projectPath, 'README.md'), '# Proj\nturn\nand the user\n'); // edited again since
    const pre = data<{ files: string[]; kept: string[] }>(await w.handle({ t: 'undo_turn', agentId: w.lead, itemId: card!.id, preview: true }));
    expect(pre.kept).toEqual(['README.md']);
    const r = data<{ files: string[]; kept: string[]; saved?: unknown }>(await w.handle({ t: 'undo_turn', agentId: w.lead, itemId: card!.id }));
    expect(r.saved).toBeUndefined();
    expect(r.kept).toEqual(['README.md']);
    expect(readFileSync(join(w.projectPath, 'app.js'), 'utf8')).toBe('two\n'); // nothing undone, not even the other file
    expect(changesOf(w, w.lead)[0]!.undoneAt).toBeUndefined();
  } finally {
    await w.dispose();
  }
}, GIT_MS);

test('someone else working in the folder during the turn makes it shared: no per-turn undo', async () => {
  const w = await gitHouse();
  try {
    const dev = w.agentOf('implementer');
    // the house's developer is busy the whole time (another chat, a team step…)
    w.sys.store.patch(dev, { status: 'busy' }, true);
    await turn(w, w.lead, 'edit', () => writeFileSync(join(w.projectPath, 'README.md'), '# Proj\nboth\n'));
    const [card] = await w.until(() => changesOf(w, w.lead).length && changesOf(w, w.lead), 10_000, 'changes card');
    expect(card!.shared).toBe(true);
    const r = await w.handle({ t: 'undo_turn', agentId: w.lead, itemId: card!.id });
    expect(r?.t === 'ack' && !r.ok && r.error).toMatch(/Someone else worked in this folder/);
    expect(readFileSync(join(w.projectPath, 'README.md'), 'utf8')).toBe('# Proj\nboth\n');
  } finally {
    await w.dispose();
  }
}, GIT_MS);

test('a turn that only reads leaves no card and no refs; undo waits while someone works', async () => {
  const w = await gitHouse();
  try {
    await turn(w, w.lead, 'what is in here?', () => {}, 'read');
    await Bun.sleep(400);
    expect(changesOf(w, w.lead)).toEqual([]);
    await w.until(() => turnRefs(w).length === 0, 5000, 'refs dropped');

    await turn(w, w.lead, 'edit', () => writeFileSync(join(w.projectPath, 'app.js'), 'three\n'));
    const [card] = await w.until(() => changesOf(w, w.lead).length && changesOf(w, w.lead), 10_000, 'changes card');
    expect(turnRefs(w)).toHaveLength(2);
    w.sys.store.patch(w.agentOf('implementer'), { status: 'busy' }, true);
    const r = await w.handle({ t: 'undo_turn', agentId: w.lead, itemId: card!.id });
    expect(r?.t === 'ack' && !r.ok && r.error).toMatch(/still working/);
    expect(readFileSync(join(w.projectPath, 'app.js'), 'utf8')).toBe('three\n');
  } finally {
    await w.dispose();
  }
}, GIT_MS);

test('a house without git: turns are not tracked', async () => {
  const w = makeSys({ workflowId: null, git: createGitService() });
  try {
    await turn(w, w.lead, 'edit', () => writeFileSync(join(w.projectPath, 'a.txt'), 'x\n'));
    await Bun.sleep(400);
    expect(changesOf(w, w.lead)).toEqual([]);
  } finally {
    await w.dispose();
  }
}, GIT_MS);

test('the card’s words', async () => {
  const { turnChangesNote } = await import('../../web/src/ui/turn-changes');
  expect(turnChangesNote({ count: 2 })).toBeNull();
  expect(turnChangesNote({ count: 2, shared: true })).toMatch(/Undo files in the Changes tab/);
  expect(turnChangesNote({ count: 2, undoneAt: 1 })).toMatch(/^Undone\./);
});
