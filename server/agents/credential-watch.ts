// Sign-ins made outside CAST (F4): `omp login google-antigravity` typed in CAST's terminal, `omp logout` in another
// shell, a models.yml edit. CAST asks omp for models and accounts only when something changed (#69), so without this it
// kept the old list until a manual Refresh.
//
// Every few seconds it stats omp's store and config files (cheap). Only when one of them changed does it read the
// credential key (credential-key.ts: the auth_credentials rows, opened read-only with a short busy timeout — omp runs
// its store in WAL mode, so a reader never blocks its writes, and nothing is ever written). A key that differs from the
// one the model list was read under, and holds on the next look (omp may still be writing), is reported once.
// Changes CAST makes itself (its own sign-in and sign-out) are skipped while they run (`busy`) and already match after.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { credentialKey } from './credential-key';
import { errorText, log } from './util';

/** What is stat'ed each round: the store, its write-ahead log, and omp's config files (credential-key.ts reads them). */
const WATCHED = ['agent.db', 'agent.db-wal', 'models.yml', 'models.yaml', 'models.json', 'config.yml', 'config.yaml'];
const INTERVAL_MS = 3000;

export interface CredentialWatchOptions {
  agentDir: string;
  /** How often the files are looked at (default 3 s). A change is reported after two looks agree. */
  intervalMs?: number;
  /** The credential key the model list in use was read under ('' : none yet — then nothing is reported). */
  known(): string;
  /** CAST itself is changing the store or checking the models right now: look again next round. */
  busy(): boolean;
  /** omp's sign-ins changed outside CAST. Not called again until it has resolved. */
  onChange(key: string): Promise<void> | void;
}

export class CredentialWatch {
  #timer: ReturnType<typeof setInterval> | null = null;
  #stamps = '';
  /** A key seen once that differs from `known()`: reported when the next look sees it again. */
  #candidate: string | null = null;
  #running = false;

  constructor(private readonly o: CredentialWatchOptions) {}

  start(): this {
    if (this.#timer) return this;
    this.#stamps = this.#stat();
    this.#timer = setInterval(() => void this.check(), this.o.intervalMs ?? INTERVAL_MS);
    this.#timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One look (the timer's; tests call it directly). Resolves once a reported change has been handled. */
  async check(): Promise<void> {
    if (this.#running) return;
    const stamps = this.#stat();
    // nothing on disk moved and nothing is waiting for a second look: done (the usual case, a few stat calls)
    if (stamps === this.#stamps && this.#candidate === null) return;
    if (this.o.busy()) return; // CAST's own change, or a model check that will read the store anyway: next round
    this.#stamps = stamps;
    const known = this.o.known();
    if (!known) return;
    const key = credentialKey(this.o.agentDir);
    if (!key || key === known) {
      this.#candidate = null;
      return;
    }
    if (this.#candidate !== key) {
      this.#candidate = key; // omp may still be writing: report it when the next look agrees
      return;
    }
    this.#candidate = null;
    this.#running = true;
    try {
      await this.o.onChange(key);
    } catch (err) {
      log('agents', `re-reading the agent's sign-ins failed: ${errorText(err)}`);
    } finally {
      this.#running = false;
    }
  }

  #stat(): string {
    return WATCHED.map((f) => {
      try {
        const st = statSync(join(this.o.agentDir, f));
        return `${Math.round(st.mtimeMs)}:${st.size}`;
      } catch {
        return '-';
      }
    }).join('|');
  }
}
