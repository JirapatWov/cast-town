// OmpHealth: is omp there, and which AI accounts does it reach — checked in the background so the server opens its
// port at once (a slow omp used to hold the whole start up for a minute), retried with backoff when a check fails,
// and reported to the app as AgentsHealth.
//
//   first look:  `omp --version` and `omp models --json` side by side (each limited by CAST_AGENT_TIMEOUT). With a
//                model list saved by the last run whose credential files are unchanged, the model check waits a few
//                seconds so it doesn't compete with the first page load: people go by the saved list meanwhile.
//   retries:     after a failed check — omp too slow, erroring — again at 30 s, 1 min, 2 min, then every 5 min
//                (each check is an omp process of a few hundred MB, so never in a tight loop). A missing omp is
//                looked for every 30 s (cheap: the spawn fails at once), so installing it is noticed.
//   Refresh:     joins a running check; reuses the last good result while omp's credential files are unchanged and
//                it is recent (ModelRegistry.upToDate) — otherwise checks again.
import type { AgentsHealth } from '../../shared/protocol';
import { ompVersionWarning } from '../../shared/omp-version';
import type { ModelRegistry } from './models';
import { AGENT_BUILD_HINT, probeOmpVersion, type OmpTimeouts } from './omp-check';
import { log } from './util';

export interface OmpHealthOptions {
  bin: string;
  env: Record<string, string | undefined>;
  models: ModelRegistry;
  timeouts: OmpTimeouts;
  /** Something the app shows changed (a check started or ended): broadcast, and people follow the models found. */
  onChange(what: { modelsChecked: boolean }): void;
  retryDelaysMs?: number[];
  missingRetryMs?: number;
  /** How long the first model check waits when a saved list is in use (default 8 s). */
  savedListDelayMs?: number;
  /** Refresh reuses a good result younger than this while the credential files are unchanged (default 10 min). */
  reuseMs?: number;
}

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const MISSING_RETRY_MS = 30_000;
const REUSE_MS = 10 * 60_000;

export type RefreshOutcome = 'checked' | 'reused';

export class OmpHealth {
  #omp: AgentsHealth['omp'] = 'checking';
  #version: string | null = null;
  #ompError: string | undefined;
  #probing: Promise<void> | null = null;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #retryAt: number | undefined;
  #failures = 0;
  #closed = false;
  #warned = '';

  constructor(private readonly o: OmpHealthOptions) {}

  /** The first look (background: the caller doesn't wait). Resolves when both checks are done (tests await it). */
  async start(): Promise<void> {
    const { models } = this.o;
    const delay = models.hasResult && models.upToDate(Number.POSITIVE_INFINITY) ? (this.o.savedListDelayMs ?? 8000) : 0;
    const version = this.#probe();
    const list = delay
      ? new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => (this.#closed ? undefined : this.#checkModels()))
      : this.#checkModels();
    this.o.onChange({ modelsChecked: false }); // "checking" is news too
    await Promise.all([version, list]);
    this.#afterRound();
  }

  /** Refresh in Models & providers (and Retry on the banner). A missing or broken omp is looked at again too. */
  async refresh(): Promise<RefreshOutcome> {
    if (this.#closed) return 'reused';
    this.#clearRetry();
    const reuse = this.#omp === 'ok' && !this.o.models.checking && this.o.models.upToDate(this.o.reuseMs ?? REUSE_MS);
    if (reuse) {
      this.o.onChange({ modelsChecked: true });
      return 'reused';
    }
    const version = this.#omp === 'ok' ? Promise.resolve() : this.#probe();
    const list = this.#checkModels();
    this.o.onChange({ modelsChecked: false });
    await Promise.all([version, list]);
    this.#afterRound();
    return 'checked';
  }

  /** Look for omp again now when it was missing (a message is about to need it). Cheap: a missing binary fails at once. */
  async recheckMissing(): Promise<void> {
    if (this.#omp !== 'missing' || this.#closed) return;
    await this.#probe();
    if (this.#omp !== 'missing') {
      await this.#checkModels();
      this.#afterRound();
    }
  }

  get version(): string | null {
    return this.#version;
  }

  get omp(): AgentsHealth['omp'] {
    return this.#omp;
  }

  /** What the app shows (hello.agents, models.agents). */
  health(): AgentsHealth {
    const m = this.o.models;
    const state = m.state === 'idle' ? 'checking' : m.state;
    return {
      omp: this.#omp,
      ompPath: this.o.bin,
      ...(this.#ompError ? { ompError: this.#ompError } : {}),
      models: state,
      ...(m.detectError ? { modelsError: m.detectError } : {}),
      ...(m.checkedAt !== null && m.hasResult ? { checkedAt: m.checkedAt } : {}),
      checking: m.checking || !!this.#probing,
      ...(this.#retryAt ? { retryAt: this.#retryAt } : {}),
    };
  }

  /** One line for the start banner / log. */
  summary(): string {
    const m = this.o.models;
    // without omp nobody works: one sentence with the fix, not two failures
    if (this.#omp === 'missing') return `the agent (cast-agent) wasn't found at ${this.o.bin} — nobody can work until it is. ${AGENT_BUILD_HINT}`;
    const omp =
      this.#omp === 'ok' ? `cast-agent ${this.#version}` : this.#omp === 'failed' ? `the agent didn't answer (${this.#ompError})` : 'cast-agent: checking…';
    const models =
      m.state === 'ok' || m.state === 'stale'
        ? m.anyAvailable()
          ? `${m.models().filter((x) => x.available).length} models connected${m.state === 'stale' ? ' (saved list; checking again)' : ''}`
          : m.demoActive()
            ? 'no AI account connected — people run on the scripted model (CAST_MOCK_LLM)'
            : 'no AI account connected yet — connect one in Models & providers'
        : m.state === 'failed'
          ? `couldn't check the AI accounts (${m.detectError}) — ${m.demoActive() ? 'scripted model meanwhile (CAST_MOCK_LLM)' : 'nobody can work until a check works; retrying'}`
          : 'checking the AI accounts…';
    return `${omp} · ${models}`;
  }

  dispose(): void {
    this.#closed = true;
    this.#clearRetry();
  }

  async #checkModels(): Promise<void> {
    const before = this.o.models.checking;
    const run = this.o.models.detect();
    if (!before) this.o.onChange({ modelsChecked: false });
    await run;
  }

  #probe(): Promise<void> {
    this.#probing ??= (async () => {
      const r = await probeOmpVersion(this.o.bin, this.o.env, this.o.timeouts.checkMs);
      if (r.kind === 'ok') {
        const wasOk = this.#omp === 'ok' && this.#version === r.version;
        this.#omp = 'ok';
        this.#version = r.version;
        this.#ompError = undefined;
        if (!wasOk) log('agents', `cast-agent ${r.version} (${this.o.bin})`);
        const warning = ompVersionWarning(r.version);
        if (warning && this.#warned !== r.version) {
          this.#warned = r.version;
          log('agents', `WARNING: ${warning} (${this.o.bin})`);
        }
      } else if (r.kind === 'missing') {
        // the first look is in the start-up summary; this is omp going away while CAST runs
        if (this.#omp !== 'missing' && this.#omp !== 'checking') log('agents', `the agent (cast-agent) wasn't found at ${this.o.bin} — nobody can work. ${AGENT_BUILD_HINT}`);
        this.#omp = 'missing';
        this.#version = null;
        this.#ompError = `nothing to run at ${this.o.bin}`;
      } else {
        // It is there (or something is), but didn't answer: keep a version an earlier probe read.
        log('agents', `cast-agent --version: ${r.error} — trying again later`);
        if (!this.#version) this.#omp = 'failed';
        this.#ompError = r.error;
      }
    })().finally(() => {
      this.#probing = null;
    });
    return this.#probing;
  }

  /** After a round of checks: tell the app, and plan the next try when something failed. */
  #afterRound() {
    if (this.#closed) return;
    const m = this.o.models;
    const failed = this.#omp === 'missing' || this.#omp === 'failed' || !!m.detectError;
    if (!failed) {
      this.#failures = 0;
      this.#clearRetry();
    } else {
      const delays = this.o.retryDelaysMs ?? RETRY_DELAYS_MS;
      const delay = this.#omp === 'missing' ? (this.o.missingRetryMs ?? MISSING_RETRY_MS) : delays[Math.min(this.#failures, delays.length - 1)]!;
      this.#failures++;
      this.#schedule(delay);
    }
    this.o.onChange({ modelsChecked: true });
  }

  #schedule(delay: number) {
    this.#clearRetry();
    this.#retryAt = Date.now() + delay;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#retryAt = undefined;
      if (this.#closed) return;
      void this.#retry();
    }, delay);
    this.#retryTimer.unref?.();
  }

  async #retry() {
    const version = this.#omp === 'ok' ? Promise.resolve() : this.#probe();
    await version;
    // A missing omp: no point asking it for models until it is there.
    if (this.#omp !== 'missing') await this.#checkModels();
    this.#afterRound();
  }

  #clearRetry() {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#retryAt = undefined;
  }
}
