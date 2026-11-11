// #27: the providers status reads the same in the top bar and in the More menu (a phone's top bar has no room for the
// providers button, so its state comes along under "Models and providers"). Never a green "0 live"; with no AI account
// connected it asks to connect one ("Connect AI").
import { describe, expect, test } from 'bun:test';
import type { ModelInfo, ProviderStatus } from '../../shared/protocol';
import { modelStatus, noneConnected, providersStatus } from '../../web/src/ui/model-state';
import { sentenceStart } from '../../web/src/ui/format';

const prov = (connected: boolean, id = 'anthropic'): ProviderStatus => ({ id, connected }) as unknown as ProviderStatus;
const model = (vendor: string, available: boolean): ModelInfo => ({ id: `${vendor}/m`, vendor, available }) as unknown as ModelInfo;
const none = { providers: [prov(false)], models: [model('anthropic', false)] };
const live = { providers: [prov(true), prov(true, 'openrouter'), prov(false, 'openai')], models: [] };

describe('#27 providers status', () => {
  test('nothing connected: an amber "Connect AI" that says nobody can work yet, and the menu says so too', () => {
    expect(providersStatus('ok', none)).toMatchObject({ tone: 'none', label: 'Connect AI', hint: 'Not connected yet' });
    expect(providersStatus('ok', none).aria).toContain('No AI account connected');
    expect(providersStatus('ok', none).aria).toContain('nobody can work yet');
    expect(providersStatus('ok', { providers: [], models: [] })).toMatchObject({ tone: 'none', label: 'Connect AI' });
  });
  test('connected: green with the count, in both places', () => {
    expect(providersStatus('ok', live)).toMatchObject({ tone: 'live', label: '2 live', hint: '2 connected' });
  });
  test('agent missing, the first check, a failed check: each says so, whatever the model list says', () => {
    for (const s of [none, live]) {
      expect(providersStatus('omp-missing', s)).toMatchObject({ tone: 'warn', label: 'No agent', hint: 'Agent not built' });
      expect(providersStatus('checking', s)).toMatchObject({ tone: 'checking', label: 'Checking…', hint: 'Checking…' });
      expect(providersStatus('check-failed', s)).toMatchObject({ tone: 'warn', label: 'Check failed', hint: 'Couldn’t check' });
      expect(providersStatus('check-failed', s).aria).toContain('nobody can work until a check works');
    }
  });
  test('every state has a label, an aria label that says where it leads, and a menu hint; never "demo"', () => {
    for (const h of ['ok', 'checking', 'omp-missing', 'check-failed'] as const) {
      for (const s of [none, live]) {
        const st = providersStatus(h, s);
        expect(st.label.length).toBeGreaterThan(0);
        expect(st.hint.length).toBeGreaterThan(0);
        expect(st.aria).toContain('Models & providers');
        expect(st.tone === 'live').toBe(h === 'ok' && s === live);
        expect(['live', 'none', 'warn', 'checking']).toContain(st.tone);
        expect(`${st.label} ${st.aria} ${st.hint}`).not.toMatch(/\bdemo\b/i);
      }
    }
  });
  test('modelStatus / noneConnected: connected providers are counted, else nothing works', () => {
    expect(modelStatus(none)).toMatchObject({ tone: 'none', label: 'Connect AI' });
    expect(modelStatus(live)).toMatchObject({ tone: 'live', label: '2 live' });
    expect(noneConnected(none)).toBe(true);
    expect(noneConnected(live)).toBe(false);
    // a provider outside the cards: its available models count by vendor
    expect(noneConnected({ providers: [prov(false)], models: [model('openai', true)] })).toBe(false);
    expect(modelStatus({ providers: [prov(false)], models: [model('openai', true)] })).toMatchObject({ tone: 'live', label: '1 live' });
  });
});

describe('the failed-check notice in Models & providers', () => {
  test('a reason starts the sentence with a capital, but a command keeps its lower-case name', () => {
    expect(sentenceStart("the agent didn't answer within 8 s (the computer may be busy)")).toBe("The agent didn't answer within 8 s (the computer may be busy)");
    expect(sentenceStart('cast-agent models exited with code 2')).toBe('cast-agent models exited with code 2');
    expect(sentenceStart('omp models exited with code 2')).toBe('omp models exited with code 2'); // an older server in another city
    expect(sentenceStart('couldn’t run the agent (EPERM)')).toBe('Couldn’t run the agent (EPERM)');
    expect(sentenceStart('')).toBe('');
  });
});
