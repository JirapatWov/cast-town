// A job's one-line status (the job switcher, the board's job rows, the palette): a lead who can't start — their model
// isn't connected, or no AI account is — never reads "Ready". Pure module (web/src/ui/jobs.ts jobStatus).
import { describe, expect, test } from 'bun:test';
import type { AgentInfo, AgentsHealth, Job, ModelInfo } from '../../shared/protocol';
import { jobStatus } from '../../web/src/ui/jobs';

const OPUS = 'anthropic/claude-opus-5-5';
const SOL = 'openai/gpt-6.1-sol';
const lead = (o: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id: 'p1:assistant', projectId: 'p1', jobId: 'main', kind: 'resident', name: 'Assistant', roleId: 'assistant', model: OPUS, modelLabel: 'Claude Opus 5.5', vendor: 'anthropic', demo: false, status: 'offline', activity: 'idle', tokens: { input: 0, output: 0 }, costUsd: 0, appearance: { seed: 1, gender: 'f' }, ...o }) as AgentInfo;
const M = (id: string, available: boolean) => ({ id, label: id, vendor: 'anthropic', available }) as ModelInfo;
const health = (models: AgentsHealth['models'], omp: AgentsHealth['omp'] = 'ok'): AgentsHealth => ({ omp, ompPath: '/usr/local/bin/omp', models, checking: models === 'checking' });
const job = { id: 'main', projectId: 'p1', name: 'Main', kind: 'general', room: { floor: 0, slot: 0 }, leadModel: OPUS } as unknown as Job;

function status(a: AgentInfo, models: ModelInfo[], o: { agents?: AgentsHealth; demoMode?: boolean } = {}) {
  const hello = { t: 'hello', demoMode: o.demoMode ?? false, agents: o.agents ?? health('ok') };
  const state = { approvals: {}, plans: {}, runs: {}, models, hello, agents: { [a.id]: a } };
  return jobStatus({ store: { state, agentsOfJob: () => [a] } } as never, job);
}

describe('jobStatus: a lead who can’t start', () => {
  test('no AI account connected: "No AI account", tone off (not an error)', () => {
    const st = status(lead({ notConnected: true }), [M(OPUS, false)]);
    expect(st.text).toBe('No AI account');
    expect(st.tone).toBe('off');
  });
  test('another account connected, not this model: "Not connected"', () => {
    expect(status(lead({ notConnected: true }), [M(OPUS, false), M(SOL, true)]).text).toBe('Not connected');
  });
  test('a failed check, or the agent missing: says which', () => {
    expect(status(lead({ notConnected: true }), [], { agents: health('failed') }).text).toBe('Check failed');
    expect(status(lead({ notConnected: true }), [], { agents: health('ok', 'missing') }).text).toBe('No agent');
  });
  test('connected, the first check still running, or the scripted test model: "Ready"', () => {
    const ready = status(lead({ notConnected: false }), [M(OPUS, true)]);
    expect(ready.text).toBe('Ready');
    expect(ready.tone).toBe('idle');
    expect(status(lead({ notConnected: true }), [M(OPUS, false)], { agents: health('checking') }).text).toBe('Ready');
    expect(status(lead({ notConnected: true }), [M(OPUS, false)], { demoMode: true }).text).toBe('Ready');
  });
});
