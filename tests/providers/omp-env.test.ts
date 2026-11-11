// config.json "ompEnv": extra environment for every omp child (F1 Google Cloud project, F2 Gemini API key). The
// server's own environment wins, the file stays 0600 and keeps its other keys, the browser never sees a key, and a
// change reaches the env object every omp copies at spawn (no restart).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOmpEnvValue, OmpEnv } from '../../server/agents/omp-env.ts';
import { loadConfig } from '../../server/config.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cast-test-ompenv-'));
  roots.push(d);
  return d;
}

const KEY = 'AIzaFakeKeyForCastTests0123456789abcd';

describe('loading config.json', () => {
  test('names the server does not set go into the env object; the server’s own (and GOOGLE_CLOUD_PROJECT_ID) win', () => {
    const d = dir();
    const file = join(d, 'config.json');
    writeFileSync(file, JSON.stringify({ terminal: false, ompEnv: { GOOGLE_CLOUD_PROJECT: 'from-config', GEMINI_API_KEY: KEY, GOOGLE_CLOUD_LOCATION: 'us-central1' } }), { mode: 0o600 });
    const env: Record<string, string | undefined> = { HOME: d, GOOGLE_CLOUD_PROJECT_ID: 'from-server' };
    const o = new OmpEnv({ configFile: file, env }).load();
    expect(env.GEMINI_API_KEY).toBe(KEY);
    expect(env.GOOGLE_CLOUD_LOCATION).toBe('us-central1'); // a name set by hand is passed on too
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined(); // omp reads GOOGLE_CLOUD_PROJECT first: it would beat the server's _ID
    expect(o.view()).toEqual({
      GOOGLE_CLOUD_PROJECT: { source: 'env', value: 'from-server', shadowed: true },
      GEMINI_API_KEY: { source: 'config' },
      ANTHROPIC_API_KEY: { source: null },
      OPENAI_API_KEY: { source: null },
    });
  });

  test('names CAST manages and broken entries are skipped with a notice that never holds a value', () => {
    const d = dir();
    const file = join(d, 'config.json');
    writeFileSync(file, JSON.stringify({ ompEnv: { PATH: '/evil', PI_CODING_AGENT_DIR: '/x', CAST_TERMINAL: '1', 'bad name': 'v', NUM: 3, GEMINI_API_KEY: KEY } }));
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
    const o = new OmpEnv({ configFile: file, env }).load();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.CAST_TERMINAL).toBeUndefined();
    expect(env.NUM).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBe(KEY);
    expect(o.notices.length).toBe(5);
    expect(o.notices.join('\n')).not.toContain(KEY);
    expect(o.notices.join('\n')).not.toContain('/evil');
  });

  test('no file, or no ompEnv: nothing changes; loadConfig still accepts a file with ompEnv', () => {
    const d = dir();
    const env: Record<string, string | undefined> = { HOME: d };
    const o = new OmpEnv({ configFile: join(d, 'config.json'), env }).load();
    expect(env).toEqual({ HOME: d });
    expect(o.view().GEMINI_API_KEY).toEqual({ source: null });
    writeFileSync(join(d, 'config.json'), JSON.stringify({ cityName: 'Hilltop', ompEnv: { GEMINI_API_KEY: KEY } }), { mode: 0o600 });
    const cfg = loadConfig({ CAST_DATA_DIR: d }, { home: d, hostname: 'box', platform: 'linux', repoRoot: d });
    expect(cfg.cityName).toBe('Hilltop');
    expect(cfg.notices.join('\n')).not.toContain('ompEnv');
  });
});

describe('saving from the app', () => {
  test('writes ompEnv into config.json (0600), keeps the other keys and names set by hand, and updates the env object', () => {
    const d = dir();
    const file = join(d, 'config.json');
    writeFileSync(file, JSON.stringify({ allowedUsers: ['someone'], ompEnv: { GOOGLE_CLOUD_LOCATION: 'eu' } }), { mode: 0o644 });
    const env: Record<string, string | undefined> = { HOME: d };
    const o = new OmpEnv({ configFile: file, env }).load();
    const gen = o.generation;
    expect(o.set({ GOOGLE_CLOUD_PROJECT: '  projects/my-project-123 ', GEMINI_API_KEY: KEY })).toEqual({ saved: true, applied: true });
    expect(o.generation).toBe(gen + 1);
    expect(env.GOOGLE_CLOUD_PROJECT).toBe('my-project-123');
    expect(env.GEMINI_API_KEY).toBe(KEY);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toEqual({ allowedUsers: ['someone'], ompEnv: { GOOGLE_CLOUD_LOCATION: 'eu', GOOGLE_CLOUD_PROJECT: 'my-project-123', GEMINI_API_KEY: KEY } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // the browser's copy: the project, never the key
    expect(JSON.stringify(o.view())).not.toContain(KEY);
    expect(o.view().GOOGLE_CLOUD_PROJECT).toEqual({ source: 'config', value: 'my-project-123' });

    // the same again: nothing to save
    expect(o.set({ GEMINI_API_KEY: KEY })).toEqual({ saved: false, applied: false });
    // removing takes it out of the env object and the file (an empty ompEnv disappears)
    expect(o.set({ GEMINI_API_KEY: null, GOOGLE_CLOUD_PROJECT: null })).toEqual({ saved: true, applied: true });
    expect('GEMINI_API_KEY' in env).toBe(false);
    expect('GOOGLE_CLOUD_PROJECT' in env).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ allowedUsers: ['someone'], ompEnv: { GOOGLE_CLOUD_LOCATION: 'eu' } });
  });

  test('a value the server’s environment overrides is saved, but omp’s environment does not change', () => {
    const d = dir();
    const env: Record<string, string | undefined> = { GEMINI_API_KEY: 'server-key-0123456789012345' };
    const o = new OmpEnv({ configFile: join(d, 'config.json'), env }).load();
    expect(o.set({ GEMINI_API_KEY: KEY })).toEqual({ saved: true, applied: false });
    expect(env.GEMINI_API_KEY).toBe('server-key-0123456789012345');
    expect(o.view().GEMINI_API_KEY).toEqual({ source: 'env', shadowed: true });
    // removing the saved one leaves the server's own alone
    o.set({ GEMINI_API_KEY: null });
    expect(env.GEMINI_API_KEY).toBe('server-key-0123456789012345');
  });

  test('a config.json that turned into broken JSON is not overwritten', () => {
    const d = dir();
    const file = join(d, 'config.json');
    const o = new OmpEnv({ configFile: file, env: {} }).load();
    writeFileSync(file, '{ "terminal": false,');
    expect(() => o.set({ GEMINI_API_KEY: KEY })).toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ "terminal": false,');
  });
});

describe('values the app accepts', () => {
  test('project IDs: lowercase IDs, domain-scoped ones and project numbers; a display name gets a hint', () => {
    expect(cleanOmpEnvValue('GOOGLE_CLOUD_PROJECT', 'my-project-123')).toBe('my-project-123');
    expect(cleanOmpEnvValue('GOOGLE_CLOUD_PROJECT', 'example.com:my-project')).toBe('example.com:my-project');
    expect(cleanOmpEnvValue('GOOGLE_CLOUD_PROJECT', '123456789012')).toBe('123456789012');
    expect(() => cleanOmpEnvValue('GOOGLE_CLOUD_PROJECT', 'My Project')).toThrow(/project’s name/);
    expect(() => cleanOmpEnvValue('GOOGLE_CLOUD_PROJECT', 'ab')).toThrow(/6–30 lowercase/);
    expect(() => cleanOmpEnvValue('GOOGLE_CLOUD_PROJECT', ' ')).toThrow(/Enter the project ID/);
  });

  test('keys: no spaces, a plausible length; the error never repeats the key', () => {
    expect(cleanOmpEnvValue('GEMINI_API_KEY', ` ${KEY}\n`)).toBe(KEY);
    const bad = 'AIza two words here 1234567890';
    let msg = '';
    try {
      cleanOmpEnvValue('GEMINI_API_KEY', bad);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/no spaces/);
    expect(msg).not.toContain('two words');
    expect(() => cleanOmpEnvValue('GEMINI_API_KEY', 'short')).toThrow(/doesn’t look like/);
  });
});
