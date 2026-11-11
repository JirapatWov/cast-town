// The owner (2026-11-04): "a workflow the assistant made, I changed a model in it by hand, told the assistant to start —
// and it saved the workflow again from its own copy, so it was back to the old model and the team ran wrong." Through
// the real AgentSystem: the lead's workflow_save merges over the workflow's base (what chat last saved): what was
// changed by hand since stays when the lead sends the earlier values; a different value of its own is refused (override
// when the user asked); people keep their ids by name; team_start says what changed; a model set by hand wins over an
// older plan-card choice. Workflows saved before this keep their stored version as the base.
import { afterAll, describe, expect, test } from 'bun:test';
import type { Workflow, WorkflowStep } from '../../shared/protocol';
import { writeFileSync } from 'node:fs';
import { WorkflowStore } from '../../server/agents/workflow-store.ts';
import { workflowOf } from '../../shared/house-workflows.ts';
import { cleanup, makeSys, type SysWorld } from './sys-world';
afterAll(cleanup);

const OPUS = 'anthropic/claude-opus-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const GPT = 'openai/gpt-6.1-sol';
const FLASH = 'google/gemini-4-argon';

/** The lead's steps (as it sends them: no ids, CAST derives them from the names). */
const LEAD_STEPS = [
  { name: 'Planner', model: OPUS, thinking: 'high', persona: 'You plan the arc of the story.', instruction: 'Plan {{task}}. Write the plan to {{runDir}}/plan.md.' },
  { name: 'Brainstorm', model: SONNET, thinking: 'high', persona: 'You brainstorm ideas.', instruction: 'Ideas for {{task}} from {{runDir}}/plan.md.' },
  { name: 'Writer', model: GPT, thinking: 'medium', persona: 'You write the chapter.', instruction: 'Write it, after {{prev}}.' },
];

type Result = { id: string; text: string; isError?: boolean };

async function lead(w: SysWorld, tool: string, args: Record<string, unknown>): Promise<Result> {
  let lp = w.procs.get(w.lead);
  if (!lp) {
    await w.handle({ t: 'prompt', agentId: w.lead, text: 'make me a team' });
    lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
    await w.until(() => lp!.prompts.length >= 1, 2000, 'lead prompt');
  }
  const call = lp.hostCall(tool, args);
  return w.until(() => lp!.hostResults.find((r) => r.id === call.id), 4000, `${tool} result`) as Promise<Result>;
}

/** The house's workflow as the page has it (the snapshot: each house's own). */
const stored = (w: SysWorld, id: string) => workflowOf(w.sys.snapshot(), w.projectId, id)!;
const step = (wf: Workflow, id: string) => wf.steps.find((s) => s.id === id)!;
const ack = (m: unknown) => m as { ok: boolean; error?: string; data?: { workflow?: Workflow } };

/** The user's hand edit in the Workflow tab: the whole workflow as the tab sends it. */
async function handEdit(w: SysWorld, id: string, change: (s: WorkflowStep[]) => WorkflowStep[]): Promise<Workflow> {
  const now = structuredClone(stored(w, id));
  const r = ack(await w.handle({ t: 'save_workflow', projectId: w.projectId, workflow: { ...now, steps: change(now.steps) } }));
  expect(r.ok).toBe(true);
  return r.data!.workflow!;
}

/** The lead made "Wuxia" (Planner → Brainstorm → Writer). */
async function made(w: SysWorld): Promise<string> {
  const r = await lead(w, 'workflow_save', { name: 'Wuxia', steps: LEAD_STEPS });
  expect(r.isError).toBeFalsy();
  return r.text.match(/\(id ([a-z0-9-]+)\)/)![1]!;
}

describe('the lead saves a workflow the user changed by hand', () => {
  test('the owner’s case: a model and an effort set in the Workflow tab survive the lead saving its earlier steps again', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: FLASH } : x.id === 'planner' ? { ...x, thinking: 'xhigh' } : x)));
    expect(step(stored(w, id), 'brainstorm').model).toBe(FLASH);

    // "start the work": the lead reads it, then saves its own earlier steps again with one change of its own
    await lead(w, 'workflow_get', { id });
    const steps = LEAD_STEPS.map((s) => (s.name === 'Writer' ? { ...s, instruction: 'Write the chapter in Thai, after {{prev}}.' } : s));
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps });
    expect(r.isError).toBeFalsy();

    const now = stored(w, id);
    expect(step(now, 'brainstorm').model).toBe(FLASH); // the user's model
    expect(step(now, 'planner').thinking).toBe('xhigh'); // the user's effort
    expect(step(now, 'writer').instruction).toContain('in Thai'); // the lead's own change
    // the lead hears what it left as it was, and how to change one when the user asks
    expect(r.text).toContain(`brainstorm.model — Brainstorm: ${FLASH} (you sent the earlier ${SONNET})`);
    expect(r.text).toContain('planner.thinking — Planner: xhigh (you sent the earlier high)');
    expect(r.text).toContain('override: ["planner.thinking","brainstorm.model"]');
    await w.dispose();
  });

  test('sent again from the same old copy: still kept; override (the user asked for it) lets the lead’s value through', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: FLASH } : x)));
    await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS });
    const again = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS });
    expect(step(stored(w, id), 'brainstorm').model).toBe(FLASH);
    expect(again.text).toContain('brainstorm.model');

    const forced = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS, override: ['brainstorm.model'] });
    expect(forced.isError).toBeFalsy();
    expect(step(stored(w, id), 'brainstorm').model).toBe(SONNET);
    expect(forced.text).not.toContain('brainstorm.model —');
    await w.dispose();
  });

  test('the lead sends a value of its own for a field changed by hand: nothing is saved, it hears both; override saves it', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'writer' ? { ...x, model: FLASH } : x)));
    const steps = LEAD_STEPS.map((s) => (s.name === 'Writer' ? { ...s, model: OPUS } : s.name === 'Planner' ? { ...s, instruction: 'Plan it well: {{task}}' } : s));
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`- writer.model — Writer: now ${FLASH} (you sent ${OPUS})`);
    expect(r.text).toContain('override: ["writer.model"]');
    expect(step(stored(w, id), 'writer').model).toBe(FLASH);
    expect(step(stored(w, id), 'planner').instruction).not.toContain('Plan it well'); // nothing of it was saved
    const forced = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps, override: ['writer.model'] });
    expect(forced.isError).toBeFalsy();
    expect(step(stored(w, id), 'writer').model).toBe(OPUS);
    expect(step(stored(w, id), 'planner').instruction).toContain('Plan it well');
    await w.dispose();
  });

  test('a person the user added or removed by hand stays added / removed when the lead sends its old team', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    const editor: WorkflowStep = { id: 'editor', name: 'Editor', model: OPUS, kind: 'work', persona: 'You edit.', instruction: 'Edit {{prev}}' };
    await handEdit(w, id, (s) => [...s.filter((x) => x.id !== 'brainstorm'), editor]);
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS.map((s) => (s.name === 'Planner' ? { ...s, model: GPT } : s)) });
    expect(r.isError).toBeFalsy();
    const now = stored(w, id);
    expect(now.steps.map((s) => s.id)).toEqual(['planner', 'writer', 'editor']);
    expect(step(now, 'planner').model).toBe(GPT); // its own change still lands
    expect(r.text).toContain('added “Editor”');
    expect(r.text).toContain('removed “Brainstorm”');
    await w.dispose();
  });

  test('the people reordered by hand and the lead adds someone to its old order: refused; built on the current order (workflow_get) it saves', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => [s[1]!, s[0]!, s[2]!]); // Brainstorm first
    const checker = { name: 'Checker', model: OPUS, kind: 'review', persona: 'You check.', instruction: 'Check {{prev}}' };
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: [...LEAD_STEPS, checker] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('- steps — the team: now Brainstorm → Planner → Writer (you sent Planner → Brainstorm → Writer → Checker)');
    expect(r.text).toContain('workflow_get');
    expect(stored(w, id).steps.map((s) => s.id)).toEqual(['brainstorm', 'planner', 'writer']);
    // what the refusal says to do: start from what is there now, add the checker
    const read = JSON.parse((await lead(w, 'workflow_get', { id })).text) as Workflow;
    const ok = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: [...read.steps, checker] });
    expect(ok.isError).toBeFalsy();
    expect(stored(w, id).steps.map((s) => s.id)).toEqual(['brainstorm', 'planner', 'writer', 'checker']);
    // override ["steps"]: the lead's order (the user asked for exactly that team)
    const forced = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: [...LEAD_STEPS, checker], override: ['steps'] });
    expect(forced.isError).toBeFalsy();
    expect(stored(w, id).steps.map((s) => s.id)).toEqual(['planner', 'brainstorm', 'writer', 'checker']);
    await w.dispose();
  });

  test('Thai names (ids by position) and no ids sent: people are matched by name, a hand-set model stays with its person', async () => {
    const w = makeSys({ workflowId: null });
    const thai = [
      { name: 'นักวางแผน', model: OPUS, persona: 'วางแผน', instruction: 'วางแผน {{task}} ลง {{runDir}}/plan.md' },
      { name: 'นักระดมสมอง', model: SONNET, persona: 'ระดมสมอง', instruction: 'ระดมสมองจาก {{runDir}}/plan.md' },
      { name: 'นักเขียน', model: GPT, persona: 'เขียน', instruction: 'เขียนต่อจาก {{prev}}' },
    ];
    const made2 = await lead(w, 'workflow_save', { name: 'นิยาย', steps: thai });
    const id = made2.text.match(/\(id ([a-z0-9-]+)\)/)![1]!;
    expect(stored(w, id).steps.map((s) => s.id)).toEqual(['step-1', 'step-2', 'step-3']);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'step-2' ? { ...x, model: FLASH } : x.id === 'step-3' ? { ...x, model: OPUS } : x)));
    // the user: "take the brainstormer out" — the lead sends the other two, without ids. The brainstormer's model was
    // set by hand: leaving them out could be a rename without the id, so the lead must say it means it
    const two = [thai[0], { ...thai[2]!, model: OPUS }];
    const asked = await lead(w, 'workflow_save', { id, replace: true, name: 'นิยาย', steps: two });
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain('- steps — “นักระดมสมอง”: now changed by hand (you sent left out (to rename someone, keep their id: "step-2"))');
    expect(stored(w, id).steps).toHaveLength(3);
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'นิยาย', steps: two, override: ['steps'] });
    expect(r.isError).toBeFalsy();
    expect(stored(w, id).steps.map((s) => `${s.id}:${s.name}:${s.model}`)).toEqual([`step-1:นักวางแผน:${OPUS}`, `step-3:นักเขียน:${OPUS}`]);
    // someone new at the front gets an id no one had
    const r2 = await lead(w, 'workflow_save', { id, replace: true, name: 'นิยาย', steps: [{ name: 'นักวิจัย', model: GPT, persona: 'วิจัย' }, thai[0], { ...thai[2]!, model: OPUS }] });
    expect(r2.isError).toBeFalsy();
    const ids = stored(w, id).steps.map((s) => s.id);
    expect(ids.slice(1)).toEqual(['step-1', 'step-3']);
    expect(['step-1', 'step-2', 'step-3']).not.toContain(ids[0]);
    await w.dispose();
  });

  test('a loop kept from a hand edit that no longer fits the lead’s team: the lead’s loop, and it hears so', async () => {
    const w = makeSys({ workflowId: null });
    const four = [...LEAD_STEPS, { name: 'Checker', model: OPUS, kind: 'review', persona: 'You check.', instruction: 'Check {{prev}}', loopBackTo: 'Writer' }];
    const id = (await lead(w, 'workflow_save', { name: 'Loop', steps: four })).text.match(/\(id ([a-z0-9-]+)\)/)![1]!;
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'checker' ? { ...x, loopBackTo: 'brainstorm' } : x)));
    // the user: "take Brainstorm out"
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'Loop', steps: four.filter((s) => s.name !== 'Brainstorm') });
    expect(r.isError).toBeFalsy();
    expect(stored(w, id).steps.map((s) => s.id)).toEqual(['planner', 'writer', 'checker']);
    expect(step(stored(w, id), 'checker').loopBackTo).toBe('writer');
    expect(r.text).toContain('“Checker” loops back to writer (yours)');
    await w.dispose();
  });

  test('a workflow the user made by hand: its first version is the base, reading it doesn’t move that', async () => {
    const w = makeSys({ workflowId: null });
    const mine: Workflow = { id: 'mine', name: 'Mine', description: '', icon: '', steps: [{ id: 'a', name: 'A', model: OPUS, kind: 'work', persona: 'p', instruction: 'Do {{task}}' }] };
    expect(ack(await w.handle({ t: 'save_workflow', projectId: w.projectId, workflow: mine })).ok).toBe(true);
    await lead(w, 'workflow_get', { id: 'mine' });
    await handEdit(w, 'mine', (s) => s.map((x) => ({ ...x, model: GPT })));
    await lead(w, 'workflow_get', { id: 'mine' });
    const r = await lead(w, 'workflow_save', { id: 'mine', replace: true, name: 'Mine', steps: [{ id: 'a', name: 'A', model: OPUS, persona: 'p', instruction: 'Do {{task}} well' }] });
    expect(r.isError).toBeFalsy();
    expect(step(stored(w, 'mine'), 'a').model).toBe(GPT);
    expect(step(stored(w, 'mine'), 'a').instruction).toBe('Do {{task}} well');
    expect(r.text).toContain('a.model');
    await w.dispose();
  });

  test('a workflow saved before bases existed (the deploy): what is stored is its base, so the owner’s sequence is caught', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await w.dispose();
    const data = `${w.root}/data`;
    writeFileSync(`${data}/workflow-bases.json`, '{"bases":[]}\n'); // as if CAST had none yet
    const w2 = makeSys({ workflowId: null, root: w.root });
    await handEdit(w2, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: FLASH } : x)));
    const r = await lead(w2, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS });
    expect(r.isError).toBeFalsy();
    expect(step(stored(w2, id), 'brainstorm').model).toBe(FLASH);
    await w2.dispose();
  });

  test('the base outlives a restart and goes with the workflow', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: FLASH } : x)));
    const again = new WorkflowStore(`${w.root}/data`);
    expect(again.chatBase(w.projectId, id)?.steps.map((s) => s.model)).toEqual([OPUS, SONNET, GPT]); // not the hand edit
    expect(again.handSetAt(w.projectId, id, 'brainstorm', 'model')).toBeGreaterThan(0);
    expect(again.remove(w.projectId, id)).toBe(true);
    expect(new WorkflowStore(`${w.root}/data`).chatBase(w.projectId, id)).toBeUndefined();
    await w.dispose();
  });

  test('team_start tells the lead what was changed by hand (the run uses it as it is now)', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: FLASH } : x)));
    w.jobs.update(w.projectId, 'main', { workStyle: 'auto' }); // no plan card
    const r = await lead(w, 'team_start', { task: 'Volume 1', workflow_id: id });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(`- brainstorm.model — Brainstorm: ${FLASH} (was ${SONNET})`);
    await w.dispose();
  });
});

describe('a model set by hand wins over an older plan-card choice for that duty', () => {
  test('the Workflow tab after a plan card: the next team runs the hand-set model; other people keep the card choice', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    w.jobs.update(w.projectId, 'main', {
      modelPrefs: [
        { stepName: 'Brainstorm', duty: 'You brainstorm ideas.', model: OPUS, thinking: 'max', at: 1 },
        { stepName: 'Writer', duty: 'You write the chapter.', model: OPUS, at: 1 },
      ],
    });
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: FLASH, thinking: undefined } : x)));
    w.jobs.update(w.projectId, 'main', { workStyle: 'auto' }); // no plan card
    const r = await lead(w, 'team_start', { task: 'Volume 1', workflow_id: id });
    expect(r.isError).toBeFalsy();
    const run = w.sys.snapshot().runs.find((x) => x.workflowId === id)!;
    expect(run.team?.find((s) => s.id === 'x-brainstorm')?.model).toBe(FLASH); // its people are x-…: it isn't the job's team
    expect(run.team?.find((s) => s.id === 'x-writer')?.model).toBe(OPUS); // not set by hand: the card choice
    expect(r.text).toContain(`Brainstorm [brainstorm] runs on ${FLASH}, which the user set by hand after picking ${OPUS} on a plan card.`);
    expect(r.text).toContain('Brainstorm [brainstorm] thinks at the default, which the user set by hand after picking max on a plan card.');
    // the job's card choices themselves are left as they are (another workflow with that person still gets them)
    expect(w.jobs.get(w.projectId, 'main')!.modelPrefs!.find((p) => p.stepName === 'Brainstorm')).toMatchObject({ model: OPUS, thinking: 'max' });
    await w.dispose();
  });
});

describe('second review: ways out, CAST’s own text, names, renames, the deploy', () => {
  test('the user asks the lead to undo a person they added by hand: override ["steps"] does it (and the note says so)', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    const editor: WorkflowStep = { id: 'editor', name: 'Editor', model: OPUS, kind: 'work', persona: 'You edit.', instruction: 'Edit {{prev}}' };
    await handEdit(w, id, (s) => [...s, editor]);
    const plain = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS });
    expect(stored(w, id).steps.map((s) => s.id)).toContain('editor');
    expect(plain.text).toContain('override: ["steps"]');
    const undo = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS, override: ['steps'] });
    expect(undo.isError).toBeFalsy();
    expect(stored(w, id).steps.map((s) => s.id)).toEqual(['planner', 'brainstorm', 'writer']);
    await w.dispose();
  });

  test('making someone a review that loops back, after their text was changed by hand: saved, with the verdict format and {{feedback}}', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'writer' ? { ...x, instruction: 'Look over {{prev}} carefully.' } : x.id === 'brainstorm' ? { ...x, instruction: 'Ideas in Thai from {{runDir}}/plan.md.' } : x)));
    const read = JSON.parse((await lead(w, 'workflow_get', { id })).text) as Workflow;
    const steps = read.steps.map((s) => (s.id === 'writer' ? { ...s, kind: 'review', loopBackTo: 'brainstorm' } : s));
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps });
    expect(r.isError).toBeFalsy();
    const now = stored(w, id);
    expect(step(now, 'writer')).toMatchObject({ kind: 'review', loopBackTo: 'brainstorm' });
    expect(step(now, 'writer').instruction).toStartWith('Look over {{prev}} carefully.');
    expect(step(now, 'writer').instruction).toMatch(/verdict/i);
    expect(step(now, 'brainstorm').instruction).toBe('Ideas in Thai from {{runDir}}/plan.md.{{feedback}}');
    await w.dispose();
  });

  test('names over 40 characters (stored cut to 40) and a person renamed by hand keep who they are when the lead sends its old copy', async () => {
    const w = makeSys({ workflowId: null });
    const long = 'ผู้เชี่ยวชาญด้านการวางโครงเรื่องนิยายกำลังภายในระดับสูง'; // > 40
    const steps = [{ ...LEAD_STEPS[0]!, name: long }, LEAD_STEPS[1]!, LEAD_STEPS[2]!];
    const id = (await lead(w, 'workflow_save', { name: 'Long', steps })).text.match(/\(id ([a-z0-9-]+)\)/)![1]!;
    const ids = stored(w, id).steps.map((s) => s.id);
    await handEdit(w, id, (s) => s.map((x, i) => (i === 0 ? { ...x, model: FLASH } : x.id === 'brainstorm' ? { ...x, name: 'Idea Finder', model: GPT } : x)));
    // the lead's old copy, no ids, one change of its own on the writer
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'Long', steps: steps.map((s) => (s.name === 'Writer' ? { ...s, thinking: 'high' } : s)) });
    expect(r.isError).toBeFalsy();
    const now = stored(w, id);
    expect(now.steps.map((s) => s.id)).toEqual(ids);
    expect(now.steps.map((s) => s.model)).toEqual([FLASH, GPT, GPT]);
    expect(step(now, 'brainstorm').name).toBe('Idea Finder');
    expect(step(now, 'writer').thinking).toBe('high');
    await w.dispose();
  });

  test('set by hand and back again: the lead’s other value for it is still refused', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: FLASH } : x)));
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: SONNET } : x)));
    const r = await lead(w, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS.map((s) => (s.name === 'Brainstorm' ? { ...s, model: GPT } : s)) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`brainstorm.model — Brainstorm: now ${SONNET} (you sent ${GPT})`);
    await w.dispose();
  });

  test('the deploy: a hand edit made before CAST kept bases — the lead’s first save that would change it is stopped once; hand edits since stay protected', async () => {
    const w = makeSys({ workflowId: null });
    const id = await made(w);
    await handEdit(w, id, (s) => s.map((x) => (x.id === 'brainstorm' ? { ...x, model: FLASH } : x))); // before the deploy
    await w.dispose();
    writeFileSync(`${w.root}/data/workflow-bases.json`, '{"bases":[]}\n'); // CAST had none then
    const w2 = makeSys({ workflowId: null, root: w.root });
    await handEdit(w2, id, (s) => s.map((x) => (x.id === 'planner' ? { ...x, thinking: 'xhigh' } : x))); // after it
    const first = await lead(w2, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS });
    expect(first.isError).toBe(true);
    expect(first.text).toContain(`- brainstorm.model — Brainstorm: now ${FLASH} (you sent ${SONNET})`);
    expect(step(stored(w2, id), 'brainstorm').model).toBe(FLASH);
    // the lead sends it again as it was (it didn't read it): goes through — but the hand edit made since stays
    const second = await lead(w2, 'workflow_save', { id, replace: true, name: 'Wuxia', steps: LEAD_STEPS });
    expect(second.isError).toBeFalsy();
    expect(step(stored(w2, id), 'planner').thinking).toBe('xhigh');
    await w2.dispose();
  });
});
