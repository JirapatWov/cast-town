// D1–D4: the demo lead and team_edit — which asks change a running team (and which stay file changes or team asks),
// the ops it makes from team_status (plan: true) of a real run, its reply to team_edit's result; and a note steered
// into a demo step doesn't start that step over.
import { afterAll, describe, expect, test } from 'bun:test';
import { classifyAsk } from '../../server/agents/demo/assistant.ts';
import { parseConversation } from '../../server/agents/demo/conversation.ts';
import { editedReply, editOps, teamIntent } from '../../server/agents/demo/team.ts';
import { LEAD_TOOL_NAMES } from '../../server/agents/lead-tools.ts';
import { cleanup, makeWorld, type World } from './world';

afterAll(cleanup);
const tools = new Set(LEAD_TOOL_NAMES);

describe('D1 which asks change the running team', () => {
  test('edit asks; file changes, team asks, continuations and status stay what they were', () => {
    for (const ask of [
      "change the Editor's prompt: keep the author's voice",
      'tweak the polish step a little — keep the author voice',
      'add a proofreader after the editor',
      'add one more step after the Editor to check spelling',
      "change the reviewer's model to gemini",
      'remove the proofreader step',
      'เปลี่ยน prompt ของการเกลาคำนิดนึง ให้คงสำนวนผู้เขียนไว้',
      'เพิ่ม step ตรวจคำผิดต่อจากเกลาคำ',
      'แก้ prompt ของ editor ในทีมหน่อย',
      'change the editor prompt to use shorter sentences',
      'เพิ่ม step ตรวจคำผิดต่อท้าย',
      'ขอเปลี่ยน prompt ของการเกลาคำนิดนึง ให้กระชับขึ้น',
      'แก้ prompt ขั้นเกลาคำนิดหน่อย',
      'เพิ่มขั้นตรวจคำผิดหลังเกลาคำ',
      'ปรับขั้นเกลาคำให้สั้นลง',
    ]) {
      expect({ ask, intent: classifyAsk(ask, tools) }).toEqual({ ask, intent: 'team-edit' });
    }
    expect(classifyAsk('change the prompt text in src/prompts.ts', tools)).toBe('change');
    expect(classifyAsk('add a step to the CI script', tools)).toBe('change');
    expect(classifyAsk('แก้ prompt ในไฟล์ src/x.ts', tools)).toBe('change');
    expect(classifyAsk('เพิ่มขั้นตอนการชำระเงิน', tools)).toBe('change');
    expect(classifyAsk('เพิ่มปุ่มหลังฟอร์ม', tools)).toBe('change');
    expect(classifyAsk('add a step counter to the signup form', tools)).toBe('change');
    expect(classifyAsk('have the team add input validation', tools)).toBe('team-run');
    expect(classifyAsk('ให้ทีมเพิ่ม PATCH /todos/:id/done', tools)).toBe('team-run');
    expect(classifyAsk('just redo the review', tools)).toBe('team-continue');
    expect(classifyAsk('how is the team doing?', tools)).toBe('team-status');
    expect(classifyAsk('update the team: the reviewer model should be gemini', tools)).toBe('workflow-change'); // the saved workflow
    // without the tool (not a lead): never
    expect(teamIntent("change the Editor's prompt: keep the author's voice", new Set(['team_start', 'team_status']))).toBeNull();
  });
});

/** The novel team (Idea-maker → Writer → Editor) with the Writer working. */
async function novelMidRun(): Promise<{ w: World; runId: string; release: () => void; status: string }> {
  const w = makeWorld({ workflowId: 'novel' });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const answer = w.answer;
  w.answer = (step, text) => (step.id === 'writer' ? gate.then(() => 'Chapter 3 written.') : answer(step, text));
  const r = await w.call('team_start', { task: 'Write chapter 3' });
  const runId = r.text.match(/run (run-\w+)/)![1]!;
  await w.until(() => w.prompts.some((p) => p.agentId.endsWith(':writer')));
  const status = (await w.call('team_status', { plan: true })).text;
  return { w, runId, release, status };
}

describe('D2 the ops from team_status of a real run', () => {
  test("a step it describes (the polish → the Editor); a person after it; one it names; a step that finished", async () => {
    const { w, runId, release, status } = await novelMidRun();
    expect(editOps('เปลี่ยน prompt ของการเกลาคำนิดนึง ให้คงสำนวนผู้เขียนไว้', status)).toEqual([{ op: 'update', step: 'editor', add_to_instruction: 'From the user: คงสำนวนผู้เขียนไว้' }]);
    expect(editOps("change the Editor's prompt: keep the author's voice", status)).toEqual([{ op: 'update', step: 'editor', add_to_instruction: "From the user: keep the author's voice" }]);
    const add = editOps('add a proofreader after the editor', status)!;
    expect(add).toEqual([{ op: 'add', after: 'editor', person: { name: 'Proofreader', model: 'openai/gpt-6.1-sol', persona: 'You are the Proofreader. Add a proofreader after the editor' } }]);
    const th = editOps('เพิ่ม step ตรวจคำผิดต่อจากเกลาคำ', status)!;
    expect(th[0]).toMatchObject({ op: 'add', after: 'editor', person: { name: 'ตรวจคำผิด' } });
    expect(editOps('change the idea prompt: darker', status)).toEqual([{ op: 'update', step: 'idea-maker', add_to_instruction: 'From the user: darker' }]);
    expect(editOps('change the prompt: darker', status)).toBeNull();
    expect(editOps('เพิ่ม step ตรวจคำผิดต่อท้าย', status)![0]).toMatchObject({ op: 'add', person: { name: 'ตรวจคำผิด' } });
    expect(editOps('ขอเปลี่ยน prompt ของการเกลาคำนิดนึง ให้กระชับขึ้น', status)).toEqual([{ op: 'update', step: 'editor', add_to_instruction: 'From the user: กระชับขึ้น' }]);
    expect(editOps('แก้ prompt ขั้นเกลาคำนิดหน่อย', status)).toEqual([{ op: 'update', step: 'editor', add_to_instruction: expect.stringMatching(/^From the user: /) }]);
    expect(editOps('เพิ่มขั้นตรวจคำผิดหลังเกลาคำ', status)![0]).toMatchObject({ op: 'add', after: 'editor', person: { name: 'ตรวจคำผิด' } });

    // the whole turn's tool calls, as the demo lead makes them
    const edited = await w.call('team_edit', { ops: editOps('เปลี่ยน prompt ของการเกลาคำนิดนึง ให้คงสำนวนผู้เขียนไว้', status) });
    expect(edited.isError).toBeFalsy();
    expect(editedReply(edited.text, true)).toBe(
      [
        'แก้ทีมแล้วค่ะ ทีมทำต่อโดยไม่ต้องเริ่มใหม่ — Idea-maker ใช้ผลเดิม, Writer ทำต่อ (ไม่ต้องเริ่มใหม่)',
        '- Editor: แก้แล้ว',
        'ต่อไป: Editor',
        'แก้เฉพาะรอบนี้นะคะ workflow ที่บันทึกไว้ยังเหมือนเดิม — ถ้าอยากให้ครั้งหน้าใช้แบบนี้ด้วยบอกได้ค่ะ',
      ].join('\n\n'),
    );
    const more = await w.call('team_edit', { ops: editOps('add a proofreader after the editor', status) });
    expect(editedReply(more.text, false)).toBe(
      [
        'Done — the team keeps going: Idea-maker keeps its result, Writer keeps working (not restarted).',
        '- Added Proofreader [proofreader] after Editor (openai/gpt-6.1-sol).',
        'Next: Editor → Proofreader.',
        'This run only — the saved workflow stays as it was. Say if you want it for next time too.',
      ].join('\n\n'),
    );
    const refused = await w.call('team_edit', { ops: editOps('change the idea prompt: darker', status) });
    expect(refused.isError).toBe(true);
    expect(editedReply(refused.text, false)).toBe('**Idea-maker** already finished, so changing it means redoing it and the steps after it. Want me to redo from Idea-maker? Until you say, the team keeps going as it is.');
    const working = await w.call('team_edit', { ops: [{ op: 'update', step: 'writer', persona: 'x' }] });
    expect(editedReply(working.text, true)).toStartWith('**Writer** กำลังทำขั้นนี้อยู่ค่ะ');
    release();
    const end = await w.until(() => (w.engine.get(runId)!.status === 'completed' ? w.engine.get(runId) : null));
    expect(end.steps.map((s) => s.stepId)).toEqual(['idea-maker', 'writer', 'editor', 'proofreader']);
    w.dispose();
  });
});

describe('D3 replies when nothing runs, and other errors', () => {
  test('texts', async () => {
    const w = makeWorld();
    const none = await w.call('team_edit', { ops: [{ op: 'update', step: 'reviewer', persona: 'x' }] });
    expect(editedReply(none.text, false)).toBe("The team isn't running right now — I can change the workflow for next time (the Workflow tab), or redo part of the last run with the change.");
    expect(editedReply('A team can have at most 12 steps.', false)).toBe("I couldn't change the team: A team can have at most 12 steps.");
    w.dispose();
  });
});

describe('D4 the demo LLM: a note steered into a step continues that step', () => {
  test("the step's ask stays the user text, its calls stay the turn, the note is kept aside", () => {
    const note = '<system-notice>\nUser interjection during work: priority.\n</system-notice>\nNote from the user for your current step:\nKeep the chapter under 800 words.\n\nKeep going with your step — your final reply is still your step\'s report.';
    const conv = parseConversation({
      messages: [
        { role: 'system', content: '[rlt-role:writer] [rlt-step-kind:work] You are the Writer.' },
        { role: 'user', content: 'Brief: Write chapter 3' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'rlt_read_1', function: { name: 'read', arguments: '{"path":"outline.md"}' } }] },
        { role: 'tool', tool_call_id: 'rlt_read_1', content: '# Outline' },
        { role: 'user', content: note },
      ],
    });
    expect(conv.userText).toBe('Brief: Write chapter 3');
    expect(conv.turn.map((c) => c.name)).toEqual(['read']);
    expect(conv.stepNotes).toEqual(['Keep the chapter under 800 words.']);
    // as the first message (nothing to continue) it is the ask
    expect(parseConversation({ messages: [{ role: 'user', content: note }] }).stepNotes).toEqual([]);
  });
});
