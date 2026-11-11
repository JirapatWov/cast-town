// Agent system entry point (see server/contracts.ts and ARCHITECTURE.md "Server → Agent system").
//
//   createAgentSystem(deps, o) → detects omp + credentialed models and returns the AgentSystem the core dispatches
//   client messages to. With o.mockLlm (CAST_MOCK_LLM, tests/dev only) it also writes data/omp-demo-agent/ and starts
//   the local scripted model, which people run on while nothing is connected.
//
// It returns at once: omp and the AI accounts are checked in the background (omp-health.ts), so the server opens its
// port without waiting for a slow omp; the app hears the result as a 'models' message with AgentsHealth.
//
// Extra environment for every omp child comes from <dataDir>/config.json "ompEnv" (omp-env.ts; the server's own wins).
//
// Env knobs: CAST_AGENT_BIN (the agent to run; see resolveOmpBin), RLT_OMP_FRAME_LOG (JSONL of every omp frame),
//            CAST_AGENT_TIMEOUT / CAST_AGENT_START_TIMEOUT (seconds; see omp-check.ts),
//            CAST_KEY_CHECK=0 (save a pasted API key without asking its vendor first: offline machines).
//            Only with CAST_MOCK_LLM: RLT_MOCK_PORT (scripted model port, default 4871), RLT_MOCK_SPEED (pacing
//            multiplier, default 1), RLT_MOCK_LOG (JSONL request log path), RLT_MOCK_DUMP_DIR (raw request bodies).
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_NAME } from '../../shared/omp-version';
import { MOCK_LLM_PORT } from '../../shared/protocol';
import type { AgentSystem, AgentSystemDeps } from '../contracts';
import { jobDir, worktreeRootFor } from '../worktrees';
import { binaryDir, COMPILED, SOURCE_ROOT } from '../runtime';
import { AgentSystemImpl } from './agent-system';
import { writeDemoAgentDir } from './demo-agent-dir';
import { checkApiKey } from './api-key-check';
import type { KeyCheck } from './google-auth';
import { LocalServers } from './local-models';
import { startMockLlm, type MockLlm } from './mock-llm';
import { ModelRegistry } from './models';
import { envSetting, ompTimeouts } from './omp-check';
import { OmpEnv } from './omp-env';
import { OmpHealth } from './omp-health';
import { errorText, log } from './util';
import { WorkflowStore, type WorkflowMigration } from './workflow-store';

/** Environment for agent children: the user's env plus ~/.bun/bin on PATH (where bun installs itself: a service's
 *  PATH often lacks it, and people's commands may need bun). The agent/bin/cast-agent launcher runs on CAST_AGENT_BUN,
 *  else `bun` on PATH: point it at the bun running CAST, so it never depends on PATH. Not from a compiled CAST: its
 *  process.execPath is cast-server, which would start another CAST instead of the agent (a compiled CAST ships a
 *  standalone cast-agent, which needs no bun). */
export function ompEnv(env: Record<string, string | undefined> = process.env, compiled = COMPILED, execPath = process.execPath): Record<string, string | undefined> {
  const home = env.HOME || homedir();
  const bunBin = join(home, '.bun', 'bin');
  const path = env.PATH ?? '';
  const out: Record<string, string | undefined> = { ...env, PATH: path.split(':').includes(bunBin) ? path : `${bunBin}:${path}` };
  const agentBun = env.CAST_AGENT_BUN || (compiled ? undefined : execPath);
  if (agentBun) out.CAST_AGENT_BUN = agentBun;
  return out;
}

/** Which agent CAST runs: CAST_AGENT_BIN when set, else — for a compiled CAST — the cast-agent shipped next to the
 *  binary (the kit, CAST.app's Resources), else agent/bin/cast-agent of the CAST folder the server runs from. Nothing
 *  else is looked for: when it isn't there (or isn't built), the check says so and how to build it. */
export function resolveOmpBin(env: Record<string, string | undefined>, bundled: string | null = COMPILED ? join(binaryDir(), AGENT_NAME) : null, repoRoot: string | null = SOURCE_ROOT): string {
  return env.CAST_AGENT_BIN?.trim() || bundled || join(repoRoot ?? binaryDir(), 'agent', 'bin', AGENT_NAME);
}

/** For moving a workflows.json from before workflows belonged to houses (workflow-store.ts), and used once to give
 *  example teams to the houses that use them: the houses there are, and which of them use a workflow — as the house's
 *  team or a job's, or in a run of it kept on disk (<house>/.rlt/runs and the jobs' own copies,
 *  <data>/worktrees/<house>/<job>/.rlt/runs; read once, only when there is an old file to move).
 *  Never throws: a file it can't read is skipped. */
export function workflowUsers(deps: Pick<AgentSystemDeps, 'city' | 'jobs' | 'dataDir'>): WorkflowMigration {
  const projects = () => {
    try {
      return deps.city.get().projects;
    } catch {
      return [];
    }
  };
  let onDisk: Map<string, Set<string>> | null = null; // workflow id → the houses with a run of it
  const runsOnDisk = () => {
    if (onDisk) return onDisk;
    onDisk = new Map();
    for (const p of projects()) {
      const folders = new Set([p.path]);
      try {
        for (const j of deps.jobs.list(p.id)) if (j.worktree) folders.add(jobDir(p, j));
      } catch {
        /* the jobs can't be read: the copies on disk are still looked at */
      }
      try {
        for (const jobId of readdirSync(join(deps.dataDir, 'worktrees', p.id))) folders.add(worktreeRootFor(deps.dataDir, p.id, jobId));
      } catch {
        /* no job has its own copy */
      }
      for (const folder of folders) {
        let ids: string[];
        try {
          ids = readdirSync(join(folder, '.rlt/runs'));
        } catch {
          continue; // no runs there
        }
        for (const id of ids) {
          try {
            const wid = (JSON.parse(readFileSync(join(folder, '.rlt/runs', id, 'run.json'), 'utf8')) as { workflowId?: unknown } | null)?.workflowId;
            if (typeof wid !== 'string' || !wid) continue; // a one-off team
            let houses = onDisk.get(wid);
            if (!houses) onDisk.set(wid, (houses = new Set()));
            houses.add(p.id);
          } catch {
            /* not a run (or unreadable): skipped */
          }
        }
      }
    }
    return onDisk;
  };
  return {
    houses: () => projects().map((p) => p.id),
    usersOf(workflowId) {
      const out = new Set<string>();
      for (const p of projects()) {
        if (p.workflowId === workflowId) out.add(p.id);
        try {
          if (deps.jobs.list(p.id).some((j) => j.workflowId === workflowId)) out.add(p.id);
        } catch {
          /* the jobs can't be read */
        }
      }
      for (const p of runsOnDisk().get(workflowId) ?? []) out.add(p);
      return [...out];
    },
  };
}

export async function createAgentSystem(deps: AgentSystemDeps, o: { mockLlm?: boolean } = {}): Promise<AgentSystem> {
  const env = ompEnv();
  // config.json's extra environment goes into `env` before anything copies it (the first model check sees a saved key).
  const extraEnv = new OmpEnv({ configFile: join(deps.dataDir, 'config.json'), env }).load();
  const keyCheck = /^(0|off|false|no)$/i.test(envSetting(process.env, 'KEY_CHECK') ?? '') ? async (): Promise<KeyCheck> => ({ ok: true }) : checkApiKey;
  const ompBin = resolveOmpBin(process.env);
  const timeouts = ompTimeouts(process.env);
  const agentDir = env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), '.omp', 'agent');
  // The last good model list is kept in the data dir: a restart on a slow machine goes by it until omp answers.
  // Its fingerprint includes config.json's extra environment (a key edited by hand there is checked on Refresh).
  const models = new ModelRegistry(ompBin, env, { cacheFile: join(deps.dataDir, 'models-cache.json'), agentDir, timeoutMs: timeouts.checkMs, envKey: () => extraEnv.key(), scripted: !!o.mockLlm });
  // (the move of an old workflows.json reads the jobs: a Main job made then gets the lead model AgentSystemImpl gives it)
  deps.jobs.setDefaultLeadModel(() => ({ model: models.preferredAssistantModel(), connected: models.anyAvailable() }));
  const workflows = new WorkflowStore(deps.dataDir, { migrate: workflowUsers(deps) });
  models.noteSelectors(workflows.all().flatMap((w) => w.steps.map((s) => s.model)));

  // The scripted model (tests/dev only): nothing of it exists without CAST_MOCK_LLM — no port, no omp-demo-agent/.
  let mockPort: number | undefined;
  let demoAgentDir: string | undefined;
  let mock: MockLlm | null = null;
  let mockError: string | null = null;
  if (o.mockLlm) {
    mockPort = Number(process.env.RLT_MOCK_PORT ?? MOCK_LLM_PORT);
    demoAgentDir = writeDemoAgentDir(deps.dataDir, mockPort, models.demoCatalog());
    try {
      mock = startMockLlm({ port: mockPort, speed: Number(process.env.RLT_MOCK_SPEED ?? 1) || 1, logFile: process.env.RLT_MOCK_LOG, dumpDir: process.env.RLT_MOCK_DUMP_DIR });
      log('agents', `scripted model listening on 127.0.0.1:${mockPort} (CAST_MOCK_LLM)`);
    } catch (err) {
      mockError = `could not listen on port ${mockPort} (${errorText(err)})`;
      log('agents', `scripted model ${mockError}`);
    }
  }

  let sys: AgentSystemImpl | undefined;
  let announced = false;
  const health = new OmpHealth({
    bin: ompBin,
    env,
    models,
    timeouts,
    onChange: (what) => {
      if (what.modelsChecked && !models.checking && !announced) {
        announced = true;
        log('agents', health.summary());
      }
      try {
        sys?.healthChanged(what.modelsChecked);
      } catch (err) {
        log('agents', `applying the agent check failed: ${errorText(err)}`);
      }
    },
  });
  sys = new AgentSystemImpl({ deps, models, workflows, ompBin, ompVersion: null, health, timeouts, env, ompEnv: extraEnv, checkKey: keyCheck, localServers: new LocalServers(agentDir, { env }), demoAgentDir, mock, mockError, mockPort, frameLog: process.env.RLT_OMP_FRAME_LOG, credentialWatch: { agentDir } });
  void health.start();
  return sys;
}

export type { AgentSystem };
