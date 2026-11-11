// The chat side of resilience, on a real AgentSystemImpl with fake omp processes (tests/rv-server/sys-world.ts):
//  #43 Stop while omp is still starting calls the start off at once (message back to the composer);
//  #25/#30 a start that fails: a plain line with Details, the message "Not sent" (no count, no title), Retry;
//  #22 a restart keeps what was in flight and says so in the chat ("Run again", "Not sent");
//  #6  a message waits for the very first AI-account check instead of refusing a signed-in user, a failed first check
//      refuses it in plain words (nobody works on a model that isn't connected), and a missing omp is said with the fix.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRegistry } from '../../server/agents/models.ts';
import { OmpHealth } from '../../server/agents/omp-health.ts';
import { OmpStartTimeout } from '../../server/agents/omp-process.ts';
import { AGENT_BUILD_COMMAND } from '../../shared/omp-version.ts';
import type { TranscriptItem } from '../../shared/protocol.ts';
import { cleanup, makeSys, sleep } from '../rv-server/sys-world';
import { cleanupTmp, fakeOmp, tmp } from './fake-omp';

afterAll(() => {
  cleanup();
  cleanupTmp();
});

const items = (w: ReturnType<typeof makeSys>, id: string): TranscriptItem[] => w.sys.store.transcript(id);
// sys-world hands back this request's ack, or else the last toast; the real server acks ok:true itself after a
// handler returns, so "no ack of its own" is a success
const send = async (w: ReturnType<typeof makeSys>, msg: Record<string, unknown>) => {
  const r = (await w.handle(msg)) as { t: string; ok?: boolean; error?: string; data?: unknown } | undefined;
  return r?.t === 'ack' ? (r as { ok: boolean; error?: string; data?: unknown }) : { ok: true };
};
const users = (w: ReturnType<typeof makeSys>, id: string) => items(w, id).filter((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user');

describe('Stop while omp starts (#43)', () => {
  test('the start is called off at once: idle, no bubble, the message back for the composer', async () => {
    const w = makeSys();
    let boot!: () => void;
    w.bootGate.set(w.lead, new Promise<void>((r) => (boot = r)));
    const sending = send(w, { t: 'prompt', agentId: w.lead, text: 'explain this project' });
    await w.until(() => w.sys.pool.isStarting(w.lead), 2000, 'booting');
    expect(w.sys.store.get(w.lead)?.status).toBe('starting');
    expect(users(w, w.lead).map((u) => u.text)).toEqual(['explain this project']);

    const t0 = Date.now();
    const stop = (await w.handle({ t: 'abort', agentId: w.lead })) as { ok: boolean; data: { restored: { text: string }[] } };
    expect(Date.now() - t0).toBeLessThan(500); // not after the boot
    expect(stop.ok).toBe(true);
    expect(stop.data.restored.map((r) => r.text)).toEqual(['explain this project']);
    expect(w.sys.store.get(w.lead)?.status).toBe('offline');
    expect(users(w, w.lead)).toEqual([]);
    expect(items(w, w.lead).some((i) => i.kind === 'system' && i.text === 'Stopped.')).toBe(true);
    const ack = await sending;
    expect(ack.ok).toBe(true); // called off, not an error…
    expect(ack.data).toEqual({ calledOff: true }); // …and the composer is told to keep the words
    boot();
    await sleep(50);
    expect(w.history.filter((p) => p.agentId === w.lead).flatMap((p) => p.prompts)).toEqual([]);
    await w.dispose();
  });
});

describe('a start that fails (#25, #30)', () => {
  test('plain line + Details, the message "Not sent", one status for person and job', async () => {
    const w = makeSys();
    w.bootFail.set(w.lead, new OmpStartTimeout(47, true, 'Still starting after 40s — phase: x\n  logs: /root/.omp/logs/omp.log'));
    const ack = (await w.handle({ t: 'prompt', agentId: w.lead, text: 'add a health endpoint' })) as { ok: boolean; error?: string };
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('Assistant took too long to start (over 47 s). The computer may be busy — try again.');
    const err = items(w, w.lead).find((i) => i.kind === 'system' && i.level === 'error') as Extract<TranscriptItem, { kind: 'system' }>;
    expect(err.text).toBe(ack.error!);
    expect(err.details).toContain('/root/.omp/logs/omp.log');
    expect(err.details).toContain('CAST_AGENT_START_TIMEOUT');
    const [bubble] = users(w, w.lead);
    expect(bubble!.notSent).toBe(true);
    const a = w.sys.store.get(w.lead)!;
    expect(a.status).toBe('error');
    expect(a.detail).toBe('Couldn’t start');
    // a message that never went counts as none and doesn't name the chat
    const thread = w.sys.threads.list(w.lead).find((t) => t.current)!;
    expect(thread.messages).toBe(0);
    expect(thread.title).toBe('New chat');
    await w.dispose();
  });

  test('Retry (the same message again) replaces the "Not sent" copy', async () => {
    const w = makeSys();
    w.bootFail.set(w.lead, new Error('The agent exited (code 1). stderr: boom'));
    await w.handle({ t: 'prompt', agentId: w.lead, text: 'add a health endpoint' });
    expect(users(w, w.lead).map((u) => [u.text, !!u.notSent])).toEqual([['add a health endpoint', true]]);
    const ack = await send(w, { t: 'prompt', agentId: w.lead, text: 'add a health endpoint' });
    expect(ack.ok).toBe(true);
    expect(users(w, w.lead).map((u) => [u.text, !!u.notSent])).toEqual([['add a health endpoint', false]]);
    await w.dispose();
  });
});

describe('a restart (#22)', () => {
  test('the turn in progress gets "Run again", unread messages are "Not sent", the person shows it', async () => {
    const w1 = makeSys();
    await w1.handle({ t: 'prompt', agentId: w1.lead, text: 'add a GET /health endpoint' });
    const lp = await w1.until(() => w1.procs.get(w1.lead), 2000, 'lead proc');
    // omp hands the message to the model (its user message_start): the turn works on it
    lp.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'add a GET /health endpoint' }] } });
    lp.emit({ type: 'agent_start' });
    // a second message while it works: queued in omp
    await w1.handle({ t: 'prompt', agentId: w1.lead, text: 'and write a test for it' });
    expect(w1.sys.store.get(w1.lead)?.queue?.map((q) => q.text)).toEqual(['and write a test for it']);
    await sleep(250); // the journal is written (coalesced)
    const file = join(w1.root, 'data', 'in-flight.json');
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.people[w1.lead].turn.text).toBe('add a GET /health endpoint');
    expect(saved.people[w1.lead].waiting.map((m: { text: string }) => m.text)).toEqual(['and write a test for it']);

    await w1.sys.shutdown(); // stopping omp must not wipe what was in flight

    const w2 = makeSys({ root: w1.root });
    const list = items(w2, w2.lead);
    const run = list.find((i) => i.kind === 'system' && !!i.resend) as Extract<TranscriptItem, { kind: 'system' }>;
    expect(run.text).toBe('Interrupted: CAST restarted before Assistant finished this.');
    expect(run.resend).toEqual({ text: 'add a GET /health endpoint' });
    const unsent = users(w2, w2.lead).filter((u) => u.notSent).map((u) => u.text);
    expect(unsent).toEqual(['and write a test for it']);
    expect(list.some((i) => i.kind === 'system' && i.text.startsWith('CAST restarted before Assistant read your message'))).toBe(true);
    const a = w2.sys.store.get(w2.lead)!;
    expect(a.interrupted).toBeGreaterThan(0);
    expect(a.detail).toBe('Interrupted by a restart');
    expect(existsSync(file)).toBe(false); // reported once

    // Run again: the message goes out again, the button has done its job, the person is back to normal
    const ack = await send(w2, { t: 'prompt', agentId: w2.lead, text: 'add a GET /health endpoint' });
    expect(ack.ok).toBe(true);
    expect(items(w2, w2.lead).some((i) => i.kind === 'system' && !!i.resend)).toBe(false);
    expect(w2.sys.store.get(w2.lead)?.interrupted).toBeUndefined();
    await w2.dispose();
  });

  test('nothing in flight → nothing marked', async () => {
    const w1 = makeSys();
    await w1.sys.shutdown();
    const w2 = makeSys({ root: w1.root });
    expect(items(w2, w2.lead).filter((i) => i.kind === 'system')).toEqual([]);
    expect(w2.sys.store.get(w2.lead)?.interrupted).toBeUndefined();
    await w2.dispose();
  });

  test('a run CAST stopped says it was interrupted (not stopped by the user)', async () => {
    const w1 = makeSys();
    w1.member = () => 'hold';
    const tab = (await w1.handle({ t: 'run_workflow', projectId: w1.projectId, jobId: 'main', workflowId: 'decode-implement-review', task: 'tidy up' })) as { ok: boolean; data: { runId: string } };
    await w1.until(() => w1.procs.get(w1.agentOf('decoder'))?.prompts[0], 2000, 'decoder works');
    await w1.sys.shutdown();
    expect(w1.sys.engine.get(tab.data.runId)?.interrupted).toBe(true);
    expect(w1.sys.engine.get(tab.data.runId)?.status).toBe('aborted');
  });
});

describe('AI accounts and omp (#6)', () => {
  test('a message waits for the first account check, then runs on the real model it found', async () => {
    const dir = tmp();
    const omp = fakeOmp(dir, 'signedin', { models: [{ provider: 'anthropic', id: 'claude-opus-5-5' }], modelsDelay: 0.4 });
    const models = new ModelRegistry(omp.bin, { HOME: dir, PATH: process.env.PATH });
    const w = makeSys({ models });
    void models.detect(); // the server's first look, still running
    const sending = w.handle({ t: 'prompt', agentId: w.lead, text: 'hi' });
    await sleep(100);
    expect(w.sys.store.get(w.lead)?.detail).toBe('Checking AI accounts…');
    expect(w.specs).toEqual([]); // omp not started yet: nothing is connected until the check ends
    await sending;
    expect(w.specs[0]?.demo).toBe(false);
    expect(w.specs[0]?.model).toBe('anthropic/claude-opus-5-5');
    await w.dispose();
  });

  test('a failed first check: the message is refused with why (nobody works until a check works), omp never starts', async () => {
    const dir = tmp();
    const omp = fakeOmp(dir, 'broken', { modelsExit: 1 });
    const models = new ModelRegistry(omp.bin, { HOME: dir, PATH: process.env.PATH });
    await models.detect();
    expect(models.state).toBe('failed');
    const w = makeSys({ models });
    expect(w.sys.demoMode()).toBe(false);
    const ack = await send(w, { t: 'prompt', agentId: w.lead, text: 'hi' });
    expect(ack.ok).toBe(false);
    expect(ack.error).toStartWith(`CAST couldn't check your AI accounts (${models.detectError}) — it tries again by itself; press Refresh under Models & providers.`);
    expect(ack.error).toEndWith('can work once a check works.');
    await sleep(50);
    expect(w.specs).toEqual([]);
    expect(w.sys.snapshot().agents.every((a) => !a.demo)).toBe(true);
    await w.dispose();
  });

  test('omp missing: the message is refused with where CAST looked and how to install it', async () => {
    const dir = tmp();
    const models = new ModelRegistry('/nonexistent/omp', { HOME: dir });
    const health = new OmpHealth({ bin: '/nonexistent/omp', env: { HOME: dir }, models, timeouts: { checkMs: 2000, startMs: 45_000 }, onChange: () => {}, missingRetryMs: 60_000 });
    await health.start();
    const w = makeSys({ models, health });
    const ack = (await w.handle({ t: 'prompt', agentId: w.lead, text: 'hi' })) as { ok: boolean; error: string };
    expect(ack.ok).toBe(false);
    expect(ack.error).toContain("wasn't found at /nonexistent/omp");
    expect(ack.error).toContain(AGENT_BUILD_COMMAND);
    expect(w.sys.health()?.omp).toBe('missing');
    health.dispose();
    await w.dispose();
  });
});
