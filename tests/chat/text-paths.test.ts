// Files are easier to open (finding #49): a path an agent writes in plain text ("I updated chapters/prologue.md")
// becomes a link to the viewer like a path in backticks already did — only inside the house, only for real file
// names with a folder in them. Run: bun test tests/chat/text-paths.test.ts
import { describe, expect, test } from 'bun:test';
import { resolvePath, type RootChoice } from '../../web/src/ui/file-paths';

// markdown.ts reaches the page's address through dom.ts (net/base.ts, read once on load): lend it one for the import
const g = globalThis as { location?: unknown };
const lent = g.location === undefined;
if (lent) g.location = new URL('http://cast.local/');
const { renderMarkdown } = await import('../../web/src/ui/markdown');
if (lent) delete g.location;

const roots: RootChoice[] = [{ root: '/home/me/novel', folder: { projectId: 'moonlight-novel' } }];
const ctx = { resolve: (raw: string) => resolvePath(raw, roots), srcNow: () => null };
const links = (html: string) => [...html.matchAll(/data-file="([^"]*)"/g)].map((m) => m[1]);

describe('plain-text paths in replies', () => {
  test('a path with a folder becomes a viewer link; the sentence around it stays as written', () => {
    const html = renderMarkdown('I updated chapters/prologue.md and src/app.ts:12. Done.', ctx);
    expect(links(html)).toEqual(['chapters/prologue.md', 'src/app.ts']); // the line number stays in the text
    expect(html).toContain('>src/app.ts:12</a>');
    expect(html).toContain('class="md-file md-textpath"');
    expect(html).toContain('. Done.');
  });

  test('words with slashes that are not files, and paths outside the house, stay plain', () => {
    const html = renderMarkdown('Use and/or the client/server split; see /etc/passwd and ../other/notes.md', ctx);
    expect(links(html)).toEqual([]);
  });

  test('Thai text right next to a path, and markup in the text, are kept (escaped)', () => {
    const html = renderMarkdown('แก้ไฟล์chapters/one.mdแล้ว <b>ok</b> & more', ctx);
    expect(links(html)).toEqual(['chapters/one.md']);
    expect(html).toContain('แก้ไฟล์');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp; more');
  });

  test('no files context (a chat without a folder): no links at all', () => {
    expect(links(renderMarkdown('see chapters/prologue.md', null))).toEqual([]);
  });

  test('paths inside a link text or code keep their own handling', () => {
    const html = renderMarkdown('[the notes/a.md file](https://example.com) and `docs/b.md`', ctx);
    expect(links(html)).toEqual(['docs/b.md']);
  });
});
