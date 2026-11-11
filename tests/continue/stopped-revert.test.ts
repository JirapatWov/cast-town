// A run the server stopped midway is in history now (run.json after every group). Found by the X1–X5 e2e: it had no
// end snapshot, so "Revert files" counted everything since its checkpoint as its own — a file the user made after the
// restart (and later runs' work) would be deleted. The engine now takes the end snapshot when it loads such a run.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowRun } from '../../shared/protocol.ts';
import { cleanup, makeCWorld, sleep, step, type CWorld } from './cworld';

afterAll(cleanup);

const count = (list: string[], v: string) => list.filter((x) => x === v).length;

/** Start a→b→c, hold b, and leave the run as a crash would: run.json from mid-run, no undo.json. */
async function crashed(w: CWorld): Promise<WorkflowRun> {
  w.behave.set('b', () => 'hold');
  const run = await w.start([step('a'), step('b'), step('c')]);
  await w.until(() => w.promptsOf('b').length, 3000, 'b prompted');
  await sleep(20);
  const file = join(w.runDir(run.id), 'run.json');
  const snapshot = readFileSync(file, 'utf8');
  await w.engine.abort(run.id);
  await w.settled(run.id);
  writeFileSync(file, snapshot);
  rmSync(join(w.runDir(run.id), 'undo.json'), { force: true });
  w.behave.delete('b');
  return run;
}

test('a run stopped by a crash gets its end snapshot at load; revert undoes only up to it', async () => {
  const w = makeCWorld();
  const run = await crashed(w);
  const before = count(w.checkpoints, `${run.id}-end`); // 1: the abort above
  const e2 = w.restart();
  expect(e2.get(run.id)!.status).toBe('aborted');
  await w.until(() => existsSync(join(w.runDir(run.id), 'undo.json')), 3000, 'undo.json');
  expect(count(w.checkpoints, `${run.id}-end`)).toBe(before + 1);
  const undo = JSON.parse(readFileSync(join(w.runDir(run.id), 'undo.json'), 'utf8'));
  expect(undo.end).toBe(`refs/rlt/checkpoints/${run.id}-end`);
  // on disk it is stopped now, like any run that ended
  expect((JSON.parse(readFileSync(join(w.runDir(run.id), 'run.json'), 'utf8')) as WorkflowRun).status).toBe('aborted');

  await e2.revert(run.id, true);
  expect(w.undoRuns.at(-1)).toEqual({ from: `refs/rlt/checkpoints/${run.id}`, to: `refs/rlt/checkpoints/${run.id}-end` });
  expect(w.checkpoints).not.toContain(`${run.id}-now`); // not "everything since its checkpoint"

  // another restart: the snapshot is not taken again
  w.restart();
  await sleep(30);
  expect(count(w.checkpoints, `${run.id}-end`)).toBe(before + 1);
  w.dispose();
});

test('revert right after the restart waits for that snapshot', async () => {
  const w = makeCWorld();
  const run = await crashed(w);
  const e2 = w.restart();
  await e2.revert(run.id, true); // no wait: revert awaits the pending end snapshot
  expect(w.undoRuns.at(-1)!.to).toBe(`refs/rlt/checkpoints/${run.id}-end`);
  w.dispose();
});

test('runs that ended normally, and a folder without git, take no snapshot at load', async () => {
  const w = makeCWorld();
  const run = await w.start([step('a')]);
  await w.end(run.id);
  await w.settled(run.id);
  const n = w.checkpoints.length;
  w.restart();
  await sleep(30);
  expect(w.checkpoints.length).toBe(n);
  w.dispose();

  const g = makeCWorld({ git: false });
  const r2 = await crashed(g);
  const m = g.checkpoints.length;
  g.restart();
  await sleep(30);
  expect(g.checkpoints.length).toBe(m); // no checkpoint ref on the run: nothing to revert to anyway
  expect(g.engine.get(r2.id)!.status).toBe('aborted');
  g.dispose();
});
