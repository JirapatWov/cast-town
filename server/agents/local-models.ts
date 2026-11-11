// Model servers on another machine (LAN or tailnet: llama.cpp, Ollama, LM Studio, any OpenAI-compatible server), set
// up from Models & providers → Local model server instead of by hand. omp reads them from <agent dir>/models.yml:
//
//   providers:
//     desk-llama:
//       baseUrl: http://192.168.1.20:8080/v1
//       api: openai-completions
//       auth: none            # or apiKey: <key>
//       discovery:
//         type: llama.cpp     # or ollama / lm-studio / openai-models-list
//
// omp asks the server for its models every time it lists them (`omp models`), so a saved server's models show up on
// the next model check (the caller runs it); nothing to restart.
//
//   the file    models.yml, or models.yaml when only that exists (omp reads whichever is there); a models.json that omp
//               hasn't moved to YAML yet is read and written out as models.yml, as omp itself would. Everything else
//               in the file — other providers, other keys of this one — is kept; Bun.YAML drops comments. Written
//               atomically, 0600 (it may hold keys).
//   addresses   http/https only, no user:password; stored ending in /v1 (omp then reads <address>/v1/models and
//               chats at <address>/v1/chat/completions), except Ollama's, which omp uses as the bare origin
//               (/api/tags, /v1/chat/completions).
//   keys        stored as given (omp first tries a key as an environment variable name, then uses it as is); never
//               sent to the browser, never logged; one starting with `!` is refused (omp would run it as a command).
//   Test        one model-list request with a short timeout; what went wrong comes back in words.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLoginProvider, LOGIN_CREDENTIAL_PROVIDERS } from '../../shared/omp-logins';
import { LOCAL_SERVER_KINDS, type LocalServer, type LocalServerKind } from '../../shared/protocol';
import { featuredProvider } from '../../shared/provider-vendors';
import { UserError, writeFileAtomic } from '../util';

const NAME = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;
const TEST_TIMEOUT_MS = 5000;
const MAX_MODELS = 200;

const KIND_LABEL: Record<LocalServerKind, string> = {
  'llama.cpp': 'a llama.cpp server',
  ollama: 'an Ollama server',
  'lm-studio': 'an LM Studio server',
  'openai-models-list': 'an OpenAI-compatible server',
};

/** How to make each kind listen on the network, not only on its own machine. */
const LISTEN_HINT: Record<LocalServerKind, string> = {
  'llama.cpp': 'start llama-server with --host 0.0.0.0',
  ollama: 'start Ollama with OLLAMA_HOST=0.0.0.0',
  'lm-studio': 'turn on “Serve on Local Network” in LM Studio’s server settings',
  'openai-models-list': 'make it listen on 0.0.0.0, not 127.0.0.1',
};

export interface LocalServerInput {
  name: string;
  kind: LocalServerKind;
  baseUrl: string;
  /** Absent or blank: keep the saved key (none for a new server). null: no key. */
  apiKey?: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isKind = (v: unknown): v is LocalServerKind => typeof v === 'string' && (LOCAL_SERVER_KINDS as readonly string[]).includes(v);
/** A models.yml provider entry this feature manages: an address and one of the discovery kinds above. */
const isLocal = (v: unknown): v is Obj & { baseUrl: string } => isObj(v) && typeof v.baseUrl === 'string' && isObj(v.discovery) && isKind(v.discovery.type);

/** A provider id for omp (its models become `<name>/<model>`), cleaned up. Throws a UserError in words. */
export function cleanServerName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!name) throw new UserError('Give the server a name, like “desk-llama”.');
  if (!NAME.test(name) || name.includes('..')) {
    throw new UserError('A name is up to 40 lowercase letters, digits, dots, dashes and underscores, like “desk-llama”. Its models are named after it.');
  }
  if (featuredProvider(name) || isLoginProvider(name) || LOGIN_CREDENTIAL_PROVIDERS.has(name) || name === 'rlt-demo') {
    throw new UserError(`The agent already has a provider called “${name}”. Pick another name, like “${name.split(/[.-]/)[0]}-desk”.`);
  }
  return name;
}

/** The address as omp gets it (see the header). Throws a UserError in words. */
export function cleanBaseUrl(kind: LocalServerKind, raw: string): string {
  let text = raw.trim();
  if (!text) throw new UserError('Enter the server’s address, like http://192.168.1.20:8080.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`; // "192.168.1.20:8080"
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UserError('That isn’t an address. Write it like http://192.168.1.20:8080.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UserError('The address starts with http:// or https://, like http://192.168.1.20:8080.');
  if (url.username || url.password) throw new UserError('Put a password or key in the API key field, not in the address.');
  if (kind === 'ollama') return url.origin;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path.endsWith('/v1') ? path : `${path}/v1`}`;
}

function cleanKey(raw: string): string {
  const key = raw.trim();
  if (/\s/.test(key)) throw new UserError('A key has no spaces in it. Copy it again (the whole key, nothing else).');
  if (key.startsWith('!')) throw new UserError('A key can’t start with “!” here (the agent would run it as a command).');
  return key;
}

/** What went wrong reaching a model server, in words (`err`: what fetch threw). */
export function connectionError(err: unknown, baseUrl: string, kind: LocalServerKind, timeoutMs = TEST_TIMEOUT_MS): string {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const name = err instanceof Error ? err.name : '';
  const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    const s = Math.max(1, Math.round(timeoutMs / 1000));
    return `${url.host} didn’t answer within ${s} ${s === 1 ? 'second' : 'seconds'}. Check the address, that the machine is on, and that no firewall blocks port ${port}.`;
  }
  if (code === 'ECONNREFUSED') {
    return `Nothing is listening at ${url.host}. Check that the server runs and listens on the network, not only on its own machine: ${LISTEN_HINT[kind]}.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Couldn’t find ${url.hostname}. Check the address (an IP address like 192.168.1.20 is safest).`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN') {
    return `Can’t reach ${url.hostname} from the CAST server. Check that both machines are on the same network (or tailnet).`;
  }
  if (code === 'ECONNRESET') return `${url.host} closed the connection. Check the port${url.protocol === 'http:' ? ', and whether the server wants https://' : ''}.`;
  if (code === 'EPROTO' || /CERT|SSL|TLS/.test(code)) {
    return url.protocol === 'https:' ? `The secure connection to ${url.host} failed. Most local model servers use http://, not https://.` : `${url.host} doesn’t speak plain http. Try https://.`;
  }
  const detail = code || (err instanceof Error ? err.message : String(err));
  return `Couldn’t connect to ${url.host}${detail ? ` (${detail.slice(0, 120)})` : ''}.`;
}

/** The model ids of a model-list answer (OpenAI `{ data: [{ id }] }`, llama.cpp/Ollama `{ models: [{ model | name }] }`);
 *  null when it isn't one. */
export function modelIds(body: unknown): string[] | null {
  if (!isObj(body)) return null;
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
  if (!rows) return null;
  const ids = new Set<string>();
  for (const row of rows) {
    const id = typeof row === 'string' ? row : isObj(row) ? [row.id, row.model, row.name].find((v): v is string => typeof v === 'string' && !!v.trim()) : undefined;
    if (id) ids.add(id.trim());
  }
  return [...ids].slice(0, MAX_MODELS);
}

export interface LocalServersOptions {
  /** The environment the agent runs with (the env object every omp copies, CAST's ompEnv included): a saved key
   *  that names a variable there is tested with that variable's value, as omp would use it. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class LocalServers {
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(
    readonly agentDir: string,
    o: LocalServersOptions = {},
  ) {
    this.#env = o.env ?? process.env;
    this.#fetch = o.fetch ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? TEST_TIMEOUT_MS;
  }

  /** The file omp reads them from (and this writes). */
  get file(): string {
    const yaml = join(this.agentDir, 'models.yaml');
    return !existsSync(join(this.agentDir, 'models.yml')) && existsSync(yaml) ? yaml : join(this.agentDir, 'models.yml');
  }

  list(): LocalServer[] {
    return listed(this.#read());
  }

  save(input: LocalServerInput): LocalServer[] {
    const name = cleanServerName(input.name);
    const baseUrl = cleanBaseUrl(input.kind, input.baseUrl);
    const doc = this.#read();
    const providers = providersOf(doc, this.file);
    const prev = providers[name];
    if (prev !== undefined && !isLocal(prev)) {
      throw new UserError(`${this.file} already has a provider called “${name}” that isn’t a model server like these. Pick another name.`);
    }
    const old: Obj = isObj(prev) ? prev : {};
    const oldDiscovery: Obj = isObj(old.discovery) ? old.discovery : {};
    const next: Obj = {
      ...old,
      baseUrl,
      api: typeof old.api === 'string' ? old.api : 'openai-completions',
      // a changed kind starts its discovery afresh: options of the old kind would fail omp's check of the whole file
      discovery: oldDiscovery.type === input.kind ? oldDiscovery : { type: input.kind, ...(typeof oldDiscovery.timeoutMs === 'number' ? { timeoutMs: oldDiscovery.timeoutMs } : {}) },
    };
    const key = typeof input.apiKey === 'string' && input.apiKey.trim() ? cleanKey(input.apiKey) : input.apiKey === null ? null : undefined;
    if (key) {
      next.apiKey = key;
      delete next.auth;
    } else if (key === null || typeof next.apiKey !== 'string' || !next.apiKey) {
      delete next.apiKey;
      next.auth = 'none';
    }
    providers[name] = next;
    doc.providers = providers;
    this.#write(doc);
    return listed(doc);
  }

  /** Take a server out of models.yml (gone already: nothing to do). */
  remove(rawName: string): LocalServer[] {
    const name = rawName.trim().toLowerCase();
    const doc = this.#read();
    const providers = providersOf(doc, this.file);
    if (!(name in providers)) return listed(doc);
    if (!isLocal(providers[name])) throw new UserError(`“${name}” in ${this.file} isn’t a model server like these. Edit that file by hand to remove it.`);
    delete providers[name];
    if (Object.keys(providers).length) doc.providers = providers;
    else delete doc.providers;
    this.#write(doc);
    return listed(doc);
  }

  /** Ask the server for its models (`name`: a saved server whose key to use when none is given). Throws a UserError
   *  that says what went wrong. */
  async test(input: { kind: LocalServerKind; baseUrl: string; apiKey?: string; name?: string }): Promise<string[]> {
    const baseUrl = cleanBaseUrl(input.kind, input.baseUrl);
    let key = input.apiKey?.trim() ? cleanKey(input.apiKey) : undefined;
    if (!key && input.name) {
      const saved = providersOf(this.#read(), this.file)[input.name.trim().toLowerCase()];
      if (isLocal(saved) && typeof saved.apiKey === 'string' && saved.apiKey.trim()) key = saved.apiKey.trim();
    }
    // omp runs a `!command` key for its output: never run it from here, nor send the command as a token
    if (key?.startsWith('!')) throw new UserError('This server’s key in models.yml is a command the agent runs to get the key. CAST can’t test with it: type the key under API key to test.');
    // omp reads a key as an environment variable name first, and uses it as it is when no such variable is set
    const resolved = key ? this.#env[key]?.trim() || key : undefined;
    const headers: Record<string, string> = resolved ? { authorization: `Bearer ${resolved}` } : {};
    const ollama = input.kind === 'ollama';
    const url = ollama ? `${baseUrl}/api/tags` : `${baseUrl}/models`;
    const get = async (u: string) => {
      try {
        return await this.#fetch(u, { headers, signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (err) {
        throw new UserError(connectionError(err, baseUrl, input.kind, this.#timeoutMs));
      }
    };
    const res = await get(url);
    if (res.status === 401 || res.status === 403) {
      throw new UserError(key ? `The server refused the API key (HTTP ${res.status}). Check the key.` : `The server wants an API key (HTTP ${res.status}). Enter it under API key.`);
    }
    if (res.status === 404 && ollama) {
      // the usual mix-up: an OpenAI-compatible server (LM Studio, llama.cpp, vLLM) picked as Ollama
      const other = await get(`${baseUrl}/v1/models`).catch(() => null);
      if (other?.ok && modelIds(await other.json().catch(() => null))) throw new UserError('This server answers like an OpenAI-compatible server, not like Ollama. Pick another kind.');
    }
    if (res.status === 404) throw new UserError(`${url} isn’t there (HTTP 404), so this doesn’t look like ${KIND_LABEL[input.kind]}. Check the port and the kind.`);
    if (!res.ok) throw new UserError(`The server answered HTTP ${res.status} at ${url}.`);
    const ids = modelIds(await res.json().catch(() => null));
    if (!ids) throw new UserError(`Something answers at ${new URL(baseUrl).host}, but not like ${KIND_LABEL[input.kind]} (no model list at ${url}). Check the port and the kind.`);
    return ids;
  }

  #read(): Obj {
    const file = this.file;
    const json = join(this.agentDir, 'models.json');
    const source = existsSync(file) ? file : existsSync(json) ? json : null;
    if (!source) return {};
    let text: string;
    try {
      text = readFileSync(source, 'utf8');
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : '';
      throw new UserError(`Couldn’t read ${source}${code ? ` (${code})` : ''}. Check that the CAST server may read the agent’s folder.`);
    }
    let doc: unknown;
    try {
      doc = source === json ? JSON.parse(text) : Bun.YAML.parse(text);
    } catch {
      // (no parser text: it may quote the file, keys and all)
      throw new UserError(`${source} can’t be read: it isn’t valid ${source === json ? 'JSON' : 'YAML'}. Fix it by hand first, then try again.`);
    }
    if (doc === null || doc === undefined) return {};
    if (!isObj(doc)) throw new UserError(`${source} should hold settings by name at the top. Fix it by hand first, then try again.`);
    return doc;
  }

  #write(doc: Obj): void {
    const file = this.file;
    try {
      mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(file, `${Bun.YAML.stringify(doc, null, 2).trimEnd()}\n`, 0o600);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : '';
      throw new UserError(`Couldn’t save ${file}${code ? ` (${code})` : ''}. Check that the CAST server may write to the agent’s folder.`);
    }
  }
}

function providersOf(doc: Obj, file: string): Obj {
  if (doc.providers === undefined || doc.providers === null) return {};
  if (!isObj(doc.providers)) throw new UserError(`“providers” in ${file} should hold providers by name. Fix it by hand first, then try again.`);
  return doc.providers;
}

function listed(doc: Obj): LocalServer[] {
  const providers = isObj(doc.providers) ? doc.providers : {};
  return Object.entries(providers)
    .filter((e): e is [string, Obj & { baseUrl: string; discovery: { type: LocalServerKind } }] => isLocal(e[1]))
    .map(([name, p]) => ({ name, kind: p.discovery.type, baseUrl: p.baseUrl, hasKey: typeof p.apiKey === 'string' && !!p.apiKey }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
