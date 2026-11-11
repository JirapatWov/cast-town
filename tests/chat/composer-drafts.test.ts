// Per-person drafts and the per-person send line behind the composer (web/src/ui/drafts.ts, send-queue.ts):
// text typed for one person never ends up with another, a failed send goes back to its own person, and messages
// typed while omp starts go out in order. Run: bun test tests/chat/composer-drafts.test.ts
import { describe, expect, test } from 'bun:test';
import { appendDraft, createDraftBook, DRAFT_TTL_MS, DRAFTS_KEY, MAX_DRAFTS, removeFromDraft, type DraftStorage } from '../../web/src/ui/drafts';
import { createSendQueue, type Outgoing } from '../../web/src/ui/send-queue';

function memStorage(seed: Record<string, string> = {}): DraftStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => void (data[k] = v),
    remove: (k) => void delete data[k],
  };
}

const IMG = (id: string) => ({ id, mimeType: 'image/png' });

describe('draft book', () => {
  test('each person keeps their own draft, across a reload of the page', () => {
    const st = memStorage();
    const a = createDraftBook(st, () => 1000);
    a.set('acme:assistant', { text: 'add a PATCH route', images: [] });
    a.set('todo:assistant', { text: 'explain this project', images: [IMG('u1')] });
    const b = createDraftBook(st, () => 2000); // a new page
    expect(b.get('acme:assistant')?.text).toBe('add a PATCH route');
    expect(b.get('todo:assistant')).toEqual({ text: 'explain this project', images: [IMG('u1')] });
    expect(b.get('todo:main:assistant')).toBeUndefined();
  });

  test('an emptied draft is dropped, and the key goes once nothing is left', () => {
    const st = memStorage();
    const book = createDraftBook(st);
    book.set('p:a', { text: 'hello', images: [] });
    book.set('p:a', { text: '   ', images: [] });
    expect(book.get('p:a')).toBeUndefined();
    expect(st.data[DRAFTS_KEY]).toBeUndefined();
  });

  test('old drafts expire and only the newest MAX_DRAFTS are kept', () => {
    let t = 0;
    const st = memStorage();
    const book = createDraftBook(st, () => t);
    for (let i = 0; i < MAX_DRAFTS + 5; i++) {
      t = 1000 + i;
      book.set(`p:${i}`, { text: `d${i}`, images: [] });
    }
    expect(book.ids().length).toBe(MAX_DRAFTS);
    expect(book.get('p:0')).toBeUndefined();
    expect(book.get(`p:${MAX_DRAFTS + 4}`)?.text).toBe(`d${MAX_DRAFTS + 4}`);
    const later = createDraftBook(st, () => t + DRAFT_TTL_MS + 1);
    expect(later.ids()).toEqual([]);
  });

  test('a broken storage entry never breaks the composer', () => {
    const book = createDraftBook(memStorage({ [DRAFTS_KEY]: '{not json' }));
    expect(book.get('x')).toBeUndefined();
    book.set('x', { text: 'ok', images: [{ id: 5 } as never, IMG('good')] });
    expect(book.get('x')).toEqual({ text: 'ok', images: [IMG('good')] });
  });
});

describe('putting a message back', () => {
  test('a failed message goes under what was typed meanwhile, images without duplicates', () => {
    const { draft, dropped } = appendDraft({ text: 'next thought', images: [IMG('a')] }, { text: 'the failed one', images: [IMG('a'), IMG('b')] }, 4);
    expect(draft).toEqual({ text: 'next thought\n\nthe failed one', images: [IMG('a'), IMG('b')] });
    expect(dropped).toBe(0);
    expect(appendDraft(undefined, { text: 'x', images: [IMG('1'), IMG('2')] }, 1)).toEqual({ draft: { text: 'x', images: [IMG('1')] }, dropped: 1 });
    // the same message coming back twice (a called-off send, then Stop's answer) is put in once
    const once = appendDraft({ text: 'draft', images: [] }, { text: 'hello', images: [IMG('a')] }, 4).draft;
    expect(appendDraft(once, { text: 'hello', images: [IMG('a')] }, 4)).toEqual({ draft: once, dropped: 0 });
    expect(appendDraft({ text: 'hello', images: [] }, { text: 'hello', images: [] }, 4).draft.text).toBe('hello');
  });

  test('a message that arrived after all comes back out — but never what the user wrote since', () => {
    const sent = { text: 'the failed one', images: [IMG('b')] };
    expect(removeFromDraft({ text: 'the failed one', images: [IMG('b')] }, sent)).toEqual({ text: '', images: [] });
    expect(removeFromDraft({ text: 'next thought\n\nthe failed one', images: [IMG('a'), IMG('b')] }, sent)).toEqual({ text: 'next thought', images: [IMG('a')] });
    expect(removeFromDraft({ text: 'the failed one, edited', images: [IMG('b')] }, sent)).toBeNull();
    expect(removeFromDraft({ text: 'the failed one', images: [] }, sent)).toBeNull(); // the image was removed by hand
  });
});

describe('send line', () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test('one message per person on the wire, in the order typed; other people are not held up', async () => {
    const wire: string[] = [];
    const calls = new Map<string, ReturnType<typeof deferred>>();
    const q = createSendQueue<string>(
      (to, msg) => {
        wire.push(`${to}:${msg}`);
        const d = deferred();
        calls.set(msg, d);
        return d.promise;
      },
      { onFail: () => {} },
    );
    q.push('A', 'first');
    q.push('A', 'second');
    q.push('B', 'other house');
    expect(wire).toEqual(['A:first', 'B:other house']);
    expect(q.pending('A').map((o) => [o.msg, o.sending])).toEqual([['first', true], ['second', false]]);
    calls.get('first')!.resolve();
    await tick();
    expect(wire).toEqual(['A:first', 'B:other house', 'A:second']);
    calls.get('second')!.resolve();
    calls.get('other house')!.resolve();
    await tick();
    expect(q.pending('A')).toEqual([]);
    expect(q.pending('B')).toEqual([]);
  });

  test('a failure brings back that message and everything typed after it for the same person, oldest first', async () => {
    const back: { to: string; msgs: string[]; err: string }[] = [];
    const calls = new Map<string, ReturnType<typeof deferred>>();
    const q = createSendQueue<string>(
      (_to, msg) => {
        const d = deferred();
        calls.set(msg, d);
        return d.promise;
      },
      { onFail: (to, failed: Outgoing<string>[], err) => back.push({ to, msgs: failed.map((f) => f.msg), err: String((err as Error).message) }) },
    );
    q.push('A', 'one');
    q.push('A', 'two');
    q.push('A', 'three');
    q.push('B', 'elsewhere');
    calls.get('one')!.reject(new Error('omp could not start'));
    await tick();
    expect(back).toEqual([{ to: 'A', msgs: ['one', 'two', 'three'], err: 'omp could not start' }]);
    expect(calls.has('two')).toBe(false); // never sent after the failure
    expect(q.pending('A')).toEqual([]);
    expect(q.pending('B').map((o) => o.msg)).toEqual(['elsewhere']);
  });

  test('a waiting message can be taken back; the one on the wire cannot', async () => {
    const d = deferred();
    const q = createSendQueue<string>(() => d.promise, { onFail: () => {} });
    const first = q.push('A', 'one');
    const second = q.push('A', 'two');
    expect(q.cancel(first.key)).toBeUndefined();
    expect(q.cancel(second.key)?.msg).toBe('two');
    expect(q.pending('A').map((o) => o.msg)).toEqual(['one']);
  });

  test('a send function that throws synchronously still fails cleanly', async () => {
    const failed: string[] = [];
    const q = createSendQueue<string>(() => {
      throw new Error('boom');
    }, { onFail: (_to, f) => failed.push(...f.map((x) => x.msg)) });
    q.push('A', 'x');
    await tick();
    expect(failed).toEqual(['x']);
  });
});
