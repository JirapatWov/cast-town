// C1: configuration precedence (env > config.json > defaults), CAST_ over RLT_, per-user defaults, legacy data dir.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEnvAliases, ConfigError, envValue, loadConfig, resolveDataDir } from '../../server/config';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cast-config-'));
  roots.push(d);
  return d;
}
/** A fake machine: home, repo checkout and platform under a temp folder (nothing of the real host leaks in). */
function machine(platform: NodeJS.Platform = 'linux') {
  const root = tmp();
  const home = join(root, 'home', 'alice');
  const repo = join(root, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  return { root, home, repo, sys: { home, repoRoot: repo, platform, hostname: 'studio.local' } };
}

describe('defaults', () => {
  test('nothing set: per-user folders, no root paths, nobody allowlisted, terminal on, host name as city', () => {
    const m = machine('linux');
    const cfg = loadConfig({}, m.sys);
    expect(cfg.dataDir).toBe(join(m.home, '.local', 'share', 'cast'));
    expect(cfg.dataDirSource).toBe('default');
    expect(cfg.workspaceRoot).toBe(join(m.home, 'CAST'));
    expect(cfg.fsRoots).toEqual([m.home]);
    expect(cfg.allowedUsers).toEqual([]);
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(4860);
    expect(cfg.terminal).toBe(true);
    expect(cfg.cityName).toBe('studio');
    expect(JSON.stringify(cfg)).not.toContain('/root');
    expect(JSON.stringify(cfg)).not.toContain('@');
  });

  test('XDG_DATA_HOME is honoured on Linux (only when absolute)', () => {
    const m = machine('linux');
    expect(loadConfig({ XDG_DATA_HOME: join(m.root, 'xdg') }, m.sys).dataDir).toBe(join(m.root, 'xdg', 'cast'));
    expect(loadConfig({ XDG_DATA_HOME: 'relative/xdg' }, m.sys).dataDir).toBe(join(m.home, '.local', 'share', 'cast'));
  });

  test('macOS: Application Support', () => {
    const m = machine('darwin');
    expect(loadConfig({}, m.sys).dataDir).toBe(join(m.home, 'Library', 'Application Support', 'CAST'));
  });
});

describe('data dir', () => {
  test('legacy <repo>/data is used only when it already holds a town, with a notice', () => {
    const m = machine();
    mkdirSync(join(m.repo, 'data'));
    expect(resolveDataDir({}, m.sys).source).toBe('default'); // an empty data/ folder is not a town
    writeFileSync(join(m.repo, 'data', 'city.json'), '{"version":1,"projects":[]}');
    const cfg = loadConfig({}, m.sys);
    expect(cfg.dataDir).toBe(join(m.repo, 'data'));
    expect(cfg.dataDirSource).toBe('legacy');
    expect(cfg.notices.some((n) => n.includes('CAST_DATA_DIR'))).toBe(true);
  });

  test('CAST_DATA_DIR beats RLT_DATA_DIR beats legacy; ~ expands', () => {
    const m = machine();
    mkdirSync(join(m.repo, 'data'));
    writeFileSync(join(m.repo, 'data', 'city.json'), '{}');
    expect(resolveDataDir({ RLT_DATA_DIR: join(m.root, 'rlt') }, m.sys)).toEqual({ dir: join(m.root, 'rlt'), source: 'env' });
    expect(resolveDataDir({ RLT_DATA_DIR: join(m.root, 'rlt'), CAST_DATA_DIR: join(m.root, 'cast') }, m.sys).dir).toBe(join(m.root, 'cast'));
    expect(resolveDataDir({ CAST_DATA_DIR: '~/state' }, m.sys).dir).toBe(join(m.home, 'state'));
    expect(resolveDataDir({ CAST_DATA_DIR: '   ' }, m.sys).source).toBe('legacy'); // blank = unset
  });
});

describe('precedence', () => {
  function withConfigFile(content: unknown) {
    const m = machine();
    const dataDir = join(m.root, 'data');
    mkdirSync(dataDir);
    const file = join(dataDir, 'config.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    chmodSync(file, 0o600);
    return { ...m, dataDir, file, env: { CAST_DATA_DIR: dataDir } as Record<string, string> };
  }

  test('config.json overrides defaults; env overrides config.json; CAST_ overrides RLT_', () => {
    const m = withConfigFile({
      allowedUsers: ['Owner@Example.com'],
      allowedOrigins: ['http://localhost:5173/'],
      workspace: '~/projects',
      fsRoots: ['~/code', '/srv/shared'],
      cityName: 'Laptop',
      terminal: false,
      port: 5000,
      host: '127.0.0.2',
      somethingElse: 'ignored',
    });
    const fromFile = loadConfig(m.env, m.sys);
    expect(fromFile.allowedUsers).toEqual(['owner@example.com']);
    expect(fromFile.allowedOrigins).toEqual(['http://localhost:5173']);
    expect(fromFile.workspaceRoot).toBe(join(m.home, 'projects'));
    expect(fromFile.fsRoots).toEqual([join(m.home, 'code'), '/srv/shared']);
    expect(fromFile.cityName).toBe('Laptop');
    expect(fromFile.terminal).toBe(false);
    expect(fromFile.port).toBe(5000);
    expect(fromFile.host).toBe('127.0.0.2');
    expect(fromFile.notices).toEqual([]);

    const fromEnv = loadConfig(
      { ...m.env, RLT_CITY_NAME: 'Old', CAST_CITY_NAME: 'New', RLT_TERMINAL: '1', RLT_ALLOWED_USERS: 'a@example.org, b@example.org', CAST_PORT: '6000', RLT_PORT: '7000' },
      m.sys,
    );
    expect(fromEnv.cityName).toBe('New');
    expect(fromEnv.terminal).toBe(true);
    expect(fromEnv.allowedUsers).toEqual(['a@example.org', 'b@example.org']);
    expect(fromEnv.port).toBe(6000);
    expect(fromEnv.workspaceRoot).toBe(join(m.home, 'projects')); // not set in env → still from the file
  });

  test('CAST_TERMINAL words; an unreadable value keeps the terminal off', () => {
    const m = machine();
    for (const [v, want] of [['0', false], ['off', false], ['false', false], ['1', true], ['yes', true]] as const) {
      expect(loadConfig({ CAST_TERMINAL: v }, m.sys).terminal).toBe(want);
    }
    const odd = loadConfig({ CAST_TERMINAL: 'disabled-please' }, m.sys);
    expect(odd.terminal).toBe(false);
    expect(odd.notices.join('\n')).toContain('CAST_TERMINAL');
  });

  test('broken JSON is a clear startup error, not silently ignored', () => {
    const m = withConfigFile('{ "terminal": false, ');
    expect(() => loadConfig(m.env, m.sys)).toThrow(ConfigError);
    expect(() => loadConfig(m.env, m.sys)).toThrow(/not valid JSON/);
    const arr = withConfigFile('[1,2]');
    expect(() => loadConfig(arr.env, arr.sys)).toThrow(/JSON object/);
  });

  test('wrong types are skipped with a notice; loose permissions are reported', () => {
    const m = withConfigFile({ terminal: 'no', fsRoots: 42, port: 'x' });
    chmodSync(m.file, 0o644);
    const cfg = loadConfig(m.env, m.sys);
    expect(cfg.terminal).toBe(true);
    expect(cfg.fsRoots).toEqual([m.home]);
    expect(cfg.port).toBe(4860);
    const text = cfg.notices.join('\n');
    expect(text).toContain('"terminal"');
    expect(text).toContain('"fsRoots"');
    expect(text).toContain('chmod 600');
  });

  test('a bad port is a ConfigError', () => {
    const m = machine();
    expect(() => loadConfig({ CAST_PORT: '99999' }, m.sys)).toThrow(ConfigError);
  });
});

describe('the scripted test model (CAST_MOCK_LLM)', () => {
  test('off by default: people never run on it unless a developer asks', () => {
    const m = machine();
    expect(loadConfig({}, m.sys).mockLlm).toBe(false);
  });
  test('CAST_MOCK_LLM=1 and the old RLT_MOCK_LLM=1 turn it on; CAST_ wins; off words and odd values keep it off', () => {
    const m = machine();
    expect(loadConfig({ CAST_MOCK_LLM: '1' }, m.sys).mockLlm).toBe(true);
    expect(loadConfig({ RLT_MOCK_LLM: '1' }, m.sys).mockLlm).toBe(true);
    expect(loadConfig({ CAST_MOCK_LLM: 'yes' }, m.sys).mockLlm).toBe(true);
    expect(loadConfig({ RLT_MOCK_LLM: '1', CAST_MOCK_LLM: '0' }, m.sys).mockLlm).toBe(false);
    for (const v of ['0', 'off', 'false', '', '  ', 'maybe']) expect(loadConfig({ CAST_MOCK_LLM: v }, m.sys).mockLlm).toBe(false);
  });
  test('config.json cannot turn it on (env only)', () => {
    const m = machine();
    const dataDir = join(m.root, 'data');
    mkdirSync(dataDir);
    const file = join(dataDir, 'config.json');
    writeFileSync(file, JSON.stringify({ mockLlm: true, mock_llm: true, MOCK_LLM: true }));
    chmodSync(file, 0o600);
    const cfg = loadConfig({ CAST_DATA_DIR: dataDir }, m.sys);
    expect(cfg.mockLlm).toBe(false);
    expect(cfg.notices).toEqual([]); // an unknown key is ignored, like any other
  });
  test('the other mock knobs alone do not turn it on', () => {
    const m = machine();
    expect(loadConfig({ CAST_MOCK_PORT: '4999', CAST_MOCK_SPEED: '0', CAST_MOCK_LOG: '1' }, m.sys).mockLlm).toBe(false);
  });
});

test('envValue and applyEnvAliases: CAST_ wins and reaches modules that read RLT_ directly', () => {
  expect(envValue({ RLT_X: 'old' }, 'X')).toBe('old');
  expect(envValue({ RLT_X: 'old', CAST_X: 'new' }, 'X')).toBe('new');
  expect(envValue({ CAST_X: ' ' }, 'X')).toBeUndefined();
  const env: Record<string, string | undefined> = { CAST_MOCK_PORT: '4896', RLT_MOCK_PORT: '4871', RLT_KEEP: 'k', CAST_EMPTY: '' };
  applyEnvAliases(env);
  expect(env.RLT_MOCK_PORT).toBe('4896');
  expect(env.RLT_KEEP).toBe('k');
  expect(env.RLT_EMPTY).toBeUndefined();
});
