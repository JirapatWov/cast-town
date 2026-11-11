// Provider accounts (Models & providers → Accounts): which credentials omp holds for the providers RLT signs in to,
// signing one out, and how much of each account's usage limits is used.
// The featured providers (ACCOUNT_PROVIDERS) are always asked about; any other sign-in of omp's menu
// (shared/omp-login-providers.ts) is asked about once omp says it is signed in (get_login_providers), so a GitHub
// Copilot, Cursor or Cerebras sign-in shows up with its accounts too.
// Accounts are listed and removed through a short-lived `omp --mode rpc-ui` (get_logout_accounts / logout — what
// omp's /logout uses); limits come from `omp usage --json`. omp keeps the credentials (~/.omp/agent) and only ever
// reports labels and ids here, never keys or tokens. Logs carry the provider and credential id, nothing personal.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { LOGIN_CREDENTIAL_PROVIDERS, credentialProviderOf } from '../../shared/omp-logins';
import { sameUsageAccount, type AccountUsage, type ProviderAccount, type UncheckedAccount, type UsageIdentity, type UsageLimit, type UsageSnapshot } from '../../shared/protocol';
import { trackGroup } from '../child-groups';
import { vendorOfProvider } from './models';
import { OmpCommandError, OmpProcess } from './omp-process';
import { errorText, log } from './util';

/** The omp login providers whose accounts RLT shows (web/src/ui/providers.ts signs in with these).
 *  openai-codex-device stores its accounts under openai-codex, so it isn't asked separately. */
export const ACCOUNT_PROVIDERS: readonly string[] = ['anthropic', 'openai-codex', 'deepseek', 'google-gemini-cli', 'google-antigravity', 'openrouter'];
/** The ones whose sign-ins are OAuth accounts omp can order (auth.accountPolicies) and pin per chat (`/session pin`);
 *  DeepSeek and OpenRouter hold API keys. */
export const OAUTH_PROVIDERS: readonly string[] = ['anthropic', 'openai-codex', 'google-gemini-cli', 'google-antigravity'];
/** Providers whose accounts may be signed out from the app: the featured ones and every one a sign-in of omp's menu
 *  stores credentials under. */
export function managedProvider(provider: string): boolean {
  return ACCOUNT_PROVIDERS.includes(provider) || LOGIN_CREDENTIAL_PROVIDERS.has(provider);
}

/** One row of `omp usage accounts --json`: who an OAuth account is as omp keys it (`email:<e>|org:<orgId>`,
 *  `account:<id>`, …). No credential id: matched to accounts by these fields. */
export interface OmpIdentity {
  provider: string;
  email?: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
}

const USAGE_TIMEOUT_MS = 45_000;
/** A usage report is reused this long: `omp usage` is a few-hundred-MB process, and omp itself keeps the providers'
 *  reports about 5 minutes. "Check limits" (force) asks again sooner. */
export const USAGE_TTL_MS = 5 * 60_000;
/** A failed usage run is answered again for this long (opening the page again must not start another omp at once). */
export const USAGE_FAILURE_TTL_MS = 60_000;
/** A Refresh this soon after the last one reuses it: the providers' usage endpoints are rate-limited. */
const FORCE_MIN_MS = 15_000;
/** omp exited but something it started still holds its stdout: what it wrote by then is all there is. */
const EXIT_GRACE_MS = 1000;
/** omp's rpc-ui refuses to start when the store has no usable credential — that just means no accounts. */
const NO_CREDENTIALS = /No default model selected|No model available matching enabledModels|No models available/i;
const EMAIL = /[^\s()<>·]+@[^\s()<>·]+\.[^\s()<>·]+/;

/** A friendly reason a list/logout failed (shown to the user as is). */
export class AccountError extends Error {
  /** `mayHaveChanged`: a sign-out reached omp, so the stored credentials may have changed although this failed. */
  constructor(message: string, readonly mayHaveChanged = false) {
    super(message);
  }
}

export interface ProviderAccountsOptions {
  ompBin: string;
  env: Record<string, string | undefined>;
  cwd: string;
  usageTimeoutMs?: number; // default 45 s (tests)
  /** Key of omp's stored sign-ins (ModelRegistry.credentialsKey): the account list is kept while it is unchanged, so
   *  opening Models & providers or pressing Refresh doesn't start an omp each time (#69). Absent or '': never kept. */
  credentialsKey?: () => string;
}

interface CachedUsage {
  snapshot: UsageSnapshot;
  at: number;
  forced: boolean; // omp was told to fetch fresh reports (Refresh)
}

export class ProviderAccounts {
  /** One omp at a time from here: each call waits for the previous one. */
  #queue: Promise<unknown> = Promise.resolve();
  #usage: CachedUsage | null = null;
  /** The last usage run failed (kept apart: #usage stays the last good report the account order shows). */
  #usageFailure: { snapshot: UsageSnapshot; at: number } | null = null;
  /** Failures already logged: the same one again (every open of Models & providers) stays quiet until omp works. */
  #said = new Set<string>();
  #missing = false;
  #usageRun: { promise: Promise<UsageSnapshot>; forced: boolean } | null = null;
  /** The last account list and the sign-in key it was read under. */
  #listed: { key: string; accounts: ProviderAccount[] } | null = null;
  /** Bumped when credentials change: a usage run that started before that isn't cached. */
  #epoch = 0;
  #rpc: OmpProcess | null = null;
  /** The running `omp usage`: kills its whole process group. */
  #child: { kill(): void } | null = null;
  #closed = false;

  constructor(private readonly o: ProviderAccountsOptions) {}

  /** Every stored account of ACCOUNT_PROVIDERS and of the other signed-in providers of omp's menu, provider by provider,
   *  oldest first. [] when omp has no credentials.
   *  Asks omp (a short-lived rpc-ui process) only when the stored sign-ins changed since the last answer. */
  list(): Promise<ProviderAccount[]> {
    return this.#serial(async () => {
      const key = this.#key();
      if (key && this.#listed?.key === key) return [...this.#listed.accounts];
      const epoch = this.#epoch;
      const accounts = await this.#withRpc(async (p) => (p ? this.#listIn(p) : []));
      // read under `key`: a sign-in meanwhile moves the key (or the epoch), and the next list asks again
      if (key && epoch === this.#epoch) this.#listed = { key, accounts: [...accounts] };
      return accounts;
    });
  }

  #key(): string {
    try {
      return this.o.credentialsKey?.() ?? '';
    } catch {
      return '';
    }
  }

  /** Remove one stored credential; returns it and the accounts left. Throws AccountError (`mayHaveChanged` once the
   *  sign-out reached omp). When omp reports a failure or doesn't answer, the store decides: a credential that is gone
   *  was signed out. */
  logout(provider: string, credentialId: number): Promise<{ removed: ProviderAccount; accounts: ProviderAccount[] }> {
    if (!managedProvider(provider)) return Promise.reject(new AccountError(`CAST doesn’t manage “${provider}” accounts.`));
    return this.#serial(() =>
      this.#withRpc(async (p) => {
        const removed = p ? (await this.#accountsOf(p, provider)).find((a) => a.credentialId === credentialId) : undefined;
        if (!p || !removed) throw new AccountError('That account is already signed out.');
        let failure: string | undefined;
        let wedged = false; // no answer (a timeout) or omp died: ask a fresh omp what is left
        try {
          const r = await p.request({ type: 'logout', providerId: provider, credentialId }, 30_000);
          if (!r.success) failure = String(r.error);
        } catch (err) {
          failure = errorText(err);
          wedged = true;
        }
        this.invalidateUsage(); // whatever omp did, the cached limits may be wrong now
        let accounts: ProviderAccount[];
        try {
          if (wedged) await p.stop(1000);
          accounts = wedged || !p.alive ? await this.#withRpc(async (q) => (q ? this.#listIn(q) : [])) : await this.#listIn(p);
        } catch (err) {
          log('accounts', `${provider}: listing after the sign-out of credential ${credentialId} failed — ${reason(err)}`);
          const why = failure === undefined ? `Signed out of ${removed.label}, but the agent couldn’t list the accounts left: ${reason(err)}` : `The agent couldn’t sign out of ${removed.label}: ${shortReason(failure)}`;
          throw new AccountError(why, true);
        }
        const gone = !accounts.some((a) => a.provider === removed.provider && a.credentialId === credentialId);
        if (failure !== undefined) {
          log('accounts', `${provider}: sign-out of credential ${credentialId} failed — ${shortReason(failure)}${gone ? ' (but it is gone: signed out)' : ''}`);
          if (!gone) throw new AccountError(`The agent couldn’t sign out of ${removed.label}: ${shortReason(failure)}`, true);
        } else log('accounts', `${provider}: signed out credential ${credentialId}`);
        const key = this.#key();
        if (key) this.#listed = { key, accounts: [...accounts] }; // what is stored now: the next list needs no omp
        return { removed, accounts };
      }),
    );
  }

  /** Usage limits of every signed-in account (`omp usage --json`). A report is reused for USAGE_TTL_MS and a failure
   *  for USAGE_FAILURE_TTL_MS; `force` asks omp to fetch fresh reports. Concurrent callers share one run. Never
   *  throws: a failure is { accounts: [], error }. */
  usage(force = false): Promise<UsageSnapshot> {
    const cached = this.#usage;
    const failed = this.#usageFailure;
    if (!force && failed && Date.now() - failed.at < USAGE_FAILURE_TTL_MS) return Promise.resolve(failed.snapshot);
    if (cached && !failed && Date.now() - cached.at < (force ? (cached.forced ? FORCE_MIN_MS : 0) : USAGE_TTL_MS)) return Promise.resolve(cached.snapshot);
    const running = this.#usageRun;
    if (running && (running.forced || !force)) return running.promise;
    const epoch = this.#epoch;
    const promise: Promise<UsageSnapshot> = this.#serial(() => this.#fetchUsage(force))
      .catch((err): UsageSnapshot => ({ fetchedAt: Date.now(), accounts: [], error: errorText(err) }))
      .then((fresh) => {
        if (epoch !== this.#epoch) return fresh;
        if (fresh.error) {
          this.#usageFailure = { snapshot: fresh, at: Date.now() };
          return fresh;
        }
        this.#usageFailure = null;
        const snapshot = keepUncheckedReports(fresh, this.#usage?.snapshot, Date.now());
        this.#usage = { snapshot, at: Date.now(), forced: force };
        return snapshot;
      })
      .finally(() => {
        if (this.#usageRun?.promise === promise) this.#usageRun = null;
      });
    this.#usageRun = { promise, forced: force };
    return promise;
  }

  /** The last usage report (null: none yet or it was invalidated) and when it was taken; never asks omp. */
  lastUsage(): { snapshot: UsageSnapshot; at: number } | null {
    return this.#usage ? { snapshot: this.#usage.snapshot, at: this.#usage.at } : null;
  }

  /** Who every stored OAuth account is, as omp keys it (`omp usage accounts --json`): the org id of an Anthropic
   *  account is only here and in its usage report. Never throws: [] when omp couldn't say. */
  identities(): Promise<OmpIdentity[]> {
    return this.#serial(async () => {
      try {
        const identities = parseIdentities(JSON.parse(await this.#runOmp(['usage', 'accounts', '--json'], 20_000)));
        this.#worked();
        return identities;
      } catch (err) {
        this.#fail('usage accounts failed', err);
        return [];
      }
    });
  }

  /** Credentials changed (a sign-in or sign-out): the next usage() and list() ask omp again (a run already going isn't
   *  shared). */
  invalidateUsage(): void {
    this.#listed = null;
    this.#usage = null;
    this.#usageFailure = null;
    this.#usageRun = null;
    this.#epoch++;
  }

  /** The last omp this module tried to run wasn't there at all (it said so in the log, once). */
  get ompMissing(): boolean {
    return this.#missing;
  }

  /** A failure, in the log once: the same line again stays quiet until an omp run works. A missing omp isn't logged
   *  here at all: the start-up check says it in one clear line (agents, OmpHealth), and every open of Models &
   *  providers would add more. */
  #fail(what: string, err: unknown): void {
    const text = errorText(err);
    const bin = this.o.ompBin;
    this.#missing = /\bENOENT\b/.test(text) && (!isAbsolute(bin) || !existsSync(bin));
    if (this.#missing) return;
    const line = `${what}: ${shortReason(text)}`;
    if (this.#said.has(line)) return;
    this.#said.add(line);
    log('accounts', line);
  }

  /** omp answered: the next failure is news again. */
  #worked(): void {
    this.#missing = false;
    this.#said.clear();
  }

  /** Server shutdown: stop whatever omp is running for us. */
  shutdown(): void {
    this.#closed = true;
    this.#rpc?.kill();
    this.#child?.kill();
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => {
      if (this.#closed) throw new AccountError('The server is shutting down.');
      return fn();
    });
    this.#queue = next.catch(() => {});
    return next;
  }

  /** Run `fn` against a fresh rpc-ui omp (null when the store has no credential at all), then stop it.
   *  Whatever goes wrong comes out as an AccountError with a short reason (no stderr, no email addresses). */
  async #withRpc<T>(fn: (p: OmpProcess | null) => Promise<T>): Promise<T> {
    const p = new OmpProcess({
      bin: this.o.ompBin,
      cwd: this.o.cwd,
      args: ['--no-session', '--no-tools', '--no-title'],
      env: { ...this.o.env, NO_COLOR: '1' },
      readyTimeoutMs: 30_000,
    });
    this.#rpc = p;
    try {
      try {
        await p.start();
      } catch (err) {
        if (NO_CREDENTIALS.test(p.stderr)) {
          this.#worked();
          return await fn(null);
        }
        this.#fail('the agent didn’t start', err);
        throw new AccountError(`Couldn’t ask the agent for its accounts: ${reason(err)}`);
      }
      this.#worked();
      try {
        return await fn(p);
      } catch (err) {
        if (err instanceof AccountError) throw err;
        this.#fail('the agent failed', err);
        throw new AccountError(`Couldn’t ask the agent for its accounts: ${reason(err)}`);
      }
    } finally {
      if (this.#rpc === p) this.#rpc = null;
      await p.stop(1000);
    }
  }

  async #listIn(p: OmpProcess): Promise<ProviderAccount[]> {
    const out: ProviderAccount[] = [];
    for (const provider of [...ACCOUNT_PROVIDERS, ...(await this.#signedInOthers(p))]) out.push(...(await this.#accountsOf(p, provider)));
    return out;
  }

  /** The credential providers of omp's other sign-ins that omp says are signed in (`get_login_providers`: a stored
   *  credential or an environment key), in its menu order. [] when this omp can't say. */
  async #signedInOthers(p: OmpProcess): Promise<string[]> {
    let data: { providers?: unknown } | undefined;
    try {
      data = await p.call<{ providers?: unknown }>({ type: 'get_login_providers' }, 15_000);
    } catch (err) {
      if (!(err instanceof OmpCommandError)) throw err;
      return [];
    }
    const out: string[] = [];
    for (const row of Array.isArray(data?.providers) ? data.providers : []) {
      if (!isRecord(row) || row.authenticated !== true || typeof row.id !== 'string') continue;
      const provider = credentialProviderOf(row.id);
      if (LOGIN_CREDENTIAL_PROVIDERS.has(provider) && !ACCOUNT_PROVIDERS.includes(provider) && !out.includes(provider)) out.push(provider);
    }
    return out;
  }

  /** One provider's accounts; [] when omp doesn't know the provider. */
  async #accountsOf(p: OmpProcess, provider: string): Promise<ProviderAccount[]> {
    let data: { accounts?: unknown } | undefined;
    try {
      data = await p.call<{ accounts?: unknown }>({ type: 'get_logout_accounts', providerId: provider }, 15_000);
    } catch (err) {
      if (!(err instanceof OmpCommandError)) throw err;
      log('accounts', `${provider}: the agent can’t list its accounts — ${redact(err.message)}`);
      return [];
    }
    const rows = Array.isArray(data?.accounts) ? data.accounts : [];
    return rows
      .map((row) => toAccount(provider, row))
      .filter((a): a is ProviderAccount => a !== null)
      .sort((a, b) => a.credentialId - b.credentialId);
  }

  async #fetchUsage(force: boolean): Promise<UsageSnapshot> {
    const started = Date.now();
    try {
      if (force) {
        // omp keeps reports for ~5 min; a Refresh should show what the provider says now.
        await this.#runOmp(['usage', 'invalidate'], 15_000).catch((err) => this.#fail('usage invalidate failed', redact(errorText(err))));
      }
      const out = await this.#runOmp(['usage', '--json'], (this.o.usageTimeoutMs ?? USAGE_TIMEOUT_MS) - (Date.now() - started));
      let json: unknown;
      try {
        json = JSON.parse(out);
      } catch {
        throw new AccountError('The agent returned usage in a format CAST doesn’t understand.');
      }
      this.#worked();
      return parseUsage(json, Date.now());
    } catch (err) {
      this.#fail('usage failed', err);
      return { fetchedAt: started, accounts: [], error: err instanceof AccountError ? err.message : `Couldn’t read usage limits: ${reason(err)}` };
    }
  }

  /** `omp <args>` → stdout. Throws AccountError on a timeout or a non-zero exit. Settles on time even when something
   *  omp started still holds its pipes: omp leads its own process group (killed whole on a timeout), and the reads
   *  are raced against the timer rather than awaited to EOF. */
  async #runOmp(args: string[], timeoutMs: number): Promise<string> {
    const limitMs = Math.max(1000, timeoutMs);
    const child = spawn(this.o.ompBin, args, {
      cwd: this.o.cwd,
      env: { ...this.o.env, NO_COLOR: '1' } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* group already gone */
      }
    };
    this.#child = { kill };
    const untrack = trackGroup(child.pid);
    child.once('exit', untrack);
    child.once('error', untrack);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-8000)));
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (c: number | null) => resolve(c));
        child.once('exit', (c: number | null) => timers.push(setTimeout(() => resolve(c), EXIT_GRACE_MS)));
        timers.push(
          setTimeout(() => {
            kill();
            reject(new AccountError(`The agent didn’t answer within ${Math.round(limitMs / 1000)} s — try Refresh in a moment.`));
          }, limitMs),
        );
      });
      if (code !== 0) throw new AccountError(`cast-agent ${args.join(' ')} failed: ${redact(firstLine(err)) || `exit code ${code}`}`);
      return out;
    } finally {
      for (const t of timers) clearTimeout(t);
      child.stdout.destroy();
      child.stderr.destroy();
      if (this.#child?.kill === kill) this.#child = null;
    }
  }
}

// ───────────────────────── parsing (fields picked one by one: omp's raw payloads never pass through) ─────────────────────────

function toAccount(asked: string, raw: unknown): ProviderAccount | null {
  if (!isRecord(raw)) return null;
  const credentialId = raw.credentialId;
  if (typeof credentialId !== 'number' || !Number.isSafeInteger(credentialId) || credentialId <= 0) return null;
  const type = raw.type === 'oauth' ? 'oauth' : 'api_key';
  const provider = optStr(raw.provider) ?? asked;
  const label = optStr(raw.label) ?? (type === 'api_key' ? `API key #${credentialId}` : `Account #${credentialId}`);
  const detail = optStr(raw.detail) ?? '';
  const account: ProviderAccount = { provider, vendor: vendorOfProvider(provider), credentialId, label, detail, type };
  if (type === 'oauth') {
    // omp's label is "<email> (<org>)", its detail "<email> · account <id> · project <id> · oauth #<n>".
    const accountId = /(?:^| · )account (.+?)(?= · |$)/.exec(detail)?.[1];
    const projectId = /(?:^| · )project (.+?)(?= · |$)/.exec(detail)?.[1];
    const email = EMAIL.exec(label)?.[0] ?? EMAIL.exec(detail)?.[0];
    const org = /^.+ \(([^()]+)\)$/.exec(label)?.[1];
    if (accountId) account.accountId = accountId;
    if (projectId) account.projectId = projectId;
    if (email) account.email = email;
    if (org) account.org = org;
  }
  return account;
}

/** `omp usage --json` → what the page shows. `fetchedAt` is when the oldest report was fetched (omp caches them for a
 *  few minutes), so "updated n min ago" tells the truth. A window that reset since its report was fetched shows as
 *  reset (settleLimit). omp's accountsWithoutUsage (OAuth) become `unchecked`. */
export function parseUsage(json: unknown, now: number): UsageSnapshot {
  if (!isRecord(json) || !Array.isArray(json.reports)) return { fetchedAt: now, accounts: [], error: 'The agent returned usage in a format CAST doesn’t understand.' };
  const accounts: AccountUsage[] = [];
  for (const r of json.reports) {
    if (!isRecord(r)) continue;
    const provider = optStr(r.provider);
    if (!provider) continue;
    const meta = isRecord(r.metadata) ? r.metadata : {};
    const rawLimits = Array.isArray(r.limits) ? r.limits : [];
    const fetchedAt = optNum(r.fetchedAt) ?? now;
    const limits = rawLimits
      .map((l, i) => toLimit(provider, l, i))
      .filter((l): l is UsageLimit => l !== null)
      .map((l) => settleLimit(l, fetchedAt, now));
    const account: AccountUsage = { provider, vendor: vendorOfProvider(provider), limits, fetchedAt };
    // Ids the metadata lacks may still be on the limits' scopes (omp attributes reports by both).
    const scoped = (key: string) => rawLimits.map((l) => (isRecord(l) && isRecord(l.scope) ? optStr(l.scope[key]) : undefined)).find((v) => v !== undefined);
    Object.assign(
      account,
      identity({
        accountId: optStr(meta.accountId) ?? scoped('accountId'),
        projectId: optStr(meta.projectId) ?? scoped('projectId'),
        email: optStr(meta.email),
        org: optStr(meta.orgName),
        orgId: optStr(meta.orgId) ?? scoped('orgId'),
      }),
    );
    const plan = optStr(meta.planType) ?? optStr(meta.plan);
    if (plan) account.plan = plan;
    accounts.push(account);
  }
  const unchecked: UncheckedAccount[] = [];
  for (const u of Array.isArray(json.accountsWithoutUsage) ? json.accountsWithoutUsage : []) {
    if (!isRecord(u) || u.type === 'api_key') continue; // a key has no report to miss (the page says none is reported)
    const provider = optStr(u.provider);
    if (!provider) continue;
    unchecked.push({
      provider,
      vendor: vendorOfProvider(provider),
      ...identity({ accountId: optStr(u.accountId), projectId: optStr(u.projectId), email: optStr(u.email), org: optStr(u.orgName), orgId: optStr(u.orgId) }),
    });
  }
  const oldest = accounts.length ? Math.min(...accounts.map((a) => a.fetchedAt)) : undefined;
  return { fetchedAt: oldest ?? optNum(json.generatedAt) ?? now, accounts, ...(unchecked.length ? { unchecked } : {}) };
}

/** `omp usage accounts --json` → identities. A key is `|`-separated `<field>:<value>` parts (email, account, project,
 *  org); unknown parts are skipped. */
export function parseIdentities(json: unknown): OmpIdentity[] {
  if (!isRecord(json) || !Array.isArray(json.accounts)) return [];
  const out: OmpIdentity[] = [];
  for (const row of json.accounts) {
    if (!isRecord(row)) continue;
    const provider = optStr(row.provider);
    const key = optStr(row.identityKey);
    if (!provider || !key) continue;
    const id: OmpIdentity = { provider };
    for (const part of key.split('|')) {
      const i = part.indexOf(':');
      if (i <= 0) continue;
      const value = part.slice(i + 1).trim();
      if (!value) continue;
      const field = part.slice(0, i);
      if (field === 'email') id.email = value;
      else if (field === 'account') id.accountId = value;
      else if (field === 'project') id.projectId = value;
      else if (field === 'org') id.orgId = value;
    }
    out.push(id);
  }
  return out;
}

/** The identity fields that are set (picked by name: nothing else of omp's rows passes). */
function identity(i: UsageIdentity): UsageIdentity {
  return Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined));
}

/** A window whose reset time has passed: if it reset after the report was fetched, nothing of the new window is used
 *  yet (marked `reset`); either way the past reset time is dropped. */
function settleLimit(l: UsageLimit, fetchedAt: number, now: number): UsageLimit {
  if (l.resetsAt === undefined || l.resetsAt > now) return l;
  const { resetsAt, ...rest } = l;
  if (fetchedAt >= resetsAt) return rest; // the report already counts from that reset
  const out: UsageLimit = { ...rest, remainingPct: 100, usedPct: 0, status: 'ok', reset: true };
  if (out.used !== undefined) out.used = 0;
  return out;
}

/** A fresh snapshot lost the report of an account omp still holds but couldn't check just now (e.g. a 429 right after
 *  Refresh wiped omp's cache): keep that account's previous report, marked stale, rather than showing no limits. */
export function keepUncheckedReports(fresh: UsageSnapshot, previous: UsageSnapshot | undefined, now: number): UsageSnapshot {
  const unchecked = fresh.unchecked ?? [];
  if (!previous || !unchecked.length) return fresh;
  const kept = previous.accounts.filter((old) => !fresh.accounts.some((a) => sameUsageAccount(old, a)) && unchecked.some((u) => sameUsageAccount(old, u)));
  if (!kept.length) return fresh;
  const stale = kept.map((old): AccountUsage => ({ ...old, limits: old.limits.map((l) => settleLimit(l, old.fetchedAt, now)), stale: true }));
  return { ...fresh, accounts: [...fresh.accounts, ...stale] };
}

function toLimit(provider: string, raw: unknown, index: number): UsageLimit | null {
  if (!isRecord(raw)) return null;
  const amount = isRecord(raw.amount) ? raw.amount : {};
  const window = isRecord(raw.window) ? raw.window : {};
  const unit = optStr(amount.unit);
  const used = optNum(amount.used);
  const limit = optNum(amount.limit);
  // Same precedence as omp's resolveUsedFraction: explicit fraction > used/limit > percent > inverted remaining.
  const remainingFraction = optNum(amount.remainingFraction);
  let usedFraction = optNum(amount.usedFraction);
  if (usedFraction === undefined && used !== undefined && limit !== undefined && limit > 0) usedFraction = used / limit;
  if (usedFraction === undefined && unit === 'percent' && used !== undefined) usedFraction = used / 100;
  if (usedFraction === undefined && remainingFraction !== undefined) usedFraction = Math.max(0, 1 - remainingFraction);
  const left = remainingFraction ?? (usedFraction === undefined ? undefined : 1 - usedFraction);
  const windowLabel = optStr(window.label);
  const label = optStr(raw.label) ?? windowLabel ?? 'Limit';
  const resetsAt = optNum(window.resetsAt);
  let status = optStr(raw.status);
  if (!status || status === 'unknown') {
    status = usedFraction === undefined ? 'unknown' : usedFraction >= 1 ? 'exhausted' : usedFraction >= 0.8 ? 'warning' : 'ok';
  }
  const out: UsageLimit = {
    id: optStr(raw.id) ?? `${provider}:${index}`,
    // "Claude 7 Day (Fable)" → "7 Day (Fable)": the card already says whose limit it is.
    label: windowLabel && label.includes(windowLabel) ? label.slice(label.indexOf(windowLabel)) : label,
    remainingPct: left === undefined ? null : pct(left),
    usedPct: usedFraction === undefined ? null : pct(usedFraction),
    status,
  };
  if (windowLabel) out.window = windowLabel;
  if (used !== undefined) out.used = used;
  if (limit !== undefined) out.limit = limit;
  if (unit) out.unit = unit;
  if (resetsAt !== undefined) out.resetsAt = resetsAt;
  return out;
}

/** 0..1 → 0..100 with one decimal (a fraction above 1 is overage: still 100% used). */
const pct = (fraction: number) => Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const firstLine = (s: string) => s.trim().split('\n')[0]?.trim().slice(0, 300) ?? '';
/** For logs: no email addresses. */
const redact = (s: string) => s.replace(new RegExp(EMAIL.source, 'g'), '<email>');
/** For the user and logs: the first line of a failure, without OmpProcess's stderr tail, no email addresses. */
const shortReason = (s: string) => redact(firstLine(s).replace(/\s*stderr:.*$/, '')) || 'unknown error';
const reason = (err: unknown) => shortReason(errorText(err));
