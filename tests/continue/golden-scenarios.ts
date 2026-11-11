// Normal runs (no continuation) whose every prompt is recorded, run ids normalized — the E12 golden: the engine's
// refactor (start → #launch, feedback → asked, continue notes) must leave these prompts byte-identical.
import { VERDICT_FOOTER } from '../../server/agents/templates.ts';
import type { WorkflowStep } from '../../shared/protocol.ts';
import { CODE_EXAMPLE, NOVEL_EXAMPLE } from '../legacy-examples.ts';
import { approve, makeCWorld, revise, step } from './cworld';

const norm = (s: string) => s.replace(/run-[a-z0-9]+/g, 'run-ID');

export async function runScenarios(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const record = async (name: string, f: (w: ReturnType<typeof makeCWorld>) => Promise<string>) => {
    const w = makeCWorld();
    const runId = await f(w);
    const end = await w.end(runId);
    out[name] = [`status ${end.status} loop ${end.loop} steps ${end.steps.map((s) => `${s.stepId}:${s.verdict ?? s.status}`).join(',')}`, ...w.asked.map((a) => `${a.step}: ${norm(a.text)}`)];
    w.dispose();
  };

  // 1. The old example code team as a one-off team: the reviewer sends it back once.
  await record('code-revise-once', async (w) => {
    w.behave.set('reviewer', (_t, n) => (n === 1 ? revise('Add a test for the empty list.\n- and handle 404') : approve()));
    w.behave.set('decoder', () => 'Plan: add PATCH /todos/:id/done');
    w.behave.set('implementer', (_t, n) => `Implemented (round ${n}).`);
    return (await w.start(structuredClone(CODE_EXAMPLE.steps), 'Add PATCH /todos/:id/done with a test')).id;
  });

  // 2. Parallel groups and a review loop into a group (p3-engine's case).
  await record('parallel-loop', async (w) => {
    w.behave.set('r2', (_t, n) => (n === 1 ? revise('w2 must cite sources') : approve()));
    return (
      await w.start([
        step('w1'),
        step('w2', { parallel: true }),
        step('r1', { kind: 'review', loopBackTo: 'w1', maxLoops: 2, instruction: `Check {{prev}}{{feedback}}\n${VERDICT_FOOTER}` }),
        step('r2', { kind: 'review', loopBackTo: 'w2', maxLoops: 2, parallel: true, instruction: `Check {{prevName}}: {{prev}}\n${VERDICT_FOOTER}` }),
      ])
    ).id;
  });

  // 3. The novel team: the editor keeps asking for changes until its loops run out.
  await record('novel-loops-out', async (w) => {
    w.behave.set('editor', (_t, n) => revise(`Round ${n}: tighten the dialogue.`));
    return (await w.start(structuredClone(NOVEL_EXAMPLE.steps), 'เขียนบทที่ 3')).id;
  });

  // 4. The job's own team (standing people) from the house's workflow.
  await record('own-team', async (w) => {
    w.city.updateProject(w.projectId, { workflowId: CODE_EXAMPLE.id });
    w.jobs.update(w.projectId, 'main', { workflowId: CODE_EXAMPLE.id });
    w.behave.set('reviewer', (_t, n) => (n === 1 ? revise('Missing test.') : approve()));
    return (await w.startSaved(CODE_EXAMPLE.id, 'Own team task')).id;
  });

  // 5. One step only; a first group of two; a review looping back to a first-group member with two revisers.
  await record('single', async (w) => (await w.start([step('solo', { instruction: 'Just {{task}} — {{prevName}} / {{prev}}{{feedback}}' })])).id);
  await record('first-group-two-revisers', async (w) => {
    w.behave.set('c', (_t, n) => (n === 1 ? revise('c says redo') : approve()));
    w.behave.set('d', (_t, n) => (n === 1 ? revise('d says redo') : approve()));
    const steps: WorkflowStep[] = [
      step('a'),
      step('b', { parallel: true }),
      step('c', { kind: 'review', loopBackTo: 'b', maxLoops: 1, instruction: `Review {{prev}}\n${VERDICT_FOOTER}` }),
      step('d', { kind: 'review', loopBackTo: 'a', maxLoops: 1, parallel: true, instruction: `Review too {{prevName}}{{feedback}}\n${VERDICT_FOOTER}` }),
      step('e'),
    ];
    return (await w.start(steps)).id;
  });
  return out;
}
