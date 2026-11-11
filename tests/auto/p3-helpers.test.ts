import { tmpdir } from 'node:os';
// Phase 3: a model per helper — the generated rlt-* agents (names, frontmatter omp parses, rewrite on model changes),
// ModelRegistry.helperModels (connected only, through sign-in channels), --extension in the pool's spawn args (real
// models only), workflow_list's helper line, the lead persona line, and the "A → B + C → D" chains.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELPER_TOOLS, helperAgents, renderHelperAgent, writeHelperAgents } from '../../server/agents/helper-agents.ts';
import { teamChain } from '../../server/agents/lead-tools.ts';
import { ModelRegistry } from '../../server/agents/models.ts';
import { ProcessPool, type ProcessSpec } from '../../server/agents/process-pool.ts';
import { leadSpec } from '../../server/agents/residents.ts';
import { importOmpSource } from '../helpers/omp-source';
import { cleanup, makeWorld, OPUS } from './world';

/** The agent's own agent-file parser (agent/packages/coding-agent/src/task/agents.ts): the test that uses it is skipped
 *  until agent/ is built (see tests/helpers/omp-source.ts; CAST_OMP_SRC points at another omp source). */
type ParsedAgent = { name: string; model?: string[]; tools?: string[]; spawns?: unknown; blocking?: boolean; thinkingLevel?: unknown; description?: string };
const ompAgents = await importOmpSource<{ parseAgent: (file: string, text: string, source: string, onError: string) => ParsedAgent }>('src/task/agents.ts');

const tmp = mkdtempSync(join(tmpdir(), 'cast-test-tmp-p3h-'));
afterAll(() => {
  cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake omp: `models --json` prints the given models; anything else records its args and exits. */
function fakeOmp(name: string, models: { provider: string; id: string }[]): { bin: string; argsFile: string } {
  const bin = join(tmp, `${name}.sh`);
  const argsFile = join(tmp, `${name}.args`);
  const json = JSON.stringify({ models: models.map((m) => ({ ...m, selector: `${m.provider}/${m.id}` })) });
  writeFileSync(bin, `#!/bin/bash\nif [ "$1" = models ]; then echo '${json}'; exit 0; fi\nprintf '%s\\n' "$@" >> ${argsFile}\necho '---' >> ${argsFile}\nexit 3\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile };
}

describe('helpers by model', () => {
  test('one helper per connected catalog model, named after the model id, on the selector omp reaches it by', async () => {
    const { bin } = fakeOmp('omp1', [
      { provider: 'anthropic', id: 'claude-opus-5-5' },
      { provider: 'openai-codex', id: 'gpt-6.1-sol' }, // a ChatGPT sign-in serving the catalog's openai/gpt-6.1-sol
      { provider: 'zai', id: 'glm-9' }, // a connected extra outside the catalog: no helper (keeps the task tool short)
    ]);
    const models = new ModelRegistry(bin, { HOME: tmp, PATH: process.env.PATH });
    await models.detect();
    expect(models.helperModels()).toEqual([
      { id: 'anthropic/claude-opus-5-5', selector: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'openai/gpt-6.1-sol', selector: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    ]);
    expect(helperAgents(models.helperModels())).toEqual([
      { name: 'rlt-claude-opus-5-5', model: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' },
      { name: 'rlt-gpt-6-1-sol', model: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    ]);
    // a model a workflow uses joins the catalog (noteSelectors) → it gets a helper when connected
    models.noteSelectors(['zai/glm-9']);
    expect(helperAgents(models.helperModels()).map((h) => h.name)).toContain('rlt-glm-9');
  });

  test('nothing connected → no helpers', async () => {
    const { bin } = fakeOmp('omp0', []);
    const models = new ModelRegistry(bin, { HOME: tmp, PATH: process.env.PATH });
    await models.detect();
    expect(models.helperModels()).toEqual([]);
  });

  test('two providers with the same model id get distinct names', () => {
    expect(
      helperAgents([
        { id: 'anthropic/claude-x', selector: 'anthropic/claude-x', label: 'X' },
        { id: 'openrouter/claude-x', selector: 'openrouter/claude-x', label: 'X (OpenRouter)' },
      ]).map((h) => h.name),
    ).toEqual(['rlt-claude-x', 'rlt-openrouter-claude-x']);
  });

  test.skipIf(!ompAgents)("omp's own parser reads the agent file: model, tools without task, no blocking, auto thinking, no spawns", () => {
    const h = { name: 'rlt-claude-opus-5-5', model: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' };
    const a = ompAgents!.parseAgent('/x/rlt-claude-opus-5-5.md', renderHelperAgent(h), 'user', 'fatal');
    expect(a.name).toBe('rlt-claude-opus-5-5');
    expect(a.model).toEqual(['anthropic/claude-opus-5-5']);
    expect(a.tools).toContain('bash');
    expect(a.tools).toContain('edit');
    expect(a.tools).not.toContain('task');
    expect(a.spawns).toBeUndefined();
    expect(a.blocking).toBeFalsy();
    expect(String(a.thinkingLevel)).toBe('auto');
    expect(a.description).toContain('Helper on Claude Opus 5.5');
    expect(HELPER_TOOLS).not.toContain('task');
  });

  test('writeHelperAgents: agents/<name>.md under a constant root, stale rlt-* removed, unchanged files left alone, no module at the root', () => {
    const data = join(tmp, 'data1');
    const a = { name: 'rlt-a', model: 'p/a', label: 'A' };
    const b = { name: 'rlt-b', model: 'p/b', label: 'B' };
    const root = writeHelperAgents(data, [a, b]);
    expect(root).toBe(join(data, 'omp-ext'));
    expect(readdirSync(join(root, 'agents')).sort()).toEqual(['rlt-a.md', 'rlt-b.md']);
    writeFileSync(join(root, 'agents', 'mine.md'), 'not RLT’s');
    const before = Bun.file(join(root, 'agents', 'rlt-a.md')).lastModified;
    Bun.sleepSync(20);
    expect(writeHelperAgents(data, [a])).toBe(root); // b signed out of
    expect(readdirSync(join(root, 'agents')).sort()).toEqual(['mine.md', 'rlt-a.md']);
    expect(Bun.file(join(root, 'agents', 'rlt-a.md')).lastModified).toBe(before);
    expect(readdirSync(root).filter((f) => /\.(ts|js|json)$/.test(f))).toEqual([]);
  });
});

describe('--extension in the spawn args', () => {
  const spec = (over: Partial<ProcessSpec>): ProcessSpec => ({
    agentId: 'p:main:x', projectId: 'p', roleId: 'x', cwd: tmp, model: OPUS, demo: false, approvalMode: 'write', systemPrompt: 'hi', sessionDir: join(tmp, 'sess'), ...over,
  });
  const pool = (bin: string) =>
    new ProcessPool({ ompBin: bin, baseEnv: { PATH: process.env.PATH }, demoAgentDir: join(tmp, 'demo'), dataDir: join(tmp, 'pooldata'), onFrame() {}, onExit() {}, isBusy: () => false });

  test('a real model gets --extension <root>; a demo person (no extensionDir) does not', async () => {
    mkdirSync(join(tmp, 'pooldata'), { recursive: true });
    const { bin, argsFile } = fakeOmp('ompargs', []);
    await pool(bin).acquire(spec({ extensionDir: '/data/omp-ext' })).catch(() => {});
    const runs = readFileSync(argsFile, 'utf8').split('---\n').filter(Boolean);
    const args = runs[0]!.trim().split('\n');
    expect(args.slice(args.indexOf('--extension'), args.indexOf('--extension') + 2)).toEqual(['--extension', '/data/omp-ext']);
    rmSync(argsFile);
    await pool(bin).acquire(spec({ agentId: 'p:main:y', demo: true, model: 'rlt-demo/claude-opus-5-5' })).catch(() => {});
    expect(readFileSync(argsFile, 'utf8')).not.toContain('--extension');
  });
});

describe('what the lead reads', () => {
  test('workflow_list: "Helpers by model (task tool `agent`)" when something is connected', async () => {
    const w = makeWorld({ available: [OPUS] });
    const text = (await w.call('workflow_list', {}, { helpers: () => [{ name: 'rlt-claude-opus-5-5', label: 'Claude Opus 5.5' }] })).text;
    expect(text).toContain('Helpers by model (task tool `agent`): rlt-claude-opus-5-5 (Claude Opus 5.5).');
    const none = (await w.call('workflow_list', {})).text;
    expect(none).not.toContain('Helpers by model');
    w.dispose();
  });

  test('the lead persona tells it how to pick a helper model (every work style)', () => {
    const w = makeWorld();
    const project = w.city.project(w.projectId)!;
    for (const style of ['ask', 'auto', 'solo'] as const) {
      const job = { ...w.jobs.get(w.projectId, 'main')!, workStyle: style };
      expect(leadSpec(project, job, [job]).persona).toContain("Pick a helper's model with the task item's agent (rlt-* helpers, connected models only).");
    }
    w.dispose();
  });

  test('teamChain joins people who work at the same time with +', () => {
    expect(teamChain([{ name: 'A' }, { name: 'B' }, { name: 'C', parallel: true }, { name: 'D' }])).toBe('A → B + C → D');
    expect(teamChain([{ name: 'A' }, { name: 'B' }])).toBe('A → B');
  });

  test('team_start with a parallel one-off team: started text, plan card and run.team keep the group', async () => {
    const w = makeWorld();
    const steps = [
      { name: 'Researcher 1', model: OPUS, persona: 'You research part one.' },
      { name: 'Researcher 2', model: OPUS, persona: 'You research part two.', parallel: true },
      { name: 'Summarizer', model: OPUS, persona: 'You merge what they found.' },
    ];
    const r = await w.call('team_start', { task: 'Research X and Y', steps });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Started “Team for this task” \(Researcher 1 \+ Researcher 2 → Summarizer\), run run-/);
    const runId = r.text.match(/run (run-[\w]+)/)![1]!;
    expect(w.engine.get(runId)!.team!.map((m) => `${m.id}${m.parallel ? '+' : ''}`)).toEqual(['x-researcher-1', 'x-researcher-2+', 'x-summarizer']);
    const team = JSON.parse(readFileSync(join(w.city.project(w.projectId)!.path, '.rlt/runs', runId, 'team.json'), 'utf8'));
    expect(team[1].parallel).toBe(true);
    const end = await w.until(() => {
      const x = w.engine.get(runId)!;
      return x.status === 'completed' ? x : null;
    });
    expect(end.steps[0]!.startedAt).toBe(end.steps[1]!.startedAt);
    const summ = w.prompts.find((p) => p.agentId.endsWith(':x-summarizer'))!.text;
    expect(summ).toContain('Researcher 1 + Researcher 2 handed this on:\n## Researcher 1\nResearcher 1 done\n\n## Researcher 2\nResearcher 2 done');
    // a plan card shows the parallel flag (a user message makes the next team ask first)
    w.gate.userMessage(w.lead);
    const pending = w.call('team_start', { task: 'Again', steps });
    const card = await w.until(() => w.gate.pending()[0]);
    expect(card.steps.map((s) => !!s.parallel)).toEqual([false, true, false]);
    await w.gate.answer(card.id, false, {});
    expect((await pending).text).toMatch(/cancelled this plan/);
    w.dispose();
  });

  test('describeRun marks who worked at the same time', async () => {
    const { describeRun } = await import('../../server/agents/lead-tools.ts');
    const w = makeWorld();
    const r = await w.call('team_start', { task: 'T', steps: [{ name: 'A', model: OPUS, persona: 'a' }, { name: 'B', model: OPUS, persona: 'b', parallel: true }] });
    const runId = r.text.match(/run (run-[\w]+)/)![1]!;
    const run = await w.until(() => (w.engine.get(runId)!.status === 'completed' ? w.engine.get(runId) : null));
    const text = describeRun(run, { workflows: w.workflows, store: w.store });
    expect(text).toContain('- A: done');
    expect(text).toContain('- B (at the same time as the one before): done');
    w.dispose();
  });
});

void existsSync;
