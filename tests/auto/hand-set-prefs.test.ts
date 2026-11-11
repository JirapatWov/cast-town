// The owner (2026-11-04): a model set by hand in the Workflow tab must not be undone by an older plan-card choice. A
// later card that changes only the effort keeps when the model was picked (modelAt), so the hand-set model still wins;
// merge pieces of workflow-merge.ts without a server: the lead's team_edit save goes into the base (carryOver).
import { afterAll, describe, expect, test } from 'bun:test';
import type { Workflow } from '../../shared/protocol';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryOver, claimStepIds, mergeLeadSave } from '../../server/agents/workflow-merge.ts';
import { normalizeWorkflow, WorkflowStore } from '../../server/agents/workflow-store.ts';
import { cleanup, GPT, makeWorld, OPUS, runEnd, SONNET } from './world';
afterAll(cleanup);

const FLASH = 'google/gemini-4-argon';
const WF: Workflow = {
  id: 'wuxia',
  name: 'Wuxia',
  description: '',
  icon: '',
  steps: [
    { id: 'planner', name: 'Planner', model: OPUS, kind: 'work', persona: 'You plan the arc.', instruction: 'Plan {{task}}' },
    { id: 'brainstorm', name: 'Brainstorm', model: SONNET, kind: 'work', persona: 'You brainstorm ideas.', instruction: 'Ideas from {{prev}}' },
  ],
};

describe('plan cards and a model set by hand', () => {
  test('card picks Opus → hand sets Flash → a card that changes only the effort → the next team still gets Flash', async () => {
    const w = makeWorld();
    w.workflows.save(w.projectId, WF);
    const card = async (answer: (planId: string) => Promise<{ runId?: string }>) => {
      w.gate.userMessage(w.lead);
      const p = w.call('team_start', { task: 'Volume 1', workflow_id: 'wuxia' });
      const plan = await w.until(() => w.gate.pending()[0]);
      const brainstorm = plan.steps.find((s) => s.id === 'brainstorm')!;
      const a = await answer(plan.id);
      await p;
      await runEnd(w, a.runId!);
      return brainstorm;
    };
    await card((id) => w.gate.answer(id, true, { brainstorm: OPUS }));
    expect(w.jobs.get(w.projectId, 'main')!.modelPrefs![0]).toMatchObject({ model: OPUS });

    await new Promise((r) => setTimeout(r, 5));
    w.workflows.save(w.projectId, { ...WF, steps: WF.steps.map((s) => (s.id === 'brainstorm' ? { ...s, model: FLASH } : s)) });
    w.workflows.noteHandSet(w.projectId, 'wuxia', 'brainstorm', 'model'); // what the Workflow tab's save notes
    await new Promise((r) => setTimeout(r, 5));

    const shown = await card((id) => w.gate.answer(id, true, {}, { brainstorm: 'max' }));
    expect(shown.model).toBe(FLASH); // the hand-set model was on the card
    const pref = w.jobs.get(w.projectId, 'main')!.modelPrefs![0]!;
    expect(pref).toMatchObject({ model: OPUS, thinking: 'max' });
    expect(pref.modelAt).toBeLessThan(pref.at); // the model part was picked on the first card

    const third = await card((id) => w.gate.answer(id, true, {}));
    expect(third.model).toBe(FLASH);
    expect(third.thinking).toBe('max');
    // workflow_list doesn't tell the lead to follow the older card model there
    const list = (await w.call('workflow_list', {})).text;
    expect(list).toContain(`Brainstorm (You brainstorm ideas.) → ${OPUS}, effort max, ${FLASH} set by hand in “Wuxia” since — that one runs there`);
    // another house's “Wuxia” with its own hand edit is not this house's: the line stays about this one
    const other = w.addHouse('other');
    w.workflows.save(other, { ...WF, name: 'Wuxia elsewhere', steps: WF.steps.map((s) => (s.id === 'brainstorm' ? { ...s, model: GPT } : s)) });
    w.workflows.noteHandSet(other, 'wuxia', 'brainstorm', 'model');
    const after = (await w.call('workflow_list', {})).text;
    expect(after).not.toContain('Wuxia elsewhere');
    expect(after).not.toContain(`${GPT} set by hand`);
    w.dispose();
  });
});

describe('the lead’s team_edit save goes into the base', () => {
  test('carryOver: the ops’ changes, people added after their neighbour, removed ones gone; hand edits stay differences', () => {
    const base = structuredClone(WF);
    const before: Workflow = { ...WF, steps: WF.steps.map((s) => (s.id === 'planner' ? { ...s, model: FLASH } : s)) }; // planner set by hand
    const writer = { id: 'writer', name: 'Writer', model: GPT, kind: 'work' as const, persona: 'You write.', instruction: 'Write {{prev}}' };
    const after: Workflow = { ...before, steps: [{ ...before.steps[0]!, thinking: 'high' }, writer] }; // the ops: planner effort, brainstorm out, writer in
    const next = carryOver(base, before, after);
    expect(next.steps.map((s) => `${s.id}:${s.model}:${s.thinking ?? '-'}`)).toEqual([`planner:${OPUS}:high`, `writer:${GPT}:-`]);
    // a later save from the lead's old copy with the effort: nothing to keep, the hand-set planner model still is
    const m = mergeLeadSave(next, after, { ...WF, steps: [{ ...WF.steps[0]!, thinking: 'high' }, writer] });
    expect('workflow' in m && m.kept.map((k) => k.key)).toEqual(['planner.model']);
  });
});

describe('round 3: carryOver keeps the base valid and follows the ops', () => {
  const W = (ids: string[], extra: Partial<Record<string, Partial<Workflow['steps'][number]>>> = {}): Workflow => ({
    ...WF,
    steps: ids.map((id) => ({ id, name: id, model: OPUS, kind: 'work' as const, persona: `p ${id}`, instruction: `do ${id}`, ...extra[id] })),
  });
  const ids = (w: Workflow) => w.steps.map((s) => s.id);

  test('the ops’ move goes into the base — unless the people were reordered by hand among them', () => {
    expect(ids(carryOver(W(['p', 'b', 'w']), W(['p', 'b', 'w']), W(['p', 'w', 'b'])))).toEqual(['p', 'w', 'b']);
    expect(ids(carryOver(W(['p', 'b', 'w']), W(['b', 'p', 'w']), W(['b', 'w', 'p'])))).toEqual(['p', 'b', 'w']);
  });

  test('a loop to someone the base lacks goes (valid base); someone the ops added under an id removed by hand is the new one', () => {
    const after = W(['p', 'b', 'w', 'editor', 'checker'], { checker: { kind: 'review', loopBackTo: 'editor', maxLoops: 2 } });
    const next = carryOver(W(['p', 'b', 'w']), W(['p', 'b', 'w', 'editor']), after);
    expect(ids(next)).toEqual(['p', 'b', 'w', 'checker']);
    expect(next.steps.at(-1)!.loopBackTo).toBeUndefined();
    expect(() => normalizeWorkflow(next)).not.toThrow();
    const readded = carryOver(W(['p', 'b', 'w']), W(['p', 'b']), W(['p', 'b', 'w'], { w: { model: FLASH } }));
    expect(readded.steps.find((s) => s.id === 'w')!.model).toBe(FLASH);
  });

  test('a carried team_edit keeps a seeded base seeded; a base row that no longer validates is kept, with its hand-edit times', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cast-test-bases-'));
    const H = 'todo';
    writeFileSync(join(dir, 'workflows.json'), `${JSON.stringify({ version: 2, houses: { [H]: [WF] }, library: [] })}\n`);
    const a = new WorkflowStore(dir);
    expect(a.chatBaseSeeded(H, 'wuxia')).toBe(true);
    a.setChatBase(H, WF, { carry: true });
    expect(a.chatBaseSeeded(H, 'wuxia')).toBe(true);
    a.noteHandSet(H, 'wuxia', 'brainstorm', 'model', 5);
    expect(a.handSetAt('other', 'wuxia', 'brainstorm', 'model')).toBeUndefined(); // the base is the house's
    const bad = { ...WF, steps: [{ ...WF.steps[0]!, kind: 'review', loopBackTo: 'nobody' }, WF.steps[1]!] };
    writeFileSync(join(dir, 'workflow-bases.json'), `${JSON.stringify({ version: 2, bases: [{ projectId: H, workflow: bad, at: 3, handSet: { brainstorm: { model: 5 } } }] })}\n`);
    const b = new WorkflowStore(dir);
    expect(b.chatBaseSeeded(H, 'wuxia')).toBe(false);
    expect(b.handSetAt(H, 'wuxia', 'brainstorm', 'model')).toBe(5);
    expect(b.chatBase(H, 'wuxia')!.steps[0]!.loopBackTo).toBe('nobody');
  });

  test('two names swapped by hand: an id-less person takes the id of the one whose persona the lead sent', () => {
    const base = W(['p', 'b', 'w']);
    base.steps[1]!.name = 'Brainstorm';
    base.steps[2]!.name = 'Writer';
    const now = structuredClone(base);
    now.steps[1]!.name = 'Writer';
    now.steps[2]!.name = 'Brainstorm';
    // the lead re-sends what it read (now), without ids
    const sent = now.steps.map(({ id: _, ...s }) => s);
    const claimed = claimStepIds(sent, now, base).steps as { id: string; name: string }[];
    expect(claimed.map((s) => `${s.id}:${s.name}`)).toEqual(['p:p', 'b:Writer', 'w:Brainstorm']);
  });
});
