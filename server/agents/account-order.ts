// Account order: which signed-in OAuth account omp prefers, per provider (the chat's account menu and Models &
// providers), and each chat's own pick.
//
// The order is CAST's: <dataDir>/account-order.json. omp reads it as `auth.accountPolicies` from a --config overlay
// with a constant path, <dataDir>/omp-config/accounts.yml, that every real-model omp gets (process-pool.ts). omp
// watches that file's folder and takes a new order within about a second, also in running processes:
//   - each placed account gets a priority (first = highest); accounts signed in later have none (tried after them);
//   - reclaimAbovePct pulls chats that follow the order back to a higher account once it has room again, at their
//     next model request — so a new order reaches running chats too, not only new ones;
//   - reservePct is the user's own global reserve, said per account so a house's own omp config can't make the
//     reclaim value invalid (omp refuses to start on an invalid overlay).
// The order is a preference: omp still skips an account that is out of quota, in its reserve, or can't report usage.
//
// A chat's own pick is an explicit omp session pin (`/session pin`, agent-runtime.ts syncAccount); omp never moves it.
// A pick older than its provider's last saved order no longer counts (every chat follows a new order). omp has no
// unpin: a chat whose pin must go is forked (same chat, a new session id whose pins are automatic again).
//
// omp matches accounts by identity (email / accountId / projectId / orgId), never by credential id, and refuses a
// selector that matches two stored accounts — so selectors are checked against every stored account of the provider,
// and get the org id when one email holds several orgs (Anthropic).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  uncheckedOf,
  usageOfAccount,
  type AccountOrder,
  type ChatAccount,
  type OrderedAccount,
  type ProviderAccount,
  type ProviderAccountOrder,
  type UsageSnapshot,
} from '../../shared/protocol';
import { vendorOfProvider } from './models';
import { AccountError, OAUTH_PROVIDERS, type OmpIdentity, type ProviderAccounts } from './provider-accounts';
import { errorText, log } from './util';

const FILE_VERSION = 1;
/** Placed accounts: 1000, 990, 980, … (32 accounts at most: never below the unplaced ones' 0). */
const TOP_PRIORITY = 1000;
const PRIORITY_STEP = 10;
/** Pull following chats back to a higher account once it has this much left (above the reserve: omp's rule). */
const RECLAIM_PCT = 25;
const DEFAULT_RESERVE_PCT = 10; // omp's retry.usageReservePct default
/** The account list is read again (in the background) when it is older than this. */
const LIST_TTL_MS = 60_000;
/** omp re-reads a rewritten overlay after a 200 ms debounce (its config watcher): a message sent sooner would still
 *  be routed by the old order, so one waits out this much after a rewrite. */
export const OVERLAY_RELOAD_MS = 1000;

/** How omp tells an account apart (auth.accountPolicies[].account): every field set must equal the account's. */
export interface AccountSelector {
  email?: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
}

export interface SavedEntry {
  credentialId: number;
  label: string;
  selector: AccountSelector;
}

export interface SavedProvider {
  savedAt: number; // the last set_account_order of this provider (also an empty one)
  accounts: SavedEntry[]; // placed accounts, first = preferred; [] → omp's own order
}

interface SavedFile {
  version: number;
  providers: Record<string, SavedProvider>;
}

/** A chat's own account of one provider (ThreadRecord.accounts). */
export interface AccountPick {
  credentialId: number;
  at: number;
}

/** What omp should do for a chat now (AgentRuntime.syncAccount). */
export interface AccountPlan {
  provider: string; // the provider of the chat's model now
  /** The chat's own pick of that provider (pin it); null → it follows the order. */
  credentialId: number | null;
  /** omp holds an explicit pin this chat no longer wants (of any provider): fork the session first. */
  drop: boolean;
}

// ───────────────────────── pure helpers (exported for tests) ─────────────────────────

const lower = (s?: string) => s?.toLowerCase();

/** An OAuth account's base identity (what omp's label/detail show). */
export function baseSelector(a: ProviderAccount): AccountSelector {
  const s: AccountSelector = {};
  if (a.email) s.email = a.email;
  if (a.accountId) s.accountId = a.accountId;
  if (a.projectId) s.projectId = a.projectId;
  return s;
}

/** omp's matchesAuthAccountSelector, against what CAST knows of an account (its org id from `orgIds`). */
export function selectorMatches(sel: AccountSelector, a: ProviderAccount, orgIds: ReadonlyMap<number, string>): boolean {
  return (
    (sel.email === undefined || sel.email === a.email) &&
    (sel.accountId === undefined || sel.accountId === a.accountId) &&
    (sel.projectId === undefined || sel.projectId === a.projectId) &&
    (sel.orgId === undefined || sel.orgId === orgIds.get(a.credentialId))
  );
}

/** Some stored accounts share their base identity (one email in two orgs): their selectors need the org id. */
export function needsOrgIds(all: ProviderAccount[]): boolean {
  return all.some((a, i) => {
    const sel = baseSelector(a);
    return Object.keys(sel).length > 0 && all.some((b, j) => j !== i && selectorMatches(sel, b, new Map()));
  });
}

/** The selector of each of `ids` among a provider's stored OAuth accounts (`all`): matching that account only. */
export function selectorsFor(all: ProviderAccount[], ids: number[], orgIds: ReadonlyMap<number, string>): Map<number, AccountSelector> {
  const out = new Map<number, AccountSelector>();
  for (const id of ids) {
    const a = all.find((x) => x.credentialId === id);
    if (!a) throw new AccountError('That account is no longer signed in — reload the list.');
    const sel = baseSelector(a);
    if (!Object.keys(sel).length) throw new AccountError(`The agent doesn’t say who ${a.label} is, so it can’t be put in an order.`);
    if (all.some((b) => b !== a && selectorMatches(sel, b, new Map()))) {
      const org = orgIds.get(a.credentialId);
      if (!org) throw new AccountError(`${a.label} shares its sign-in with another account and the agent didn’t say which organization it is — refresh the usage limits and try again.`);
      sel.orgId = org;
    }
    if (all.filter((b) => selectorMatches(sel, b, orgIds)).length !== 1) throw new AccountError(`The agent can’t tell ${a.label} apart from another account of the same sign-in.`);
    out.set(id, sel);
  }
  return out;
}

/** A saved order against the accounts signed in now: each entry is its account again (by identity, else by
 *  credential id), entries whose account is gone are dropped, the rest keep their order. */
export function remapSaved(entries: SavedEntry[], all: ProviderAccount[], orgIds: ReadonlyMap<number, string>): SavedEntry[] {
  const out: SavedEntry[] = [];
  for (const e of entries) {
    const bySel = all.filter((a) => selectorMatches(e.selector, a, orgIds) && (e.selector.orgId === undefined || orgIds.has(a.credentialId)));
    const a = bySel.length === 1 ? bySel[0] : all.find((x) => x.credentialId === e.credentialId);
    if (!a || out.some((o) => o.credentialId === a.credentialId)) continue;
    out.push({ credentialId: a.credentialId, label: a.label, selector: e.selector });
  }
  return out;
}

/** The org id of an account whose email holds several orgs: from its usage report (matched like the limits are), else
 *  from omp's identities when the label shows the org id itself. */
export function orgIdOf(a: ProviderAccount, all: ProviderAccount[], usage: UsageSnapshot | null | undefined, identities: OmpIdentity[]): string | undefined {
  const report = usage ? usageOfAccount(a, all, usage.accounts) : undefined;
  if (report?.orgId) return report.orgId;
  const unchecked = uncheckedOf(a, usage);
  if (unchecked?.orgId && unchecked.org && lower(unchecked.org) === lower(a.org)) return unchecked.orgId;
  const rows = identities.filter((i) => i.provider === a.provider && i.orgId && (!a.email || lower(i.email) === lower(a.email)));
  return rows.find((i) => i.orgId === a.org)?.orgId;
}

/** omp's settings the overlay must agree with: the user's global reserve and their own account policies. */
export interface OmpUserConfig {
  reservePct: number;
  /** auth.accountPolicies of the user's config.yml: kept for the providers CAST has no order for (an overlay's list
   *  replaces the user's whole list). */
  policies: Record<string, unknown>[];
}

/** Read `<agentDir>/config.yml` (or .yaml) for the overlay; defaults when there is none or it can't be read. */
export function readOmpUserConfig(agentDir: string): OmpUserConfig {
  const out: OmpUserConfig = { reservePct: DEFAULT_RESERVE_PCT, policies: [] };
  for (const name of ['config.yml', 'config.yaml']) {
    const file = join(agentDir, name);
    if (!existsSync(file)) continue;
    try {
      const raw = Bun.YAML.parse(readFileSync(file, 'utf8')) as { retry?: { usageReservePct?: unknown }; auth?: { accountPolicies?: unknown } } | null;
      const r = raw?.retry?.usageReservePct;
      if (typeof r === 'number' && Number.isFinite(r)) out.reservePct = Math.max(0, Math.min(100, r));
      const p = raw?.auth?.accountPolicies;
      if (Array.isArray(p)) out.policies = p.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { provider?: unknown }).provider === 'string');
    } catch (err) {
      log('accounts', `could not read the agent's ${name}: ${errorText(err)}`);
    }
    break;
  }
  return out;
}

/** The overlay omp reads: CAST's order per provider (selectors in order) plus the user's own policies of other
 *  providers. `{}` when CAST has no order (the user's own list, if any, stays in effect). */
export function renderAccountsOverlay(orders: { provider: string; selectors: AccountSelector[] }[], user: OmpUserConfig): string {
  const ours = orders.filter((o) => o.selectors.length);
  if (!ours.length) return '{}\n';
  const reserve = user.reservePct;
  const reclaim = reserve < 100 ? Math.min(100, Math.max(RECLAIM_PCT, reserve + 15)) : undefined;
  const lines: string[] = [];
  for (const o of ours) {
    o.selectors.forEach((account, i) => {
      lines.push(JSON.stringify({ provider: o.provider, account, priority: TOP_PRIORITY - PRIORITY_STEP * i, reservePct: reserve, ...(reclaim !== undefined ? { reclaimAbovePct: reclaim } : {}) }));
    });
  }
  const managed = new Set(ours.map((o) => o.provider));
  for (const p of user.policies) if (!managed.has(String(p.provider))) lines.push(JSON.stringify(p));
  return ['# CAST’s account order (a chat’s account menu / Models & providers). CAST rewrites this file: don’t edit it.', 'auth:', '  accountPolicies:', ...lines.map((l) => `    - ${l}`), ''].join('\n');
}

/** One provider's accounts as the client shows them: placed ones first (saved order), then the rest by credential id. */
export function providerOrderView(
  provider: string,
  all: ProviderAccount[],
  saved: SavedProvider | undefined,
  usage: UsageSnapshot | null | undefined,
  inUse: (credentialId: number) => number,
): ProviderAccountOrder {
  const placed: ProviderAccount[] = [];
  for (const e of saved?.accounts ?? []) {
    const a = all.find((x) => x.credentialId === e.credentialId);
    if (a && !placed.includes(a)) placed.push(a);
  }
  const rest = all.filter((a) => !placed.includes(a)).sort((a, b) => a.credentialId - b.credentialId);
  const row = (a: ProviderAccount, isPlaced: boolean): OrderedAccount => {
    const out: OrderedAccount = { credentialId: a.credentialId, label: a.label, placed: isPlaced, inUse: inUse(a.credentialId) };
    const report = usage ? usageOfAccount(a, all, usage.accounts) : undefined;
    if (report) {
      out.limits = report.limits;
      if (report.stale || uncheckedOf(a, usage)) out.stale = true;
    }
    return out;
  };
  return {
    provider,
    vendor: vendorOfProvider(provider),
    accounts: [...placed.map((a) => row(a, true)), ...rest.map((a) => row(a, false))],
    saved: placed.length > 0,
    ...(saved ? { savedAt: saved.savedAt } : {}),
  };
}

/** The chat's pick still counts: made after its provider's last saved order, and its account is still signed in. */
export function validPick(pick: AccountPick | undefined, resetAt: number, accounts: ProviderAccount[]): AccountPick | undefined {
  return pick && pick.at > resetAt && accounts.some((a) => a.credentialId === pick.credentialId) ? pick : undefined;
}

/** What omp must do for a chat: pin its pick of the model's provider, and fork away explicit pins it no longer wants
 *  (of an account still signed in: omp drops the pins of one that is gone). */
export function accountPlan(
  provider: string,
  picks: Record<string, AccountPick> | undefined,
  pinned: Record<string, number> | undefined,
  pickOf: (provider: string, pick: AccountPick | undefined) => AccountPick | undefined,
  signedIn: (provider: string, credentialId: number) => boolean,
): AccountPlan {
  const drop = Object.entries(pinned ?? {}).some(([p, id]) => signedIn(p, id) && !pickOf(p, picks?.[p]));
  return { provider, credentialId: pickOf(provider, picks?.[provider])?.credentialId ?? null, drop };
}

/** AgentInfo.account of a chat on `provider` (its OAuth accounts `accounts`, ≥ 1). */
export function chatAccountOf(
  provider: string,
  accounts: ProviderAccount[],
  pick: AccountPick | undefined,
  pinned: Record<string, number> | undefined,
  seen: number | undefined,
  dropPending: boolean,
): ChatAccount {
  const known = (id: number | undefined) => (id !== undefined && accounts.some((a) => a.credentialId === id) ? id : undefined);
  const credentialId = pick?.credentialId ?? known(seen) ?? (accounts.length === 1 ? accounts[0]!.credentialId : null);
  const pending = pick ? pinned?.[provider] !== pick.credentialId : dropPending;
  return {
    provider,
    credentialId,
    label: credentialId === null ? '' : (accounts.find((a) => a.credentialId === credentialId)?.label ?? ''),
    pinned: !!pick,
    ...(pending ? { pending: true } : {}),
    choices: accounts.length,
  };
}

function storedSelector(v: unknown): AccountSelector | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const s: AccountSelector = {};
  for (const k of ['email', 'accountId', 'projectId', 'orgId'] as const) if (typeof o[k] === 'string' && o[k]) s[k] = o[k] as string;
  return s.email || s.accountId || s.projectId ? s : undefined;
}

function readSaved(file: string): SavedFile {
  const empty: SavedFile = { version: FILE_VERSION, providers: {} };
  if (!existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { providers?: unknown };
    const providers: Record<string, SavedProvider> = {};
    for (const [p, v] of Object.entries(raw.providers && typeof raw.providers === 'object' ? raw.providers : {})) {
      if (!OAUTH_PROVIDERS.includes(p) || !v || typeof v !== 'object') continue;
      const sp = v as { savedAt?: unknown; accounts?: unknown };
      const accounts: SavedEntry[] = [];
      for (const e of Array.isArray(sp.accounts) ? sp.accounts : []) {
        const id = (e as { credentialId?: unknown })?.credentialId;
        const selector = storedSelector((e as { selector?: unknown })?.selector);
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || !selector) continue;
        accounts.push({ credentialId: id, label: String((e as { label?: unknown }).label ?? ''), selector });
      }
      providers[p] = { savedAt: typeof sp.savedAt === 'number' && Number.isFinite(sp.savedAt) ? sp.savedAt : 0, accounts };
    }
    return { version: FILE_VERSION, providers };
  } catch (err) {
    log('accounts', `could not read the account order (${errorText(err)}); starting without one`);
    return empty;
  }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ───────────────────────── the book ─────────────────────────

export interface AccountOrderOptions {
  dataDir: string;
  accounts: ProviderAccounts;
  /** omp's agent dir (PI_CODING_AGENT_DIR or ~/.omp/agent): its config.yml is read, never written. */
  agentDir: string;
  /** The signed-in accounts or the order changed (people's AgentInfo.account and the clients' order are stale). */
  onChange(): void;
}

export class AccountOrderBook {
  /** The overlay every real-model omp gets (`--config`): written before any spawn, rewritten atomically. */
  readonly overlayPath: string;
  #file: string;
  #saved: SavedFile;
  #accounts: ProviderAccount[] | null = null;
  #listedAt = 0;
  #listing: Promise<void> | null = null;
  /** Why the accounts could not be listed (AccountOrder.error while there is no list). */
  #listError: string | undefined;
  /** Org ids of accounts that share an email (Anthropic orgs), by credential id; filled when needed. */
  #orgIds = new Map<number, string>();
  #overlay = '';
  /** When omp's overlay was last rewritten (0: never since this server started). */
  #overlayAt = 0;
  /** Bumped by every setOrder: a note() that ran across one works it out again (see note). */
  #gen = 0;

  constructor(private readonly o: AccountOrderOptions) {
    this.#file = join(o.dataDir, 'account-order.json');
    this.overlayPath = join(o.dataDir, 'omp-config', 'accounts.yml');
    this.#saved = readSaved(this.#file);
    // From the saved selectors as they are: checked against the stored accounts once they are listed.
    this.#writeOverlay(Object.entries(this.#saved.providers).map(([provider, sp]) => ({ provider, selectors: sp.accounts.map((e) => e.selector) })));
  }

  /** The overlay exists (a missing --config file stops omp before it is ready): rewritten when it went missing. */
  ensureOverlay(): string {
    if (!existsSync(this.overlayPath)) {
      try {
        writeAtomic(this.overlayPath, this.#overlay || '{}\n');
      } catch (err) {
        log('accounts', `could not write the account order for the agent: ${errorText(err)}`);
      }
    }
    return this.overlayPath;
  }

  /** The signed-in accounts as last listed (null: not listed yet). */
  accounts(): ProviderAccount[] | null {
    return this.#accounts;
  }

  /** One provider's signed-in OAuth accounts, oldest first ([] when none or not listed yet). */
  oauth(provider: string): ProviderAccount[] {
    return (this.#accounts ?? []).filter((a) => a.provider === provider && a.type === 'oauth').sort((a, b) => a.credentialId - b.credentialId);
  }

  /** When this provider's order was last saved: picks made before then no longer count. */
  resetAt(provider: string): number {
    return this.#saved.providers[provider]?.savedAt ?? 0;
  }

  /** The chat's pick still counts (see validPick). */
  pickOf(provider: string, pick: AccountPick | undefined): AccountPick | undefined {
    return validPick(pick, this.resetAt(provider), this.oauth(provider));
  }

  signedIn(provider: string, credentialId: number): boolean {
    return this.oauth(provider).some((a) => a.credentialId === credentialId);
  }

  /** List the accounts again (one run at a time; `ifOlderMs`: only when the list is older). Never throws. */
  refresh(ifOlderMs = 0): Promise<void> {
    if (this.#accounts && Date.now() - this.#listedAt < ifOlderMs) return Promise.resolve();
    this.#listing ??= this.o.accounts
      .list()
      .then((accounts) => this.note(accounts))
      .catch((err: unknown) => {
        const first = this.#listError === undefined;
        this.#listError = errorText(err);
        // once per spell of failures; a missing omp was already said by the accounts module, in one line
        if (first && !this.o.accounts.ompMissing) log('accounts', `listing the accounts for the order failed: ${this.#listError}`);
      })
      .finally(() => (this.#listing = null));
    return this.#listing;
  }

  /** Listed when it never was; an older list is read again in the background. */
  async ensureListed(): Promise<void> {
    if (!this.#accounts) return this.refresh();
    void this.refresh(LIST_TTL_MS);
  }

  /** A fresh account list (also from list_accounts / logout_account): the saved order follows it (signed-out accounts
   *  leave it, a second org of one email gets its org id) and omp's overlay is rewritten when that changed. */
  async note(accounts: ProviderAccount[]): Promise<void> {
    const before = JSON.stringify(this.#accounts);
    this.#accounts = accounts;
    this.#listedAt = Date.now();
    this.#listError = undefined;
    let orders: { provider: string; selectors: AccountSelector[] }[] = [];
    let savedChanged = false;
    // Finding org ids can wait on omp for seconds: an order saved meanwhile (setOrder) must not be overwritten with the
    // order this run started from — the overlay omp reads would then disagree with the saved one. So: again, from the
    // order as it is now, until no save came in between.
    for (let gen = -1; gen !== this.#gen; ) {
      gen = this.#gen;
      orders = [];
      for (const [provider, sp] of Object.entries(this.#saved.providers)) {
        if (!sp.accounts.length) continue;
        const all = this.oauth(provider);
        await this.#loadOrgIds(all, false);
        if (gen !== this.#gen) break; // saved meanwhile: start over
        const entries = remapSaved(sp.accounts, all, this.#orgIds);
        try {
          const sels = selectorsFor(all, entries.map((e) => e.credentialId), this.#orgIds);
          for (const e of entries) e.selector = sels.get(e.credentialId)!;
          orders.push({ provider, selectors: entries.map((e) => e.selector) });
        } catch (err) {
          // Better no order for this provider than one omp refuses (every request of it would fail).
          log('accounts', `${provider}: the saved order can’t be given to the agent now — ${err instanceof Error ? err.message.replace(/\S+@\S+/g, '<email>') : errorText(err)}`);
        }
        if (JSON.stringify(entries) !== JSON.stringify(sp.accounts)) {
          sp.accounts = entries;
          savedChanged = true;
        }
      }
    }
    if (savedChanged) this.#save();
    const overlayChanged = this.#writeOverlay(orders);
    if (before !== JSON.stringify(accounts) || savedChanged || overlayChanged) this.o.onChange();
  }

  /** Resolves once running omps have had time to reload a just rewritten overlay (at once otherwise). */
  overlaySettled(): Promise<void> {
    const left = this.#overlayAt + OVERLAY_RELOAD_MS - Date.now();
    return left > 0 ? Bun.sleep(left) : Promise.resolve();
  }

  /** Save one provider's order (`ids` first = preferred; [] → omp's own). Returns when it was saved: every chat's own
   *  pick of this provider made before then no longer counts. Throws AccountError. */
  async setOrder(provider: string, ids: number[]): Promise<number> {
    if (!OAUTH_PROVIDERS.includes(provider)) throw new AccountError('Only Claude, ChatGPT and Google sign-ins have an order — an API key is a single account.');
    if (!this.#accounts || ids.some((id) => !this.signedIn(provider, id))) await this.refresh();
    const all = this.oauth(provider);
    if (!all.length) throw new AccountError('No account of that provider is signed in.');
    const missing = ids.find((id) => !all.some((a) => a.credentialId === id));
    if (missing !== undefined) throw new AccountError('That account is no longer signed in — reload the list.');
    await this.#loadOrgIds(all, true);
    const sels = selectorsFor(all, ids, this.#orgIds);
    const savedAt = Math.max(Date.now(), this.resetAt(provider) + 1);
    this.#saved.providers[provider] = { savedAt, accounts: ids.map((id) => ({ credentialId: id, label: all.find((a) => a.credentialId === id)!.label, selector: sels.get(id)! })) };
    this.#gen++;
    this.#save();
    this.#writeOverlay(this.#ordersNow());
    log('accounts', `${provider}: order saved (${ids.length ? ids.map((id) => `#${id}`).join(' > ') : 'the agent’s own'})`);
    this.o.onChange();
    return savedAt;
  }

  /** The order as the client shows it. */
  view(usage: UsageSnapshot | null | undefined, inUse: (provider: string, credentialId: number) => number): AccountOrder {
    if (!this.#accounts) return { providers: [], ...(this.#listError ? { error: this.#listError } : {}) };
    const providers = OAUTH_PROVIDERS.filter((p) => this.oauth(p).length).map((p) => providerOrderView(p, this.oauth(p), this.#saved.providers[p], usage, (id) => inUse(p, id)));
    return { providers, ...(usage && !usage.error ? { usageAt: usage.fetchedAt } : {}) };
  }

  /** The saved selectors as they stand (after setOrder: the accounts were just checked). */
  #ordersNow(): { provider: string; selectors: AccountSelector[] }[] {
    return Object.entries(this.#saved.providers).map(([provider, sp]) => ({ provider, selectors: sp.accounts.map((e) => e.selector) }));
  }

  /** Org ids for a provider's accounts when one email holds several orgs: usage reports, omp's identities, and (`fetch`)
   *  a usage run when neither said. */
  async #loadOrgIds(all: ProviderAccount[], fetch: boolean): Promise<void> {
    if (!needsOrgIds(all)) return;
    const lacking = () => all.filter((a) => !this.#orgIds.has(a.credentialId));
    let identities: OmpIdentity[] | null = null;
    for (let round = 0; round < (fetch ? 2 : 1) && lacking().length; round++) {
      const usage = round === 0 ? this.o.accounts.lastUsage()?.snapshot : await this.o.accounts.usage();
      identities ??= await this.o.accounts.identities();
      for (const a of lacking()) {
        const org = orgIdOf(a, all, usage, identities);
        if (org) this.#orgIds.set(a.credentialId, org);
      }
    }
  }

  #save() {
    try {
      writeAtomic(this.#file, `${JSON.stringify(this.#saved, null, 2)}\n`);
    } catch (err) {
      log('accounts', `could not save the account order: ${errorText(err)}`);
    }
  }

  /** Rewrite omp's overlay when its text changed (atomic: omp watches the folder and reads the new file whole). */
  #writeOverlay(orders: { provider: string; selectors: AccountSelector[] }[]): boolean {
    const text = renderAccountsOverlay(orders, readOmpUserConfig(this.o.agentDir));
    if (text === this.#overlay && existsSync(this.overlayPath)) return false;
    try {
      writeAtomic(this.overlayPath, text);
      if (this.#overlay) this.#overlayAt = Date.now(); // a rewrite: running omps reload it (the first write is read at start)
      this.#overlay = text;
      return true;
    } catch (err) {
      log('accounts', `could not write the account order for the agent: ${errorText(err)}`);
      return false;
    }
  }
}
