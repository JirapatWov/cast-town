// #69: a model-list or account-list refresh must not start a few-hundred-MB omp when nothing about the sign-ins
// changed. omp's agent.db also holds usage counters, caches and settings that change with every chat turn, so the
// "did the sign-ins change" key reads the credential rows (never their secrets), and the account list is kept by it.
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialKey, credentialRowsDigest } from '../../server/agents/credential-key.ts';
import { ModelRegistry } from '../../server/agents/models.ts';
import { ProviderAccounts } from '../../server/agents/provider-accounts.ts';
import { cleanupTmp, fakeOmp, tmp } from './fake-omp';

afterAll(cleanupTmp);

const SECRET = 'sk-ant-oat01-very-secret-token';

/** An agent dir with an omp-like agent.db: credentials plus the tables a chat turn writes to. */
function store() {
  const agentDir = join(tmp('cast-test-cred-'), 'agent');
  mkdirSync(agentDir, { recursive: true });
  const db = new Database(join(agentDir, 'agent.db'));
  db.run('PRAGMA journal_mode=WAL');
  db.run(`CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
    data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL, created_at INTEGER, updated_at INTEGER)`);
  db.run('CREATE TABLE model_usage (model TEXT PRIMARY KEY, count INTEGER)');
  db.run('CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  const signIn = (provider: string, type = 'oauth') =>
    db.query('INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, ?, ?, ?)').run(provider, type, JSON.stringify({ access: SECRET }), `account:${provider}-1`);
  return { agentDir, db, signIn };
}

describe('credentialKey', () => {
  test('moves with a sign-in, a sign-out and a disabled account — not with chat turns, caches or token refreshes', () => {
    const { agentDir, db, signIn } = store();
    signIn('anthropic');
    const k0 = credentialKey(agentDir);
    expect(k0.startsWith('auth:')).toBe(true);

    // what every chat turn and `omp usage` write: same key
    db.run("INSERT INTO model_usage VALUES ('anthropic/claude-opus-5-5', 1)");
    db.run("INSERT INTO cache VALUES ('usage:anthropic', '{}', 0)");
    // an OAuth token refresh rewrites the secret: same sign-ins, same key
    db.run(`UPDATE auth_credentials SET data = '{"access":"refreshed"}', updated_at = 99 WHERE id = 1`);
    expect(credentialKey(agentDir)).toBe(k0);

    signIn('openai-codex'); // a sign-in (still in the WAL: the key reads it there too)
    const k1 = credentialKey(agentDir);
    expect(k1).not.toBe(k0);
    db.run("UPDATE auth_credentials SET disabled_cause = 'refresh failed' WHERE id = 2");
    const k2 = credentialKey(agentDir);
    expect(k2).not.toBe(k1);
    db.run('DELETE FROM auth_credentials WHERE id = 2'); // sign-out
    expect(credentialKey(agentDir)).toBe(k0);
    db.close();
  });

  test('a models.yml edit moves it; the secret is never part of it', () => {
    const { agentDir, db, signIn } = store();
    signIn('anthropic');
    const k0 = credentialKey(agentDir);
    writeFileSync(join(agentDir, 'models.yml'), 'providers: {}\n');
    expect(credentialKey(agentDir)).not.toBe(k0);
    expect(credentialKey(agentDir)).not.toContain(SECRET);
    db.close();
  });

  test('reads a store nobody holds open (omp closed: WAL checkpointed, no -shm) without changing it', () => {
    const { agentDir, db, signIn } = store();
    signIn('anthropic');
    const live = credentialKey(agentDir);
    db.close(); // the last connection checkpoints and removes -wal / -shm
    const file = join(agentDir, 'agent.db');
    chmodSync(file, 0o600);
    const before = readFileSync(file);
    expect(credentialKey(agentDir)).toBe(live);
    expect(readFileSync(file).equals(before)).toBe(true);
    // a side file the read-only open may leave keeps the store's own 0600 (SQLite copies the database's mode)
    for (const side of ['agent.db-wal', 'agent.db-shm']) if (existsSync(join(agentDir, side))) expect(statSync(join(agentDir, side)).mode & 0o077).toBe(0);
  });

  test('no store yet is a key of its own; an unreadable one falls back to the file stamps', () => {
    const dir = join(tmp('cast-test-cred-'), 'agent');
    mkdirSync(dir, { recursive: true });
    expect(credentialRowsDigest(join(dir, 'agent.db'))).toBe('none');
    expect(credentialKey(dir).startsWith('auth:none|')).toBe(true);
    expect(credentialKey(undefined)).toBe('');

    writeFileSync(join(dir, 'agent.db'), 'not sqlite');
    expect(credentialRowsDigest(join(dir, 'agent.db'))).toBeNull();
    const k = credentialKey(dir);
    expect(k).toContain('agent.db:');
    utimesSync(join(dir, 'agent.db'), new Date(), new Date(Date.now() + 5000));
    expect(credentialKey(dir)).not.toBe(k); // more checks than needed, never fewer
  });

  test('an older store without some columns still works', () => {
    const agentDir = join(tmp('cast-test-cred-'), 'agent');
    mkdirSync(agentDir, { recursive: true });
    const db = new Database(join(agentDir, 'agent.db'));
    db.run('CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT)');
    db.run("INSERT INTO auth_credentials VALUES (1, 'anthropic', 'api_key', 'x')");
    const k = credentialKey(agentDir);
    expect(k.startsWith('auth:')).toBe(true);
    db.run("INSERT INTO auth_credentials VALUES (2, 'deepseek', 'api_key', 'y')");
    expect(credentialKey(agentDir)).not.toBe(k);
    db.close();
  });
});

describe('Refresh reuses the model list while people chat (#69)', () => {
  test('agent.db changing with every turn no longer makes the last check out of date; a sign-in does', async () => {
    const { agentDir, db, signIn } = store();
    signIn('anthropic');
    const w = tmp();
    const omp = fakeOmp(w, 'models', { models: [{ provider: 'anthropic', id: 'claude-opus-5-5' }] });
    const m = new ModelRegistry(omp.bin, { HOME: w, PATH: process.env.PATH }, { agentDir });
    await m.detect();
    expect(omp.count()).toBe(1);
    db.run("INSERT INTO model_usage VALUES ('anthropic/claude-opus-5-5', 7)"); // a chat turn
    utimesSync(join(agentDir, 'agent.db'), new Date(), new Date(Date.now() + 5000));
    expect(m.upToDate(60_000)).toBe(true);
    signIn('google-gemini-cli');
    expect(m.upToDate(60_000)).toBe(false);
    db.close();
  });
});

/** A fake `omp --mode rpc-ui` that answers get_logout_accounts from <dir>/accounts.json and counts its starts. */
function fakeRpcOmp(dir: string) {
  const bin = join(dir, 'rpc-omp.js');
  const accountsFile = join(dir, 'accounts.json');
  const countFile = join(dir, 'rpc.count');
  writeFileSync(accountsFile, JSON.stringify({ anthropic: [{ credentialId: 1, type: 'oauth', label: 'Work account' }] }));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(countFile)}, process.argv.slice(2).join(' ') + '\\n');
const accounts = JSON.parse(fs.readFileSync(${JSON.stringify(accountsFile)}, 'utf8'));
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const cmd = JSON.parse(line);
    const data = cmd.type === 'get_logout_accounts' ? { accounts: accounts[cmd.providerId] ?? [] } : {};
    process.stdout.write(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`,
  );
  chmodSync(bin, 0o755);
  const starts = () => (existsSync(countFile) ? readFileSync(countFile, 'utf8').split('\n').filter((l) => l.includes('rpc-ui')).length : 0);
  return { bin, accountsFile, starts };
}

describe('the account list is kept while the sign-ins are unchanged (#69)', () => {
  test('opening Models & providers again (or Refresh) starts no omp; a sign-in elsewhere or invalidation does', async () => {
    const { agentDir, db, signIn } = store();
    signIn('anthropic');
    const dir = tmp();
    const omp = fakeRpcOmp(dir);
    const accounts = new ProviderAccounts({ ompBin: omp.bin, env: { HOME: dir, PATH: process.env.PATH }, cwd: dir, credentialsKey: () => credentialKey(agentDir) });
    try {
      const first = await accounts.list();
      expect(first.map((a) => a.label)).toEqual(['Work account']);
      expect(omp.starts()).toBe(1);
      db.run("INSERT INTO model_usage VALUES ('x', 1)"); // people chat meanwhile
      expect((await accounts.list()).map((a) => a.label)).toEqual(['Work account']);
      await Promise.all([accounts.list(), accounts.list()]);
      expect(omp.starts()).toBe(1);

      // a sign-in in the terminal (omp login): the store has a new row → asked again
      writeFileSync(omp.accountsFile, JSON.stringify({ anthropic: [{ credentialId: 1, type: 'oauth', label: 'Work account' }], deepseek: [{ credentialId: 2, type: 'api_key' }] }));
      signIn('deepseek', 'api_key');
      expect((await accounts.list()).map((a) => a.label)).toEqual(['Work account', 'API key #2']);
      expect(omp.starts()).toBe(2);

      // a sign-in through CAST invalidates it outright
      accounts.invalidateUsage();
      await accounts.list();
      expect(omp.starts()).toBe(3);
    } finally {
      accounts.shutdown();
      db.close();
    }
  });

  test('without a key (no agent dir) every list asks omp, as before', async () => {
    const dir = tmp();
    const omp = fakeRpcOmp(dir);
    const accounts = new ProviderAccounts({ ompBin: omp.bin, env: { HOME: dir, PATH: process.env.PATH }, cwd: dir });
    try {
      await accounts.list();
      await accounts.list();
      expect(omp.starts()).toBe(2);
    } finally {
      accounts.shutdown();
    }
  });
});
