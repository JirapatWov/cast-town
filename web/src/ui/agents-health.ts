// What the app says about the agent and the AI-account check (hello.agents, kept fresh by every `models` push): one
// reading for the banner under the top bar, the top bar's providers button, Models & providers, the composer and the
// boot screen — so they never disagree ("agent not found · real providers connected", a green "0 live", …).
import type { AgentInfo, ServerMsg } from '../../../shared/protocol';
import { storage } from './dom';
import { liveProviders, type ModelState } from '../../../shared/live-providers';
import { noneConnected } from './model-state';
import type { Shell } from './shell';

type Hello = Extract<ServerMsg, { t: 'hello' }>;

export type AgentsState =
  /** Nothing to say: omp runs and the check worked (or went by a saved result). Older servers send no health. */
  | { kind: 'ok' }
  /** The very first account check still runs and there is nothing to go by: a message waits for it. */
  | { kind: 'checking' }
  /** No omp where CAST looks: nobody can work. */
  | { kind: 'omp-missing'; path: string }
  /** No account check has worked (omp too slow, an error): nothing counts as connected, so nobody can work; CAST
   *  retries by itself. */
  | { kind: 'check-failed'; reason: string; checking: boolean; retryAt?: number };

export function agentsState(hello: Hello | null | undefined): AgentsState {
  const a = hello?.agents;
  if (!a) return { kind: 'ok' };
  if (a.omp === 'missing') return { kind: 'omp-missing', path: a.ompPath };
  if (a.models === 'checking') return { kind: 'checking' };
  if (a.models === 'failed') return { kind: 'check-failed', reason: a.modelsError ?? a.ompError ?? 'the agent didn’t answer', checking: a.checking, retryAt: a.retryAt };
  return { kind: 'ok' };
}

/** What lifts the lock on a person whose model isn't connected (format.ts agentBlocked): the server's scripted test
 *  model (hello.demoMode, CAST_MOCK_LLM only), or the first account check still running (a message waits for it). */
export function blockOpts(hello: Hello | null | undefined): { scripted: boolean; checking: boolean } {
  return { scripted: hello?.demoMode === true, checking: agentsState(hello).kind === 'checking' };
}

/** The check worked and no AI account is connected: the town asks to connect one first (top bar Connect AI, the
 *  board's first card, the welcome). Not while omp is missing or a check runs or failed — those say so themselves. */
export function needsAccount(s: ModelState & { hello: Hello | null | undefined }): boolean {
  return agentsState(s.hello).kind === 'ok' && noneConnected(s);
}

/** "Retry" / "Check again": the server joins a check that runs, or starts one (its answer comes as a toast and a
 *  `models` push). */
export function recheckAgents(shell: Shell): void {
  shell.store.send({ t: 'refresh_models' });
}

/** The boot screen's foot line. `models`: what the page knows of the accounts, once the snapshot is in (until then the
 *  line says nothing about them). */
export function bootFootText(hello: Hello | null | undefined, models?: ModelState): string {
  const st = agentsState(hello);
  const omp = hello?.ompVersion
    ? `cast-agent ${hello.ompVersion}`
    : st.kind === 'omp-missing'
      ? 'cast-agent not built'
      : !hello?.agents
        ? 'cast-agent not found'
        : hello.agents.omp === 'checking'
          ? 'checking cast-agent…'
          : 'cast-agent (version unknown)';
  const ai =
    st.kind === 'omp-missing'
      ? 'build the agent to start'
      : st.kind === 'checking'
        ? 'checking AI accounts…'
        : st.kind === 'check-failed'
          ? 'couldn’t check AI accounts'
          : !models
            ? null
            : liveProviders(models) === 0
              ? 'no AI account connected yet'
              : 'AI accounts connected';
  return ai ? `${omp} · ${ai}` : omp;
}

const SEEN_KEY = 'rlt.interrupted.seen';

/** After CAST restarted mid-work, say so once (the chats of those people say what to run again). */
export function noticeInterrupted(shell: Shell, agents: Record<string, AgentInfo>): void {
  const hit = Object.values(agents).filter((a) => a.interrupted);
  if (!hit.length) return;
  const latest = Math.max(...hit.map((a) => a.interrupted!));
  const seen = Number(storage.get(SEEN_KEY) ?? 0);
  if (latest <= seen) return;
  storage.set(SEEN_KEY, String(latest));
  const one = hit.length === 1 ? hit[0]! : null;
  shell.toast(
    'warn',
    one
      ? `CAST restarted while ${one.name} was working — their chat says what to run again.`
      : `CAST restarted while ${hit.length} people were working — their chats say what to run again.`,
    one ? { agentId: one.id } : undefined,
  );
}
