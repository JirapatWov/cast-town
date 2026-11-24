// Files attached to a chat message (server/uploads.ts, FILE_UPLOAD_PATH): kept once per content and name in the data
// folder, served back only as a download (never rendered on CAST's origin), names made safe, no size cap, the note
// the model gets, the prompt's validation, and pruning (a file no chat names goes after the grace period, its
// <sha256> folder with it). The prompt hand-off itself is in tests/rv-server/prompt-files.test.ts.
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_UPLOAD_PATH, fileUploadPath, MAX_PROMPT_FILES, type FileRef } from '../../shared/protocol';
import { pruneUploads, UPLOAD_GRACE_MS } from '../../server/data-wipe';
import { attachmentNote, createUploads, fileUploadsDir, readFileRef, safeFileName, stripAttachmentNote } from '../../server/uploads';
import { parseClientMsg } from '../../server/validate';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cast-files-'));
  roots.push(d);
  return d;
}

const BASE = 'http://127.0.0.1:1';
function post(dataDir: string, name: string, body: BodyInit, headers: Record<string, string> = {}) {
  const url = new URL(`${BASE}${FILE_UPLOAD_PATH}?name=${encodeURIComponent(name)}`);
  return createUploads({ dataDir }).handle(new Request(url, { method: 'POST', body, headers }), url);
}
function get(dataDir: string, path: string, method = 'GET') {
  const url = new URL(`${BASE}${path}`);
  return createUploads({ dataDir }).handle(new Request(url, { method }), url);
}

describe('storing and serving an attached file', () => {
  test('round trip: the original name, a download with nosniff and a sandboxed CSP, never inline', async () => {
    const d = tmp();
    const bytes = new TextEncoder().encode('name,score\nAda,3\n');
    const res = await post(d, 'scores 2026 (final).csv', bytes);
    expect(res.status).toBe(200);
    const ref = (await res.json()) as FileRef;
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(ref).toEqual({ id: `${sha}/scores 2026 (final).csv`, name: 'scores 2026 (final).csv', size: bytes.length, mimeType: 'text/csv' });
    // in the data folder, under its own id
    expect(existsSync(join(fileUploadsDir(d), sha, 'scores 2026 (final).csv'))).toBe(true);

    const back = await get(d, fileUploadPath(ref.id));
    expect(back.status).toBe(200);
    expect(await back.text()).toBe('name,score\nAda,3\n');
    expect(back.headers.get('content-type')).toBe('application/octet-stream');
    expect(back.headers.get('x-content-type-options')).toBe('nosniff');
    expect(back.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(back.headers.get('content-disposition')).toBe(`attachment; filename="scores 2026 (final).csv"; filename*=UTF-8''scores%202026%20%28final%29.csv`);
    expect((await get(d, fileUploadPath(ref.id), 'HEAD')).headers.get('content-length')).toBe(String(bytes.length));
  });

  test('an HTML file is still only a download; a Thai name keeps its exact bytes in filename*', async () => {
    const d = tmp();
    const ref = (await (await post(d, 'รายงาน.html', '<script>alert(1)</script>')).json()) as FileRef;
    expect(ref.name).toBe('รายงาน.html');
    const back = await get(d, fileUploadPath(ref.id));
    expect(back.headers.get('content-type')).toBe('application/octet-stream');
    expect(back.headers.get('content-disposition')).toBe(`attachment; filename="______.html"; filename*=UTF-8''${encodeURIComponent('รายงาน.html')}`);
  });

  test('the same bytes under the same name are kept once', async () => {
    const d = tmp();
    const a = (await (await post(d, 'a.txt', 'same')).json()) as FileRef;
    const b = (await (await post(d, 'a.txt', 'same')).json()) as FileRef;
    expect(a.id).toBe(b.id);
    const sha = a.id.split('/')[0]!;
    expect(readdirSync(join(fileUploadsDir(d), sha))).toEqual(['a.txt']);
    expect(readdirSync(fileUploadsDir(d)).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  test('unknown, malformed or escaping ids are 404', async () => {
    const d = tmp();
    const ref = (await (await post(d, 'x.txt', 'x')).json()) as FileRef;
    const sha = ref.id.split('/')[0]!;
    for (const path of [`${FILE_UPLOAD_PATH}/${'0'.repeat(64)}/x.txt`, `${FILE_UPLOAD_PATH}/${sha}/y.txt`, `${FILE_UPLOAD_PATH}/${sha}/%2e%2e%2fsecret`, `${FILE_UPLOAD_PATH}/${sha}/.env`, `${FILE_UPLOAD_PATH}/zz/x.txt`]) {
      expect((await get(d, path)).status).toBe(404);
    }
    expect(readFileRef(d, `${sha}/../../token`)).toBeNull();
  });

  test('no size cap: a streamed body past the old 50 MB limit is kept whole, with no temp file left', async () => {
    const d = tmp();
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    const chunks = 60;
    const hash = createHash('sha256');
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent === chunks) return c.close();
        sent++;
        hash.update(chunk);
        c.enqueue(chunk);
      },
    });
    const url = new URL(`${BASE}${FILE_UPLOAD_PATH}?name=big.bin`);
    const res = await createUploads({ dataDir: d }).handle(new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit), url);
    expect(res.status).toBe(200);
    const ref = (await res.json()) as FileRef;
    expect(ref.size).toBe(chunks * chunk.length);
    expect(ref.id).toBe(`${hash.digest('hex')}/big.bin`);
    expect(readdirSync(fileUploadsDir(d))).toEqual([ref.id.split('/')[0]]); // no .tmp- left beside it
  });

  test('a POST without a name is refused', async () => {
    expect((await post(tmp(), '', 'x')).status).toBe(400);
  });
});

describe('names', () => {
  test('one segment, no control or direction characters, never hidden, bounded, extension kept', () => {
    expect(safeFileName('../x')).toBe('x');
    expect(safeFileName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(safeFileName('/etc/passwd')).toBe('passwd');
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('a\u0000b\nc\u0007.txt')).toBe('abc.txt');
    expect(safeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe'); // no right-to-left trick
    const long = safeFileName(`${'ก'.repeat(300)}.pdf`);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
  });

  test('a POSTed "../.env" is kept as "env" inside the data folder', async () => {
    const d = tmp();
    const ref = (await (await post(d, '../.env', 'A=1')).json()) as FileRef;
    expect(ref.name).toBe('env');
    expect(readFileRef(d, ref.id)?.path).toBe(join(fileUploadsDir(d), ref.id.split('/')[0]!, 'env'));
  });
});

describe('what the model gets', () => {
  const ref = (name: string, size: number): FileRef => ({ id: `${'a'.repeat(64)}/${name}`, name, size, mimeType: 'application/pdf' });
  test('the text, then each file’s absolute path, name and size, and how to read them', () => {
    const note = attachmentNote('Summarise this', [
      { ref: ref('report.pdf', 1_300_000), path: '/data/uploads/files/aaa/report.pdf' },
      { ref: ref('notes.txt', 12), path: '/data/uploads/files/bbb/notes.txt' },
    ]);
    expect(note.startsWith('Summarise this\n\n<cast-attachments>\n')).toBe(true);
    expect(note).toContain('- /data/uploads/files/aaa/report.pdf (report.pdf, 1.2 MB)');
    expect(note).toContain('- /data/uploads/files/bbb/notes.txt (notes.txt, 12 bytes)');
    expect(note).toContain('read them with your tools');
    expect(stripAttachmentNote(note)).toBe('Summarise this');
    expect(attachmentNote('just text', [])).toBe('just text');
    expect(stripAttachmentNote('no note here')).toBe('no note here');
  });
});

describe('the prompt message', () => {
  const id = `${'b'.repeat(64)}/data.csv`;
  test('takes file ids; a malformed one says to attach it again', () => {
    const ok = parseClientMsg(JSON.stringify({ t: 'prompt', agentId: 'p:assistant', text: '', files: [id] }));
    expect(ok.ok).toBe(true);
    for (const bad of [`${'b'.repeat(64)}/../x`, `${'b'.repeat(64)}/.env`, 'nope', `${'b'.repeat(63)}/a.txt`]) {
      const r = parseClientMsg(JSON.stringify({ t: 'prompt', agentId: 'p:assistant', text: 'x', files: [bad] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('attach it again');
    }
    const many = parseClientMsg(JSON.stringify({ t: 'prompt', agentId: 'p:assistant', text: 'x', files: Array(MAX_PROMPT_FILES + 1).fill(id) }));
    expect(many.ok).toBe(false);
  });
});

describe('pruning', () => {
  test('keeps files a chat names and young ones; removes the rest after the grace period, with their empty folders', () => {
    const d = tmp();
    const now = Date.now();
    const old = (now - UPLOAD_GRACE_MS - 60_000) / 1000;
    const put = (sha: string, name: string, age: 'old' | 'new') => {
      const dir = join(fileUploadsDir(d), sha);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), 'x');
      if (age === 'old') utimesSync(join(dir, name), old, old);
    };
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    const C = 'c'.repeat(64);
    put(A, 'kept "quoted".pdf', 'old'); // named in a chat (JSON-escaped there)
    put(A, 'other name.pdf', 'old'); // same bytes, a name no chat uses
    put(B, 'gone.zip', 'old');
    put(C, 'draft.csv', 'new'); // may sit in an unsent draft
    writeFileSync(join(fileUploadsDir(d), '.tmp-1-abc'), 'partial');
    utimesSync(join(fileUploadsDir(d), '.tmp-1-abc'), old, old);
    const item = { kind: 'user', text: 'see', files: [{ id: `${A}/kept "quoted".pdf`, name: 'kept "quoted".pdf', size: 1, mimeType: 'application/pdf' }] };
    mkdirSync(join(d, 'transcripts', 'p', 'r'), { recursive: true });
    writeFileSync(join(d, 'transcripts', 'p', 'r', 't-1.json'), JSON.stringify({ items: [item] }));

    expect(pruneUploads(d, now)).toBe(3); // other name.pdf, gone.zip, the stale temp file
    expect(readdirSync(join(fileUploadsDir(d), A))).toEqual(['kept "quoted".pdf']);
    expect(existsSync(join(fileUploadsDir(d), B))).toBe(false); // its folder went with its last file
    expect(readdirSync(join(fileUploadsDir(d), C))).toEqual(['draft.csv']);
  });
});
