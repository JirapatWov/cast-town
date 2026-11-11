// Approval cards for file edits show what the edit would change (finding #12): before, the card said only
// "File · README.md" and the user approved blind. CAST now works the change out from the tool call's arguments and
// the file on disk (server/agents/approval-preview.ts) and sends it as a unified diff with the card.
// Run: bun test tests/chat/approval-preview.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRequest, ServerMsg } from '../../shared/protocol';
import { approvalChange, MAX_DIFF_LINES } from '../../server/agents/approval-preview';
import { ApprovalBook } from '../../server/agents/approvals';
import { diffLines } from '../../server/agents/line-diff';

function house(files: Record<string, string>): string {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'preview-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

const README = ['# Todo API', '', 'A tiny API.', '', '## Install', '', 'bun install', '', '## Run', '', 'bun run dev', ''].join('\n');

/** The +/- lines of a diff, without headers. */
const changed = (diff: string) => diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));

describe('line diff', () => {
  test('one changed line in the middle of a file: one hunk with 3 lines of context and the right numbers', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const b = [...a];
    b[9] = 'line ten';
    const r = diffLines(a, b);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0].split('\n')[0]).toBe('@@ -7,7 +7,7 @@');
  });

  test('changes far apart become separate hunks', () => {
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const b = a.map((l, i) => (i === 2 || i === 35 ? `${l}!` : l));
    expect(diffLines(a, b).hunks).toHaveLength(2);
  });
});

describe('approvalChange', () => {
  test('write over an existing file: exactly the lines that change', () => {
    const dir = house({ 'README.md': README });
    const next = README.replace('A tiny API.', 'A tiny API.\n\n## Notes\n\nKeep it small.');
    const c = approvalChange('write', { path: 'README.md', content: next }, dir)!;
    expect(c.files).toEqual(['README.md']);
    expect(c.added).toBe(4);
    expect(c.removed).toBe(0);
    expect(c.approx).toBeUndefined();
    expect(c.diff).toContain('--- a/README.md');
    expect(changed(c.diff)).toEqual(['+## Notes', '+', '+Keep it small.', '+']);
  });

  test('write of a new file (absolute path inside the folder): all added, shown relative', () => {
    const dir = house({});
    const c = approvalChange('write', { path: join(dir, 'src/new.ts'), content: 'export const a = 1;\nexport const b = 2;\n' }, dir)!;
    expect(c.files).toEqual(['src/new.ts']);
    expect(c.added).toBe(2);
    expect(c.diff).toContain('new file mode');
    expect(c.diff).toContain('--- /dev/null');
  });

  test('replace edit: placed in the file, with its real line numbers', () => {
    const dir = house({ 'README.md': README });
    const c = approvalChange('edit', { path: 'README.md', old_string: 'bun run dev', new_string: 'bun run dev --port 3000' }, dir)!;
    expect(changed(c.diff)).toEqual(['-bun run dev', '+bun run dev --port 3000']);
    expect(c.diff).toMatch(/@@ -8,4 \+8,4 @@/);
    expect(c.approx).toBeUndefined();
  });

  test('replace edit whose text is not in the file (omp matches whitespace loosely): the snippet, marked approximate', () => {
    const dir = house({ 'README.md': README });
    const c = approvalChange('edit', { path: 'README.md', old_string: 'bun  install', new_string: 'bun install --frozen-lockfile' }, dir)!;
    expect(c.approx).toBe(true);
    expect(changed(c.diff)).toEqual(['-bun  install', '+bun install --frozen-lockfile']);
  });

  test('replacement text with $& is taken literally', () => {
    const dir = house({ 'a.txt': 'price\n' });
    const c = approvalChange('edit', { path: 'a.txt', old_string: 'price', new_string: '$& in $$' }, dir)!;
    expect(changed(c.diff)).toEqual(['-price', '+$& in $$']);
  });

  test('hashline (omp default): replace a range, insert after a line, append', () => {
    const dir = house({ 'README.md': README });
    const input = ['*** Begin Patch', '[README.md#1a2b]', 'PUT 3.=3:', '+A tiny, fast API.', 'PUT >7:', '+bun run build', 'PUT >$:', '+## License', '+', '+MIT', '*** End Patch'].join('\n');
    const c = approvalChange('edit', { input }, dir)!;
    expect(c.files).toEqual(['README.md']);
    expect(changed(c.diff)).toEqual(['-A tiny API.', '+A tiny, fast API.', '+bun run build', '+## License', '+', '+MIT']);
    expect(c.approx).toBeUndefined();
  });

  test('hashline CUT + paste moves lines; REM deletes a file; MV renames', () => {
    const dir = house({ 'a.txt': 'one\ntwo\nthree\n', 'old.txt': 'bye\n', 'b.txt': 'x\n' });
    const input = ['[a.txt#0001]', 'CUT 1.=1 @first', 'PUT >3 @first', '[old.txt#0002]', 'REM', '[b.txt#0003]', 'MV c.txt'].join('\n');
    const c = approvalChange('edit', { input }, dir)!;
    expect(c.files).toEqual(['a.txt', 'old.txt', 'b.txt → c.txt']);
    expect(c.diff).toContain('deleted file mode');
    expect(c.diff).toContain('rename to c.txt');
    const a = c.diff.split('diff --git').find((s) => s.includes('a/a.txt'))!;
    expect(changed(a)).toEqual(['-one', '+one']);
  });

  test('hashline block op (PUT N*:) is placed by a guess and marked approximate', () => {
    const dir = house({ 'x.ts': 'function a() {\n  return 1;\n}\n\nfunction b() {}\n' });
    const c = approvalChange('edit', { input: '[x.ts#beef]\nPUT 1*:\n+function a() {\n+  return 2;\n+}' }, dir)!;
    expect(c.approx).toBe(true);
    expect(changed(c.diff)).toEqual(['-  return 1;', '+  return 2;']);
  });

  test('hashline lines that are not there (stale numbers) still show what it writes, marked approximate', () => {
    const dir = house({ 'a.txt': 'one\n' });
    const c = approvalChange('edit', { input: '[a.txt#0001]\nPUT 40.=41:\n+forty' }, dir)!;
    expect(c.approx).toBe(true);
    expect(changed(c.diff)).toContain('+forty');
    expect(c.removed).toBe(2);
  });

  test('apply_patch: update with a context anchor, add, delete, move', () => {
    const dir = house({ 'src/app.py': 'import os\n\ndef greet():\n    print("Hi")\n\ngreet()\n', 'obsolete.txt': 'old\n' });
    const input = '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-    print("Hi")\n+    print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n';
    const c = approvalChange('edit', { input }, dir)!;
    expect(c.files).toEqual(['hello.txt', 'src/app.py → src/main.py', 'obsolete.txt']);
    expect(c.added).toBe(2);
    expect(c.removed).toBe(2);
    expect(c.approx).toBeUndefined();
    expect(c.diff).toMatch(/@@ -1,6 \+1,6 @@/);
  });

  test('patch mode: unified hunks applied to the file', () => {
    const dir = house({ 'README.md': README });
    const c = approvalChange('edit', { path: 'README.md', edits: [{ diff: '@@ -5,3 +5,3 @@\n ## Install\n \n-bun install\n+bun install --production' }] }, dir)!;
    expect(changed(c.diff)).toEqual(['-bun install', '+bun install --production']);
    expect(c.approx).toBeUndefined();
  });

  test('files outside the folder are never read — not by path, not through a symlink', () => {
    const outside = house({ 'secret.txt': 'TOP SECRET\nline 2\n' });
    const dir = house({});
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    for (const path of [join(outside, 'secret.txt'), '../' + outside.split('/').pop() + '/secret.txt', 'link.txt']) {
      const c = approvalChange('write', { path, content: 'new\n' }, dir)!;
      expect(c.diff).not.toContain('TOP SECRET');
      expect(c.approx).toBe(true);
      expect(changed(c.diff)).toEqual(['+new']);
    }
    // without a folder nothing is read at all
    const c = approvalChange('edit', { path: join(outside, 'secret.txt'), old_string: 'TOP SECRET', new_string: 'x' }, undefined)!;
    expect(c.approx).toBe(true);
  });

  test('a huge write is cut short and says so; counts stay whole', () => {
    const dir = house({});
    const content = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join('\n') + '\n';
    const c = approvalChange('write', { path: 'big.txt', content }, dir)!;
    expect(c.truncated).toBe(true);
    expect(c.added).toBe(5000);
    expect(changed(c.diff).length).toBeLessThanOrEqual(MAX_DIFF_LINES);
  });

  test('other tools get no preview', () => {
    expect(approvalChange('bash', { command: 'ls' }, '/tmp')).toBeUndefined();
    expect(approvalChange('edit', { input: 'nonsense' }, '/tmp')).toBeUndefined();
    expect(approvalChange('write', null, '/tmp')).toBeUndefined();
  });
});

describe('ApprovalBook: the card carries the change', () => {
  test('an "Allow tool: edit" dialog in Ask first mode is broadcast with the diff', () => {
    const dir = house({ 'README.md': README });
    const sent: ServerMsg[] = [];
    const added: ApprovalRequest[] = [];
    const book = new ApprovalBook(
      { broadcast: (m) => void sent.push(m), clients: () => [] },
      { added: (r) => void added.push(r), resolved: () => {} },
      () => ({ mode: 'ask', dir }),
    );
    const frame = { id: 'ui-1', method: 'select', title: 'Allow tool: edit\nFile: README.md', options: ['Approve', 'Deny'] };
    book.offer(frame, 'todo-api:assistant', 'todo-api', () => {}, { path: 'README.md', old_string: 'A tiny API.', new_string: 'A tiny API.\n\n## Notes' });
    const msg = sent.find((m): m is Extract<ServerMsg, { t: 'approval' }> => m.t === 'approval')!;
    expect(msg.approval.change).toMatchObject({ files: ['README.md'], added: 2, removed: 0 });
    expect(added[0].change?.diff).toContain('+## Notes');
  });
});
