// F4: sign-ins made outside CAST (`omp login google-antigravity` typed in CAST's terminal) are noticed without a
// restart — models re-detected, every client told — by watching omp's credential store read-only; omp keeps writing
// while CAST reads it. And a hand edit of config.json ompEnv is picked up by Refresh (it is part of the model list's
// fingerprint). A scratch PI_CODING_AGENT_DIR with an omp-like agent.db and a fake omp that lists models by the
// credential rows stored there.
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialKey } from '../../server/agents/credential-key.ts';
import { CredentialWatch } from '../../server/agents/credential-watch.ts';
import { ModelRegistry } from '../../server/agents/models.ts';
import { OmpEnv } from '../../server/agents/omp-env.ts';
import { OmpHealth } from '../../server/agents/omp-health.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { cleanup, makeSys, sleep } from '../rv-server/sys-world';

const root = mkdtempSync(join(tmpdir(), 'cast-test-credwatch-'));
afterAll(() => {
  cleanup();
  rmSync(root, { recursive: true, force: true });
});

const KEY = 'AIzaFakeKeyForCastTests0123456789abcd';

/** An agent dir with omp's agent.db layout (WAL, credentials next to tables every chat turn writes). */
function agentDir(): { dir: string; db: Database; signIn(provider: string): void; signOut(provider: string): void } {
  const dir = join(mkdtempSync(join(root, 'agent-')), 'agent');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'agent.db'));
  db.run('PRAGMA journal_mode=WAL');
  db.run(`CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
    data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL)`);
  db.run('CREATE TABLE model_usage (model TEXT PRIMARY KEY, count INTEGER)');
  return {
    dir,
    db,
    signIn: (provider) => void db.query("INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', '{\"access\":\"secret\"}', ?)").run(provider, `account:${provider}`),
    signOut: (provider) => void db.query('DELETE FROM auth_credentials WHERE provider = ?').run(provider),
  };
}

/** A fake omp: `models --json` lists Antigravity's models when agent.db holds a google-antigravity row (and Gemini
 *  models when GEMINI_API_KEY reaches it), the way omp lists only what has credentials. Counts its model checks. */
function fakeOmp(): { bin: string; checks: () => number } {
  const bin = join(root, `omp-${Math.random().toString(36).slice(2)}.ts`);
  const count = `${bin}.count`;
  writeFileSync(
    bin,
    `#!${process.execPath}
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync } from 'node:fs';
const [cmd] = process.argv.slice(2);
if (cmd === '--version') { console.log('omp/18.13.2'); process.exit(0); }
if (cmd !== 'models') { console.error('No models available'); process.exit(1); }
appendFileSync(${JSON.stringify(count)}, 'x\\n');
const file = (process.env.PI_CODING_AGENT_DIR ?? '') + '/agent.db';
let providers = [];
if (existsSync(file)) {
  const db = new Database(file, { readonly: true });
  providers = db.query('SELECT provider FROM auth_credentials').values().map((r) => r[0]);
  db.close();
}
const models = [];
if (providers.includes('google-antigravity')) for (const [id, name] of [['claude-opus-5-5', 'Claude Opus 5.5'], ['gemini-4-argon', 'Gemini 4 Argon']]) models.push({ provider: 'google-antigravity', id, selector: 'google-antigravity/' + id, name });
if (process.env.GEMINI_API_KEY) models.push({ provider: 'google', id: 'gemini-2.5-pro', selector: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' });
console.log(JSON.stringify({ models }));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, checks: () => (existsSync(count) ? readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0) };
}

describe('CredentialWatch', () => {
  test('reports a change once, after two looks agree; never while CAST is busy; not what the model list already knows', async () => {
    const a = agentDir();
    let known = credentialKey(a.dir);
    let busy = false;
    const seen: string[] = [];
    const w = new CredentialWatch({ agentDir: a.dir, known: () => known, busy: () => busy, onChange: (k) => void seen.push(k) });
    await w.check();
    expect(seen).toEqual([]);

    a.db.run("INSERT INTO model_usage VALUES ('x', 1)"); // a chat turn: the files move, the sign-ins don't
    await w.check();
    await w.check();
    expect(seen).toEqual([]);

    a.signIn('google-antigravity'); // `omp login` in a terminal
    busy = true; // CAST's own sign-in running: left to it
    await w.check();
    await w.check();
    expect(seen).toEqual([]);
    busy = false;
    await w.check(); // first look: maybe omp is still writing
    expect(seen).toEqual([]);
    await w.check(); // second look agrees
    expect(seen).toEqual([credentialKey(a.dir)]);
    await w.check();
    expect(seen.length).toBe(1); // once

    known = credentialKey(a.dir); // the model list was read under it
    a.signOut('google-antigravity');
    known = credentialKey(a.dir); // …and CAST's own sign-out already re-read it
    await w.check();
    await w.check();
    expect(seen.length).toBe(1);
    a.db.close();
  });

  test('omp keeps writing its store while CAST reads it (no busy errors, WAL left to omp)', async () => {
    const a = agentDir();
    a.db.close();
    // another process plays omp: a fixed number of writes with no busy timeout at all, started once CAST is reading,
    // so the outcome doesn't depend on how fast this machine is
    const writes = 32;
    const writer = join(root, 'writer.ts');
    writeFileSync(
      writer,
      `import { Database } from 'bun:sqlite';
const db = new Database(process.argv[2]);
db.run('PRAGMA busy_timeout = 0');
console.log('ready');
for await (const _ of console) break;
let busy = 0, done = 0;
for (let i = 0; i < ${writes}; i++) {
  try { db.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic', 'oauth', 'x')").run(); db.query('DELETE FROM auth_credentials WHERE id = (SELECT MIN(id) FROM auth_credentials)').run(); done++; }
  catch (e) { if (/busy|locked/i.test(String(e))) busy++; else throw e; }
  await Bun.sleep(2);
}
console.log(JSON.stringify({ busy, done }));
`,
    );
    const child = spawn(process.execPath, [writer, join(a.dir, 'agent.db')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    let closed = false;
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number | null>();
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      if (out.includes('ready\n')) ready.resolve();
    });
    child.on('close', (code) => {
      closed = true;
      ready.reject(new Error(`the writer stopped before it was ready: ${out}`));
      exited.resolve(code);
    });
    const w = new CredentialWatch({ agentDir: a.dir, known: () => 'something-else', busy: () => false, onChange: () => {} });
    const reads: { start: number; end: number }[] = [];
    const reading = (async () => {
      while (!closed) {
        const start = performance.now();
        await w.check();
        reads.push({ start, end: performance.now() });
        await new Promise<void>((r) => setImmediate(r)); // let the writer's output in between looks
      }
    })();
    try {
      await ready.promise;
      const go = performance.now();
      child.stdin.end('go\n');
      expect(await exited.promise).toBe(0);
      const stop = performance.now();
      await reading;
      expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({ busy: 0, done: writes });
      // CAST was reading while omp wrote: at least one look ran inside the writing phase
      expect(reads.filter((x) => x.start < stop && x.end > go).length).toBeGreaterThan(0);
    } finally {
      closed = true;
      child.kill();
    }
  }, 30_000);
});

describe('a sign-in made outside CAST, end to end through the agent system', () => {
  test('noticed without a restart: models re-detected, clients told, a toast; CAST’s own model checks are not repeated', async () => {
    const a = agentDir();
    const omp = fakeOmp();
    const env: Record<string, string | undefined> = { HOME: root, PATH: process.env.PATH, PI_CODING_AGENT_DIR: a.dir };
    const models = new ModelRegistry(omp.bin, env, { agentDir: a.dir });
    const w = makeSys({ models, extra: () => ({ env, credentialWatch: { agentDir: a.dir, intervalMs: 40 } }) });
    await models.detect();
    expect(models.anyAvailable()).toBe(false);
    const checks = omp.checks();
    await sleep(200);
    expect(omp.checks()).toBe(checks); // nothing changed: no omp started

    a.signIn('google-antigravity'); // `omp login google-antigravity` in CAST's terminal
    await w.until(() => w.sent.some((m) => m.t === 'models' && m.models.some((x) => x.id === 'google-antigravity/claude-opus-5-5' && x.available)), 4000, 'the models push');
    expect(models.isAvailable('google-antigravity/claude-opus-5-5')).toBe(true);
    await w.until(() => w.sent.some((m) => m.t === 'toast' && /New sign-in found \(made outside CAST\)/.test(m.text)), 2000, 'the toast');
    await sleep(300);
    expect(omp.checks()).toBe(checks + 1); // one check for one sign-in

    a.signOut('google-antigravity'); // `omp logout` elsewhere
    await w.until(() => w.sent.some((m) => m.t === 'toast' && /last sign-in was removed outside CAST/.test(m.text)), 4000, 'the sign-out toast');
    expect(models.anyAvailable()).toBe(false);
    a.db.close();
    await w.dispose();
  });
});

describe('Refresh picks up config.json ompEnv edited by hand (F4)', () => {
  test('the extra environment is part of the model list’s fingerprint: an edit is checked, no edit is reused', async () => {
    const a = agentDir();
    const omp = fakeOmp();
    const env: Record<string, string | undefined> = { HOME: root, PATH: process.env.PATH, PI_CODING_AGENT_DIR: a.dir };
    const dataRoot = mkdtempSync(join(root, 'sys-'));
    const configFile = join(dataRoot, 'data', 'config.json');
    mkdirSync(join(dataRoot, 'data'), { recursive: true });
    const ompEnv = new OmpEnv({ configFile, env }).load();
    const models = new ModelRegistry(omp.bin, env, { agentDir: a.dir, envKey: () => ompEnv.key() });
    const health = new OmpHealth({ bin: omp.bin, env, models, timeouts: { checkMs: 10_000, startMs: 10_000 }, onChange: () => {} });
    const w = makeSys({ root: dataRoot, models, health, extra: () => ({ env, ompEnv }) });
    await health.start();
    const refresh = async () => {
      const before = w.sent.length;
      await w.handle({ t: 'refresh_models' });
      return w.sent.slice(before);
    };
    const toastOf = (msgs: ServerMsg[]) => msgs.find((m): m is Extract<ServerMsg, { t: 'toast' }> => m.t === 'toast')?.text ?? '';
    expect(toastOf(await refresh())).toMatch(/^Up to date/); // nothing changed: reused, no omp started

    writeFileSync(configFile, JSON.stringify({ ompEnv: { GEMINI_API_KEY: KEY } }), { mode: 0o600 }); // by hand
    const checks = omp.checks();
    const out = await refresh();
    expect(omp.checks()).toBe(checks + 1);
    expect(toastOf(out)).toBe('1 model connected.');
    expect(out.some((m) => m.t === 'omp_env' && m.ompEnv.GEMINI_API_KEY.source === 'config')).toBe(true);
    expect(env.GEMINI_API_KEY).toBe(KEY);
    expect(models.isAvailable('google/gemini-2.5-pro')).toBe(true);
    expect(JSON.stringify(w.sent)).not.toContain(KEY);
    expect(toastOf(await refresh())).toMatch(/^Up to date/); // and reused again after that

    writeFileSync(configFile, JSON.stringify({}), { mode: 0o600 }); // removed by hand
    expect(toastOf(await refresh())).toBe('Nobody is signed in yet — connect an AI account under Models & providers.');
    expect(w.sys.demoMode()).toBe(false); // nobody works now: no scripted stand-in outside the tests' opt-in
    expect('GEMINI_API_KEY' in env).toBe(false);
    a.db.close();
    await w.dispose();
  });
});
