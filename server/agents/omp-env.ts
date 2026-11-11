// Extra environment for every omp CAST starts: <dataDir>/config.json "ompEnv", for example GOOGLE_CLOUD_PROJECT (a
// Google account that needs a Cloud project to sign in) or an API key pasted in Models & providers (GEMINI_API_KEY,
// ANTHROPIC_API_KEY, OPENAI_API_KEY: omp has no key sign-in for these, it reads the key from the environment).
//
//   precedence  the CAST server's own environment wins: a name set there (or a name omp reads for the same setting,
//               SAME_AS) is never replaced from config.json.
//   reach       every omp child: people's omp processes, sign-ins, `omp models`, `omp usage`, account lists. They all
//               copy one env object when they spawn (agents/index.ts ompEnv()), and OmpEnv keeps that object up to
//               date in place, so a change reaches the next spawn without a restart. The browser terminal keeps its
//               own login environment (terminal.ts).
//   secrets     config.json is written 0600. Values are never logged, and the browser gets only whether a secret is
//               set (view()); the project ID is not a secret and is shown.
//   app edits   only OMP_ENV_KEYS. Other names in the file (set by hand) are passed on as they are, except names CAST
//               manages itself (RESERVED, CAST_* / RLT_*), which are skipped with a notice.
//   hand edits  config.json is read again by Refresh (reload()); key() — a hash, never the values — is part of the
//               fingerprint the model list is kept by (models.ts), so a key added or removed by hand is checked.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { OMP_ENV_KEYS, type ApiKeyName, type OmpEnvKey, type OmpEnvView } from '../../shared/protocol';
import { UserError, writeFileAtomic } from '../util';
import { log } from './util';

type Env = Record<string, string | undefined>;

const SECRET: Record<OmpEnvKey, boolean> = { GOOGLE_CLOUD_PROJECT: false, GEMINI_API_KEY: true, ANTHROPIC_API_KEY: true, OPENAI_API_KEY: true };
/** What a pasted key looks like, and where to copy it again (said when it doesn't look right). */
const KEY_SHAPE: Record<ApiKeyName, { prefix: string; label: string; where: string }> = {
  GEMINI_API_KEY: { prefix: '', label: 'a Gemini API key', where: 'from Google AI Studio (it starts with AIza)' },
  ANTHROPIC_API_KEY: { prefix: 'sk-ant-', label: 'an Anthropic API key', where: 'from the Claude Console (it starts with sk-ant-)' },
  OPENAI_API_KEY: { prefix: 'sk-', label: 'an OpenAI API key', where: 'from the OpenAI dashboard (it starts with sk-)' },
};
/** Other names omp reads for the same setting (omp: GOOGLE_CLOUD_PROJECT || GOOGLE_CLOUD_PROJECT_ID): set in the
 *  server's environment, they win over config.json too. */
const SAME_AS: Partial<Record<string, string[]>> = { GOOGLE_CLOUD_PROJECT: ['GOOGLE_CLOUD_PROJECT_ID'] };
/** Names CAST sets for omp itself, or that would move omp's data elsewhere: never taken from config.json. */
const RESERVED = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'PI_CODING_AGENT_DIR', 'CAST_AGENT_BUN', 'BUN_OPTIONS', 'NO_COLOR']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE = 4096;

const blank = (v: string | undefined): v is undefined => v === undefined || !v.trim();

/** A value the app may save for `key`, cleaned up (trimmed, `projects/` dropped). Throws a UserError that says what
 *  is wrong in words. */
export function cleanOmpEnvValue(key: OmpEnvKey, raw: string): string {
  const v = raw.trim();
  if (key === 'GOOGLE_CLOUD_PROJECT') {
    const id = v.replace(/^projects\//, '');
    if (!id) throw new UserError('Enter the project ID.');
    // Project IDs: 6–30 lowercase letters, digits and hyphens, starting with a letter; old ones may carry a domain
    // ("example.com:my-project"). A project number works with Google too.
    if (/^(?:[a-z0-9.-]+\.[a-z]{2,}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id) || /^\d{6,20}$/.test(id)) return id;
    if (/\s/.test(id) || /[A-Z]/.test(id)) {
      throw new UserError('That looks like the project’s name. Use its ID instead: lowercase, like my-project-123, shown under the name in the Google Cloud console.');
    }
    throw new UserError('That isn’t a Google Cloud project ID. It is 6–30 lowercase letters, digits and hyphens, like my-project-123.');
  }
  if (!v) throw new UserError('Paste the key first.');
  if (/\s/.test(v)) throw new UserError('A key has no spaces in it. Copy it again (the whole key, nothing else).');
  const shape = KEY_SHAPE[key];
  if (v.length < 20 || v.length > 400 || !v.startsWith(shape.prefix)) throw new UserError(`That doesn’t look like ${shape.label}. Copy it again ${shape.where}.`);
  return v;
}

export interface OmpEnvOptions {
  /** <dataDir>/config.json */
  configFile: string;
  /** The env object every omp child copies at spawn (agents/index.ts): updated in place. What it holds when OmpEnv is
   *  made counts as the server's own environment. */
  env: Env;
}

export class OmpEnv {
  readonly #file: string;
  readonly #env: Env;
  readonly #server: Env;
  /** config.json's usable ompEnv entries. */
  #config: Record<string, string> = {};
  /** Names this class put into the env object (so a removal takes them out again, and nothing else). */
  #applied = new Set<string>();
  #generation = 0;
  /** One-line notes for the log (skipped names, bad values). Never values. */
  readonly notices: string[] = [];

  constructor(o: OmpEnvOptions) {
    this.#file = o.configFile;
    this.#env = o.env;
    this.#server = { ...o.env };
  }

  /** Read config.json and apply its ompEnv (startup). A file loadConfig already accepted, so errors here only note. */
  load(): this {
    try {
      this.#config = this.#usable(this.#readFile().ompEnv);
    } catch (err) {
      this.notices.push(`config.json: ${err instanceof Error ? err.message : String(err)} — no extra agent environment`);
      this.#config = {};
    }
    this.#apply();
    const names = Object.keys(this.#config);
    if (names.length) log('agents', `extra agent environment from config.json: ${names.map((k) => (this.#serverHas(k) ? `${k} (the server's own wins)` : k)).join(', ')}`);
    for (const n of this.notices) log('agents', n);
    return this;
  }

  /** Bumped by every change that reached the env object (the process pool restarts idle omp processes on it). */
  get generation(): number {
    return this.#generation;
  }

  /** A short hash of what config.json adds to omp's environment ('' when it adds nothing). Never the values. */
  key(): string {
    const entries = Object.entries(this.#effective()).filter(([k, v]) => v !== undefined && this.#applied.has(k));
    if (!entries.length) return '';
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
  }

  /** Read config.json again (Refresh: the file may have been edited by hand). saved: what the browser sees changed;
   *  applied: omp's environment changed (generation bumped). A file that can't be read keeps what was loaded. */
  reload(): { saved: boolean; applied: boolean } {
    let next: Record<string, string>;
    const notices: string[] = [];
    try {
      next = this.#usable(this.#readFile().ompEnv, notices);
    } catch (err) {
      log('agents', `config.json: ${err instanceof Error ? err.message : String(err)} — keeping the extra agent environment as it was`);
      return { saved: false, applied: false };
    }
    if (JSON.stringify(next) === JSON.stringify(this.#config)) return { saved: false, applied: false };
    const viewBefore = JSON.stringify(this.view());
    const before = this.#effective();
    this.#config = next;
    this.#apply();
    const applied = JSON.stringify(before) !== JSON.stringify(this.#effective());
    if (applied) this.#generation++;
    for (const n of notices) log('agents', n);
    log('agents', `extra agent environment re-read from config.json: ${Object.keys(next).join(', ') || 'none'}`);
    return { saved: JSON.stringify(this.view()) !== viewBefore, applied };
  }

  /** What the browser may know: where each app setting comes from, values only for non-secrets. */
  view(): OmpEnvView {
    const out = {} as OmpEnvView;
    for (const key of OMP_ENV_KEYS) {
      const server = this.#serverValue(key);
      const config = this.#config[key];
      out[key] = {
        source: server !== undefined ? 'env' : config !== undefined ? 'config' : null,
        ...(!SECRET[key] && (server ?? config) !== undefined ? { value: server ?? config } : {}),
        ...(server !== undefined && config !== undefined ? { shadowed: true } : {}),
      };
    }
    return out;
  }

  /** Save app settings (null removes one) to config.json and apply them. saved: config.json changed (view() too);
   *  applied: omp's environment changed (a value the server's environment overrides is saved but changes nothing for
   *  omp). Throws UserError. */
  set(patch: Partial<Record<OmpEnvKey, string | null>>): { saved: boolean; applied: boolean } {
    const next = { ...this.#config };
    for (const [key, raw] of Object.entries(patch) as [OmpEnvKey, string | null | undefined][]) {
      if (!OMP_ENV_KEYS.includes(key) || raw === undefined) continue;
      if (raw === null) delete next[key];
      else next[key] = cleanOmpEnvValue(key, raw);
    }
    const changed = OMP_ENV_KEYS.filter((k) => next[k] !== this.#config[k]);
    if (!changed.length) return { saved: false, applied: false };
    this.#writeFile(next, changed);
    this.#config = next;
    const before = this.#effective();
    this.#apply();
    log('agents', `extra agent environment: ${changed.map((k) => `${k} ${next[k] === undefined ? 'removed' : 'saved'}${this.#serverHas(k) ? " (the server's own wins)" : ''}`).join(', ')}`);
    const applied = JSON.stringify(before) !== JSON.stringify(this.#effective());
    if (applied) this.#generation++;
    return { saved: true, applied };
  }

  #effective(): Record<string, string | undefined> {
    return Object.fromEntries([...new Set([...this.#applied, ...Object.keys(this.#config)])].sort().map((k) => [k, this.#env[k]]));
  }

  #serverValue(key: string): string | undefined {
    for (const name of [key, ...(SAME_AS[key] ?? [])]) {
      const v = this.#server[name];
      if (!blank(v)) return v.trim();
    }
    return undefined;
  }

  #serverHas(key: string): boolean {
    return this.#serverValue(key) !== undefined;
  }

  /** Make the env object hold the server's own environment plus config.json's names the server doesn't set. */
  #apply() {
    for (const k of this.#applied) {
      if (this.#config[k] === undefined || this.#serverHas(k)) {
        if (this.#server[k] === undefined) delete this.#env[k];
        else this.#env[k] = this.#server[k];
        this.#applied.delete(k);
      }
    }
    for (const [k, v] of Object.entries(this.#config)) {
      if (this.#serverHas(k)) continue;
      this.#env[k] = v;
      this.#applied.add(k);
    }
  }

  /** config.json as an object ({} when it doesn't exist). */
  #readFile(): Record<string, unknown> {
    if (!existsSync(this.#file)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      throw new UserError(`${this.#file} is not valid JSON. Fix it (or move it away) first, then try again.`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UserError(`${this.#file} must hold a JSON object.`);
    return raw as Record<string, unknown>;
  }

  /** The entries of a config.json ompEnv that omp may get (what was skipped goes to `notices`). */
  #usable(v: unknown, notices: string[] = this.notices): Record<string, string> {
    if (v === undefined) return {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      notices.push('config.json: "ompEnv" should be an object of names and text values — ignored');
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!NAME.test(k)) notices.push(`config.json: ompEnv name "${k.slice(0, 60)}" is not an environment variable name — ignored`);
      else if (RESERVED.has(k) || /^(CAST|RLT)_/.test(k)) notices.push(`config.json: ompEnv.${k} is set by CAST itself — ignored`);
      else if (typeof val !== 'string' || val.length > MAX_VALUE) notices.push(`config.json: ompEnv.${k} should be text — ignored`);
      else if (val.trim()) out[k] = val.trim();
    }
    return out;
  }

  /** Rewrite config.json with these app settings: every other key (and ompEnv names set by hand) kept, mode 0600. */
  #writeFile(next: Record<string, string>, changed: OmpEnvKey[]) {
    const file = this.#readFile();
    const prev = file.ompEnv && typeof file.ompEnv === 'object' && !Array.isArray(file.ompEnv) ? (file.ompEnv as Record<string, unknown>) : {};
    const ompEnv: Record<string, unknown> = { ...prev };
    for (const k of changed) {
      if (next[k] === undefined) delete ompEnv[k];
      else ompEnv[k] = next[k];
    }
    if (Object.keys(ompEnv).length) file.ompEnv = ompEnv;
    else delete file.ompEnv;
    try {
      writeFileAtomic(this.#file, `${JSON.stringify(file, null, 2)}\n`, 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new UserError(`Couldn’t save ${this.#file}${code ? ` (${code})` : ''}. Check that the CAST server may write to its data folder.`);
    }
  }
}
