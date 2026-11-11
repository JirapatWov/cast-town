// Plan card effort helpers: what answer_plan sends, what an answered card shows.
import { describe, expect, test } from 'bun:test';
import type { ModelInfo, TeamPlan } from '../../shared/protocol.ts';
import { changedPeople, changedThinking, effortWords, finalThinking, planOutcome } from '../../web/src/ui/plans.ts';

const MODELS = [{ id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', vendor: 'openai', available: true }] as ModelInfo[];
const plan = (over: Partial<TeamPlan> = {}): TeamPlan => ({
  id: 'plan-1', agentId: 'a', projectId: 'p', jobId: 'main', title: 'T', task: 't', status: 'approved', ts: 1,
  steps: [
    { id: 'writer', name: 'Writer', duty: 'd', model: 'anthropic/claude-opus-5-5', kind: 'work', thinking: 'low' },
    { id: 'reviewer', name: 'Reviewer', duty: 'd', model: 'anthropic/claude-opus-5-5', kind: 'review' },
  ],
  ...over,
});

describe('effort helpers', () => {
  test('changedThinking: only real changes; "" against a planned level is a change, against none is not', () => {
    expect(changedThinking(plan(), { writer: 'low', reviewer: '' })).toEqual({});
    expect(changedThinking(plan(), { writer: '', reviewer: 'max' })).toEqual({ writer: '', reviewer: 'max' });
    expect(changedThinking(plan(), { ghost: 'max' } as never)).toEqual({});
  });
  test('finalThinking: the change wins, "" means the default', () => {
    const p = plan({ changedThinking: { writer: '', reviewer: 'high' } });
    expect(finalThinking(p, p.steps[0]!)).toBeUndefined();
    expect(finalThinking(p, p.steps[1]!)).toBe('high');
    expect(finalThinking(plan(), plan().steps[0]!)).toBe('low');
  });
  test('changedPeople counts a person once', () => {
    expect(changedPeople({ writer: 'x/y' }, { writer: 'max', reviewer: '' })).toBe(2);
    expect(changedPeople({}, {})).toBe(0);
  });
  test('planOutcome names effort changes', () => {
    expect(effortWords('xhigh')).toBe('Very high effort');
    expect(effortWords('')).toBe('default effort');
    expect(planOutcome(plan({ changedThinking: { writer: 'max' } }), undefined, MODELS)).toBe('Started — you changed Writer to Max effort');
    expect(planOutcome(plan({ changed: { reviewer: 'openai/gpt-6.1-sol' }, changedThinking: { reviewer: 'high', writer: '' } }), undefined, MODELS)).toBe(
      'Started — you changed Reviewer to GPT-6.1 Sol at High effort and Writer to default effort',
    );
    expect(planOutcome(plan({ changed: { reviewer: 'openai/gpt-6.1-sol' } }), undefined, MODELS)).toBe('Started — you changed Reviewer to GPT-6.1 Sol');
  });
});
