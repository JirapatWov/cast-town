// E12: normal runs (no continuation) prompt every person byte-identically to the engine before the continuation
// change (golden/prompts.json was written by gen-golden.ts against that engine: the `asked`/feedback refactor, the
// start → #launch split and the continue notes change nothing for them).
import { afterAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup } from './cworld';
import { runScenarios } from './golden-scenarios';

afterAll(cleanup);

test('E12: every prompt of six normal runs is byte-identical to the golden', async () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dir, 'golden', 'prompts.orig-engine.json'), 'utf8')) as Record<string, string[]>;
  const now = await runScenarios();
  expect(Object.keys(now)).toEqual(Object.keys(golden));
  for (const k of Object.keys(golden)) expect({ k, prompts: now[k] }).toEqual({ k, prompts: golden[k] });
  // the golden covers feedback after a loop, parallel notes, verdict footers, a first group, standing people
  const all = Object.values(golden).flat().join('\n');
  for (const s of ['asked for changes — address every point:', 'Others work at the same time as you', '"verdict": "approve" | "revise"', '(You are first — there is no previous step.)']) expect(all).toContain(s);
  expect(golden['own-team']![0]).toContain('decoder:done');
});
