// The scripted test model's lead (CAST_MOCK_LLM) deciding alone in work styles 'ask' / 'auto': which asks go to a team,
// which team it picks from a real workflow_list, and how it reads team_start's result.
import { afterAll, describe, expect, test } from 'bun:test';
import { classifyAsk } from '../../server/agents/demo/assistant.ts';
import { chooseTeam, isAutoAsk, parseWorkflowList, workStyleOf } from '../../server/agents/demo/auto.ts';
import { startedReply } from '../../server/agents/demo/team.ts';
import { cleanup, DEEPSEEK, GEMINI, GPT, makeWorld, OPUS, SONNET } from './world';

afterAll(cleanup);

const LEAD_TOOLS = new Set(['team_start', 'team_status', 'team_stop', 'workflow_list', 'workflow_save', 'team_assign', 'task']);

describe('classifyAsk', () => {
  const staged = [
    'fix the failing tests and get it reviewed',
    'Please fix the login bug, then have it reviewed',
    'implement pagination and review',
    'write chapter 5',
    'Write the next chapter',
    'แก้เทสต์ที่พังแล้วรีวิวด้วย',
    'แก้บั๊กหน้า login แล้วให้ตรวจ',
    'เขียนบทที่ 5',
  ];
  test.each(staged)('ask/auto: %p → auto-team', (text) => {
    expect(isAutoAsk(text)).toBe(true);
    expect(classifyAsk(text, LEAD_TOOLS, '', 'ask')).toBe('auto-team');
    expect(classifyAsk(text, LEAD_TOOLS, '', 'auto')).toBe('auto-team');
  });
  test('solo / old personas / no team tools: the old routes', () => {
    expect(classifyAsk('fix the failing tests and get it reviewed', LEAD_TOOLS, '', 'solo')).toBe('change');
    expect(classifyAsk('fix the failing tests and get it reviewed', LEAD_TOOLS, '', null)).toBe('change');
    expect(classifyAsk('fix the failing tests and get it reviewed', new Set(['task']), '', 'ask')).toBe('change');
  });
  test('small asks stay with the lead even in ask/auto', () => {
    expect(classifyAsk('fix the typo in README', LEAD_TOOLS, '', 'ask')).toBe('change');
    expect(classifyAsk('แก้คำผิดใน README', LEAD_TOOLS, '', 'auto')).toBe('change');
    expect(classifyAsk('what does src/app.ts do?', LEAD_TOOLS, '', 'ask')).toBe('explain');
    expect(classifyAsk('ไฟล์ไหนเป็นตัวหลัก', LEAD_TOOLS, '', 'ask')).toBe('explain');
    expect(isAutoAsk('can you review my approach?')).toBe(false);
  });
  test('explicit team / design asks keep their routes', () => {
    expect(classifyAsk('have the team fix the failing tests', LEAD_TOOLS, '', 'ask')).toBe('team-run');
    expect(classifyAsk('how is the team doing?', LEAD_TOOLS, '', 'ask')).toBe('team-status');
  });
  test('workStyleOf reads the marker', () => {
    expect(workStyleOf('...\n[rlt-work-style:auto] ...')).toBe('auto');
    expect(workStyleOf('no marker')).toBeNull();
  });
});

describe('choosing a team from a real workflow_list', () => {
  const list = async (opts: Parameters<typeof makeWorld>[0]) => {
    const w = makeWorld(opts);
    const text = (await w.call('workflow_list', {})).text;
    w.dispose();
    return parseWorkflowList(text);
  };

  test("the job's team when its models are connected (or nothing is)", async () => {
    const l = await list({ available: [] });
    expect(l.teamId).toBe('decode-implement-review');
    expect(l.models).toBeNull();
    expect(l.workflows.find((x) => x.id === 'novel')).toMatchObject({ builtin: false, connected: true }); // no ", built-in" any more
    expect(chooseTeam(l, 'code', 'T', false).args).toEqual({ task: 'T', why: expect.stringContaining('“Decode → Implement → Review”') });
  });

  test('no job team → a one-off team on the connected models (no stored workflow is picked by its id)', async () => {
    const l = await list({ available: [OPUS, DEEPSEEK, GPT], workflowId: null });
    expect(l.teamId).toBeNull();
    expect(l.models).toEqual([OPUS, GPT, DEEPSEEK]); // catalog order
    expect(l.workflows.find((x) => x.id === 'decode-implement-review')).toMatchObject({ builtin: false, connected: true });
    const c = chooseTeam(l, 'code', 'T', false);
    expect(c.args.workflow_id).toBeUndefined();
    expect(c.args).toMatchObject({ task: 'T', name: 'Fix → Review' });
    expect((c.args.steps as { model: string }[]).map((s) => s.model)).toEqual([OPUS, GPT]);
  });

  test('nothing fitting connected → a one-off team on connected models, reviewer from another vendor (TH why)', async () => {
    const l = await list({ available: [SONNET, GEMINI] });
    expect(l.workflows.find((x) => x.id === 'decode-implement-review')!.connected).toBe(false);
    const c = chooseTeam(l, 'code', 'T', true);
    expect(c.args).toMatchObject({ task: 'T', name: 'Fix → Review' });
    const steps = c.args.steps as { name: string; model: string; loopBackTo?: string }[];
    expect(steps.map((s) => `${s.name}/${s.model}`)).toEqual([`Fixer/${SONNET}`, `Reviewer/${GEMINI}`]);
    expect(steps[1]!.loopBackTo).toBe('Fixer');
    expect(String(c.args.why)).toMatch(/ต้องแก้แล้วมีคนตรวจ/);
    const novel = chooseTeam({ ...l, workflows: [] }, 'novel', 'T', false);
    expect(novel.args.name).toBe('Write → Edit');
  });
});

describe('startedReply', () => {
  test('started, with the models the user changed (EN/TH)', () => {
    const r = 'Started “Decode → Implement → Review” (Decoder → Implementer → Reviewer), run run-1. It works in the background.\nThe user approved the plan and changed: Reviewer → google/gemini-4-argon. Keep their model choices for later teams in this job.';
    expect(startedReply(r, false)).toMatch(/^The team is on it — Decoder → Implementer → Reviewer\. With your picks: Reviewer → google\/gemini-4-argon/);
    expect(startedReply(r, true)).toMatch(/^ทีมรับงานแล้วค่ะ — Decoder → Implementer → Reviewer \(ใช้ตามที่คุณเลือกไว้นะคะ: Reviewer → google\/gemini-4-argon/);
    expect(startedReply('Started “X” (A → B), run run-2.', false)).not.toMatch(/With your picks/);
  });
  test('cancelled, new message, stopped, withdrawn, refused', () => {
    expect(startedReply("The user cancelled this plan — don't start it.", false)).toMatch(/^OK — I won't start that team/);
    expect(startedReply("The user cancelled this plan — don't start it.", true)).toMatch(/^ได้ค่ะ ไม่เริ่มทีม/);
    expect(startedReply('The user wrote a new message instead of answering the plan — read it.', false)).toMatch(/new message/);
    expect(startedReply("The user pressed Stop before answering the plan — don't start it.", false)).toBe('Stopped — no team was started.');
    expect(startedReply('The plan was withdrawn before the user answered it.', true)).toMatch(/^หยุดแล้วค่ะ/);
    expect(startedReply('Not connected: “Reviewer” [reviewer] uses openai/x.', false)).toMatch(/^I couldn't start the team: Not connected/);
  });
});
