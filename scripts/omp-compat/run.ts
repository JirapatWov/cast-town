#!/usr/bin/env bun
// omp compatibility suite for CAST: does this agent (cast-agent, or another omp build) still behave the way CAST's
// server/agents/* expects?
//
//   bun run compat:agent [--omp <path-to-agent>] [--work <dir>] [--keep] [--only cli,lead,…] [--verbose]
//
// Starts its own mock LLM and a scratch PI_CODING_AGENT_DIR + HOME (the user's ~/.omp is never read or written),
// spawns omp in --mode rpc-ui exactly like CAST's ProcessPool, and prints PASS/FAIL per behaviour. Exit code 1 on any
// FAIL, 2 on a usage error. See README.md.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Report } from './checks';
import { accountsGroup, advisorGroup, cliGroup, compactionGroup, leadGroup, resumeGroup, type Ctx, type HostToolDef } from './groups';
import { MockLlm, mockModelsYml } from './mock-llm';
import { killAll } from './omp-rpc';

const GROUPS = ['cli', 'accounts', 'lead', 'resume', 'advisor', 'compaction'] as const;
type Group = (typeof GROUPS)[number];

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: bun run scripts/omp-compat/run.ts [--omp <path-to-agent>] [--work <dir>] [--keep] [--only <groups>] [--verbose]');
  console.error(`groups: ${GROUPS.join(', ')} (resume needs lead)`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv.includes('-h') || argv.includes('--help')) usage();
// The agent CAST itself runs from this checkout (server/agents/index.ts resolveOmpBin), unless told otherwise.
const ompArg = opt('--omp') ?? (process.env.CAST_AGENT_BIN?.trim() || join(import.meta.dir, '..', '..', 'agent', 'bin', 'cast-agent'));
if (!existsSync(ompArg)) usage(`agent not found: ${ompArg} (build it with \`bun run build:agent\`, or pass --omp)`);
const bin = resolve(ompArg);
const only = (opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [...GROUPS]) as Group[];
for (const g of only) if (!GROUPS.includes(g)) usage(`unknown group ${g}`);
if (only.includes('resume') && !only.includes('lead')) only.push('lead');
const keep = argv.includes('--keep');
const verbose = argv.includes('--verbose');

// The scratch dir is wiped at the start of a run: only an empty dir or one an earlier run made (marker file) is taken.
const MARKER = '.omp-compat-scratch';
const workArg = opt('--work');
const work = workArg ? resolve(workArg) : mkdtempSync(join(tmpdir(), 'omp-compat-'));
if (workArg && existsSync(work)) {
  if (readdirSync(work).length && !existsSync(join(work, MARKER))) usage(`--work ${work} is not empty and was not made by this suite`);
  rmSync(work, { recursive: true, force: true });
}
mkdirSync(work, { recursive: true });
writeFileSync(join(work, MARKER), 'scratch dir of scripts/omp-compat/run.ts — wiped by the next run\n');

// Ctrl-C: take the omp process groups this run started down with it.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    killAll();
    process.exit(130);
  });
}

const t0 = Date.now();
const mock = new MockLlm();
mock.start();

// Scratch dirs: agent dir (models.yml → the mock), an empty agent dir, HOME, the project, CAST's helper extension root.
const agentDir = join(work, 'agent');
const emptyAgentDir = join(work, 'agent-empty');
const home = join(work, 'home');
const project = join(work, 'project');
const extDir = join(work, 'omp-ext');
const logs = join(work, 'logs');
for (const d of [agentDir, emptyAgentDir, home, project, join(extDir, 'agents'), logs, join(work, 'omp-config')]) mkdirSync(d, { recursive: true });
writeFileSync(join(agentDir, 'models.yml'), mockModelsYml(mock.port));
writeFileSync(join(project, 'a.txt'), 'alpha\n');
writeFileSync(join(project, 'README.md'), '# compat project\n');

// CAST's own definitions when this suite runs inside the CAST tree (the real thing is what omp must accept); a copy
// otherwise. helper-agents.ts renderHelperAgent → <ext>/agents/rlt-mock-b.md; lead-tools.ts LEAD_TOOLS → set_host_tools.
let leadTools: HostToolDef[];
let helperMd: string;
let source = 'CAST';
try {
  const lt = (await import('../../server/agents/lead-tools')) as { LEAD_TOOLS: HostToolDef[] };
  const ha = (await import('../../server/agents/helper-agents')) as { renderHelperAgent(h: { name: string; model: string; label: string }): string };
  leadTools = lt.LEAD_TOOLS;
  helperMd = ha.renderHelperAgent({ name: 'rlt-mock-b', model: 'mockp/mock-b', label: 'Mock B' });
} catch (err) {
  source = `built-in copy (CAST import failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
  const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
  leadTools = [
    { name: 'team_status', label: 'Check on the team', description: "How this job's team run is going.", parameters: NO_ARGS, loadMode: 'essential' },
    { name: 'workflow_list', label: 'List workflows', description: 'The saved workflows and connected models.', parameters: NO_ARGS, loadMode: 'essential' },
    { name: 'workflow_get', label: 'Read a workflow', description: 'One workflow in full.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, loadMode: 'essential' },
  ];
  helperMd = [
    '---',
    'name: "rlt-mock-b"',
    'description: "Helper on Mock B (mockp/mock-b): a general worker like `task`, with full tools but no helpers of its own."',
    'model: "mockp/mock-b"',
    'thinking-level: "auto"',
    'tools: "read, bash, edit, write, grep, glob, find, todo, ask"',
    '---',
    'Worker agent for delegated tasks, running on Mock B. Generated by the omp compat suite.',
    '',
  ].join('\n');
}
writeFileSync(join(extDir, 'agents', 'rlt-mock-b.md'), helperMd);

// agent-system.ts #settingsOverlay: a lead without an advisor, and one with the advisor on another model.
const leadOverlay = join(work, 'omp-config', 'lead.yml');
const advisorOverlay = join(work, 'omp-config', 'advisor.yml');
writeFileSync(leadOverlay, 'goal:\n  continuationModes: [interactive, rpc]\nadvisor:\n  enabled: false\n');
writeFileSync(advisorOverlay, 'goal:\n  continuationModes: [interactive, rpc]\nadvisor:\n  enabled: true\nmodelRoles:\n  advisor: "mockp/mock-b"\n');

// Like CAST's ompEnv() + ProcessPool: PATH with ~/.bun/bin, the launcher on this bun, BUN_OPTIONS ipv4first — but
// nothing else from this shell (no provider keys) and a scratch HOME/agent dir.
const bunBin = join(homedir(), '.bun', 'bin');
const path = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
const baseEnv: Record<string, string> = {
  PATH: path.split(':').includes(bunBin) ? path : `${bunBin}:${path}`,
  CAST_AGENT_BUN: process.execPath,
  HOME: home,
  PI_CODING_AGENT_DIR: agentDir,
  BUN_OPTIONS: '--dns-result-order=ipv4first',
  LANG: process.env.LANG ?? 'C.UTF-8',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};

const report = new Report();
report.verbose = verbose;
const ctx: Ctx = {
  bin,
  work,
  project,
  extDir,
  logs,
  env: baseEnv,
  emptyAgentEnv: { ...baseEnv, PI_CODING_AGENT_DIR: emptyAgentDir },
  mock,
  r: report,
  leadTools,
  leadOverlay,
  advisorOverlay,
  persona: 'You are the lead of the omp compat suite. Answer briefly. [rlt-role:assistant]',
  lead: {},
};

let real = bin;
try {
  real = realpathSync(bin);
} catch {
  /* keep */
}
console.log(`omp compat suite · omp ${bin}${real !== bin ? ` → ${real}` : ''}`);
console.log(`scratch ${work} · mock LLM 127.0.0.1:${mock.port} · CAST defs: ${source}`);
console.log(`groups: ${only.join(', ')}\n`);

const timings: string[] = [];
let version: string | undefined;
const order: Group[] = GROUPS.filter((g) => only.includes(g));
for (const g of order) {
  const g0 = Date.now();
  console.log(`── ${g} ${'─'.repeat(Math.max(0, 60 - g.length))}`);
  try {
    if (g === 'cli') version = (await cliGroup(ctx)).version;
    else if (g === 'accounts') await accountsGroup(ctx);
    else if (g === 'lead') await leadGroup(ctx);
    else if (g === 'resume') await resumeGroup(ctx);
    else if (g === 'advisor') await advisorGroup(ctx);
    else if (g === 'compaction') await compactionGroup(ctx);
  } catch (err) {
    report.group = g;
    report.fail('group', 'the group runs to the end', err instanceof Error ? err.stack ?? err.message : String(err));
  }
  timings.push(`${g} ${((Date.now() - g0) / 1000).toFixed(1)}s`);
}

mock.stop();
const fails = report.failures;
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${'═'.repeat(64)}`);
console.log(`omp ${version ?? '?'} (${real})`);
console.log(`${report.results.length} checks · ${report.results.length - fails.length} passed · ${fails.length} failed · ${secs}s (${timings.join(', ')})`);
if (fails.length) {
  console.log('\nFailed:');
  for (const f of fails) console.log(`  - ${f.group} · ${f.name}`);
  console.log(`\nframe logs kept in ${logs}`);
} else if (!keep) {
  rmSync(work, { recursive: true, force: true });
} else {
  console.log(`scratch kept in ${work}`);
}
process.exit(fails.length ? 1 : 0);
