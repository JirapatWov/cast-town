// #62: deleting history — one chat (ThreadBook.remove), one house (removeHouseHistory + artifacts), unreferenced chat
// pictures (pruneUploads), and "Delete all CAST data" (wipeDataDir + the /api/data/wipe route).
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadBook } from '../../server/agents/thread-store';
import { createDataRoutes } from '../../server/data-routes';
import { pruneUploads, removeHouseArtifacts, removeHouseHistory, UPLOAD_GRACE_MS, wipeDataDir, WIPE_CONFIRM_TEXT } from '../../server/data-wipe';
import { exec } from '../../server/exec';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cast-wipe-'));
  roots.push(d);
  return d;
}
function put(path: string, text = 'x') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}
const PIC = (c: string) => `${c.repeat(64)}.png`;

test('wipeDataDir empties the folder but keeps config.json and logs', () => {
  const d = tmp();
  for (const f of ['city.json', 'jobs.json', 'token', 'devices.json', 'cities.json', 'config.json', 'server.log', 'server.pid', 'transcripts/p/a/threads.json', 'uploads/x.png', 'sessions/p/a/s.jsonl']) put(join(d, f));
  const r = wipeDataDir(d);
  expect(readdirSync(d).sort()).toEqual(['config.json', 'server.log', 'server.pid']);
  expect(r.removed).toContain('token');
  expect(r.removed).toContain('transcripts');
  expect(r.failed).toEqual([]);
});

test('removeHouseHistory deletes that house’s chats and sessions only (jobs’ copies of files stay)', () => {
  const d = tmp();
  for (const f of ['transcripts/todo/assistant/t-1.json', 'transcripts/todo/jobs/j1/assistant/t-2.json', 'sessions/todo/assistant/a.jsonl', 'transcripts/other/assistant/t-3.json', 'worktrees/todo/j1/file.txt']) put(join(d, f));
  const gone = removeHouseHistory(d, 'todo');
  expect(gone).toHaveLength(2);
  expect(existsSync(join(d, 'transcripts', 'todo'))).toBe(false);
  expect(existsSync(join(d, 'sessions', 'todo'))).toBe(false);
  expect(existsSync(join(d, 'transcripts', 'other', 'assistant', 't-3.json'))).toBe(true);
  expect(existsSync(join(d, 'worktrees', 'todo', 'j1', 'file.txt'))).toBe(true);
});

test('pruneUploads drops pictures no chat names, keeps referenced and recent ones', () => {
  const d = tmp();
  const now = Date.now();
  const old = (now - UPLOAD_GRACE_MS - 60_000) / 1000;
  for (const c of ['a', 'b', 'c']) {
    put(join(d, 'uploads', PIC(c)));
    utimesSync(join(d, 'uploads', PIC(c)), old, old);
  }
  put(join(d, 'uploads', PIC('d'))); // fresh: may sit in an unsent draft
  put(join(d, 'transcripts', 'p', 'r', 't-1.json'), JSON.stringify({ items: [{ kind: 'user', images: [{ id: PIC('a') }] }] }));
  expect(pruneUploads(d, now)).toBe(2);
  expect(readdirSync(join(d, 'uploads')).sort()).toEqual([PIC('a'), PIC('d')]);
});

describe('house artifacts', () => {
  test('.rlt and run checkpoints go; branches, files and job bases (runs scope) stay', async () => {
    const repo = tmp();
    const git = (...args: string[]) => exec(['git', '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { cwd: repo });
    await git('init', '-q', '-b', 'main');
    put(join(repo, 'README.md'), 'hi');
    await git('add', '.');
    await git('commit', '-qm', 'init');
    await git('update-ref', 'refs/rlt/checkpoints/run-1', 'HEAD');
    await git('update-ref', 'refs/rlt/jobs/p/j/base', 'HEAD');
    put(join(repo, '.rlt', 'runs', 'r1', 'task.md'), 'task');
    await removeHouseArtifacts({ path: repo, isGit: true }, 'runs');
    const refs = (await git('for-each-ref', '--format=%(refname)')).stdout;
    expect(refs).not.toContain('refs/rlt/checkpoints/');
    expect(refs).toContain('refs/rlt/jobs/p/j/base');
    expect(refs).toContain('refs/heads/main');
    expect(existsSync(join(repo, '.rlt'))).toBe(false);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('hi');
    await removeHouseArtifacts({ path: repo, isGit: true }, 'all');
    expect((await git('for-each-ref', '--format=%(refname)', 'refs/rlt/')).stdout.trim()).toBe('');
  });

  test('a missing folder is fine', async () => {
    await removeHouseArtifacts({ path: join(tmp(), 'gone'), isGit: true });
  });
});

describe('ThreadBook.remove', () => {
  test('deletes the chat’s transcript, its omp session and its helpers’ sessions; refuses the current chat', () => {
    const base = tmp();
    const transcriptDir = join(base, 'transcripts', 'p', 'assistant');
    const sessionDir = join(base, 'sessions', 'p', 'assistant');
    const lists: unknown[] = [];
    const book = new ThreadBook((_id, threads) => lists.push(threads));
    book.attach({ agentId: 'p:assistant', transcriptDir, sessionDir });
    const first = book.current('p:assistant')!;
    book.observe('p:assistant', [{ kind: 'user', id: 'u1', text: 'hello there', ts: 1 } as never]);
    put(join(sessionDir, 'one.jsonl'), '{}');
    put(join(sessionDir, 'one', 'helper.jsonl'), '{}');
    book.noteSession('p:assistant', join(sessionDir, 'one.jsonl'));
    book.flushAll();
    expect(existsSync(join(transcriptDir, `${first.id}.json`))).toBe(true);

    expect(() => book.remove('p:assistant', first.id)).toThrow(/current/);
    const { thread: second } = book.create('p:assistant');
    expect(second.id).not.toBe(first.id);
    expect(book.remove('p:assistant', first.id)).toBe(true);
    expect(existsSync(join(transcriptDir, `${first.id}.json`))).toBe(false);
    expect(existsSync(join(sessionDir, 'one.jsonl'))).toBe(false);
    expect(existsSync(join(sessionDir, 'one'))).toBe(false);
    expect(book.list('p:assistant').map((t) => t.id)).toEqual([second.id]);
    const index = JSON.parse(readFileSync(join(transcriptDir, 'threads.json'), 'utf8')) as { threads: { id: string }[] };
    expect(index.threads.map((t) => t.id)).not.toContain(first.id);
    expect(book.remove('p:assistant', first.id)).toBe(false);
  });
});

describe('POST /api/data/wipe', () => {
  function route() {
    const dataDir = tmp();
    put(join(dataDir, 'token'), 'secret-token-value');
    put(join(dataDir, 'config.json'), '{}');
    let restarted: (() => Promise<void>) | null = null;
    let spawned = 0;
    const handle = createDataRoutes({
      cfg: { dataDir, allowedOrigins: [] },
      city: { get: () => ({ lots: [], projects: [] }) },
      restart: (after) => {
        restarted = after;
      },
      spawnFresh: () => spawned++,
    });
    const call = (body: unknown, headers: Record<string, string> = {}) => {
      const r = new Request('http://127.0.0.1:4860/api/data/wipe', { method: 'POST', headers: { host: '127.0.0.1:4860', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return handle(r, new URL(r.url))!;
    };
    return { dataDir, call, handle, restartedFn: () => restarted, spawned: () => spawned };
  }

  test('needs the typed confirmation and our own origin', async () => {
    const r = route();
    expect((await r.call({ confirm: 'yes' })).status).toBe(400);
    expect((await r.call({ confirm: WIPE_CONFIRM_TEXT }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(r.handle(new Request('http://127.0.0.1:4860/api/other'), new URL('http://127.0.0.1:4860/api/other'))).toBeNull();
  });

  test('answers first, then restarts: data deleted (config kept) and a fresh server started', async () => {
    const r = route();
    const res = await r.call({ confirm: 'Delete Everything' }, { origin: 'http://127.0.0.1:4860' });
    expect(res.status).toBe(202);
    await Bun.sleep(400);
    const after = r.restartedFn();
    expect(after).not.toBeNull();
    await after!();
    expect(readdirSync(r.dataDir)).toEqual(['config.json']);
    expect(r.spawned()).toBe(1);
  });
});
