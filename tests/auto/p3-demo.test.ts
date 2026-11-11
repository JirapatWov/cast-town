// Phase 3 demo lead: "research X and Y in parallel then summarize" (and the Thai ask) → a one-off team with two
// researchers at the same time and a summarizer; the generic work step says whose replies it merged.
import { afterAll, describe, expect, test } from 'bun:test';
import { classifyAsk } from '../../server/agents/demo/assistant.ts';
import { chooseTeam, isAutoAsk, parallelParts, parseWorkflowList } from '../../server/agents/demo/auto.ts';
import { mergedFrom } from '../../server/agents/demo/generic.ts';
import { prepareSteps } from '../../server/agents/lead-tools.ts';
import { cleanup, fakeModels, GEMINI, GPT, makeWorld, OPUS, SONNET } from './world';

afterAll(cleanup);

const LEAD_TOOLS = new Set(['team_start', 'team_status', 'team_stop', 'workflow_list', 'workflow_save', 'team_assign', 'task']);

describe('parallel asks', () => {
  const asks: [string, [string, string]][] = [
    ['research the auth flow and the billing flow in parallel then summarize', ['auth flow', 'billing flow']],
    ['Please look into caching and rate limiting at the same time, then sum it up', ['caching', 'rate limiting']],
    ['compare Bun and Node side by side and give me a summary', ['Bun', 'Node']],
    ['ค้นคว้าเรื่องระบบล็อกอินกับระบบชำระเงินพร้อมกันแล้วสรุป', ['ระบบล็อกอิน', 'ระบบชำระเงิน']],
    ['ช่วยหาข้อมูล React และ Vue ไปพร้อม ๆ กัน แล้วสรุปให้หน่อย', ['React', 'Vue']],
  ];
  test.each(asks)('%p → two parts, auto-team in ask/auto', (text, parts) => {
    expect(parallelParts(text)).toEqual(parts);
    expect(isAutoAsk(text)).toBe(true);
    expect(classifyAsk(text, LEAD_TOOLS, '', 'ask')).toBe('auto-team');
    expect(classifyAsk(text, LEAD_TOOLS, '', 'auto')).toBe('auto-team');
  });
  test('solo keeps the old route (helpers for "parallel"); not a parallel ask without a merge or the two parts', () => {
    expect(classifyAsk('research the auth flow and the billing flow in parallel then summarize', LEAD_TOOLS, '', 'solo')).toBe('helpers');
    expect(parallelParts('research the auth flow in parallel')).toBeNull();
    expect(parallelParts('research auth and billing')).toBeNull();
    expect(parallelParts('what does src/app.ts do?')).toBeNull();
  });
});

describe('the team the demo lead picks', () => {
  const list = async (available: string[]) => {
    const w = makeWorld({ available });
    const text = (await w.call('workflow_list', {})).text;
    w.dispose();
    return parseWorkflowList(text);
  };

  test('nothing connected: two researchers (the second parallel) and a summarizer; prepareSteps accepts it', async () => {
    const c = chooseTeam(await list([]), 'code', 'T', false, ['auth flow', 'billing flow']);
    expect(c.args).toMatchObject({ task: 'T', name: 'Research in parallel → Summary' });
    expect(String(c.args.why)).toContain('at the same time');
    const steps = c.args.steps as { name: string; model: string; parallel?: boolean; persona: string }[];
    expect(steps.map((s) => `${s.name}${s.parallel ? '+' : ''}`)).toEqual(['Researcher 1', 'Researcher 2+', 'Summarizer']);
    expect(steps[0]!.persona).toContain('“auth flow” only');
    expect(steps[1]!.persona).toContain('“billing flow” only');
    const prep = prepareSteps(steps, { models: fakeModels([]) }, 'team');
    expect('steps' in prep && prep.steps.map((s) => `${s.id}${s.parallel ? '+' : ''}`)).toEqual(['researcher-1', 'researcher-2+', 'summarizer']);
    // the second researcher works beside the first: RLT's default instruction treats it as first too
    const [r1, r2, sum] = 'steps' in prep ? prep.steps : [];
    expect(r2!.instruction).toBe(r1!.instruction.replace('Researcher 1', 'Researcher 2'));
    expect(r2!.instruction).not.toContain('{{prev}}');
    expect(sum!.instruction).toContain('{{prevName}} handed this on:\n{{prev}}');
    expect(c.label).toContain(' + ');
  });

  test('connected models only, researchers from other vendors than the summarizer when there are some', async () => {
    const c = chooseTeam(await list([SONNET, GPT, GEMINI]), 'code', 'T', false, ['a', 'b']);
    const steps = c.args.steps as { model: string }[];
    expect(steps.map((s) => s.model)).toEqual([GPT, GEMINI, SONNET]);
    const one = chooseTeam(await list([OPUS]), 'code', 'T', false, ['a', 'b']);
    expect((one.args.steps as { model: string }[]).map((s) => s.model)).toEqual([OPUS, OPUS, OPUS]);
  });

  test('Thai: Thai names and why', async () => {
    const c = chooseTeam(await list([]), 'code', 'T', true, ['ล็อกอิน', 'ชำระเงิน']);
    expect((c.args.steps as { name: string }[]).map((s) => s.name)).toEqual(['นักค้นคว้า 1', 'นักค้นคว้า 2', 'ผู้สรุป']);
    expect(String(c.args.why)).toContain('พร้อมกัน');
  });
});

describe('the step after a group', () => {
  test('mergedFrom reads the "## <Name>" sections of {{prev}}', () => {
    const prompt = [
      'Task: research',
      '',
      'Researcher 1 + Researcher 2 handed this on:',
      '## Researcher 1',
      'Looked at README.md and left notes.',
      '',
      '## Researcher 2',
      'Looked at src/app.ts.',
      '',
      'You are the Summarizer. Do your part of the task.',
    ].join('\n');
    expect(mergedFrom(prompt)).toEqual([
      { name: 'Researcher 1', gist: 'Looked at README.md and left notes.' },
      { name: 'Researcher 2', gist: 'Looked at src/app.ts.' },
    ]);
    expect(mergedFrom('Task: x\n\nA handed this on:\nplain text')).toEqual([]);
  });
});

describe('the demo lead reads a run with a parallel group', () => {
  test('parseRunReport drops the marker from the name and keeps it as a flag', async () => {
    const { parseRunReport } = await import('../../server/agents/demo/team.ts');
    const r = parseRunReport('“T” — completed, 23s, $0.12.\nTask: x\nSteps:\n- A: done\n- B (at the same time as the one before): done\n- C: done');
    expect(r.steps).toEqual([{ name: 'A', state: 'done' }, { name: 'B', state: 'done', parallel: true }, { name: 'C', state: 'done' }]);
  });
});
