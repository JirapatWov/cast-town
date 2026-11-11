// Model catalog + credential detection.
//
// Truth source: `omp models --json` run with the user's normal environment (default agent dir ~/.omp/agent,
// env API keys). omp lists ONLY credentialed models, so presence == available. A person whose model is not
// available can't work until it is connected — CAST never silently swaps in another vendor. Only with the
// scripted option (CAST_MOCK_LLM, tests/dev) do people run on the local scripted model (`rlt-demo` provider,
// demo-agent-dir.ts) while nothing at all is connected.
import { THINKING_LEVELS, type ModelInfo, type ProviderStatus, type ThinkingLevel, type Vendor } from '../../shared/protocol';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loginLabel } from '../../shared/omp-logins';
import { PROVIDER_VENDOR } from '../../shared/provider-vendors';
import { credentialKey } from './credential-key';
import { probeOmpVersion, runOmp } from './omp-check';
import { errorText, log } from './util';

export interface ModelCost {
  input: number; // USD per million tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CatalogModel {
  id: string; // omp selector "provider/id"
  label: string;
  vendor: Vendor;
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  images: boolean; // takes image input (omp's `input` includes "image")
}

/** What omp reports for one credentialed model (`omp models --json`). */
interface OmpModelEntry {
  provider: string;
  id: string;
  selector: string;
  name?: string;
  cost?: Partial<ModelCost>;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinking?: string[]; // the model's effort ladder, lowest first ("low", …, "xhigh", "max")
  input?: string[]; // what the model reads: "text", "image"
}

export const DEMO_PROVIDER = 'rlt-demo';

/** The levels omp offers for a model, as RLT names them (absent: unknown, e.g. not connected). */
function ladder(entry: OmpModelEntry | undefined): ThinkingLevel[] | undefined {
  if (!entry?.reasoning || !Array.isArray(entry.thinking)) return undefined;
  const levels = THINKING_LEVELS.filter((l) => l !== 'off' && entry.thinking!.includes(l));
  return levels.length ? levels : undefined;
}

const cost = (input: number, output: number): ModelCost => ({ input, output, cacheRead: input / 10, cacheWrite: input * 1.25 });

/** Image input per omp's own report (absent: unknown). */
const takesImages = (entry: OmpModelEntry | undefined): boolean | undefined => (Array.isArray(entry?.input) ? entry!.input.includes('image') : undefined);

/** Default catalog shown in the UI (selectors and image input verified against the bundled omp 18.13 catalog). */
export const DEFAULT_CATALOG: CatalogModel[] = [
  { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', vendor: 'anthropic', cost: cost(4, 20), contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, images: true },
  { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', vendor: 'anthropic', cost: cost(2, 10), contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, images: true },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', vendor: 'openai', cost: cost(2, 10), contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true, images: true },
  { id: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra', vendor: 'openai', cost: cost(1, 5), contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true, images: true },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'deepseek', cost: cost(1.32, 3.96), contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, images: false },
  { id: 'deepseek/deepseek-flash', label: 'DeepSeek Flash', vendor: 'deepseek', cost: cost(0.3, 1.2), contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, images: true },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', vendor: 'google', cost: cost(2, 10), contextWindow: 1_000_000, maxTokens: 64_000, reasoning: true, images: true },
];


/** How a picker names the sign-in a model runs through when it isn't the maker's own API (ModelInfo.route). */
const ROUTE_LABEL: Record<string, string> = {
  'openai-codex': 'ChatGPT',
  'openai-codex-device': 'ChatGPT',
  azure: 'Azure',
  'google-gemini-cli': 'Gemini CLI',
  'google-antigravity': 'Antigravity',
  'google-vertex': 'Vertex AI',
  openrouter: 'OpenRouter',
};

/** The route of an omp provider (undefined: a maker's own API — anthropic, openai, deepseek, google). Other providers
 *  are their own route, by the name omp's sign-in menu gives them ("github-copilot" → "GitHub Copilot"), else after
 *  their id ("my-llm" → "My llm"). */
export function routeOf(provider: string): string | undefined {
  if (ROUTE_LABEL[provider]) return ROUTE_LABEL[provider];
  if (PROVIDER_VENDOR[provider] === provider || !provider || provider === DEMO_PROVIDER) return undefined;
  return loginLabel(provider) ?? provider[0]!.toUpperCase() + provider.slice(1).replace(/[-_]+/g, ' ');
}

/** At most `n` of each provider's models, in the order given: one provider with hundreds (OpenRouter) doesn't push
 *  another provider's models out of the pickers. */
function capPerProvider(models: OmpModelEntry[], n: number): OmpModelEntry[] {
  const seen = new Map<string, number>();
  return models.filter((m) => {
    const k = (seen.get(m.provider) ?? 0) + 1;
    seen.set(m.provider, k);
    return k <= n;
  });
}

/** Vendor of an omp provider id ('openai-codex' → 'openai'); 'other' when RLT doesn't know it. */
export function vendorOfProvider(provider: string): Vendor {
  return PROVIDER_VENDOR[provider] ?? 'other';
}

/** Same-vendor, same-model alternative channels (e.g. a ChatGPT subscription serving gpt-6.1-sol). */
const ALT_CHANNELS: Partial<Record<string, string[]>> = {
  openai: ['openai-codex', 'openai-codex-device'],
  google: ['google-gemini-cli', 'google-antigravity'],
};

const PROVIDERS: { vendor: Vendor; label: string; how: string }[] = [
  { vendor: 'anthropic', label: 'Anthropic', how: 'export ANTHROPIC_API_KEY=… or run `cast-agent login anthropic` (Claude Pro/Max)' },
  { vendor: 'openai', label: 'OpenAI', how: 'export OPENAI_API_KEY=… or run `cast-agent login openai-codex` (ChatGPT Plus/Pro)' },
  { vendor: 'deepseek', label: 'DeepSeek', how: 'export DEEPSEEK_API_KEY=… (from platform.deepseek.com)' },
  { vendor: 'google', label: 'Google', how: 'export GEMINI_API_KEY=… or run `cast-agent login google-gemini-cli`' },
  { vendor: 'openrouter', label: 'OpenRouter', how: 'export OPENROUTER_API_KEY=sk-or-… or run `cast-agent login openrouter`' },
  { vendor: 'other', label: 'Other providers', how: 'a provider CAST has no card for (xAI, Mistral, a custom one in models.yml, …), signed in through the agent' },
];

export function vendorOfModelId(id: string): Vendor {
  const s = id.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(s)) return 'anthropic';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/gemini|gemma/.test(s)) return 'google';
  if (/gpt|codex|\bo\d/.test(s)) return 'openai';
  return 'other';
}

export function splitSelector(selector: string): { provider: string; id: string } {
  const bare = selector.replace(/:(off|minimal|low|medium|high|xhigh|max|auto)$/, '');
  const i = bare.indexOf('/');
  return i < 0 ? { provider: '', id: bare } : { provider: bare.slice(0, i), id: bare.slice(i + 1) };
}

/** Vendor = who made the model (drives the person's shirt color). Aggregators and the scripted model resolve by
 *  model id. */
export function vendorOf(selector: string): Vendor {
  const { provider, id } = splitSelector(selector);
  const byProvider = PROVIDER_VENDOR[provider];
  if (byProvider && byProvider !== 'openrouter') return byProvider;
  const byId = vendorOfModelId(id);
  if (byId !== 'other') return byId;
  return byProvider ?? 'other';
}

/** "claude-opus-5-5" → "Claude Opus 5 5"-ish label for models we have no catalog name for. */
function guessLabel(selector: string): string {
  const { id } = splitSelector(selector);
  const last = id.split('/').pop() ?? id;
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\b(gpt)\b/gi, 'GPT')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export type ResolvedModel =
  | { demo: false; selector: string } // real run: strict --model <selector>, default agent dir
  | { demo: true; selector: string }; // not connected: rlt-demo/<id>, run only on the scripted model (CAST_MOCK_LLM)

/** What the registry knows (AgentsHealth.models, plus 'idle': no check was ever asked for, e.g. in tests). */
export type ModelsState = 'idle' | 'checking' | 'ok' | 'stale' | 'failed';

export interface ModelRegistryOptions {
  /** Where the last good `omp models` answer is kept between runs (absent: not kept). */
  cacheFile?: string;
  /** omp's agent dir (credentials in agent.db, models.yml, config.yml): a change there means a check is due. */
  agentDir?: string;
  /** How long `omp models --json` may take (default 60 s). */
  timeoutMs?: number;
  /** A key of the extra environment omp gets (config.json ompEnv, OmpEnv.key()): a key added or removed by hand
   *  changes which models omp lists, so it is part of the fingerprint the saved list is checked against. */
  envKey?: () => string;
  /** Tests/dev only (CAST_MOCK_LLM): while nothing is connected, people run on the local scripted model. */
  scripted?: boolean;
}

/** What omp is signed in to, as a key that changes only when the sign-ins (or omp's model config) do: the stored
 *  credential rows, not agent.db's mtime, which moves with every chat turn (credential-key.ts). */
export function credentialFingerprint(agentDir: string | undefined): string {
  return credentialKey(agentDir);
}

/** The fingerprint a model list is read under: the sign-ins, plus omp's extra environment when there is one (without
 *  any, the same string as before, so a list saved by an older CAST stays valid). */
function listFingerprint(credentials: string, env: string): string {
  return env ? `${credentials}|env:${env}` : credentials;
}

interface ModelsCache {
  version: 1;
  at: number; // epoch ms of the check
  bin: string;
  fingerprint: string;
  models: OmpModelEntry[];
}

export class ModelRegistry {
  #available = new Map<string, OmpModelEntry>(); // selector → entry
  /** A check of this run worked at least once. */
  #detected = false;
  /** What #available holds came from the cache file (the last run's check), not from a check of this run. */
  #fromCache = false;
  #detectError: string | null = null;
  /** Why the last check failed, in kind: omp missing, too slow, or an error. */
  #failure: 'missing' | 'timeout' | 'failed' | null = null;
  #checkedAt: number | null = null;
  #fingerprint = ''; // credential files (and omp's extra environment) when #available was read
  #credentials = ''; // the credential key alone when #available was read ('' : not known)
  #inflight: Promise<void> | null = null;
  #extras: CatalogModel[] = []; // models used by workflows that are not in the default catalog
  readonly #timeoutMs: number;

  constructor(private readonly ompBin: string, private readonly env: Record<string, string | undefined>, private readonly opts: ModelRegistryOptions = {}) {
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    this.#loadCache();
  }

  /** Re-detect credentialed models. Never throws; a check already running is joined, not started twice (each one is an
   *  omp process of a few hundred MB). A failed check keeps what the last good one found — of this run, or saved by
   *  the last run: a hiccup must never lock out a signed-in user. Failing before any result, nothing counts as
   *  connected: nobody can work and AgentsHealth says why. */
  detect(): Promise<void> {
    this.#inflight ??= this.#detect().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  #envKey(): string {
    try {
      return this.opts.envKey?.() ?? '';
    } catch {
      return '';
    }
  }

  async #detect(): Promise<void> {
    const credentials = credentialFingerprint(this.opts.agentDir);
    const fingerprint = listFingerprint(credentials, this.#envKey());
    const r = await runOmp(this.ompBin, ['models', '--json'], this.env, this.#timeoutMs);
    try {
      if (r.kind !== 'ok') throw Object.assign(new Error(r.error), { kind: r.kind });
      let parsed: { models?: OmpModelEntry[] };
      try {
        parsed = JSON.parse(r.stdout) as { models?: OmpModelEntry[] };
      } catch {
        throw Object.assign(new Error('cast-agent models printed something CAST could not read'), { kind: 'failed' });
      }
      const next = new Map<string, OmpModelEntry>();
      for (const m of parsed.models ?? []) {
        if (!m?.provider || !m.id || m.provider === DEMO_PROVIDER) continue;
        next.set(m.selector ?? `${m.provider}/${m.id}`, m);
      }
      this.#available = next;
      this.#detected = true;
      this.#fromCache = false;
      this.#detectError = null;
      this.#failure = null;
      this.#checkedAt = Date.now();
      this.#fingerprint = fingerprint;
      this.#credentials = credentials;
      this.#saveCache();
      const none = this.opts.scripted ? ' (people run on the scripted model: CAST_MOCK_LLM)' : ' (nobody can work until an AI account is connected)';
      log('models', `credentialed models: ${this.#available.size}${this.#available.size ? '' : none}`);
    } catch (err) {
      this.#detectError = errorText(err);
      this.#failure = ((err as { kind?: string }).kind as 'missing' | 'timeout' | 'failed' | undefined) ?? 'failed';
      const kept = this.#detected ? 'keeping the last result' : this.#fromCache ? 'keeping the result saved by the last run' : 'nothing counts as connected until a check works';
      if (this.#failure !== 'missing') log('models', `model check failed: ${this.#detectError} — ${kept}`); // a missing omp: OmpHealth says it
    }
  }

  /** A check of this run worked at least once. */
  get detected(): boolean {
    return this.#detected;
  }

  /** There is a result to go by: a check of this run, or the one the last run saved. */
  get hasResult(): boolean {
    return this.#detected || this.#fromCache;
  }

  /** Why the last check failed (null: it worked, or none ran yet). */
  get detectError(): string | null {
    return this.#detectError;
  }

  /** The last check failed because omp isn't there / too slow / errored (null: it didn't fail). */
  get failure(): 'missing' | 'timeout' | 'failed' | null {
    return this.#detectError ? this.#failure : null;
  }

  get checking(): boolean {
    return !!this.#inflight;
  }

  /** When the result in use was read (epoch ms; null: none). */
  get checkedAt(): number | null {
    return this.#checkedAt;
  }

  /** idle: never asked · checking: the first check runs, nothing to go by yet · ok: this run's last check worked ·
   *  stale: going by an earlier result (the last run's, or this run's before a check that failed or still runs) ·
   *  failed: no check has worked and nothing is saved — nothing counts as connected. */
  get state(): ModelsState {
    if (this.#detected && !this.#detectError) return 'ok';
    if (this.hasResult) return 'stale';
    if (this.#detectError) return 'failed';
    return this.#inflight ? 'checking' : 'idle';
  }

  /** Resolves once the very first check has ended (worked or not) — at once when there is a result, when no check
   *  runs, or when one already failed (then the app says so). A message waits for it rather than being refused for a
   *  user who is signed in. */
  async firstResult(): Promise<void> {
    if (this.state === 'checking') await this.#inflight;
  }

  /** The key of omp's sign-ins right now (credential-key.ts; '' without an agent dir): other readers of omp's
   *  stored accounts cache by it too. */
  credentialsKey(): string {
    return credentialFingerprint(this.opts.agentDir);
  }

  /** The credential key the model list in use was read under ('' : none read this run, nothing to compare with). The
   *  credential watch (credential-watch.ts) compares omp's store with it: a sign-in CAST made itself already matches. */
  get checkedCredentialsKey(): string {
    return this.#credentials;
  }

  /** The last good check is recent and omp's credential files (and its extra environment) haven't changed since: asking
   *  omp again would say the same (Refresh uses this to avoid starting a few-hundred-MB omp for nothing). */
  upToDate(maxAgeMs: number, now = Date.now()): boolean {
    if (!this.hasResult || this.#detectError || this.#checkedAt === null || !this.opts.agentDir) return false;
    return now - this.#checkedAt < maxAgeMs && listFingerprint(credentialFingerprint(this.opts.agentDir), this.#envKey()) === this.#fingerprint;
  }

  #loadCache() {
    const file = this.opts.cacheFile;
    if (!file || !existsSync(file)) return;
    try {
      const c = JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelsCache>;
      if (c.version !== 1 || c.bin !== this.ompBin || !Array.isArray(c.models) || typeof c.at !== 'number') return;
      for (const m of c.models) if (m?.provider && m.id && m.provider !== DEMO_PROVIDER) this.#available.set(m.selector ?? `${m.provider}/${m.id}`, m);
      this.#fromCache = true;
      this.#checkedAt = c.at;
      this.#fingerprint = typeof c.fingerprint === 'string' ? c.fingerprint : '';
      this.#credentials = this.#fingerprint.split('|env:')[0]!;
    } catch {
      /* unreadable: check from scratch */
    }
  }

  #saveCache() {
    const file = this.opts.cacheFile;
    if (!file) return;
    const c: ModelsCache = { version: 1, at: this.#checkedAt ?? Date.now(), bin: this.ompBin, fingerprint: this.#fingerprint, models: [...this.#available.values()] };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      log('models', `could not save the model list: ${errorText(err)}`);
    }
  }

  /** The effective real selector for a requested model, or null when it has no credentials. */
  #realRoute(selector: string): string | null {
    const { provider, id } = splitSelector(selector);
    if (this.#available.has(`${provider}/${id}`)) return `${provider}/${id}`;
    for (const alt of ALT_CHANNELS[provider] ?? []) {
      if (this.#available.has(`${alt}/${id}`)) return `${alt}/${id}`;
    }
    return null;
  }

  isAvailable(selector: string): boolean {
    return this.#realRoute(selector) !== null;
  }

  resolve(selector: string): ResolvedModel {
    const real = this.#realRoute(selector);
    if (real) return { demo: false, selector: real };
    return { demo: true, selector: `${DEMO_PROVIDER}/${splitSelector(selector).id}` };
  }

  /** Something is connected. */
  anyAvailable(): boolean {
    return this.#available.size > 0;
  }

  /** People on unconnected models run on the scripted model: only with the scripted option (CAST_MOCK_LLM, tests/dev)
   *  and only while nothing is connected. Always false in production. */
  demoActive(): boolean {
    return this.opts.scripted === true && this.#available.size === 0;
  }

  /** Best model for the general Assistant: Opus when credentialed, else any credentialed core model, else the first
   *  connected model (a provider outside the catalog), else Opus (nothing connected yet). */
  preferredAssistantModel(): string {
    const order = ['anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol', 'google/gemini-4-argon', 'deepseek/deepseek-v4-pro', 'anthropic/claude-sonnet-5-5'];
    return order.find((s) => this.isAvailable(s)) ?? this.models().find((m) => m.available)?.id ?? 'anthropic/claude-opus-5-5';
  }

  /** Register models referenced by workflows so they get labels (and scripted-model entries). */
  noteSelectors(selectors: string[]): boolean {
    let added = false;
    for (const s of selectors) {
      const { provider, id } = splitSelector(s);
      const sel = `${provider}/${id}`;
      if (!provider || !id) continue;
      if (DEFAULT_CATALOG.some((m) => m.id === sel) || this.#extras.some((m) => m.id === sel)) continue;
      this.#extras.push(this.#catalogFor(sel));
      added = true;
    }
    return added;
  }

  #catalogFor(selector: string): CatalogModel {
    const known = DEFAULT_CATALOG.find((m) => m.id === selector) ?? this.#extras.find((m) => m.id === selector);
    if (known) return known;
    const entry = this.#available.get(selector);
    const c = entry?.cost;
    return {
      id: selector,
      label: entry?.name ?? guessLabel(selector),
      vendor: vendorOf(selector),
      cost: { input: c?.input ?? 1, output: c?.output ?? 5, cacheRead: c?.cacheRead ?? 0.1, cacheWrite: c?.cacheWrite ?? 1 },
      contextWindow: entry?.contextWindow ?? 200_000,
      maxTokens: entry?.maxTokens ?? 32_000,
      reasoning: entry?.reasoning ?? true,
      images: takesImages(entry) ?? false,
    };
  }

  /** The model takes image input: what omp reports for the route RLT would use (the user's models.yml may say
   *  otherwise than the catalog), else the catalog. Scripted-model selectors answer for the model they stand in for. */
  takesImages(selector: string): boolean {
    const sel = this.undemo(selector);
    const real = this.#realRoute(sel);
    return takesImages(real ? this.#available.get(real) : undefined) ?? this.#catalogFor(sel).images;
  }

  label(selector: string): string {
    const { provider, id } = splitSelector(selector);
    if (provider === DEMO_PROVIDER) {
      const m = [...DEFAULT_CATALOG, ...this.#extras].find((c) => splitSelector(c.id).id === id);
      return m?.label ?? guessLabel(selector);
    }
    return this.#catalogFor(`${provider}/${id}`).label;
  }

  /** Map a scripted-model selector ("rlt-demo/claude-opus-5-5") back to the catalog selector it stands in for. */
  undemo(selector: string): string {
    const { provider, id } = splitSelector(selector);
    if (provider !== DEMO_PROVIDER) return `${provider}/${id}`;
    return [...DEFAULT_CATALOG, ...this.#extras].find((c) => splitSelector(c.id).id === id)?.id ?? selector;
  }

  /** Catalog + credentialed extras (core vendors first, capped per provider so the picker stays usable and every
   *  signed-in provider keeps its models there). Providers RLT doesn't
   *  know (xAI, Mistral, a custom one) are listed too — as vendor 'other' — so whoever is signed in only there still
   *  has models to pick (anyAvailable() counts them); so are OpenRouter's models from makers without a card (vendor
   *  'openrouter'), while its Claude / GPT / Gemini / DeepSeek models go on those vendors' cards. */
  models(): ModelInfo[] {
    const out: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const m of [...DEFAULT_CATALOG, ...this.#extras]) {
      const real = this.#realRoute(m.id);
      const entry = real ? this.#available.get(real) : undefined;
      // (no route: a catalog model goes through whichever sign-in has it — its maker's first; the extras below name theirs)
      out.push({ id: m.id, label: m.label, vendor: m.vendor, available: this.isAvailable(m.id), thinking: ladder(entry), images: takesImages(entry) ?? m.images });
      seen.add(m.id);
    }
    const extras = [...this.#available.values()]
      .filter((m) => !seen.has(m.selector))
      .sort((a, b) => a.selector.localeCompare(b.selector));
    const firstParty = extras.filter((m) => PROVIDER_VENDOR[m.provider] && m.provider !== 'openrouter');
    const others = extras.filter((m) => !firstParty.includes(m) && vendorOfModelId(m.id) !== 'other');
    // the rest: makers CAST has no vendor for, through OpenRouter (its card) or a provider of their own ('other')
    const unknown = extras.filter((m) => !firstParty.includes(m) && !others.includes(m));
    for (const m of [...firstParty.slice(0, 60), ...capPerProvider(others, 40), ...capPerProvider(unknown, 40)]) {
      const route = routeOf(m.provider);
      out.push({ id: m.selector, label: m.name ?? guessLabel(m.selector), vendor: vendorOf(m.selector), available: true, thinking: ladder(m), images: takesImages(m) ?? false, ...(route ? { route } : {}) });
    }
    return out;
  }

  providers(): ProviderStatus[] {
    const connected = new Set<Vendor>();
    for (const m of this.#available.values()) connected.add(PROVIDER_VENDOR[m.provider] ?? vendorOfModelId(m.id));
    // Every vendor with a sign-in gets a card, OpenRouter included (hidden until connected, it could never be connected
    // from the app). "Other providers" (no sign-in of CAST's, set up through omp) shows once something is connected there.
    return PROVIDERS.filter((p) => p.vendor !== 'other' || connected.has(p.vendor)).map((p) => ({
      vendor: p.vendor,
      label: p.label,
      connected: connected.has(p.vendor),
      how: p.how,
    }));
  }

  /** Connected models RLT knows by name (the catalog and the models workflows use), each with the selector omp
   *  reaches it by — one task-tool helper each (helper-agents.ts). Not every connected extra: the task tool lists every
   *  helper in its description, so the list stays short. */
  helperModels(): { id: string; selector: string; label: string }[] {
    const out: { id: string; selector: string; label: string }[] = [];
    for (const m of [...DEFAULT_CATALOG, ...this.#extras]) {
      const real = this.#realRoute(m.id);
      if (real && !out.some((x) => x.selector === real)) out.push({ id: m.id, selector: real, label: m.label });
    }
    return out;
  }

  /** Every model the scripted provider must be able to stand in for (CAST_MOCK_LLM). */
  demoCatalog(): CatalogModel[] {
    return [...DEFAULT_CATALOG, ...this.#extras];
  }

  /** Per-million-token cost for a selector (used to sanity-check reported costs). */
  catalogEntry(selector: string): CatalogModel {
    return this.#catalogFor(this.undemo(selector));
  }
}

/** `omp --version` → "18.13.2" (null when it couldn't be read: see probeOmpVersion for why). */
export async function detectOmpVersion(ompBin: string, env: Record<string, string | undefined>, timeoutMs = 60_000): Promise<string | null> {
  const r = await probeOmpVersion(ompBin, env, timeoutMs);
  return r.kind === 'ok' ? r.version : null;
}
