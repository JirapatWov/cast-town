// A chat message with attached files, through the real agent system (fake omp processes): the model's message is the
// text plus the files' absolute paths, the chat keeps the text as typed with the FileRefs, an id that is gone is
// refused with "attach it again", and a message taken back (× on its queue chip, Stop) comes back with its files.
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FILE_UPLOAD_PATH, type FileRef, type TranscriptItem } from '../../shared/protocol';
import { createUploads, fileUploadsDir } from '../../server/uploads';
import { cleanup, makeSys, type SysWorld } from './sys-world';

afterAll(cleanup);

async function attach(w: SysWorld, name: string, body: string): Promise<FileRef> {
  const url = new URL(`http://127.0.0.1:1${FILE_UPLOAD_PATH}?name=${encodeURIComponent(name)}`);
  const res = await createUploads({ dataDir: join(w.root, 'data') }).handle(new Request(url, { method: 'POST', body }), url);
  return (await res.json()) as FileRef;
}

const userItems = (w: SysWorld) => w.sys.store.transcript(w.lead).filter((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user');

describe('a message with attached files', () => {
  test('the model gets the paths; the chat keeps the text and the FileRefs', async () => {
    const w = makeSys();
    const pdf = await attach(w, 'report.pdf', '%PDF-1.4 fake');
    const csv = await attach(w, 'data.csv', 'a,b\n1,2\n');
    const ack = await w.handle({ t: 'prompt', agentId: w.lead, text: 'What do these say?', files: [pdf.id, csv.id] });
    expect(ack && 'ok' in ack ? ack.ok : true).toBe(true);
    const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
    await w.until(() => lp.prompts.length === 1, 2000, 'lead prompt');
    const sent = lp.prompts[0]!.message;
    const dir = fileUploadsDir(join(w.root, 'data'));
    expect(sent.startsWith('What do these say?\n\n<cast-attachments>')).toBe(true);
    expect(sent).toContain(`- ${join(dir, pdf.id)} (report.pdf, `);
    expect(sent).toContain(`- ${join(dir, csv.id)} (data.csv, 8 bytes)`);
    const bubble = await w.until(() => userItems(w).at(-1), 2000, 'bubble');
    expect(bubble.text).toBe('What do these say?'); // the listing the model saw is not part of the bubble
    expect(bubble.files).toEqual([pdf, csv]);
    await w.dispose();
  });

  test('files alone (no text) are a message too', async () => {
    const w = makeSys();
    const f = await attach(w, 'notes.md', '# hi');
    await w.handle({ t: 'prompt', agentId: w.lead, text: '', files: [f.id] });
    const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
    await w.until(() => lp.prompts.length === 1, 2000, 'lead prompt');
    expect(lp.prompts[0]!.message.startsWith('<cast-attachments>')).toBe(true);
    expect((await w.until(() => userItems(w).at(-1), 2000, 'bubble')).files).toEqual([f]);
    await w.dispose();
  });

  test('an id whose file is gone is refused: attach it again', async () => {
    const w = makeSys();
    const ack = (await w.handle({ t: 'prompt', agentId: w.lead, text: 'look', files: [`${'f'.repeat(64)}/missing.pdf`] })) as { ok?: boolean; error?: string; text?: string };
    const why = ack.error ?? ack.text ?? '';
    expect(why).toContain('attach it again');
    expect(w.procs.get(w.lead)?.prompts.length ?? 0).toBe(0);
    await w.dispose();
  });
});

describe('a message taken back keeps its files', () => {
  test('× on the queue chip: omp is asked with the text it got; the draft is the typed text plus the files', async () => {
    const w = makeSys();
    await w.handle({ t: 'prompt', agentId: w.lead, text: 'first' });
    const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
    await w.until(() => lp.prompts.length === 1, 2000, 'lead prompt');
    const f = await attach(w, 'later.txt', 'later');
    await w.handle({ t: 'prompt', agentId: w.lead, text: 'and this', files: [f.id] });
    await w.until(() => lp.prompts.length === 2, 2000, 'second prompt');
    const chip = await w.until(() => w.sys.store.get(w.lead)?.queue?.[0], 2000, 'queue chip');
    expect(chip.text).toBe('and this');
    expect(chip.files).toBe(1);
    const asked: string[] = [];
    const call = lp.call.bind(lp);
    lp.call = (async (cmd: { type: string; message?: string }) => {
      if (cmd.type === 'remove_queued_message') {
        asked.push(cmd.message ?? '');
        return { removed: cmd.message === lp.prompts[1]!.message };
      }
      return call(cmd);
    }) as typeof lp.call;
    const ack = (await w.handle({ t: 'queue_action', agentId: w.lead, key: chip.key, action: 'remove' })) as { ok: boolean; data: { text: string; files?: FileRef[] } };
    expect(ack.ok).toBe(true);
    expect(asked[0]).toContain('<cast-attachments>');
    expect(ack.data.text).toBe('and this');
    expect(ack.data.files).toEqual([f]);
    await w.dispose();
  });

  test('Stop: the queued messages come back with their files', async () => {
    const w = makeSys();
    await w.handle({ t: 'prompt', agentId: w.lead, text: 'first' });
    const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
    await w.until(() => lp.prompts.length === 1, 2000, 'lead prompt');
    const f = await attach(w, 'queued.csv', 'x,y');
    await w.handle({ t: 'prompt', agentId: w.lead, text: 'queued one', files: [f.id] });
    await w.until(() => lp.prompts.length === 2, 2000, 'second prompt');
    const call = lp.call.bind(lp);
    lp.call = (async (cmd: { type: string }) => {
      const r = await call(cmd);
      return cmd.type === 'abort_and_restore_queue' ? { followUp: [{ text: lp.prompts[1]!.message }] } : r;
    }) as typeof lp.call;
    const ack = (await w.handle({ t: 'abort', agentId: w.lead })) as { ok: boolean; data: { restored: { text: string; files?: FileRef[] }[] } };
    expect(ack.data.restored).toEqual([{ text: 'queued one', images: [], files: [f] } as never]);
    await w.dispose();
  });
});
