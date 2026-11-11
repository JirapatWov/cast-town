// Every sign-in `omp login` offers is in Models & providers (shared/omp-login-providers.ts, generated from omp's source
// by scripts/gen-omp-login-providers.ts), and nothing else reaches omp's command line.
//
// - The list itself: ids unique, every entry with a kind and a group, the featured sign-ins and the aliases in it.
// - The agent's real menu: `cast-agent login </dev/null` with a scratch agent dir prints the menu without signing in;
//   every name in it must be in the list, so a change to agent/ that adds a provider fails here until the list is
//   generated again. Skipped when no agent is there to run (CAST_AGENT_BIN, else agent/bin/cast-agent once built), and
//   not compared when that agent is another version than the list's.
// - The checked-in file is what the generator makes from the agent's source (agent/; OMP_SRC / CAST_OMP_SRC for
//   another omp checkout).
// - The message validator: login_start only for a sign-in of the list ('llama.cpp' included); an empty answer passes
//   (some prompts are optional).
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOGIN_CREDENTIAL_PROVIDERS, OMP_LOGIN_PROVIDERS, OMP_LOGIN_PROVIDERS_VERSION, credentialProviderOf, isLoginProvider, loginLabel, loginOfCredential } from '../../shared/omp-logins';
import { OMP_TESTED_VERSION } from '../../shared/omp-version';
import { parseClientMsg } from '../../server/validate';
import { readProviders, render } from '../../scripts/gen-omp-login-providers';

const repo = resolve(import.meta.dir, '../..');
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe('the generated list', () => {
  test('one entry per id, each with a name, a label, a kind and a group, for the pinned omp', () => {
    expect(OMP_LOGIN_PROVIDERS_VERSION).toBe(OMP_TESTED_VERSION);
    expect(OMP_LOGIN_PROVIDERS.length).toBeGreaterThanOrEqual(80);
    const ids = OMP_LOGIN_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of OMP_LOGIN_PROVIDERS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
      expect(['browser', 'device', 'key', 'email']).toContain(p.kind);
      expect(['signin', 'key', 'cloud', 'other']).toContain(p.group);
    }
    // labels tell providers apart
    const labels = OMP_LOGIN_PROVIDERS.map((p) => p.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('the featured sign-ins, the aliases and every kind are in it', () => {
    for (const id of ['anthropic', 'openai-codex', 'openai-codex-device', 'google-gemini-cli', 'google-antigravity', 'deepseek', 'openrouter', 'github-copilot', 'cursor', 'kimi-code', 'cerebras', 'llama.cpp']) {
      expect(isLoginProvider(id)).toBe(true);
    }
    expect(OMP_LOGIN_PROVIDERS.find((p) => p.id === 'openai-codex-device')).toMatchObject({ kind: 'device', storeAs: 'openai-codex' });
    expect(OMP_LOGIN_PROVIDERS.find((p) => p.id === 'zai-coding-plan')).toMatchObject({ kind: 'browser', storeAs: 'zai' });
    expect(OMP_LOGIN_PROVIDERS.find((p) => p.id === 'anthropic')).toMatchObject({ kind: 'browser', group: 'signin', label: 'Anthropic' });
    expect(OMP_LOGIN_PROVIDERS.find((p) => p.id === 'github-copilot')).toMatchObject({ kind: 'device' });
    expect(OMP_LOGIN_PROVIDERS.find((p) => p.id === 'cerebras')).toMatchObject({ kind: 'key', group: 'cloud' });
    expect(OMP_LOGIN_PROVIDERS.find((p) => p.id === 'perplexity')).toMatchObject({ kind: 'email' });
    expect(OMP_LOGIN_PROVIDERS.find((p) => p.id === 'ollama')).toMatchObject({ group: 'other' });
    expect(new Set(OMP_LOGIN_PROVIDERS.map((p) => p.kind))).toEqual(new Set(['browser', 'device', 'key', 'email']));
  });

  test('lookups: unknown ids are not sign-ins; aliases store under their target; names for sentences', () => {
    for (const bad of ['', 'nope', '--help', 'anthropic;rm', '../x', 'ANTHROPIC', 42, null]) expect(isLoginProvider(bad)).toBe(false);
    expect(credentialProviderOf('openai-codex-device')).toBe('openai-codex');
    expect(credentialProviderOf('cerebras')).toBe('cerebras');
    expect(LOGIN_CREDENTIAL_PROVIDERS.has('zai')).toBe(true);
    expect(LOGIN_CREDENTIAL_PROVIDERS.has('zai-coding-plan')).toBe(false);
    expect(loginOfCredential('zai')?.id).toBe('zai'); // its own (key) sign-in, not the alias
    expect(loginLabel('github-copilot')).toBe('GitHub Copilot');
    expect(loginLabel('cursor')).toBe('Cursor');
    expect(loginLabel('my-llm')).toBeUndefined();
  });
});

/** The agent to ask: CAST's own setting first, else this repository's agent once it is built. */
function findOmp(): string | null {
  const chosen = process.env.CAST_AGENT_BIN?.trim();
  if (chosen) return existsSync(chosen) ? chosen : null;
  const built = existsSync(join(repo, 'agent', 'packages', 'coding-agent', 'dist', 'cli.js'));
  return built ? join(repo, 'agent', 'bin', 'cast-agent') : null;
}

const omp = findOmp();

describe('omp’s own menu', () => {
  test.skipIf(!omp)(
    '`omp login` lists nothing the generated list lacks (a scratch agent dir; stdin closed, so nothing is signed in)',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'cast-test-ompmenu-'));
      scratch.push(home);
      // its own HOME and agent dir: the real sign-ins are never read, and nothing is written next to them
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', CAST_AGENT_BUN: process.execPath, HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), NO_COLOR: '1', TMPDIR: tmpdir() };
      const version = /\d+\.\d+\.\d+/.exec(Bun.spawnSync([omp!, '--version'], { cwd: home, stdin: 'ignore', env, timeout: 60_000 }).stdout.toString())?.[0];
      if (version !== OMP_LOGIN_PROVIDERS_VERSION) {
        console.warn(`${omp} is omp ${version ?? '(unknown)'}, the list is from ${OMP_LOGIN_PROVIDERS_VERSION}: not compared`);
        return;
      }
      const r = Bun.spawnSync([omp!, 'login'], {
        cwd: home,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env,
        timeout: 90_000,
      });
      const out = r.stdout.toString();
      const menu = [...out.matchAll(/^\s+\d+\.\s+(.+?)\s*$/gm)].map((m) => m[1]!);
      expect(menu.length).toBeGreaterThan(10); // it printed the menu
      const names = new Set(OMP_LOGIN_PROVIDERS.map((p) => p.name));
      const missing = menu.filter((n) => !names.has(n));
      // a new provider in the agent: run `bun run gen:omp-logins`
      expect(missing).toEqual([]);
      // and in omp's order: the list is its menu
      expect(OMP_LOGIN_PROVIDERS.map((p) => p.name).filter((n) => menu.includes(n))).toEqual(menu);
    },
    120_000,
  );
});

/** The agent's source: OMP_SRC / CAST_OMP_SRC (the generator's inputs), else agent/ of this repository. */
function findSource(): string | null {
  for (const raw of [process.env.OMP_SRC, process.env.CAST_OMP_SRC, join(repo, 'agent')]) {
    if (!raw?.trim()) continue;
    let root = resolve(raw.trim());
    for (let i = 0; i < 3 && !existsSync(join(root, 'packages', 'catalog')); i++) root = resolve(root, '..');
    if (existsSync(join(root, 'packages', 'catalog', 'src', 'compat', 'rules.json'))) return root;
  }
  return null;
}

const source = findSource();

describe('the generator', () => {
  test.skipIf(!source)('the checked-in file is what omp’s source gives (run the generator after an omp bump)', () => {
    const { version, providers } = readProviders(source!);
    if (version !== OMP_LOGIN_PROVIDERS_VERSION) {
      console.warn(`omp source is ${version}, the list is from ${OMP_LOGIN_PROVIDERS_VERSION}: not compared`);
      return;
    }
    expect(render(version, providers)).toBe(readFileSync(join(repo, 'shared', 'omp-login-providers.ts'), 'utf8'));
  });
});

describe('what reaches omp', () => {
  const login = (provider: unknown) => parseClientMsg(JSON.stringify({ t: 'login_start', provider }));
  test('login_start takes a sign-in of the list, and nothing else', () => {
    expect(login('github-copilot')).toMatchObject({ ok: true });
    expect(login('llama.cpp')).toMatchObject({ ok: true }); // a dot in an omp id
    for (const bad of ['nope', '--version', 'anthropic --api-key x', '../../etc', 'a..b', '', 7]) expect(login(bad).ok).toBe(false);
  });
  test('an empty answer passes the validator (an optional prompt); a sign-out may name any stored provider', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'login_input', loginId: 'login-1', value: '' }))).toMatchObject({ ok: true });
    expect(parseClientMsg(JSON.stringify({ t: 'logout_account', reqId: 'r', provider: 'llama.cpp', credentialId: 3 }))).toMatchObject({ ok: true });
  });
});
