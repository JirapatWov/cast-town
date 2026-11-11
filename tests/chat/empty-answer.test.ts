// F5: an agent stuck on "returned an empty response". omp re-sends the identical request (up to 10 times) and then gives
// up with "Retry budget exhausted after 10 retries: Cloud Code Assist API returned an empty response". CAST shows one
// plain-words card from the 2nd empty answer (not after omp's 10), updated in place, with "Switch model…" and
// "Send “continue”" (rendered by the client from `stuck`). The frames below are omp's rpc frames as recorded from a
// Gemini 4 Argon / Antigravity session (texts from omp's google-gemini-cli.ts and turn-recovery.ts), fed to a real
// AgentSystemImpl with a fake omp process (tests/rv-server/sys-world.ts). No provider is called.
import { afterAll, describe, expect, test } from 'bun:test';
import { EmptyStreak, errorKey, retriesOf, stuckKind, stuckText } from '../../server/agents/empty-answer.ts';
import type { TranscriptItem } from '../../shared/protocol.ts';
import { cleanup, makeSys, sleep, type FakeProc } from '../rv-server/sys-world';

afterAll(cleanup);

const EMPTY = 'Cloud Code Assist API returned an empty response';
const EXHAUSTED = `Retry budget exhausted after 10 retries: ${EMPTY}`;
type System = Extract<TranscriptItem, { kind: 'system' }>;
const systems = (w: ReturnType<typeof makeSys>, id: string) => w.sys.store.transcript(id).filter((i): i is System => i.kind === 'system');

/** One failed attempt as omp reports it: an assistant message with nothing in it that ended in an error. */
function failedAttempt(p: FakeProc, n: number, message = EMPTY) {
  p.emit({ type: 'message_start', messageId: `m${n}`, message: { role: 'assistant' } });
  p.emit({
    type: 'message_end',
    messageId: `m${n}`,
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: message, usage: { input: 41_000, output: 0 }, provider: 'google-antigravity', model: 'gemini-4-argon' },
  });
}
const retryNotice = (p: FakeProc, attempt: number, message = EMPTY) => p.emit({ type: 'auto_retry_start', attempt, maxAttempts: 10, delayMs: 2000, errorMessage: message });

async function leadTurn(w: ReturnType<typeof makeSys>, text = 'tighten chapter 3') {
  await w.handle({ t: 'prompt', agentId: w.lead, text });
  const p = await w.until(() => w.procs.get(w.lead), 2000, 'the lead’s omp');
  const id = await w.until(() => p.prompts.at(-1)?.id, 2000, 'the prompt');
  p.emit({ type: 'agent_start' });
  return { p, id };
}

describe('empty-answer.ts', () => {
  test('omp’s texts: empty answers, giving up, everything else', () => {
    expect(stuckKind(EMPTY)).toBe('empty');
    expect(stuckKind(EXHAUSTED)).toBe('empty');
    expect(stuckKind('Assistant returned no final output after retry cap; try switching models')).toBe('empty');
    expect(stuckKind('Google API returned an empty response (finishReason STOP with no content) after 3 attempts')).toBe('empty');
    expect(stuckKind('Retry budget exhausted after 10 retries: 503 Service Unavailable')).toBe('failing');
    expect(stuckKind('429 Too Many Requests')).toBeNull();
    expect(retriesOf(EXHAUSTED)).toBe(10);
    expect(errorKey(EXHAUSTED)).toBe(errorKey(EMPTY));
    expect(stuckText('empty', 'Gemini 4 Argon', EMPTY)).toBe(
      'Gemini 4 Argon sent back an empty answer several times in a row. This usually repeats for the same conversation — switch this agent to another model, or send a short message to nudge it.',
    );
  });

  test('the streak: identical empty answers on one model; another error, another model or real output start over', () => {
    const s = new EmptyStreak();
    expect(s.note(EMPTY, 'a')).toBe(1);
    expect(s.atLeast(EMPTY, 'a', 1)).toBe(1); // the retry notice of the same attempt: not counted twice
    expect(s.note(EMPTY, 'a')).toBe(2);
    expect(s.note(EXHAUSTED, 'a')).toBe(3); // omp's last one is the same error
    expect(s.note(EMPTY, 'b')).toBe(1); // another model
    expect(s.note('overloaded', 'b')).toBeNull();
    expect(s.count).toBe(0);
    expect(s.atLeast(EMPTY, 'b', 4)).toBe(4); // only the retry notices arrived
  });
});

describe('the card in the chat (F5)', () => {
  test('nothing after the 1st empty answer, the card after the 2nd, one card updated in place, no 10 red lines', async () => {
    const w = makeSys();
    const { p, id } = await leadTurn(w);

    failedAttempt(p, 1);
    retryNotice(p, 1);
    await sleep(20);
    expect(systems(w, w.lead).filter((s) => s.stuck)).toEqual([]);
    expect(w.sys.store.get(w.lead)?.detail).toBe('Empty answer — retrying (1/10)');

    failedAttempt(p, 2);
    const card = await w.until(() => systems(w, w.lead).find((s) => s.stuck), 2000, 'the card');
    expect(card.stuck).toMatchObject({ kind: 'empty', count: 2 });
    expect(card.stuck!.final).toBeUndefined();
    expect(card.level).toBe('warn');
    expect(card.text).toContain('sent back an empty answer several times in a row');
    expect(card.text).toContain('switch this agent to another model, or send a short message to nudge it');

    for (let n = 2; n <= 10; n++) {
      retryNotice(p, n);
      failedAttempt(p, n + 1, n === 10 ? EXHAUSTED : EMPTY);
    }
    p.emit({ type: 'auto_retry_end', success: false, attempt: 10, finalError: EMPTY });
    p.emit({ type: 'agent_end' });
    p.emit({ type: 'prompt_result', id, status: 'error', error: { message: EXHAUSTED, provider: 'google-antigravity', model: 'gemini-4-argon', retryable: true }, sessionSettled: true });
    await w.until(() => w.sys.store.get(w.lead)?.status === 'error', 2000, 'the error status');

    const cards = systems(w, w.lead).filter((s) => s.stuck);
    expect(cards.length).toBe(1); // updated in place
    expect(cards[0]!.stuck).toMatchObject({ kind: 'empty', count: 11, final: true });
    expect(cards[0]!.level).toBe('error');
    expect(cards[0]!.details).toBe(EXHAUSTED); // omp's words behind Details
    expect(systems(w, w.lead).filter((s) => s.level === 'error' && !s.stuck)).toEqual([]); // no line per attempt, no second line
    expect(w.sys.store.get(w.lead)?.detail).toBe('Empty answers — switch model?');
    expect(w.sent.some((m) => m.t === 'toast' && m.level === 'error' && m.text.includes('keeps sending back empty answers'))).toBe(true);
    await w.dispose();
  });

  test('after “continue”: one more empty answer shows a new card at once; a real answer ends the streak', async () => {
    const w = makeSys();
    const first = await leadTurn(w);
    failedAttempt(first.p, 1, EXHAUSTED);
    first.p.emit({ type: 'prompt_result', id: first.id, status: 'error', error: { message: EXHAUSTED }, sessionSettled: true });
    await w.until(() => systems(w, w.lead).some((s) => s.stuck?.final), 2000, 'the final card');

    const second = await leadTurn(w, 'continue');
    failedAttempt(second.p, 2);
    await w.until(() => systems(w, w.lead).filter((s) => s.stuck).length === 2, 2000, 'a second card at the end of the chat');
    expect(w.sys.store.transcript(w.lead).at(-1)).toMatchObject({ kind: 'system', stuck: { kind: 'empty' } });

    // the model answers after all: the next empty answer starts from 1 again (no card)
    second.p.emit({ type: 'message_start', messageId: 'ok', message: { role: 'assistant' } });
    second.p.emit({ type: 'message_end', messageId: 'ok', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } });
    const before = systems(w, w.lead).filter((s) => s.stuck).length;
    failedAttempt(second.p, 3);
    await sleep(30);
    expect(systems(w, w.lead).filter((s) => s.stuck).length).toBe(before);
    await w.dispose();
  });

  test('omp giving up on another error: the "kept failing" card with the reason; other errors stay plain lines', async () => {
    const w = makeSys();
    const { p, id } = await leadTurn(w);
    failedAttempt(p, 1, '503 Service Unavailable');
    await sleep(20);
    expect(systems(w, w.lead).some((s) => s.level === 'error' && s.text === '503 Service Unavailable' && !s.stuck)).toBe(true);
    p.emit({ type: 'prompt_result', id, status: 'error', error: { message: 'Retry budget exhausted after 3 retries: 503 Service Unavailable' }, sessionSettled: true });
    const card = await w.until(() => systems(w, w.lead).find((s) => s.stuck), 2000, 'the card');
    expect(card.stuck).toMatchObject({ kind: 'failing', count: 4, final: true });
    expect(card.text).toContain('failed several times in a row (503 Service Unavailable)');
    await w.dispose();
  });

  test('an expired sign-in in a chat turn says where it is fixed, omp’s words under Details', async () => {
    const w = makeSys();
    const { p, id } = await leadTurn(w);
    const raw = 'OAuth token refresh failed for provider anthropic: anthropic token refresh failed: 400 {"error":"invalid_grant"}';
    p.emit({ type: 'prompt_result', id, status: 'error', error: { message: raw }, sessionSettled: true });
    const line = await w.until(() => systems(w, w.lead).find((s) => s.level === 'error' && s.details === raw), 2000, 'the line');
    expect(line.text).toBe('The Anthropic sign-in expired — sign in again under Models & providers, then send the message again.');
    await w.dispose();
  });
});
