// REGRESSION (was a repro of a bug that is fixed now): PlanGate.#remember keeps one entry per stepName+duty. Two
// changed people with the same name and duty on one card (a parallel pair) used to leave two contradictory entries
// ("Writer (…) → A, Writer (…) → B") for the lead to follow; now the first one counts.
import { afterAll, expect, test } from 'bun:test';
import { cleanup, GEMINI, makeWorld, OPUS, runEnd, SONNET } from '../auto/world';
afterAll(cleanup);

test('modelPrefs: two people with the same name and duty changed on one card → one entry (the first one counts)', async () => {
  const w = makeWorld();
  w.gate.userMessage(w.lead);
  const p = w.call('team_start', {
    task: 'Write chapters 3 and 4',
    steps: [
      { name: 'Writer', model: OPUS, persona: 'You write one chapter of the novel.' },
      { name: 'Writer', model: OPUS, persona: 'You write one chapter of the novel.', parallel: true },
    ],
  });
  const plan = await w.until(() => w.gate.pending()[0]);
  expect(plan.steps.map((s) => s.id)).toEqual(['writer', 'writer-2']);
  const a = await w.gate.answer(plan.id, true, { writer: SONNET, 'writer-2': GEMINI });
  await p;
  await runEnd(w, a.runId!);
  const prefs = w.jobs.get(w.projectId, 'main')!.modelPrefs!;
  expect(prefs.map((x) => `${x.stepName}|${x.duty}|${x.model}`)).toEqual([`Writer|You write one chapter of the novel.|${SONNET}`]);
  const list = await w.call('workflow_list', {});
  const line = list.text.split('\n').find((l: string) => l.startsWith("The user's model choices"));
  expect(line).toBe(`The user's model choices (follow them for these duties): Writer (You write one chapter of the novel.) → ${SONNET}.`);
  w.dispose();
});
