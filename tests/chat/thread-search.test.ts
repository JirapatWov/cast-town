// Searching chats (finding #44): the chat menu searches a person's chats — titles and what was said, old chats
// included (server: ThreadBook.search over the transcripts on disk) — and "Find in this chat" also finds what sits
// in folded tool cards. Run: bun test tests/chat/thread-search.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptItem } from '../../shared/protocol';
import { searchItems, snippetAt } from '../../server/agents/thread-search';
import { ThreadBook } from '../../server/agents/thread-store';
import { parseClientMsg } from '../../server/validate';
import { foldedMatches } from '../../web/src/ui/find-text';

const user = (id: string, text: string, ts = 1): TranscriptItem => ({ kind: 'user', id, text, ts });
const reply = (id: string, text: string, ts = 2): TranscriptItem => ({ kind: 'assistant', id, text, ts });
const tool = (id: string, title: string, result: string, args?: unknown): TranscriptItem => ({ kind: 'tool', id, tool: 'bash', title, result, args, status: 'done', ts: 3 });

describe('searchItems', () => {
  test('counts matches in messages and tool output, case-insensitive; the snippet is from the first one', () => {
    const items = [user('u1', 'Why does the login fail?'), reply('a1', 'The LOGIN handler drops the cookie.'), tool('t1', 'run tests', '1 failing: login redirect')];
    const m = searchItems(items, 'login');
    expect(m.hits).toBe(3);
    expect(m.itemId).toBe('u1');
    expect(m.snippet.slice(m.at![0], m.at![1])).toBe('login');
  });

  test('a long text gets a short snippet around the match, whitespace folded', () => {
    const text = `${'x'.repeat(300)}\n\n  the   needle here ${'y'.repeat(300)}`;
    const s = snippetAt(text, text.indexOf('needle'), 6);
    expect(s.snippet.length).toBeLessThan(180);
    expect(s.snippet.startsWith('…')).toBe(true);
    expect(s.snippet.endsWith('…')).toBe(true);
    expect(s.snippet.slice(s.at[0], s.at[1])).toBe('needle');
    expect(s.snippet).toContain('the needle here');
  });

  test('nothing for an empty query or no match', () => {
    expect(searchItems([user('u', 'hello')], '  ').hits).toBe(0);
    expect(searchItems([user('u', 'hello')], 'bye').hits).toBe(0);
  });
});

describe('ThreadBook.search', () => {
  function bookWithChats() {
    const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'threads-'));
    const dir = join(root, 'tx');
    mkdirSync(dir, { recursive: true });
    const old = 't-old00001';
    const mid = 't-mid00001';
    const cur = 't-cur00001';
    writeFileSync(
      join(dir, 'threads.json'),
      JSON.stringify({
        version: 1,
        current: cur,
        threads: [
          { id: old, title: 'Set up the database', createdAt: 1, updatedAt: 10, messages: 2 },
          { id: mid, title: 'Fix the login redirect', createdAt: 2, updatedAt: 20, messages: 2 },
          { id: cur, title: 'Release notes', createdAt: 3, updatedAt: 30, messages: 2 },
        ],
      }),
    );
    writeFileSync(join(dir, `${old}.json`), JSON.stringify({ version: 1, items: [user('o1', 'Use Postgres for the database'), reply('o2', 'Decided: Postgres 16, and the login table gets an index.')] }));
    writeFileSync(join(dir, `${mid}.json`), JSON.stringify({ version: 1, items: [user('m1', 'Login redirects to a 404'), reply('m2', 'Fixed the route.')] }));
    writeFileSync(join(dir, `${cur}.json`), JSON.stringify({ version: 1, items: [user('c1', 'Write release notes'), reply('c2', 'Done.')] }));
    const book = new ThreadBook(() => {});
    book.attach({ agentId: 'p:assistant', transcriptDir: dir, sessionDir: join(root, 'sess') });
    return { book, old, mid, cur };
  }

  test('finds a decision in an old chat by what was said, not only by title', () => {
    const { book, old } = bookWithChats();
    const r = book.search('p:assistant', 'postgres 16');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ threadId: old, title: 'Set up the database', hits: 1, current: false, itemId: 'o2' });
    expect(r[0].snippet).toContain('Postgres 16');
  });

  test('title matches first, then the newest', () => {
    const { book, old, mid } = bookWithChats();
    const r = book.search('p:assistant', 'login');
    expect(r.map((x) => x.threadId)).toEqual([mid, old]);
  });

  test('the current chat is searched as it is in memory (not yet saved)', () => {
    const { book, cur } = bookWithChats();
    book.observe('p:assistant', [user('c1', 'Write release notes'), reply('c2', 'Done.'), user('c3', 'Mention the dark mode toggle')]);
    const r = book.search('p:assistant', 'dark mode');
    expect(r[0]).toMatchObject({ threadId: cur, current: true, hits: 1 });
  });

  test('unknown person or empty query: nothing', () => {
    const { book } = bookWithChats();
    expect(book.search('nobody', 'login')).toEqual([]);
    expect(book.search('p:assistant', ' ')).toEqual([]);
  });

  test('the server accepts search_threads with a query of sane length', () => {
    const ok = (m: unknown) => parseClientMsg(JSON.stringify(m)).ok;
    expect(ok({ t: 'search_threads', reqId: 'r', agentId: 'p:assistant', query: 'login' })).toBe(true);
    expect(ok({ t: 'search_threads', reqId: 'r', agentId: 'p:assistant', query: '' })).toBe(false);
    expect(ok({ t: 'search_threads', reqId: 'r', agentId: 'p:assistant', query: 'x'.repeat(201) })).toBe(false);
  });
});

describe('find in this chat', () => {
  test('matches that only sit in a folded tool card (input/output) or a reply’s thinking are found, to be unfolded', () => {
    const items: TranscriptItem[] = [
      user('u', 'run the tests'),
      tool('t1', 'bun test', 'FAIL tests/login.test.ts'),
      tool('t2', 'read file', 'ok', { path: 'src/login.ts' }),
      tool('t3', 'list', 'nothing here'),
      { kind: 'assistant', id: 'a', text: 'Done', thinking: 'The login test is flaky', ts: 4 },
    ];
    expect(foldedMatches(items, 'LOGIN')).toEqual({ tools: ['t1', 't2'], thinking: ['a'] });
    expect(foldedMatches(items, '')).toEqual({ tools: [], thinking: [] });
  });
});
