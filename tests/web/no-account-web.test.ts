// With no AI account connected nobody can work, and the page says so instead of pretending: the lock on a person
// (blockOpts: lifted only on the scripted test model or while the first check runs), the town's "connect first" ask
// (needsAccount), the boot screen's foot line, the people's name tags (people/tag-state.ts), model menus, chips and
// the chat box. Pure modules, plus source checks where the copy is built into the DOM. Run: bun test <this file>
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentsHealth, ModelInfo, ProviderStatus, ServerMsg } from '../../shared/protocol';
import { setTagModels, tagNotConnected } from '../../web/src/people/tag-state';
import { blockOpts, bootFootText, needsAccount } from '../../web/src/ui/agents-health';
import { agentBlocked } from '../../web/src/ui/format';
import { vendorStateText } from '../../web/src/ui/model-chip';

type Hello = Extract<ServerMsg, { t: 'hello' }>;
const OPUS = 'anthropic/claude-opus-5-5';
const SOL = 'openai/gpt-6.1-sol';
const M = (id: string, available: boolean): ModelInfo => ({ id, label: id, vendor: id.split('/')[0], available }) as ModelInfo;
const prov = (connected: boolean, id = 'anthropic'): ProviderStatus => ({ id, connected }) as unknown as ProviderStatus;
const health = (models: AgentsHealth['models'], omp: AgentsHealth['omp'] = 'ok'): AgentsHealth => ({ omp, ompPath: '/usr/local/bin/omp', models, checking: models === 'checking' });
const hello = (o: { agents?: AgentsHealth; demoMode?: boolean; ompVersion?: string | null } = {}): Hello => ({ t: 'hello', demoMode: false, ompVersion: '18.13.2', ...o }) as unknown as Hello;
const none = [M(OPUS, false), M(SOL, false)];
const some = [M(OPUS, false), M(SOL, true)];
const src = (f: string) => readFileSync(join(import.meta.dir, '../../web/src', f), 'utf8');

describe('blockOpts: what lifts the lock on a person whose model isn’t connected', () => {
  test('nothing in production once the check is done: nobody works without an account', () => {
    const o = blockOpts(hello({ agents: health('ok') }));
    expect(o).toEqual({ scripted: false, checking: false });
    expect(agentBlocked({ model: OPUS }, none, o)).toBe(true);
    expect(agentBlocked({ model: SOL }, some, o)).toBe(false);
  });
  test('the first account check still runs: not locked yet (the server holds a message until it is done)', () => {
    const o = blockOpts(hello({ agents: health('checking') }));
    expect(o).toEqual({ scripted: false, checking: true });
    expect(agentBlocked({ model: OPUS }, none, o)).toBe(false);
  });
  test('a failed check, or omp missing: locked (nothing counts as connected)', () => {
    expect(agentBlocked({ model: OPUS }, none, blockOpts(hello({ agents: health('failed') })))).toBe(true);
    expect(agentBlocked({ model: OPUS }, none, blockOpts(hello({ agents: health('checking', 'missing') })))).toBe(true);
  });
  test('the scripted test model (CAST_MOCK_LLM: hello.demoMode) plays every model: not locked', () => {
    const o = blockOpts(hello({ demoMode: true, agents: health('ok') }));
    expect(o.scripted).toBe(true);
    expect(agentBlocked({ model: OPUS }, none, o)).toBe(false);
  });
  test('no hello yet (or an older server without health): locked by the model list alone', () => {
    expect(blockOpts(null)).toEqual({ scripted: false, checking: false });
    expect(blockOpts(hello())).toEqual({ scripted: false, checking: false });
  });
  test('the server’s word wins over the list (it knows every connected model; the list shows only some); helpers are never locked', () => {
    const o = blockOpts(hello({ agents: health('ok') }));
    const ROUTE = 'openai-codex/gpt-6.1-sol'; // a ChatGPT sign-in's route: connected, but past the list's cap
    expect(agentBlocked({ model: ROUTE, notConnected: false }, some, o)).toBe(false);
    expect(agentBlocked({ model: SOL, notConnected: true }, some, o)).toBe(true);
    expect(agentBlocked({ model: ROUTE }, some, o)).toBe(true); // an older server: the list decides
    expect(agentBlocked({ model: ROUTE, kind: 'subagent' }, some, o)).toBe(false);
    expect(agentBlocked({ model: OPUS, notConnected: true }, none, blockOpts(hello({ agents: health('checking') })))).toBe(false);
  });
});

describe('needsAccount: the town asks to connect an AI account first', () => {
  test('the check worked and nothing is connected', () => {
    expect(needsAccount({ hello: hello({ agents: health('ok') }), providers: [prov(false)], models: none })).toBe(true);
    expect(needsAccount({ hello: hello({ agents: health('stale') }), providers: [], models: [] })).toBe(true);
    expect(needsAccount({ hello: null, providers: [], models: [] })).toBe(true);
  });
  test('not once something is connected', () => {
    expect(needsAccount({ hello: hello({ agents: health('ok') }), providers: [prov(true)], models: none })).toBe(false);
    expect(needsAccount({ hello: hello({ agents: health('ok') }), providers: [], models: some })).toBe(false);
  });
  test('not while omp is missing or a check runs or failed: those say so themselves', () => {
    for (const h of [health('checking'), health('failed'), health('ok', 'missing')]) {
      expect(needsAccount({ hello: hello({ agents: h }), providers: [], models: [] })).toBe(false);
    }
  });
});

describe('where the town asks to connect one', () => {
  test('the Board’s first card, the 2D list’s first item and the Place a project dialog', () => {
    expect(src('ui/focus-view.ts')).toMatch(/if \(needsAccount\(s\)\) \{\s*cards\.unshift\(/);
    expect(src('ui/focus-view.ts')).toContain("h('span', { class: 'muted small' }, 'Nobody can work until one is connected')");
    expect(src('ui/main-view.ts')).toContain("icon('key', 15), h('span', null, 'Connect an AI account')");
    expect(src('ui/placement.ts')).toContain("'No AI account yet — connect one first so the lead uses it.'");
  });
});

describe('the boot screen’s foot line', () => {
  test('says when no AI account is connected, once the page knows the accounts', () => {
    const h = hello({ agents: health('ok') });
    expect(bootFootText(h, { providers: [prov(false)], models: none })).toBe('cast-agent 18.13.2 · no AI account connected yet');
    expect(bootFootText(h, { providers: [prov(true)], models: [] })).toBe('cast-agent 18.13.2 · AI accounts connected');
    expect(bootFootText(h)).toBe('cast-agent 18.13.2'); // before the snapshot: nothing said about the accounts
  });
  test('the check running, failed, or the agent missing', () => {
    expect(bootFootText(hello({ agents: health('checking') }), { providers: [], models: [] })).toBe('cast-agent 18.13.2 · checking AI accounts…');
    expect(bootFootText(hello({ agents: health('failed') }), { providers: [], models: [] })).toBe('cast-agent 18.13.2 · couldn’t check AI accounts');
    expect(bootFootText(hello({ ompVersion: null, agents: health('ok', 'missing') }))).toBe('cast-agent not built · build the agent to start');
  });
  test('never mentions a demo or a mock', () => {
    for (const h of [health('ok'), health('checking'), health('failed'), health('ok', 'missing')]) {
      for (const models of [undefined, { providers: [], models: [] }]) expect(bootFootText(hello({ agents: h }), models)).not.toMatch(/demo|mock/i);
    }
  });
});

describe('name tags: "not connected" on people whose model has no account', () => {
  test('a list of the models that work marks the others; null marks nobody', () => {
    expect(setTagModels([SOL])).toBe(true);
    expect(tagNotConnected({ model: OPUS })).toBe(true);
    expect(tagNotConnected({ model: SOL })).toBe(false);
    // the server's word wins (a connected route past the list's cap; a model it won't start); helpers never
    expect(tagNotConnected({ model: 'openai-codex/gpt-6.1-sol', notConnected: false })).toBe(false);
    expect(tagNotConnected({ model: SOL, notConnected: true })).toBe(true);
    expect(tagNotConnected({ model: OPUS, kind: 'subagent' })).toBe(false);
    expect(setTagModels([SOL])).toBe(false); // unchanged: no re-sync
    expect(setTagModels([])).toBe(true); // nothing connected: everyone is marked
    expect(tagNotConnected({ model: SOL })).toBe(true);
    expect(setTagModels(null)).toBe(true); // the first check runs, or the scripted test model
    expect(tagNotConnected({ model: OPUS })).toBe(false);
    expect(tagNotConnected({ model: OPUS, notConnected: true })).toBe(false);
    expect(setTagModels([OPUS, SOL])).toBe(true);
    expect(setTagModels([SOL, OPUS])).toBe(false); // the same set
    setTagModels(null);
  });
  test('main.ts feeds the tags from the same reading as the chat lock', () => {
    const main = src('main.ts');
    expect(main).toContain('return o.scripted || o.checking ? null : s.models.filter((m) => m.available).map((m) => m.id);');
    expect(src('people/tag.ts')).toContain("chip.textContent = 'not connected';");
  });
});

describe('model menus and chips with nothing connected', () => {
  test('a vendor’s section says only "not connected" — never that it runs as anything else', () => {
    expect(vendorStateText(true)).toBe('');
    expect(vendorStateText(false)).toBe(' · not connected');
  });
  test('the model picker lets any model be picked and says people work once an account is connected', () => {
    const picker = src('ui/model-picker.ts');
    expect(picker).toContain("'No AI account connected yet — you can pick a model now; people can work once you connect one. '");
    expect(picker).toContain("'Connect an AI account…'");
    expect(picker).toContain('disabled: live && !m.available,');
  });
  test('the "not connected" chip says what to do in either case', () => {
    const w = src('ui/widgets.ts');
    expect(w).toContain("'No AI account connected yet — connect one under Models & providers'");
    expect(w).toContain("'Nobody is signed in to this model’s provider — sign in under Models & providers, or pick another model'");
    expect(w).not.toContain('demoChip');
  });
});

describe('the chat box with no AI account', () => {
  const chat = src('ui/chat-tab.ts');
  test('locked, with why and where to connect one', () => {
    expect(chat).toContain("placeholder: 'Connect an AI account to start…'");
    expect(chat).toContain("'No AI account is connected'");
    expect(chat).toContain("'Nobody can work until CAST has an AI account — connect one in '");
  });
  test('a failed check: locked until a check works', () => {
    expect(chat).toContain("placeholder: 'Waiting for a check of your AI accounts…'");
    expect(chat).toContain("'CAST couldn’t check your AI accounts'");
  });
  test('the empty chat offers to connect an account instead of things to say that can’t be sent', () => {
    expect(chat).toContain("none ? 'Connect an AI account' : 'Models & providers'");
    expect(chat).toContain('const tips = blocked ? [] : chatSuggestions(a, workKindOf({ jobKind: job?.kind }));');
  });
  test('the empty chat of a locked person promises no work: they work once what is missing is there', () => {
    expect(chat).toContain('`They work on ${where} once ${until}.`');
    for (const until of ["'the agent is built'", "'a check of your AI accounts works'", "'an AI account is connected'", '`${a.modelLabel} is connected — or pick another model`']) expect(chat).toContain(until);
    expect(chat).toContain("const none = st === 'ok' && !anyConnected(store.state.models);"); // a failed check doesn't ask to connect one
  });
  test('the lock reads the server’s own reading (agentBlocked with blockOpts), not a per-person demo flag', () => {
    expect(chat).toContain('return agentBlocked(a, store.state.models, blockOpts(store.state.hello));');
    expect(chat).not.toMatch(/a\.demo\b|spendText|spendTitle/);
  });
});
