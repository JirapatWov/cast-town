// Model servers on another machine (Models & providers → Model servers on your network): what Save does to the
// agent's models.yml (other providers and keys kept, 0600, bad names and addresses refused), what Test connection
// says when it can't get a model list, and save → models checked again → available, remove → gone, through a real
// AgentSystemImpl whose fake `omp models` lists one model per models.yml server (like omp's discovery does).
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkApiKey } from '../../server/agents/api-key-check.ts';
import { connectionError, LocalServers } from '../../server/agents/local-models.ts';
import { ModelRegistry } from '../../server/agents/models.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { cleanup, makeSys } from '../rv-server/sys-world';

const root = mkdtempSync(join(tmpdir(), 'cast-test-local-models-'));
afterAll(() => {
  cleanup();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const agentDir = () => {
  const d = join(root, `agent-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const yml = (d: string) => Bun.YAML.parse(readFileSync(join(d, 'models.yml'), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;

describe('Save merges the server into models.yml', () => {
  test('other providers, other settings and other keys of the entry are kept; the file is 0600', () => {
    const d = agentDir();
    writeFileSync(
      join(d, 'models.yml'),
      'modelRoles:\n  default: anthropic/claude-opus-5-5\nproviders:\n  my-proxy:\n    baseUrl: https://proxy.example/v1\n    apiKey: PROXY_KEY\n    api: openai-responses\n  desk:\n    baseUrl: http://10.0.0.2:8080/v1\n    api: openai-completions\n    auth: none\n    modelOverrides:\n      qwen:\n        contextWindow: 32768\n    discovery:\n      type: llama.cpp\n      timeoutMs: 3000\n',
      { mode: 0o644 },
    );
    const s = new LocalServers(d);
    const list = s.save({ name: ' Desk ', kind: 'llama.cpp', baseUrl: '192.168.1.20:8080/' });
    expect(list).toEqual([{ name: 'desk', kind: 'llama.cpp', baseUrl: 'http://192.168.1.20:8080/v1', hasKey: false }]);
    const doc = yml(d);
    expect(doc.modelRoles).toEqual({ default: 'anthropic/claude-opus-5-5' });
    expect(doc.providers['my-proxy']).toEqual({ baseUrl: 'https://proxy.example/v1', apiKey: 'PROXY_KEY', api: 'openai-responses' });
    expect(doc.providers.desk).toEqual({
      baseUrl: 'http://192.168.1.20:8080/v1',
      api: 'openai-completions',
      auth: 'none',
      modelOverrides: { qwen: { contextWindow: 32768 } },
      discovery: { type: 'llama.cpp', timeoutMs: 3000 },
    });
    expect(statSync(join(d, 'models.yml')).mode & 0o777).toBe(0o600);
  });

  test('a key is saved, kept when left blank, removed with null — and never listed', () => {
    const d = agentDir();
    const s = new LocalServers(d);
    expect(s.save({ name: 'box', kind: 'ollama', baseUrl: 'http://100.64.0.20:11434/v1', apiKey: ' sk-local-123 ' })).toEqual([{ name: 'box', kind: 'ollama', baseUrl: 'http://100.64.0.20:11434', hasKey: true }]);
    expect(yml(d).providers.box).toEqual({ baseUrl: 'http://100.64.0.20:11434', api: 'openai-completions', discovery: { type: 'ollama' }, apiKey: 'sk-local-123' });
    expect(JSON.stringify(s.list())).not.toContain('sk-local-123');
    s.save({ name: 'box', kind: 'ollama', baseUrl: 'http://100.64.0.21:11434' });
    expect(yml(d).providers.box!.apiKey).toBe('sk-local-123');
    s.save({ name: 'box', kind: 'ollama', baseUrl: 'http://100.64.0.21:11434', apiKey: null });
    expect(yml(d).providers.box).toEqual({ baseUrl: 'http://100.64.0.21:11434', api: 'openai-completions', discovery: { type: 'ollama' }, auth: 'none' });
  });

  test('a new kind drops the old kind’s discovery options (omp would refuse the whole file)', () => {
    const d = agentDir();
    writeFileSync(join(d, 'models.yml'), 'providers:\n  gw:\n    baseUrl: http://h:8000/v1\n    api: openai-completions\n    auth: none\n    discovery:\n      type: openai-models-list\n      injectV1: false\n');
    new LocalServers(d).save({ name: 'gw', kind: 'lm-studio', baseUrl: 'http://h:1234' });
    expect(yml(d).providers.gw!.discovery).toEqual({ type: 'lm-studio' });
  });

  test('a models.json omp hasn’t moved yet is read and written out as models.yml', () => {
    const d = agentDir();
    writeFileSync(join(d, 'models.json'), JSON.stringify({ providers: { other: { baseUrl: 'https://x.example/v1', apiKey: 'K' } } }));
    new LocalServers(d).save({ name: 'desk', kind: 'llama.cpp', baseUrl: 'http://10.0.0.5:8080' });
    expect(Object.keys(yml(d).providers)).toEqual(['other', 'desk']);
  });

  test('Remove takes out only that server; one already gone is no error', () => {
    const d = agentDir();
    const s = new LocalServers(d);
    s.save({ name: 'a', kind: 'llama.cpp', baseUrl: 'http://10.0.0.5:8080' });
    s.save({ name: 'b', kind: 'ollama', baseUrl: 'http://10.0.0.6:11434' });
    expect(s.remove('a').map((x) => x.name)).toEqual(['b']);
    expect(s.remove('a').map((x) => x.name)).toEqual(['b']);
    expect(s.remove('b')).toEqual([]);
    expect(yml(d) ?? {}).toEqual({});
  });
});

describe('Save refuses, in words, and leaves the file as it was', () => {
  const d = agentDir();
  const original = 'providers:\n  hand:\n    baseUrl: https://hand.example/v1\n    apiKey: HAND_KEY\n    api: openai-completions\n';
  writeFileSync(join(d, 'models.yml'), original);
  const s = new LocalServers(d);
  const refused = (input: Parameters<LocalServers['save']>[0]) => {
    let message = '';
    try {
      s.save(input);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(readFileSync(join(d, 'models.yml'), 'utf8')).toBe(original);
    return message;
  };
  const ok = { kind: 'llama.cpp' as const, baseUrl: 'http://192.168.1.20:8080' };

  test('names that aren’t provider ids, or that the agent already uses', () => {
    expect(refused({ ...ok, name: '' })).toContain('Give the server a name');
    expect(refused({ ...ok, name: 'my box' })).toContain('lowercase letters');
    expect(refused({ ...ok, name: 'a/b' })).toContain('lowercase letters');
    expect(refused({ ...ok, name: '-x' })).toContain('lowercase letters');
    expect(refused({ ...ok, name: 'anthropic' })).toContain('already has a provider called “anthropic”');
    expect(refused({ ...ok, name: 'llama.cpp' })).toContain('already has a provider called “llama.cpp”');
    expect(refused({ ...ok, name: 'hand' })).toContain('isn’t a model server like these');
  });

  test('addresses that aren’t http or https, or carry a password; keys omp would run', () => {
    expect(refused({ ...ok, name: 'x', baseUrl: '' })).toContain('Enter the server’s address');
    expect(refused({ ...ok, name: 'x', baseUrl: 'ftp://10.0.0.1/' })).toContain('starts with http:// or https://');
    expect(refused({ ...ok, name: 'x', baseUrl: 'file:///etc/passwd' })).toContain('starts with http:// or https://');
    expect(refused({ ...ok, name: 'x', baseUrl: 'http://u:p@10.0.0.1:8080' })).toContain('not in the address');
    expect(refused({ ...ok, name: 'x', baseUrl: 'http://[nope' })).toContain('isn’t an address');
    expect(refused({ ...ok, name: 'x', apiKey: '!printenv' })).toContain('can’t start with “!”');
    expect(refused({ ...ok, name: 'x', apiKey: 'two words' })).toContain('no spaces');
  });

  test('a models.yml that isn’t valid YAML is not overwritten, and its text is not echoed', () => {
    const bad = agentDir();
    writeFileSync(join(bad, 'models.yml'), 'providers:\n  a: [\n    apiKey: sk-secret-value\n');
    expect(() => new LocalServers(bad).save({ ...ok, name: 'x' })).toThrow(/isn’t valid YAML/);
    expect(() => new LocalServers(bad).list()).not.toThrow(/sk-secret-value/);
    expect(readFileSync(join(bad, 'models.yml'), 'utf8')).toContain('sk-secret-value');
  });
});

describe('Test connection says what went wrong', () => {
  const hits: { path: string; auth: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push({ path: pathname, auth: req.headers.get('authorization') });
      if (pathname.startsWith('/locked/')) return req.headers.get('authorization') === 'Bearer sk-right' ? Response.json({ data: [{ id: 'm' }] }) : new Response('no', { status: 401 });
      if (pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'qwen3-coder-30b' }, { id: 'qwen3-coder-30b' }, { id: 'gemma-3' }] });
      if (pathname === '/web/v1/models') return new Response('<html>router login</html>', { headers: { 'content-type': 'text/html' } });
      if (pathname === '/empty/v1/models') return Response.json({ data: [] });
      if (pathname === '/slow/v1/models') return new Promise<Response>(() => {});
      return new Response('not found', { status: 404 });
    },
  });
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const dir = agentDir();
  // the agent's environment: CAST's ompEnv lands in this object too
  const env: Record<string, string | undefined> = { LAN_BOX_KEY: 'sk-right' };
  const s = new LocalServers(dir, { env, fetch, timeoutMs: 400 });
  const fails = async (input: Parameters<LocalServers['test']>[0]) => {
    try {
      await s.test(input);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected the test to fail');
  };

  test('a server that answers: its model ids, once each (at <address>/v1/models)', async () => {
    expect(await s.test({ kind: 'llama.cpp', baseUrl: base })).toEqual(['qwen3-coder-30b', 'gemma-3']);
    expect(hits.at(-1)).toEqual({ path: '/v1/models', auth: null });
    expect(await s.test({ kind: 'openai-models-list', baseUrl: `${base}/empty` })).toEqual([]);
  });

  test('a key: sent as a bearer token; asked for or refused', async () => {
    expect(await fails({ kind: 'openai-models-list', baseUrl: `${base}/locked` })).toBe('The server wants an API key (HTTP 401). Enter it under API key.');
    expect(await fails({ kind: 'openai-models-list', baseUrl: `${base}/locked`, apiKey: 'sk-wrong' })).toBe('The server refused the API key (HTTP 401). Check the key.');
    expect(await s.test({ kind: 'openai-models-list', baseUrl: `${base}/locked`, apiKey: 'sk-right' })).toEqual(['m']);
  });

  test('a saved key that names an environment variable is tested with its value, as the agent uses it', async () => {
    writeFileSync(
      join(dir, 'models.yml'),
      `providers:\n  lan-box:\n    baseUrl: ${base}/locked/v1\n    api: openai-completions\n    apiKey: LAN_BOX_KEY\n    discovery:\n      type: openai-models-list\n  cmd-box:\n    baseUrl: ${base}/locked/v1\n    api: openai-completions\n    apiKey: "!pass show lan-box"\n    discovery:\n      type: openai-models-list\n`,
    );
    expect(await s.test({ kind: 'openai-models-list', baseUrl: `${base}/locked`, name: 'lan-box' })).toEqual(['m']);
    expect(hits.at(-1)).toEqual({ path: '/locked/v1/models', auth: 'Bearer sk-right' });
    // unset: the agent uses the text as the key itself
    delete env.LAN_BOX_KEY;
    expect(await fails({ kind: 'openai-models-list', baseUrl: `${base}/locked`, name: 'lan-box' })).toBe('The server refused the API key (HTTP 401). Check the key.');
    expect(hits.at(-1)!.auth).toBe('Bearer LAN_BOX_KEY');
  });

  test('a saved `!command` key is neither run nor sent: the test says so in words', async () => {
    const before = hits.length;
    expect(await fails({ kind: 'openai-models-list', baseUrl: `${base}/locked`, name: 'cmd-box' })).toContain('a command the agent runs to get the key');
    expect(hits.length).toBe(before);
  });

  test('not a model server: a 404, a web page, or an OpenAI-compatible server picked as Ollama', async () => {
    expect(await fails({ kind: 'llama.cpp', baseUrl: `${base}/nothing` })).toContain('isn’t there (HTTP 404), so this doesn’t look like a llama.cpp server');
    expect(await fails({ kind: 'lm-studio', baseUrl: `${base}/web` })).toContain('but not like an LM Studio server');
    expect(await fails({ kind: 'ollama', baseUrl: base })).toBe('This server answers like an OpenAI-compatible server, not like Ollama. Pick another kind.');
  });

  test('nothing listening: the listen-on-the-network hint for that kind; no answer: the timeout', async () => {
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = closed.port;
    closed.stop(true);
    expect(await fails({ kind: 'llama.cpp', baseUrl: `http://127.0.0.1:${port}` })).toContain('Nothing is listening at 127.0.0.1:');
    expect(await fails({ kind: 'llama.cpp', baseUrl: `http://127.0.0.1:${port}` })).toContain('--host 0.0.0.0');
    expect(await fails({ kind: 'ollama', baseUrl: `http://127.0.0.1:${port}` })).toContain('OLLAMA_HOST=0.0.0.0');
    expect(await fails({ kind: 'llama.cpp', baseUrl: `${base}/slow` })).toBe(`127.0.0.1:${server.port} didn’t answer within 1 second. Check the address, that the machine is on, and that no firewall blocks port ${server.port}.`);
  });

  test('the other ways a connection fails', () => {
    const err = (code: string) => Object.assign(new TypeError(code), { code });
    expect(connectionError(err('ENOTFOUND'), 'http://desk.lan:8080/v1', 'llama.cpp')).toBe('Couldn’t find desk.lan. Check the address (an IP address like 192.168.1.20 is safest).');
    expect(connectionError(err('EHOSTUNREACH'), 'http://10.1.2.3:8080/v1', 'llama.cpp')).toContain('Can’t reach 10.1.2.3 from the CAST server');
    expect(connectionError(err('EPROTO'), 'https://10.1.2.3:8080/v1', 'llama.cpp')).toContain('Most local model servers use http://');
    expect(connectionError(err('ECONNRESET'), 'http://10.1.2.3:8080/v1', 'llama.cpp')).toContain('closed the connection');
    expect(connectionError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 'http://10.1.2.3/v1', 'ollama', 5000)).toContain('within 5 seconds');
  });
});

describe('Paste API key: Anthropic and OpenAI checks', () => {
  const fake = (status: number, body = '') => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { f, seen };
  };

  test('a good key: one model-list call with the vendor’s own header', async () => {
    const a = fake(200, '{"data":[]}');
    expect(await checkApiKey('ANTHROPIC_API_KEY', 'sk-ant-x', a.f)).toEqual({ ok: true });
    expect(a.seen).toEqual([{ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': 'sk-ant-x', 'anthropic-version': '2023-06-01' } }]);
    const o = fake(429);
    expect(await checkApiKey('OPENAI_API_KEY', 'sk-x', o.f)).toEqual({ ok: true });
    expect(o.seen[0]!.headers).toEqual({ authorization: 'Bearer sk-x' });
  });

  test('refused (not saved) vs. not asked (saved with a warning)', async () => {
    expect(await checkApiKey('OPENAI_API_KEY', 'sk-x', fake(401, '{"error":{"message":"Incorrect API key provided: sk-x"}}').f)).toEqual({ ok: false, rejected: true, message: 'OpenAI says that key isn’t valid. Copy it again from the OpenAI dashboard (the whole key) and paste it here.' });
    expect(await checkApiKey('ANTHROPIC_API_KEY', 'sk-ant-x', fake(529).f)).toEqual({ ok: false, rejected: false, message: 'Anthropic had a problem (HTTP 529)' });
    const offline = (async () => {
      throw new TypeError('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await checkApiKey('ANTHROPIC_API_KEY', 'sk-ant-x', offline)).toEqual({ ok: false, rejected: false, message: 'Couldn’t reach Anthropic' });
  });
});

describe('save_local_server / remove_local_server through the agent system', () => {
  /** `omp models --json` as omp's discovery would answer: `<name>/served-model` for every models.yml server. */
  function modelsOmp(): string {
    const bin = join(root, 'omp-models.ts');
    writeFileSync(
      bin,
      `#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
if (process.argv[2] !== 'models') process.exit(3);
const file = process.env.PI_CODING_AGENT_DIR + '/models.yml';
const doc = existsSync(file) ? Bun.YAML.parse(readFileSync(file, 'utf8')) ?? {} : {};
const models = Object.keys(doc.providers ?? {}).map((p) => ({ provider: p, id: 'served-model', selector: p + '/served-model', name: 'Served model' }));
console.log(JSON.stringify({ models }));
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  test('saved: every client hears the list, the models are checked again and the model is ready; removed: gone', async () => {
    const dir = agentDir();
    const env: Record<string, string | undefined> = { HOME: root, PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir };
    const models = new ModelRegistry(modelsOmp(), env, { agentDir: dir });
    const w = makeSys({ models, scripted: false, extra: () => ({ env, localServers: new LocalServers(dir) }) });
    await models.detect();
    expect(models.anyAvailable()).toBe(false);

    const ack = await w.handle({ t: 'save_local_server', name: 'desk', kind: 'llama.cpp', baseUrl: 'http://192.168.1.20:8080', apiKey: 'sk-local-secret' });
    expect(ack).toMatchObject({ t: 'ack', ok: true, data: { servers: [{ name: 'desk', kind: 'llama.cpp', baseUrl: 'http://192.168.1.20:8080/v1', hasKey: true }] } });
    await w.until(() => models.isAvailable('desk/served-model'));
    expect(w.sent.some((m) => m.t === 'local_servers' && m.servers.length === 1)).toBe(true);
    expect(w.sent.some((m: ServerMsg) => m.t === 'models' && m.models.some((x) => x.id === 'desk/served-model' && x.available))).toBe(true);
    await w.until(() => w.sent.some((m) => m.t === 'toast' && m.text === 'desk saved — 1 model is ready.'));
    expect(JSON.stringify(w.sent)).not.toContain('sk-local-secret');

    const off = await w.handle({ t: 'remove_local_server', name: 'desk' });
    expect(off).toMatchObject({ ok: true, data: { servers: [] } });
    await w.until(() => !models.isAvailable('desk/served-model') || null);
    await w.dispose();
  });

  test('without a LocalServers (older wiring) the messages are refused politely', async () => {
    const w = makeSys();
    expect(await w.handle({ t: 'list_local_servers' })).toMatchObject({ ok: false, error: 'This server can’t change the agent’s model servers.' });
    await w.dispose();
  });
});
