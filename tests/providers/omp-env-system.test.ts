// Paste API key (Google F2, Anthropic, OpenAI) and the omp environment as a whole: set_omp_env through a real
// AgentSystemImpl whose `omp models` is a fake that lists a vendor's models only when its key reaches it (like omp does:
// verified against omp 18.13 with a scratch PI_CODING_AGENT_DIR and fake keys), the key check, what the browser may
// see, and a real ProcessPool restarting an idle omp on its next acquire after the environment changed.
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeyCheck } from '../../server/agents/google-auth.ts';
import { ModelRegistry } from '../../server/agents/models.ts';
import { OmpEnv } from '../../server/agents/omp-env.ts';
import { ProcessPool, type ProcessSpec } from '../../server/agents/process-pool.ts';
import { parseClientMsg } from '../../server/validate.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { cleanup, makeSys } from '../rv-server/sys-world';

const root = mkdtempSync(join(tmpdir(), 'cast-test-ompenv-sys-'));
afterAll(() => {
  cleanup();
  rmSync(root, { recursive: true, force: true });
});

const KEY = 'AIzaFakeKeyForCastTests0123456789abcd';

/** `omp models --json`: Google's models when GEMINI_API_KEY is set, Anthropic's when ANTHROPIC_API_KEY is. */
function modelsOmp(): string {
  const bin = join(root, 'omp-models.sh');
  const rows = (provider: string, ids: string[]) => ids.map((id) => JSON.stringify({ provider, id, selector: `${provider}/${id}`, name: id })).join(',');
  const google = rows('google', ['gemini-2.5-pro', 'gemini-2.5-flash']);
  const anthropic = rows('anthropic', ['claude-opus-5-5']);
  writeFileSync(
    bin,
    `#!/bin/bash\nif [ "$1" = models ]; then m=''\n[ -n "$GEMINI_API_KEY" ] && m='${google}'\n[ -n "$ANTHROPIC_API_KEY" ] && m="\${m:+$m,}"'${anthropic}'\necho "{\\"models\\":[$m]}"; exit 0; fi\nexit 3\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function world(check: (key: string) => Promise<KeyCheck>) {
  const env: Record<string, string | undefined> = { HOME: root, PATH: process.env.PATH };
  const models = new ModelRegistry(modelsOmp(), env);
  const checked: string[] = [];
  let ompEnv!: OmpEnv;
  const w = makeSys({
    models,
    extra: (dataDir) => {
      ompEnv = new OmpEnv({ configFile: join(dataDir, 'config.json'), env }).load();
      return {
        env,
        ompEnv,
        checkKey: (_name, key) => {
          checked.push(key);
          return check(key);
        },
      };
    },
  });
  return { ...w, env, models, checked, configFile: () => join(w.root, 'data', 'config.json') };
}

const googleReady = (msgs: ServerMsg[]) => msgs.some((m) => m.t === 'models' && m.models.some((x) => x.vendor === 'google' && x.available));

describe('set_omp_env: Paste API key for Google', () => {
  test('a good key: checked once, saved 0600, omp sees it, models re-detected — and the browser never gets it back', async () => {
    const w = world(async () => ({ ok: true }));
    await w.models.detect();
    expect(w.models.anyAvailable()).toBe(false);
    const ack = await w.handle({ t: 'set_omp_env', patch: { GEMINI_API_KEY: ` ${KEY} ` } });
    expect(ack).toMatchObject({ t: 'ack', ok: true, data: { ompEnv: { GEMINI_API_KEY: { source: 'config' }, GOOGLE_CLOUD_PROJECT: { source: null } } } });
    expect(w.checked).toEqual([KEY]);
    expect(w.env.GEMINI_API_KEY).toBe(KEY);
    expect(JSON.parse(readFileSync(w.configFile(), 'utf8')).ompEnv.GEMINI_API_KEY).toBe(KEY);
    // every client hears the new view; the models follow without a restart
    expect(w.sent.some((m) => m.t === 'omp_env')).toBe(true);
    expect(googleReady(w.sent)).toBe(true);
    expect(w.models.isAvailable('google/gemini-2.5-pro')).toBe(true);
    expect(w.sent.some((m) => m.t === 'toast' && m.text === 'Gemini API key saved — 2 Google models are ready.')).toBe(true);
    expect(JSON.stringify(w.sent)).not.toContain(KEY);
    expect(JSON.stringify(await w.handle({ t: 'get_omp_env' }))).not.toContain(KEY);

    // removed: omp no longer gets it, its models go
    const off = await w.handle({ t: 'set_omp_env', patch: { GEMINI_API_KEY: null } });
    expect(off).toMatchObject({ ok: true, data: { ompEnv: { GEMINI_API_KEY: { source: null } } } });
    expect('GEMINI_API_KEY' in w.env).toBe(false);
    expect(w.models.anyAvailable()).toBe(false);
    await w.dispose();
  });

  test('a key Google refuses is not saved; the error says why without repeating it', async () => {
    const w = world(async () => ({ ok: false, rejected: true, message: 'Google says that key isn’t valid.' }));
    const ack = await w.handle({ t: 'set_omp_env', patch: { GEMINI_API_KEY: KEY } });
    expect(ack).toMatchObject({ t: 'ack', ok: false, error: 'Google says that key isn’t valid.' });
    expect(w.env.GEMINI_API_KEY).toBeUndefined();
    expect(existsSync(w.configFile())).toBe(false);
    expect(JSON.stringify(w.sent)).not.toContain(KEY);
    await w.dispose();
  });

  test('Google unreachable: saved anyway, with a warning in the answer', async () => {
    const w = world(async () => ({ ok: false, rejected: false, message: 'Couldn’t reach Google' }));
    const ack = await w.handle({ t: 'set_omp_env', patch: { GEMINI_API_KEY: KEY } });
    expect(ack).toMatchObject({ ok: true, data: { warning: expect.stringContaining('Couldn’t reach Google to check the key') } });
    expect(w.env.GEMINI_API_KEY).toBe(KEY);
    await w.dispose();
  });

  test('a project ID needs no check; a bad one is refused in words', async () => {
    const w = world(async () => {
      throw new Error('must not be called');
    });
    expect(await w.handle({ t: 'set_omp_env', patch: { GOOGLE_CLOUD_PROJECT: 'my-project-123' } })).toMatchObject({ ok: true, data: { ompEnv: { GOOGLE_CLOUD_PROJECT: { source: 'config', value: 'my-project-123' } } } });
    expect(w.env.GOOGLE_CLOUD_PROJECT).toBe('my-project-123');
    expect(await w.handle({ t: 'set_omp_env', patch: { GOOGLE_CLOUD_PROJECT: 'My Project' } })).toMatchObject({ ok: false, error: expect.stringContaining('project’s name') });
    await w.dispose();
  });

  test('without an OmpEnv (tests, older wiring) the messages are refused politely', async () => {
    const w = makeSys();
    expect(await w.handle({ t: 'get_omp_env' })).toMatchObject({ ok: false, error: 'This server can’t change the agent’s environment.' });
    await w.dispose();
  });

  test('an Anthropic key: checked, saved, its models follow; removing it takes them away again', async () => {
    const ANT = 'sk-ant-api03-FakeKeyForCastTests0123456789';
    const w = world(async () => ({ ok: true }));
    await w.models.detect();
    expect(await w.handle({ t: 'set_omp_env', patch: { ANTHROPIC_API_KEY: 'AIzaNotAnAnthropicKey0123456789' } })).toMatchObject({ ok: false, error: expect.stringContaining('starts with sk-ant-') });
    expect(w.checked).toEqual([]);
    const ack = await w.handle({ t: 'set_omp_env', patch: { ANTHROPIC_API_KEY: ANT } });
    expect(ack).toMatchObject({ ok: true, data: { ompEnv: { ANTHROPIC_API_KEY: { source: 'config' }, GEMINI_API_KEY: { source: null } } } });
    expect(w.checked).toEqual([ANT]);
    expect(w.models.isAvailable('anthropic/claude-opus-5-5')).toBe(true);
    expect(w.sent.some((m) => m.t === 'toast' && m.text === 'Anthropic API key saved — 1 Anthropic model is ready.')).toBe(true);
    expect(JSON.stringify(w.sent)).not.toContain(ANT);
    await w.handle({ t: 'set_omp_env', patch: { ANTHROPIC_API_KEY: null } });
    expect('ANTHROPIC_API_KEY' in w.env).toBe(false);
    expect(w.models.isAvailable('anthropic/claude-opus-5-5')).toBe(false);
    await w.dispose();
  });
});

describe('validation', () => {
  test('only the app’s keys get through (no PATH, no LD_PRELOAD from the browser)', () => {
    const r = parseClientMsg(JSON.stringify({ t: 'set_omp_env', reqId: 'r1', patch: { GEMINI_API_KEY: KEY, PATH: '/evil', LD_PRELOAD: '/x.so' } }));
    expect(r).toEqual({ ok: true, msg: { t: 'set_omp_env', reqId: 'r1', patch: { GEMINI_API_KEY: KEY } } });
    const long = parseClientMsg(JSON.stringify({ t: 'set_omp_env', reqId: 'r2', patch: { GEMINI_API_KEY: 'x'.repeat(500) } }));
    expect(long).toEqual({ ok: false, error: 'The API key is too long (at most 400 characters).', reqId: 'r2' });
  });
});

describe('ProcessPool and a changed omp environment', () => {
  /** An rpc-ui omp: logs which key it started with, says ready, answers every command (get_state: its --model). */
  function rpcOmp(log: string): string {
    const bin = join(root, 'omp-rpc.ts');
    writeFileSync(
      bin,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const sel = args[args.indexOf('--model') + 1] ?? '';
const i = sel.indexOf('/');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, key: process.env.GEMINI_API_KEY ?? null }) + '\\n');
console.log(JSON.stringify({ type: 'ready' }));
for await (const line of console) {
  let cmd; try { cmd = JSON.parse(line); } catch { continue; }
  const data = cmd.type === 'get_state' ? { model: { provider: sel.slice(0, i), id: sel.slice(i + 1) } } : {};
  console.log(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
}
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  test('an idle omp started before the change is restarted on its next acquire; a busy one and scripted-model ones (CAST_MOCK_LLM) keep going', async () => {
    const dir = mkdtempSync(join(root, 'pool-'));
    const log = join(dir, 'spawns.jsonl');
    appendFileSync(log, '');
    const env: Record<string, string | undefined> = { HOME: dir, PATH: process.env.PATH };
    const ompEnv = new OmpEnv({ configFile: join(dir, 'config.json'), env }).load();
    let busy = false;
    mkdirSync(join(dir, 'data'), { recursive: true });
    const pool = new ProcessPool({
      ompBin: rpcOmp(log),
      baseEnv: env,
      demoAgentDir: join(dir, 'demo'),
      dataDir: join(dir, 'data'),
      onFrame() {},
      onExit() {},
      isBusy: () => busy,
      envGeneration: () => ompEnv.generation,
    });
    const spec = (over: Partial<ProcessSpec>): ProcessSpec =>
      ({ agentId: 'p:main:lead', projectId: 'p', roleId: 'lead', cwd: dir, model: 'google/gemini-2.5-pro', demo: false, approvalMode: 'write', systemPrompt: 'hi', sessionDir: join(dir, 'sess'), ...over }) as ProcessSpec;
    const real = spec({});
    const demo = spec({ agentId: 'p:main:demo', model: 'rlt-demo/claude-opus-5-5', demo: true });
    try {
      const p1 = await pool.acquire(real);
      const d1 = await pool.acquire(demo);
      expect(await pool.acquire(real)).toBe(p1); // nothing changed: same process

      ompEnv.set({ GEMINI_API_KEY: KEY });
      busy = true;
      expect(await pool.acquire(real)).toBe(p1); // working: it finishes on the old environment
      busy = false;
      const p2 = await pool.acquire(real);
      expect(p2).not.toBe(p1);
      expect(p1.alive).toBe(false);
      expect(await pool.acquire(demo)).toBe(d1); // the scripted test model needs no key

      const spawns = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { key: string | null });
      expect(spawns.map((s) => s.key)).toEqual([null, null, KEY]);
    } finally {
      await pool.shutdown();
    }
  });
});
