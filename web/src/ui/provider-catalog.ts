// What Models & providers lists beyond the featured vendor cards, as pure functions (no DOM, unit-tested): every
// sign-in `omp login` offers ("Connect another account": searched, grouped, the connected ones first), the card each
// other signed-in provider gets (its accounts and models), and the folded/unfolded state of the cards' parts.
import { OMP_LOGIN_PROVIDERS, credentialProviderOf, loginLabel, loginOfCredential, type OmpLoginGroup, type OmpLoginKind, type OmpLoginProvider } from '../../../shared/omp-logins';
import { featuredProvider } from '../../../shared/provider-vendors';
import type { ModelInfo, ProviderAccount } from '../../../shared/protocol';

export const GROUP_ORDER: readonly OmpLoginGroup[] = ['signin', 'key', 'cloud', 'other'];

export const GROUP_TITLE: Record<OmpLoginGroup, string> = {
  signin: 'Subscriptions & sign-ins',
  key: 'API keys',
  cloud: 'Cloud & gateways',
  other: 'Local & other',
};

/** The kind as a short tag, and as words for a tooltip / screen reader. */
export const KIND_TAG: Record<OmpLoginKind, string> = { browser: 'Browser sign-in', device: 'Device code', key: 'API key', email: 'Email code' };
export const KIND_TEXT: Record<OmpLoginKind, string> = {
  browser: 'Sign in in the browser',
  device: 'Open a page and enter a code',
  key: 'Paste an API key',
  email: 'Get a code by email',
};

/** The omp provider a model runs through: its selector's first part ("github-copilot/claude-…" → "github-copilot"). */
export const providerOfModel = (id: string): string => id.slice(0, Math.max(0, id.indexOf('/')));

/** The credential providers that are signed in: a stored account, or a connected model running through them (an
 *  environment key). */
export function signedInProviders(models: readonly ModelInfo[], accounts: readonly ProviderAccount[]): Set<string> {
  const out = new Set<string>(accounts.map((a) => a.provider));
  for (const m of models) if (m.available) out.add(providerOfModel(m.id));
  out.delete('');
  return out;
}

/** The sign-ins whose credential provider is signed in ('openai-codex-device' counts when ChatGPT is). */
export function connectedLogins(signedIn: ReadonlySet<string>, list: readonly OmpLoginProvider[] = OMP_LOGIN_PROVIDERS): Set<string> {
  return new Set(list.filter((p) => signedIn.has(credentialProviderOf(p.id))).map((p) => p.id));
}

/** Every word of the query is in the provider's name, label, id, kind or group ("key cloud", "copilot"). */
export function matchesLogin(p: OmpLoginProvider, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${p.name} ${p.label} ${p.id} ${KIND_TAG[p.kind]} ${KIND_TEXT[p.kind]} ${GROUP_TITLE[p.group]}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface LoginGroup {
  group: OmpLoginGroup;
  title: string;
  providers: OmpLoginProvider[];
  connected: number;
}

/** The list's groups in GROUP_ORDER (empty ones left out), each with the connected sign-ins first and otherwise omp's
 *  menu order; filtered by the query. */
export function groupLogins(query: string, connected: ReadonlySet<string>, list: readonly OmpLoginProvider[] = OMP_LOGIN_PROVIDERS): LoginGroup[] {
  const hits = list.filter((p) => matchesLogin(p, query));
  return GROUP_ORDER.map((group) => {
    const mine = hits.filter((p) => p.group === group);
    const on = mine.filter((p) => connected.has(p.id));
    return { group, title: GROUP_TITLE[group], providers: [...on, ...mine.filter((p) => !connected.has(p.id))], connected: on.length };
  }).filter((g) => g.providers.length);
}

/** A signed-in provider without a featured card: its own card. */
export interface OtherProvider {
  provider: string; // the credential / model provider id ('github-copilot', 'zai', 'cerebras', a models.yml one)
  label: string;
  login?: OmpLoginProvider; // the sign-in that connects it again (absent: one omp's menu doesn't have)
  models: ModelInfo[];
  accounts: ProviderAccount[];
}

/** One card per signed-in provider that has no featured card, in omp's menu order (others after, by id): the models
 *  that run through it and the accounts omp holds for it. */
export function otherProviders(models: readonly ModelInfo[], accounts: readonly ProviderAccount[]): OtherProvider[] {
  const ids = [...signedInProviders(models, accounts)].filter((p) => !featuredProvider(p));
  const rank = (p: string) => {
    const login = loginOfCredential(p);
    return login ? OMP_LOGIN_PROVIDERS.indexOf(login) : Number.MAX_SAFE_INTEGER;
  };
  ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return ids.map((provider) => ({
    provider,
    label: loginLabel(provider) ?? provider[0]!.toUpperCase() + provider.slice(1).replace(/[-_]+/g, ' '),
    ...(loginOfCredential(provider) ? { login: loginOfCredential(provider) } : {}),
    models: models.filter((m) => m.available && providerOfModel(m.id) === provider),
    accounts: accounts.filter((a) => a.provider === provider),
  }));
}

/** Where a sign-in's panel shows: its featured card ('vendor'), the card of its provider ('card'), or its row of the
 *  list ('list'). */
export function signInHome(login: string, cards: ReadonlySet<string>): 'vendor' | 'card' | 'list' {
  const provider = credentialProviderOf(login);
  if (featuredProvider(provider) || featuredProvider(login)) return 'vendor';
  return cards.has(provider) ? 'card' : 'list';
}

// ───────────────────────── folded parts (remembered per device) ─────────────────────────

/** deviceStorage key: { "<part>:<card>": true } for each part the user unfolded. */
export const OPEN_PARTS_KEY = 'rlt.providers.open';

export function parseOpenParts(raw: string | null): Set<string> {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return new Set();
    return new Set(Object.entries(v as Record<string, unknown>).filter(([k, on]) => on === true && k.length <= 120).map(([k]) => k));
  } catch {
    return new Set();
  }
}

export function serializeOpenParts(open: ReadonlySet<string>): string {
  return JSON.stringify(Object.fromEntries([...open].sort().map((k) => [k, true])));
}

/** "12 models", "1 model". */
export const modelCount = (n: number): string => `${n} ${n === 1 ? 'model' : 'models'}`;

/** The device code to enter, from a sign-in's code field or its instructions ("Enter code: ABCD-1234"). */
export function deviceCode(l: { userCode?: string; instructions?: string }): string | null {
  return l.userCode ?? /\bcode:\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/i.exec(l.instructions ?? '')?.[1] ?? null;
}

/** Past this share of the screen's height the dialog's header counts as tall. */
export const TALL_HEAD_SHARE = 0.4;

/** The dialog's header (title, subtitle, Refresh) takes so much of the screen that the cards below it get little room
 *  (very large text on a small phone): the whole dialog scrolls then (providers-list.ts watchTallHead). */
export function isTallHead(headHeight: number, viewportHeight: number): boolean {
  return viewportHeight > 0 && headHeight > viewportHeight * TALL_HEAD_SHARE;
}
