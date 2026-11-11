// Server configuration, resolved once at startup from the environment, an optional config file and defaults.
//
// Precedence: environment > <dataDir>/config.json > defaults. Every variable is read as CAST_X first, then the older
// RLT_X name (CAST_ wins when both are set), so existing installs keep working unchanged.
//
//   CAST_PORT            HTTP/WS port (default 4860)
//   CAST_HOST            bind address (default 127.0.0.1 — reach it from other devices with `tailscale serve`)
//   CAST_DATA_DIR        runtime state: town, chats, pairing token, devices (default: see resolveDataDir)
//   CAST_WORKSPACE       where CAST creates new projects (default ~/CAST, created when first needed)
//   CAST_FS_ROOTS        comma-separated folders the folder picker may browse (default: your home folder)
//   CAST_ALLOWED_USERS   comma-separated Tailscale logins let in without pairing (default: none — pairing only)
//   CAST_ALLOWED_ORIGINS extra comma-separated origins allowed to open the WebSocket (e.g. http://localhost:5173)
//   CAST_CITY_NAME       this machine's name in the city switcher (default: the host name)
//   CAST_TERMINAL=0      turn the browser terminal off entirely (default on)
//   CAST_STUB_AGENTS=1   use server/dev-stub-agents.ts instead of the real agent system (dev/testing)
//   CAST_WEB_DIST        built web app to serve (default <repo>/web/dist; in a compiled binary: web/dist next to it)
//   CAST_LAUNCHED_BY     'mac-app' when the CAST menu-bar app started this server (see runtime.ts)
//   CAST_SERVICE_WORKER=off  serve a worker that removes itself (and CAST's caches) from every browser (server/pwa.ts)
//   CAST_PUSH=off        no Web Push notifications at all (server/push; they go through Apple's/Google's push service)
//   CAST_PUSH_CONTACT    the VAPID contact sent to push services: mailto:you@example.com or an https: URL
//   CAST_PUSH_EXTRA_ENDPOINTS  comma-separated extra push-service origins (tests and local fakes only; http allowed)
//   CAST_MOCK_LLM=1      tests/dev only: people run on a local scripted model while no account is connected
//                        (CONTRIBUTING.md)
//
// config.json mirrors the names in camelCase: { "port", "host", "workspace", "fsRoots", "allowedUsers",
// "allowedOrigins", "cityName", "terminal" }. Unknown keys are ignored. Paths may start with ~/.
// It may also hold "ompEnv": { "NAME": "value" }, extra environment for every omp CAST starts (the server's own
// environment wins). Models & providers writes GOOGLE_CLOUD_PROJECT and the pasted API keys (GEMINI_API_KEY,
// ANTHROPIC_API_KEY, OPENAI_API_KEY) there; server/agents/omp-env.ts reads and writes it, so keep the file 0600.
//
// No default may point at one particular machine (CAST once defaulted to root-owned paths and to its author's tailnet
// login): defaults come from the running user's home folder and platform only.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import pkg from '../package.json';
import { SERVER_PORT } from '../shared/protocol';
import { binaryDir, COMPILED, launchedBy, SOURCE_ROOT } from './runtime';

/** The version of this build. Imported, not read from disk: the bundler inlines it, so a compiled binary knows it too. */
const PACKAGE_VERSION: string = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

export interface ServerConfig {
  port: number;
  host: string;
  /** The CAST checkout this server runs from (a compiled binary: the binary's folder). */
  pocRoot: string;
  /** Running as one compiled file (`bun run build:server`), not from a checkout (runtime.ts). */
  compiled: boolean;
  /** The CAST menu-bar app started this server (CAST_LAUNCHED_BY=mac-app). */
  launchedBy: 'mac-app' | null;
  dataDir: string;
  /** Why dataDir is where it is: set explicitly, the old in-repo folder (it already holds a town), or the default. */
  dataDirSource: 'env' | 'legacy' | 'default';
  /** <dataDir>/config.json (may not exist). */
  configFile: string;
  workspaceRoot: string;
  webDist: string;
  fsRoots: string[];
  allowedUsers: string[];
  allowedOrigins: string[];
  stubAgents: boolean;
  /** CAST_MOCK_LLM (env only, tests/dev): people run on the local scripted model while nothing is connected. */
  mockLlm: boolean;
  serverVersion: string;
  /** This machine's name in the city switcher. */
  cityName: string;
  /** false: /term is refused and the UI hides the terminal. */
  terminal: boolean;
  /** false (CAST_SERVICE_WORKER=off): /sw.js removes itself and CAST's caches from every browser (server/pwa.ts). */
  serviceWorker: boolean;
  /** false (CAST_PUSH=off): no Web Push at all. */
  push: boolean;
  /** CAST_PUSH_CONTACT: the VAPID `sub` (mailto: or https:); null → the device's own https origin. */
  pushContact: string | null;
  /** CAST_PUSH_EXTRA_ENDPOINTS: push-service origins allowed beside the known ones (tests, a local fake). */
  pushExtraEndpoints: string[];
  /** One-line notes for the startup log (legacy data folder, ignored config keys, loose file permissions). */
  notices: string[];
}

/** What loadConfig needs from the machine; tests pass their own. */
export interface ConfigSystem {
  home: string;
  platform: NodeJS.Platform;
  hostname: string;
  /** The source checkout (unused in a compiled binary: there is none). */
  repoRoot: string;
  /** A compiled binary: no legacy `<repo>/data`, web/dist next to the binary. */
  compiled: boolean;
  /** The compiled binary's folder. */
  binDir: string;
}

/** A startup problem with a message written for the person running CAST (printed without a stack trace). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function system(over: Partial<ConfigSystem> = {}): ConfigSystem {
  return {
    home: over.home ?? homedir(),
    platform: over.platform ?? process.platform,
    hostname: over.hostname ?? hostname(),
    repoRoot: over.repoRoot ?? SOURCE_ROOT ?? binaryDir(),
    compiled: over.compiled ?? COMPILED,
    binDir: over.binDir ?? binaryDir(),
  };
}

/** CAST_<name>, else RLT_<name>; blank counts as unset. */
export function envValue(env: Env, name: string): string | undefined {
  for (const key of [`CAST_${name}`, `RLT_${name}`]) {
    const v = env[key]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Copy every CAST_X onto RLT_X so modules that read process.env.RLT_X directly (agents, file viewer, scripted model)
 *  honour the new names too. Called once at startup, before anything else reads the environment. */
export function applyEnvAliases(env: Env = process.env): void {
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('CAST_') && v !== undefined && v.trim()) env[`RLT_${k.slice(5)}`] = v;
  }
}

/** ~ and ~/x → the home folder; everything else resolved against the current directory. */
function expandPath(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return resolve(p);
}

function list(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** On/off words for CAST_TERMINAL and friends; undefined when the value is not one of them. */
function flag(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return undefined;
}

/** The per-user data folder of this platform (outside any source checkout). */
export function platformDataDir(env: Env, sys: Pick<ConfigSystem, 'home' | 'platform'>): string {
  if (sys.platform === 'darwin') return join(sys.home, 'Library', 'Application Support', 'CAST');
  if (sys.platform === 'win32') return join(env.APPDATA?.trim() || join(sys.home, 'AppData', 'Roaming'), 'CAST');
  const xdg = env.XDG_DATA_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(sys.home, '.local', 'share'), 'cast');
}

/** Where CAST keeps its state: CAST_DATA_DIR → the old `<repo>/data` when it already holds a town (installs from
 *  before this default changed keep their houses and chats; never for a compiled binary, which has no checkout) → the
 *  platform's per-user data folder. */
export function resolveDataDir(env: Env = process.env, over: Partial<ConfigSystem> = {}): { dir: string; source: ServerConfig['dataDirSource'] } {
  const sys = system(over);
  const explicit = envValue(env, 'DATA_DIR');
  if (explicit) return { dir: expandPath(explicit, sys.home), source: 'env' };
  if (!sys.compiled) {
    const legacy = join(sys.repoRoot, 'data');
    if (existsSync(join(legacy, 'city.json'))) return { dir: legacy, source: 'legacy' };
  }
  return { dir: platformDataDir(env, sys), source: 'default' };
}

interface FileConfig {
  port?: number;
  host?: string;
  workspace?: string;
  fsRoots?: string[];
  allowedUsers?: string[];
  allowedOrigins?: string[];
  cityName?: string;
  terminal?: boolean;
}

/** Read <dataDir>/config.json. Missing → {}. Broken JSON is a startup error: silently ignoring it could switch the
 *  terminal back on or drop an allowlist the owner relies on. Keys of the wrong type are skipped with a notice. */
export function readConfigFile(file: string, notices: string[]): FileConfig {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix it or move it away, then start CAST again.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${file} must hold a JSON object like { "terminal": false }.`);
  try {
    if ((statSync(file).mode & 0o077) !== 0) notices.push(`${file} can be read by other users on this machine — run: chmod 600 '${file}'`);
  } catch {
    /* unreadable stat: the read above already worked */
  }
  const o = raw as Record<string, unknown>;
  const out: FileConfig = {};
  const bad = (key: string, want: string) => notices.push(`config.json: "${key}" should be ${want} — ignored`);
  const strings = (key: keyof FileConfig): string[] | undefined => {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v === 'string') return list(v) ?? [];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.map((x) => x.trim()).filter(Boolean);
    bad(key, 'a list of strings');
    return undefined;
  };
  if (o.port !== undefined) {
    if (typeof o.port === 'number' && Number.isInteger(o.port)) out.port = o.port;
    else bad('port', 'a whole number');
  }
  for (const key of ['host', 'workspace', 'cityName'] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
    else bad(key, 'a non-empty string');
  }
  for (const key of ['fsRoots', 'allowedUsers', 'allowedOrigins'] as const) {
    const v = strings(key);
    if (v) out[key] = v;
  }
  if (o.terminal !== undefined) {
    if (typeof o.terminal === 'boolean') out.terminal = o.terminal;
    else bad('terminal', 'true or false');
  }
  return out;
}

/** The machine's short name: "studio.local" → "studio". */
function shortHost(name: string): string {
  const first = name.trim().split('.')[0] ?? '';
  return first || 'CAST';
}

export function loadConfig(env: Env = process.env, over: Partial<ConfigSystem> = {}): ServerConfig {
  const sys = system(over);
  const notices: string[] = [];
  const { dir: dataDir, source: dataDirSource } = resolveDataDir(env, sys);
  if (dataDirSource === 'legacy') {
    notices.push(`Using the data folder inside the CAST checkout (${dataDir}) because it already holds a town. Set CAST_DATA_DIR to keep it there explicitly, or move it to ${platformDataDir(env, sys)}.`);
  }
  const configFile = join(dataDir, 'config.json');
  const file = readConfigFile(configFile, notices);

  const portRaw = envValue(env, 'PORT');
  const port = portRaw !== undefined ? Number(portRaw) : (file.port ?? SERVER_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError(`Invalid port: ${portRaw ?? file.port} (CAST_PORT or "port" in config.json must be 1–65535).`);

  const terminalRaw = envValue(env, 'TERMINAL');
  const terminalEnv = flag(terminalRaw);
  if (terminalRaw !== undefined && terminalEnv === undefined) {
    // An unreadable value must not leave a shell open that the owner meant to close.
    notices.push(`CAST_TERMINAL="${terminalRaw}" is not on/off — the terminal stays off. Use 1 or 0.`);
  }
  const terminal = terminalRaw !== undefined ? (terminalEnv ?? false) : (file.terminal ?? true);

  const fsRoots = list(envValue(env, 'FS_ROOTS')) ?? file.fsRoots ?? [sys.home];
  const onOff = (name: string, what: string): boolean => {
    const raw = envValue(env, name);
    const v = flag(raw);
    if (raw !== undefined && v === undefined) notices.push(`CAST_${name}="${raw}" is not on/off — ${what} stays on. Use on or off.`);
    return v ?? true;
  };
  let pushContact = envValue(env, 'PUSH_CONTACT') ?? null;
  if (pushContact && !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/i.test(pushContact)) {
    notices.push(`CAST_PUSH_CONTACT="${pushContact}" must be mailto:you@example.com or an https:// address — ignored.`);
    pushContact = null;
  }
  const cityName = (envValue(env, 'CITY_NAME') ?? file.cityName ?? shortHost(sys.hostname)).slice(0, 60);

  return {
    port,
    host: envValue(env, 'HOST') ?? file.host ?? '127.0.0.1',
    pocRoot: sys.compiled ? sys.binDir : sys.repoRoot,
    compiled: sys.compiled,
    launchedBy: launchedBy(env),
    dataDir,
    dataDirSource,
    configFile,
    workspaceRoot: expandPath(envValue(env, 'WORKSPACE') ?? file.workspace ?? join(sys.home, 'CAST'), sys.home),
    webDist: expandPath(envValue(env, 'WEB_DIST') ?? join(sys.compiled ? sys.binDir : sys.repoRoot, 'web', 'dist'), sys.home),
    fsRoots: fsRoots.map((p) => expandPath(p, sys.home)),
    allowedUsers: (list(envValue(env, 'ALLOWED_USERS')) ?? file.allowedUsers ?? []).map((u) => u.toLowerCase()),
    allowedOrigins: (list(envValue(env, 'ALLOWED_ORIGINS')) ?? file.allowedOrigins ?? []).map((o) => o.replace(/\/+$/, '').toLowerCase()),
    stubAgents: flag(envValue(env, 'STUB_AGENTS')) === true,
    mockLlm: flag(envValue(env, 'MOCK_LLM')) === true,
    serverVersion: PACKAGE_VERSION,
    cityName,
    terminal,
    serviceWorker: onOff('SERVICE_WORKER', 'the service worker'),
    push: onOff('PUSH', 'Web Push'),
    pushContact,
    pushExtraEndpoints: (list(envValue(env, 'PUSH_EXTRA_ENDPOINTS')) ?? []).map((o) => o.replace(/\/+$/, '').toLowerCase()),
    notices,
  };
}
