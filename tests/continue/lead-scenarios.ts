// Plain runs (no continuation) as the lead sees them — team_status (describeRun) through the demo's statusReply,
// and the "[RLT team update]" through updateReply — for the L7 golden: the new describeRun lines ([id], Run <id>,
// the team_continue hint, earlier runs) must leave the demo's replies for these runs as they were.
import { describeRun, runLeadTool } from '../../server/agents/lead-tools.ts';
import { statusReply, updateReply } from '../../server/agents/demo/team.ts';
import { duration } from '../../server/agents/lead-tools.ts';
import type { WorkflowRun } from '../../shared/protocol.ts';
import { makeCWorld, revise, approve, step, sleep } from './cworld';

const norm = (s: string) => s.replace(/run-[a-z0-9]+/g, 'run-ID').replace(/\b\d+s\b/g, 'Ns');

function update(run: WorkflowRun, text: string): string {
  const how = run.status === 'completed' ? 'finished' : run.status === 'aborted' ? 'was stopped' : 'failed';
  return [`[RLT team update] “${run.workflowName}” ${how} after ${duration((run.endedAt ?? Date.now()) - run.startedAt)}.`, text, 'Tell the user briefly.'].join('\n\n');
}

export async function leadScenarios(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const status = async (w: ReturnType<typeof makeCWorld>) =>
    (await runLeadTool({ tool: 'team_status', args: {}, agentId: w.agent('assistant'), projectId: w.projectId, jobId: 'main' }, { engine: w.engine, workflows: w.workflows, store: w.store } as never)).text;
  const record = (name: string, run: WorkflowRun, statusText: string, w: ReturnType<typeof makeCWorld>) => {
    const d = { workflows: w.workflows, store: w.store };
    for (const thai of [false, true]) {
      out[`${name}/status/${thai ? 'th' : 'en'}`] = norm(statusReply(statusText, thai));
      if (run.status !== 'running' && run.status !== 'waiting_approval') out[`${name}/update/${thai ? 'th' : 'en'}`] = norm(updateReply(update(run, describeRun(run, d)), thai));
    }
  };
  {
    const w = makeCWorld();
    w.behave.set('r', (_t, n) => (n === 1 ? revise('Fix it.') : approve('Good — tests pass in 3s.')));
    const run = await w.start([step('a'), step('b'), step('c', { parallel: true }), step('r', { kind: 'review', loopBackTo: 'a', maxLoops: 2 })], 'Ship it');
    const end = await w.end(run.id);
    record('completed', end, await status(w), w);
    w.dispose();
  }
  {
    const w = makeCWorld();
    w.behave.set('b', () => ({ status: 'error', text: '', error: 'boom' }));
    const run = await w.start([step('a'), step('b'), step('c')], 'Ship it');
    const end = await w.end(run.id);
    record('failed', end, await status(w), w);
    w.dispose();
  }
  {
    const w = makeCWorld();
    w.behave.set('b', () => 'hold');
    const run = await w.start([step('a'), step('b'), step('c')], 'Ship it');
    await w.until(() => w.promptsOf('b').length, 3000);
    record('running', w.engine.get(run.id)!, await status(w), w);
    await w.engine.abort(run.id);
    const end = await w.end(run.id);
    await sleep(20);
    record('stopped', end, await status(w), w);
    w.dispose();
  }
  return out;
}
