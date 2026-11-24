// Uploading into a folder from the Files viewer (POST FOLDER_UPLOAD_PATH → server/folder-upload.ts → files.ts upload):
// it lands in the house folder or the job's own copy, and is refused exactly where the viewer refuses to show — dot
// segments, a symlink leading out, CAST's data folder or one like it, secret-looking names — never writes over a
// folder or a link, asks before replacing a file (409 'exists', then replace=1), has no size cap, leaves no temp file, and
// tells the town once per burst. Signed-in and same-origin are the server's job: tests/security/server.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOLDER_UPLOAD_PATH, type ServerMsg } from '../../shared/protocol';
import { createFileViewer } from '../../server/files';
import { createFolderUpload, type FolderUploadRoute } from '../../server/folder-upload';

const root = mkdtempSync(join(tmpdir(), 'cast-folder-up-'));
const house = join(root, 'house');
const copy = join(root, 'data', 'worktrees', 'p1', 'j1'); // a job's own copy lives in the data folder
const dataDir = join(root, 'data');
const outside = join(root, 'outside');
const sent: ServerMsg[] = [];
let route: FolderUploadRoute;

beforeAll(() => {
  for (const d of [house, copy, outside, join(house, 'docs'), join(house, '.git'), join(house, 'backup')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dataDir, 'token'), 'secret');
  writeFileSync(join(dataDir, 'city.json'), '{}');
  writeFileSync(join(house, 'backup', 'token'), 'old'); // a copy of a CAST data folder inside the house
  writeFileSync(join(house, 'backup', 'city.json'), '{}');
  writeFileSync(join(house, 'docs', 'old.txt'), 'old');
  mkdirSync(join(house, 'docs', 'taken'));
  symlinkSync(outside, join(house, 'out'));
  symlinkSync(join(outside, 'x.txt'), join(house, 'docs', 'link.txt'));
  symlinkSync(dataDir, join(house, 'data-link'));
  const city = { project: (id: string) => (id === 'p1' ? { id: 'p1', name: 'notes', path: house } : undefined) };
  const jobs = { get: (p: string, j: string) => (p === 'p1' && j === 'j1' ? { id: 'j1', name: 'Docs', worktree: { path: copy } } : p === 'p1' && j === 'main' ? { id: 'main', name: 'Main' } : undefined) };
  const files = createFileViewer({ dataDir, city: city as never, jobs: jobs as never, token: 't', ompAgentDir: join(root, 'agent') });
  route = createFolderUpload({
    files,
    city: city as never,
    jobs: jobs as never,
    broadcast: (m) => void sent.push(m),
    gitSummary: async (projectId, jobId) => ({ projectId, ...(jobId ? { jobId } : {}), isGit: true, branch: 'main', ahead: 0, behind: 0, dirty: 1, files: [] }) as never,
    quietMs: 30,
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function up(q: Record<string, string>, body: BodyInit = 'hello', headers: Record<string, string> = {}) {
  const url = new URL(`http://127.0.0.1:1${FOLDER_UPLOAD_PATH}?${new URLSearchParams({ projectId: 'p1', dir: '', ...q })}`);
  return route.handle(new Request(url, { method: 'POST', body, headers }), url);
}
const errorOf = async (res: Response) => (await res.json()) as { error: string; code?: string };
/** No hidden temp file left in a folder after an upload, whatever its outcome. */
const noTemp = (dir: string) => expect(readdirSync(dir).filter((n) => n.startsWith('.cast-upload-'))).toEqual([]);

describe('where it lands', () => {
  test('the house folder: a normal file (0644), its FileEntry answered', async () => {
    const res = await up({ name: 'brief.md', dir: 'docs' }, '# Brief\n');
    expect(res.status).toBe(200);
    const entry = (await res.json()) as { name: string; isDir: boolean; size: number; dir: string; replaced: boolean };
    expect(entry).toMatchObject({ name: 'brief.md', isDir: false, size: 8, dir: 'docs', replaced: false });
    expect(readFileSync(join(house, 'docs', 'brief.md'), 'utf8')).toBe('# Brief\n');
    expect(statSync(join(house, 'docs', 'brief.md')).mode & 0o777).toBe(0o644);
    noTemp(join(house, 'docs'));
  });

  test('a job with its own copy: into the copy (inside the data folder), not the house', async () => {
    const res = await up({ name: 'in-copy.txt', jobId: 'j1' });
    expect(res.status).toBe(200);
    expect(existsSync(join(copy, 'in-copy.txt'))).toBe(true);
    expect(existsSync(join(house, 'in-copy.txt'))).toBe(false);
  });

  test('a job without a copy works in the house folder', async () => {
    expect((await up({ name: 'main-job.txt', jobId: 'main' })).status).toBe(200);
    expect(existsSync(join(house, 'main-job.txt'))).toBe(true);
  });

  test('a burst of uploads is one activity line, and the Changes tab is refreshed', async () => {
    mkdirSync(join(house, 'burst'));
    sent.length = 0;
    await up({ name: 'a1.txt', dir: 'burst' });
    await up({ name: 'a2.txt', dir: 'burst' });
    const mine = () => sent.filter((m) => m.t === 'toast' && m.text.includes('/burst'));
    // the line is written once uploads stop for quietMs (30 ms here): wait for it, not for a guessed time
    for (let i = 0; i < 400 && !mine().length; i++) await Bun.sleep(5);
    expect(mine()).toEqual([{ t: 'toast', level: 'success', text: '2 files uploaded to notes/burst', projectId: 'p1' }]);
    expect(sent.filter((m) => m.t === 'git').length).toBeGreaterThanOrEqual(2);
  });
});

describe('refused like the viewer refuses to show', () => {
  const cases: [string, Record<string, string>, number][] = [
    ['a dot segment in the folder', { dir: '.git', name: 'x.txt' }, 403],
    ['a hidden name', { name: '.env' }, 403],
    ['a name with a folder in it', { name: '../x.txt' }, 400],
    ['a backslash', { name: '..\\x.txt' }, 400],
    ['a parent folder', { dir: 'docs/..', name: 'x.txt' }, 400],
    ['a symlinked folder leading out', { dir: 'out', name: 'x.txt' }, 403],
    ['a link into CAST’s data folder', { dir: 'data-link', name: 'x.txt' }, 403],
    ['a folder that looks like a CAST data folder', { dir: 'backup', name: 'x.txt' }, 403],
    ['a secret-looking name', { name: 'id_rsa' }, 403],
    ['a key file', { dir: 'docs', name: 'server.pem' }, 403],
    ['a missing folder', { dir: 'nope', name: 'x.txt' }, 404],
    ['an unknown house', { projectId: 'p9', name: 'x.txt' }, 404],
  ];
  for (const [what, q, status] of cases) {
    test(what, async () => {
      const res = await up(q);
      expect(res.status).toBe(status);
      expect((await errorOf(res)).error.length).toBeGreaterThan(5);
    });
  }
  test('nothing was written anywhere it shouldn’t', () => {
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(dataDir).sort()).toEqual(['city.json', 'token', 'worktrees']);
    expect(existsSync(join(house, '.git', 'x.txt'))).toBe(false);
    expect(existsSync(join(root, 'x.txt'))).toBe(false);
    noTemp(house);
  });
});

describe('a name that is taken', () => {
  test('a file: 409 without replace, then replaced with replace=1', async () => {
    const first = await up({ dir: 'docs', name: 'old.txt' }, 'new');
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toMatchObject({ code: 'exists' });
    expect(readFileSync(join(house, 'docs', 'old.txt'), 'utf8')).toBe('old');
    const again = await up({ dir: 'docs', name: 'old.txt', replace: '1' }, 'new');
    expect(again.status).toBe(200);
    expect(((await again.json()) as { replaced: boolean }).replaced).toBe(true);
    expect(readFileSync(join(house, 'docs', 'old.txt'), 'utf8')).toBe('new');
    noTemp(join(house, 'docs'));
  });

  test('a folder is never replaced, not even with replace=1', async () => {
    for (const replace of ['0', '1']) {
      const res = await up({ dir: 'docs', name: 'taken', replace });
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe('folder');
    }
    expect(statSync(join(house, 'docs', 'taken')).isDirectory()).toBe(true);
  });

  test('a symlink at the name is never followed or replaced', async () => {
    const res = await up({ dir: 'docs', name: 'link.txt', replace: '1' }, 'through the link');
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('special');
    expect(lstatSync(join(house, 'docs', 'link.txt')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
  });
});

describe('size', () => {
  test('no cap: a streamed file past the old 50 MB limit lands whole, and leaves no temp file', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(3);
    const chunks = 60;
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n === chunks) return c.close();
        n++;
        c.enqueue(chunk);
      },
    });
    const url = new URL(`http://127.0.0.1:1${FOLDER_UPLOAD_PATH}?projectId=p1&dir=&name=big.bin`);
    const res = await route.handle(new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit), url);
    expect(res.status).toBe(200);
    expect(statSync(join(house, 'big.bin')).size).toBe(chunks * chunk.length);
    noTemp(house);
    rmSync(join(house, 'big.bin'));
  });

  test('only POST', async () => {
    const url = new URL(`http://127.0.0.1:1${FOLDER_UPLOAD_PATH}?projectId=p1&name=x`);
    expect((await route.handle(new Request(url), url)).status).toBe(405);
  });
});
