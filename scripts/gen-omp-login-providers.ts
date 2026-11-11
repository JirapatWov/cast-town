// bun run gen:omp-logins [--check]        (= bun run scripts/gen-omp-login-providers.ts)
//
// Writes shared/omp-login-providers.ts: every sign-in `omp login` offers, in its menu order, for the agent CAST runs
// (cast-agent, CAST's fork of omp in agent/). Read from the agent's own source, so a change that adds providers only
// needs this script run again (and tests/providers/omp-login-providers.test.ts fails until it is: it compares the list
// with the agent's real login menu).
//
// What it reads from the agent's source (agent/ of this repository; OMP_SRC or CAST_OMP_SRC: another omp checkout):
//   packages/catalog/src/compat/rules.json      the compiled auth rules (rules/auth/*.kdl) in /login order: id, name,
//                                               the login flow kind, store-as, show-in-login-list, available
//   packages/ai/src/registry/hooks/*.ts         which module a `login "custom"` hook runs, to tell its kind
//   packages/ai/src/registry/oauth/*.ts         …and that module's source
//   packages/coding-agent/package.json          the omp version
//
// --check: exit 1 (writing nothing) when the checked-in file differs from what this omp gives.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Kind = 'browser' | 'device' | 'key' | 'email';
type Group = 'signin' | 'key' | 'cloud' | 'other';

interface Entry {
  id: string;
  name: string;
  label: string;
  kind: Kind;
  group: Group;
  storeAs?: string;
}

/** `login "custom"` hooks whose kind the source can't tell at a glance (checked by hand against their modules). A hook
 *  missing here is classified from its module's source; the script says so, so a person looks once. */
const HOOK_KIND: Record<string, Kind> = {
  'alibaba-coding-plan': 'key', // endpoint choice, then a key
  'alibaba-token-plan': 'key',
  'cloudflare-ai-gateway': 'key', // token, account ID, gateway ID
  'cloudflare-workers-ai': 'key', // token, account ID
  kilo: 'device',
  xiaomi: 'key',
  'openai-codex-device': 'device',
  'github-copilot': 'device', // GitHub Enterprise domain (blank for github.com), then a device code
  cursor: 'browser', // opens a page and waits; nothing to paste
  perplexity: 'email', // the terminal flow: e-mail address, then the code sent there
  snowflake: 'browser', // account identifier, then a browser sign-in (redirect pasted back)
};

/** What a provider is, for the list's groups. A provider missing here is grouped by its kind and name. */
const GROUP: Record<string, Group> = {
  // subscriptions and account sign-ins (coding plans included, even when they hand out a key)
  'openai-codex': 'signin',
  'openai-codex-device': 'signin',
  anthropic: 'signin',
  zai: 'signin',
  'zai-coding-plan': 'signin',
  'kimi-code': 'signin',
  'github-copilot': 'signin',
  cursor: 'signin',
  devin: 'signin',
  'google-antigravity': 'signin',
  'google-gemini-cli': 'signin',
  'xai-oauth': 'signin',
  'gitlab-duo': 'signin',
  'gitlab-duo-agent': 'signin',
  'alibaba-coding-plan': 'signin',
  'alibaba-token-plan': 'signin',
  'zhipu-coding-plan': 'signin',
  umans: 'signin',
  'qwen-portal': 'signin',
  'minimax-code': 'signin',
  'minimax-code-cn': 'signin',
  'xiaomi-token-plan-sgp': 'signin',
  'xiaomi-token-plan-ams': 'signin',
  'xiaomi-token-plan-cn': 'signin',
  firepass: 'signin',
  'cline-pass': 'signin',
  'factory-droid': 'signin',
  commandcode: 'signin',
  'charm-hyper': 'signin',
  'muse-code': 'signin',
  perplexity: 'signin',
  stencil: 'signin',
  // a model maker's own API
  xai: 'key',
  aiand: 'key',
  abliteration: 'key',
  sakana: 'key',
  xiaomi: 'key',
  deepseek: 'key',
  stepfun: 'key',
  meta: 'key',
  moonshot: 'key',
  inception: 'key',
  qianfan: 'key',
  helmcode: 'key',
  // hosted inference, routers and gateways
  openrouter: 'cloud',
  sambanova: 'cloud',
  cerebras: 'cloud',
  baseten: 'cloud',
  fireworks: 'cloud',
  together: 'cloud',
  nvidia: 'cloud',
  novita: 'cloud',
  deepinfra: 'cloud',
  huggingface: 'cloud',
  venice: 'cloud',
  siliconflow: 'cloud',
  'siliconflow-cn': 'cloud',
  synthetic: 'cloud',
  nanogpt: 'cloud',
  'wafer-serverless': 'cloud',
  coreweave: 'cloud',
  'vercel-ai-gateway': 'cloud',
  'cloudflare-ai-gateway': 'cloud',
  'cloudflare-workers-ai': 'cloud',
  snowflake: 'cloud',
  litellm: 'cloud',
  kilo: 'cloud',
  zenmux: 'cloud',
  'opencode-zen': 'cloud',
  'opencode-go': 'cloud',
  'ollama-cloud': 'cloud',
  'gmi-cloud': 'cloud',
  'singularityapi-dev': 'cloud',
  'singularityapi-tech': 'cloud',
  'yolo-auto': 'cloud',
  // local servers, search and other tools
  ollama: 'other',
  'lm-studio': 'other',
  'llama.cpp': 'other',
  vllm: 'other',
  tavily: 'other',
  kagi: 'other',
  exa: 'other',
  parallel: 'other',
  typesafe: 'other',
  coralbricks: 'other',
};

interface Rule {
  id?: unknown;
  name?: unknown;
  login?: { kind?: unknown; hook?: unknown } | null;
  storeAs?: unknown;
  showInLoginList?: unknown;
  available?: unknown;
}

const notes: string[] = [];

function ompRoot(): string {
  const raw = process.env.OMP_SRC?.trim() || process.env.CAST_OMP_SRC?.trim() || join(import.meta.dir, '..', 'agent');
  let root = resolve(raw);
  // also accept a package folder inside the checkout (packages/coding-agent, packages/catalog, …)
  for (let i = 0; i < 3 && !existsSync(join(root, 'packages', 'catalog')); i++) root = dirname(root);
  if (!existsSync(join(root, 'packages', 'catalog', 'src', 'compat', 'rules.json'))) {
    throw new Error(`No omp checkout at ${raw} (packages/catalog/src/compat/rules.json is missing).`);
  }
  return root;
}

/** hook name → the module file it imports, from the registry's hook tables (`name: () => import("../oauth/x")…`). */
function hookModules(root: string): Map<string, string> {
  const dir = join(root, 'packages', 'ai', 'src', 'registry', 'hooks');
  const out = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/(?:"([^"]+)"|'([^']+)'|([\w$]+))\s*:\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)/g)) {
      const name = m[1] ?? m[2] ?? m[3]!;
      const spec = m[4]!;
      if (!spec.startsWith('.')) continue; // a package module (no login flow of its own)
      out.set(name, resolve(dir, `${spec}.ts`));
    }
  }
  return out;
}

/** A custom hook's kind: the table above, else read from its module (a device code, a pasted key, or the browser). */
function hookKind(hook: string, modules: Map<string, string>): Kind {
  const known = HOOK_KIND[hook];
  if (known) return known;
  const file = modules.get(hook);
  const src = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  const kind: Kind = /user_code|userCode|Enter code/.test(src) ? 'device' : /message:\s*["'`]Paste your [^"'`]*(?:API key|token)/i.test(src) ? 'key' : 'browser';
  notes.push(`hook "${hook}" is not in HOOK_KIND: read as "${kind}" from ${file ? file.split('/packages/')[1] ?? file : 'nowhere (module not found)'}`);
  return kind;
}

function groupOf(id: string, name: string, kind: Kind): Group {
  const known = GROUP[id];
  if (known) return known;
  const group: Group =
    kind !== 'key' || /\b(?:plan|pass|subscription)\b/i.test(name)
      ? 'signin'
      : /local/i.test(name)
        ? 'other'
        : /gateway|cloud|serverless|inference|router/i.test(name)
          ? 'cloud'
          : 'key';
  notes.push(`provider "${id}" is not in GROUP: put in "${group}"`);
  return group;
}

/** "Cursor (Claude, GPT, etc.)" → "Cursor"; the full name when another provider would end up with the same label. */
function labels(names: string[]): string[] {
  const short = names.map((n) => n.replace(/\s*\([^()]*\)\s*$/, '').trim() || n);
  return short.map((s, i) => (short.filter((x) => x.toLowerCase() === s.toLowerCase()).length > 1 ? names[i]! : s));
}

export function readProviders(root: string): { version: string; providers: Entry[] } {
  const rules = JSON.parse(readFileSync(join(root, 'packages', 'catalog', 'src', 'compat', 'rules.json'), 'utf8')) as { auth?: { providers?: Rule[] } };
  const pkg = JSON.parse(readFileSync(join(root, 'packages', 'coding-agent', 'package.json'), 'utf8')) as { version?: string };
  const modules = hookModules(root);
  const rows = (rules.auth?.providers ?? []).filter(
    (p) => typeof p.id === 'string' && typeof p.name === 'string' && p.login && p.showInLoginList !== false && p.available !== false,
  );
  const names = labels(rows.map((p) => p.name as string));
  const providers = rows.map((p, i): Entry => {
    const id = p.id as string;
    const name = p.name as string;
    const login = p.login!;
    const kind: Kind =
      login.kind === 'api-key'
        ? 'key'
        : login.kind === 'device-code'
          ? 'device'
          : login.kind === 'oauth-code'
            ? 'browser'
            : login.kind === 'custom' && typeof login.hook === 'string'
              ? hookKind(login.hook, modules)
              : (notes.push(`provider "${id}" has an unknown login kind ${String(login.kind)}: read as "browser"`), 'browser');
    const entry: Entry = { id, name, label: names[i]!, kind, group: groupOf(id, name, kind) };
    if (typeof p.storeAs === 'string' && p.storeAs && p.storeAs !== id) entry.storeAs = p.storeAs;
    return entry;
  });
  return { version: pkg.version ?? 'unknown', providers };
}

/** A single-quoted TypeScript string (the repository's style). */
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function render(version: string, providers: Entry[]): string {
  const rows = providers
    .map((p) => `  { id: ${str(p.id)}, name: ${str(p.name)}, label: ${str(p.label)}, kind: ${str(p.kind)}, group: ${str(p.group)}${p.storeAs ? `, storeAs: ${str(p.storeAs)}` : ''} },`)
    .join('\n');
  return `// GENERATED by scripts/gen-omp-login-providers.ts from omp ${version} — do not edit by hand.
// Run \`bun run gen:omp-logins\` after changing the agent (agent/).
//
// Every sign-in \`omp login\` offers, in its menu order: omp's provider id, its display name, a shorter label, how the
// sign-in works (kind) and the group Models & providers lists it under. \`storeAs\`: the provider omp keeps the
// credential under when it is another one (a second way into the same account).
// tests/providers/omp-login-providers.test.ts checks it against the menu of the omp it finds.

/** browser: sign in on the provider's page (the address it lands on may be pasted back) · device: open a page and
 *  enter the code shown · key: paste an API key (some ask an endpoint or an account ID first) · email: a code sent by
 *  e-mail. */
export type OmpLoginKind = 'browser' | 'device' | 'key' | 'email';
/** signin: subscriptions and account sign-ins · key: a model maker's API key · cloud: hosted inference, routers and
 *  gateways · other: local servers, search and other tools. */
export type OmpLoginGroup = 'signin' | 'key' | 'cloud' | 'other';

export interface OmpLoginProvider {
  id: string;
  name: string;
  label: string;
  kind: OmpLoginKind;
  group: OmpLoginGroup;
  storeAs?: string;
}

export const OMP_LOGIN_PROVIDERS_VERSION = ${str(version)};

export const OMP_LOGIN_PROVIDERS: readonly OmpLoginProvider[] = [
${rows}
];
`;
}

if (import.meta.main) {
  const root = ompRoot();
  const { version, providers } = readProviders(root);
  const text = render(version, providers);
  const out = resolve(import.meta.dir, '..', 'shared', 'omp-login-providers.ts');
  for (const n of notes) console.warn(`note: ${n}`);
  if (process.argv.includes('--check')) {
    const same = existsSync(out) && readFileSync(out, 'utf8') === text;
    console.log(same ? `shared/omp-login-providers.ts is up to date (omp ${version}, ${providers.length} providers)` : `shared/omp-login-providers.ts is out of date for omp ${version}: run without --check`);
    process.exit(same ? 0 : 1);
  }
  writeFileSync(out, text);
  console.log(`wrote shared/omp-login-providers.ts: ${providers.length} providers from omp ${version}`);
}
