// L6–L7: what the lead reads about a run (describeRun via team_status and the team update) — the run id, step ids,
// kept steps, a line of each result, the team_continue hint, earlier runs, run_id — and the demo lead's replies for
// plain runs staying as they were (golden/lead-replies.orig.json, written before the change by gen-golden-lead.ts).
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeRun } from '../../server/agents/lead-tools.ts';
import { parseRunReport, statusReply, updateReply } from '../../server/agents/demo/team.ts';
import { cleanup as cleanupC } from './cworld';
import { leadScenarios } from './lead-scenarios';
import { cleanup, makeWorld, runEnd } from '../auto/world';

afterAll(() => {
  cleanup();
  cleanupC();
});

describe('L6 team_status', () => {
  test('run id, step ids, kept steps, said lines, the hint, earlier runs, run_id', async () => {
    const w = makeWorld();
    w.answer = (step) => (step.kind === 'review' ? `Looks right: ${'the tests pass and the handler validates its input. '.repeat(5)}\n\`\`\`json\n{"verdict":"approve","notes":""}\n\`\`\`` : `${step.name} done`);
    const a = (await w.call('team_start', { task: 'Add PATCH /todos/:id/done' })).text.match(/run (run-\w+)/)![1]!;
    await runEnd(w, a);
    const first = await w.call('team_status', {});
    expect(first.text.split('\n').slice(0, 4)).toEqual([
      expect.stringMatching(/^“Decode → Implement → Review” — completed, \d+s, \$0\.00\.$/),
      'Task: Add PATCH /todos/:id/done',
      `Run ${a}.`,
      'Steps:',
    ]);
    expect(first.text).toContain('- Decoder: done [decoder]\n    said: “Decoder done”\n- Implementer: done [implementer]');
    expect(first.text).toContain('- Reviewer: done (approve) [reviewer]\n    said: “Looks right: the tests pass');
    const said = first.text.match(/- Reviewer: done \(approve\) \[reviewer\]\n {4}said: “(.+)”/)![1]!;
    expect(said.length).toBe(160);
    expect(said.endsWith('…')).toBe(true);
    expect(first.text).toContain('To redo only part of this run: team_continue with from_step (decoder, implementer, reviewer) — the steps before it keep their results; the files stay as they are.');
    expect(first.text).not.toContain('Earlier runs');

    const cont = await w.call('team_continue', { from_step: 'reviewer', note: 'Check the 404 path too.' });
    const b = cont.text.match(/run (run-\w+) — continuing/)![1]!;
    // live: no hint
    const live = await w.call('team_status', {});
    expect(live.text).toContain(`Run ${b} — continues run ${a} from Reviewer, note: “Check the 404 path too.”.`);
    await runEnd(w, b);
    const status = await w.call('team_status', {});
    expect(status.text).toContain(`Run ${b} — continues run ${a} from Reviewer, note: “Check the 404 path too.”.`);
    expect(status.text).toContain(`- Decoder: done (kept from ${a}) [decoder]\n    said: “Decoder done”`);
    expect(status.text).toContain(`- Implementer: done (kept from ${a}) [implementer]`);
    expect(status.text).toContain('- Reviewer: done (approve) [reviewer]');
    expect(status.text).toMatch(new RegExp(`Earlier runs of this job: ${a} “Decode → Implement → Review” completed \\d\\d:\\d\\d\\.`));
    expect(status.text).toContain(`Folder: .rlt/runs/${b}/`);
    // run_id: an older run of this job; another job's or an unknown one: an error
    const older = await w.call('team_status', { run_id: a });
    expect(older.text).toContain(`Run ${a}.`);
    expect(older.text).toContain(`Earlier runs of this job: ${b} “Decode → Implement → Review” completed`);
    const bad = await w.call('team_status', { run_id: 'run-nope' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('No run “run-nope” in this job');
    // the update message's text (no detail, no earlier runs)
    const plain = describeRun(w.engine.get(b)!, w.deps());
    expect(plain).not.toContain('said:');
    expect(plain).not.toContain('Earlier runs');
    expect(plain).toContain('To redo only part of this run:');
    // the demo reads it: names without ids, the run id, kept states
    const r = parseRunReport(status.text);
    expect(r.steps.map((s) => `${s.name}|${s.id}|${s.state}`)).toEqual([`Decoder|decoder|done (kept from ${a})`, `Implementer|implementer|done (kept from ${a})`, 'Reviewer|reviewer|done (approve)']);
    expect(r.runId).toBe(b);
    expect(r.folder).toBe(`.rlt/runs/${b}/`);
    expect(r.name).toBe('Decode → Implement → Review');
    expect(r.status).toBe('completed');
    // the demo's update for a continuation says "kept", not the earlier run's id
    const upd = `[RLT team update] “Decode → Implement → Review” finished after 1s.\n\n${plain}\n\nTell the user briefly.`;
    expect(updateReply(upd, false)).toContain('— Decoder done (kept), Implementer done (kept), Reviewer approved.');
    expect(updateReply(upd, true)).toContain('— Decoder เสร็จ (ใช้ผลเดิม), Implementer เสร็จ (ใช้ผลเดิม), Reviewer อนุมัติ');
    expect(statusReply(status.text, false)).toContain('- Decoder: done (kept)\n- Implementer: done (kept)\n- Reviewer: approved');
    // reverted: the hint says so
    const reverted = { ...w.engine.get(a)!, revertedAt: Date.now() };
    expect(describeRun(reverted, w.deps())).toContain('Its files were reverted, so it can only run again from the start — team_start (or team_continue from its first step).');
    w.dispose();
  });

  test('a note with "in 5 min" or a said line doesn\'t confuse the demo\'s elapsed time', () => {
    const text = [
      '“X” — completed, 2 min, $0.10.',
      'Task: T',
      'Run run-b — continues run run-a from Reviewer, note: “finish in 5 min”.',
      'Steps:',
      '- Reviewer: done (approve) [reviewer]',
      '    said: “ran the tests in 3s”',
      'Folder: .rlt/runs/run-b/ (task.md, then one NN-<step>.md per finished step).',
    ].join('\n');
    expect(parseRunReport(text).elapsed).toBe('2 min');
    expect(statusReply(text, false)).toContain('completed in 2 min');
  });
});

describe('L7 the demo lead\'s replies for plain runs', () => {
  test('statusReply and updateReply as before (golden); a failed run now offers to carry on', async () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dir, 'golden', 'lead-replies.orig.json'), 'utf8')) as Record<string, string>;
    const now = await leadScenarios();
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
    const changed = ['failed/update/en', 'failed/update/th'];
    // by design (g9): the demo lead calls its money what it is — simulated, nothing billed
    const sim = (k: string, s: string) => s.replace(/\$(\d)/g, `${k.endsWith('/th') ? 'ค่าใช้จ่ายจำลอง' : 'simulated cost'} $$$1`);
    for (const k of Object.keys(golden)) if (!changed.includes(k)) expect({ k, reply: now[k] }).toEqual({ k, reply: sim(k, golden[k]!) });
    // by design (spec 2.5): a failed run's update offers to carry on from the step that didn't finish
    expect(now['failed/update/en']).toBe(golden['failed/update/en']!.replace('or start the team again?', 'or carry on from B (the steps before it keep their results)?'));
    expect(now['failed/update/th']).toBe(golden['failed/update/th']!.replace('หรือเริ่มทีมใหม่อีกรอบดีคะ?', 'หรือให้ทีมทำต่อจาก B (ขั้นก่อนหน้าใช้ผลเดิม)ดีคะ?'));
    // short-form updates (no step list) keep the old offer
    expect(updateReply('[RLT team update] “X” failed after 2 min.', false)).toContain('or start the team again?');
  });
});
