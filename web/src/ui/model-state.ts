// Which AI accounts work, as people should read it, in one place. With none connected nobody can work, so the top bar,
// the More menu and the welcome say so and lead to Models & providers. Pure: no DOM, no store — callers pass what
// they know.
import type { ModelInfo, ProviderStatus } from '../../../shared/protocol';

/** What the town runs on, as far as the client knows. */
export interface ModelState {
  providers: ProviderStatus[];
  models: ModelInfo[];
}

/** Providers (or vendors of a custom provider's models) that are signed in right now. */
export function liveProviders(s: ModelState): number {
  const cards = s.providers.filter((p) => p.connected).length;
  return cards || new Set(s.models.filter((m) => m.available).map((m) => m.vendor)).size;
}

/** No AI account is connected: nobody can work until one is. */
export function noneConnected(s: ModelState): boolean {
  return liveProviders(s) === 0;
}

/** The top bar's model status. 'live': ≥ 1 provider works (the only green state); 'none': nothing is connected, so
 *  nobody can work — the button asks to connect an account. */
export function modelStatus(s: ModelState): { tone: 'live' | 'none'; label: string; aria: string } {
  const live = liveProviders(s);
  if (live === 0) return { tone: 'none', label: 'Connect AI', aria: 'No AI account connected — nobody can work yet. Open Models & providers' };
  return { tone: 'live', label: `${live} live`, aria: `${live} provider${live === 1 ? '' : 's'} connected — open Models & providers` };
}

/** What the omp / AI-account check says (agents-health.ts AgentsState['kind']). */
export type HealthKind = 'ok' | 'checking' | 'omp-missing' | 'check-failed';

export interface ProvidersStatus {
  tone: 'live' | 'none' | 'warn' | 'checking';
  /** The top bar's word ("Connect AI", "2 live", "No agent"). */
  label: string;
  aria: string;
  /** The same in a few words under "Models and providers" in the More menu: a phone's top bar has no room for the
   *  button, and the state must not vanish with it (finding #27). */
  hint: string;
}

/** The providers status everywhere it shows (top bar, More menu): omp missing, the first check running and a failed
 *  check each say so — never a green "0 live" — else modelStatus. */
export function providersStatus(health: HealthKind, s: ModelState): ProvidersStatus {
  if (health === 'omp-missing') return { tone: 'warn', label: 'No agent', aria: 'The agent (cast-agent) isn’t built — open Models & providers', hint: 'Agent not built' };
  if (health === 'checking') return { tone: 'checking', label: 'Checking…', aria: 'Checking AI accounts — open Models & providers', hint: 'Checking…' };
  if (health === 'check-failed') return { tone: 'warn', label: 'Check failed', aria: 'Couldn’t check AI accounts — nobody can work until a check works. Open Models & providers', hint: 'Couldn’t check' };
  const st = modelStatus(s);
  const hint = st.tone === 'none' ? 'Not connected yet' : `${liveProviders(s)} connected`;
  return { ...st, hint };
}
