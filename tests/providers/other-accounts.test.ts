// Accounts of providers beyond the featured six (server/agents/provider-accounts.ts): omp's `get_login_providers`
// says which sign-ins are signed in, and those providers' accounts are listed too (GitHub Copilot, Cerebras, …), in
// omp's menu order, once each — an alias counts for the provider it stores under, and a featured one isn't asked twice.
// An omp without that command still lists the featured ones. Signing out works for any provider a sign-in of omp's
// menu stores under, and for nothing else. A fake `omp --mode rpc-ui`; no real sign-in is read.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderAccounts, managedProvider } from '../../server/agents/provider-accounts.ts';

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** A fake rpc-ui omp: accounts per provider, the login list (or `null`: an omp without get_login_providers), and a
 *  log of the commands it got. */
function fakeRpc(accounts: Record<string, unknown[]>, logins: unknown[] | null) {
  const dir = mkdtempSync(join(tmpdir(), 'cast-test-others-'));
  roots.push(dir);
  const bin = join(dir, 'omp.js');
  const state = join(dir, 'accounts.json');
  const log = join(dir, 'commands.log');
  writeFileSync(state, JSON.stringify(accounts));
  writeFileSync(log, '');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const logins = ${JSON.stringify(logins)};
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const cmd = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(log)}, cmd.type + ' ' + (cmd.providerId ?? '') + '\\n');
    const accounts = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
    const reply = (data) => process.stdout.write(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }) + '\\n');
    if (cmd.type === 'get_login_providers') {
      if (!logins) process.stdout.write(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: false, error: 'Unknown command: get_login_providers' }) + '\\n');
      else reply({ providers: logins });
    } else if (cmd.type === 'get_logout_accounts') reply({ accounts: accounts[cmd.providerId] ?? [] });
    else if (cmd.type === 'logout') {
      accounts[cmd.providerId] = (accounts[cmd.providerId] ?? []).filter((a) => a.credentialId !== cmd.credentialId);
      fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(accounts));
      reply({});
    } else reply({});
  }
});
process.stdin.on('end', () => process.exit(0));
`,
  );
  chmodSync(bin, 0o755);
  const commands = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { bin, dir, commands };
}

const accountsOf = (bin: string, dir: string) => new ProviderAccounts({ ompBin: bin, env: { HOME: dir, PATH: process.env.PATH }, cwd: dir });

describe('accounts of the other signed-in providers', () => {
  test('listed after the featured ones, in omp’s menu order, each provider once', async () => {
    const omp = fakeRpc(
      {
        anthropic: [{ credentialId: 1, type: 'oauth', label: 'Work account' }],
        'openai-codex': [{ credentialId: 2, type: 'oauth', label: 'Home (Team)' }],
        'github-copilot': [{ credentialId: 5, type: 'oauth', label: 'Copilot account' }],
        cerebras: [{ credentialId: 7, type: 'api_key' }],
        cursor: [{ credentialId: 9, type: 'oauth', label: 'Should not be asked' }],
      },
      [
        { id: 'anthropic', name: 'Anthropic (Claude Pro/Max)', available: true, authenticated: true },
        { id: 'openai-codex-device', name: 'ChatGPT Plus/Pro (Codex Subscription, device code)', available: true, authenticated: true },
        { id: 'github-copilot', name: 'GitHub Copilot', available: true, authenticated: true },
        { id: 'cursor', name: 'Cursor (Claude, GPT, etc.)', available: true, authenticated: false },
        { id: 'cerebras', name: 'Cerebras', available: true, authenticated: true },
        { id: 'not-in-the-list', name: 'Something new', available: true, authenticated: true },
        { name: 'broken row', authenticated: true },
      ],
    );
    const accounts = accountsOf(omp.bin, omp.dir);
    try {
      const list = await accounts.list();
      expect(list.map((a) => `${a.provider}#${a.credentialId}`)).toEqual(['anthropic#1', 'openai-codex#2', 'github-copilot#5', 'cerebras#7']);
      const asked = omp.commands().filter((c) => c.startsWith('get_logout_accounts')).map((c) => c.split(' ')[1]);
      expect(asked.filter((p) => p === 'openai-codex')).toHaveLength(1); // the device-code alias isn't asked again
      expect(asked).not.toContain('cursor'); // not signed in
      expect(asked).not.toContain('not-in-the-list'); // nothing reaches omp that its menu (the list) lacks
    } finally {
      accounts.shutdown();
    }
  });

  test('an omp without get_login_providers: the featured ones, as before', async () => {
    const omp = fakeRpc({ anthropic: [{ credentialId: 1, type: 'oauth', label: 'Work account' }], cerebras: [{ credentialId: 7, type: 'api_key' }] }, null);
    const accounts = accountsOf(omp.bin, omp.dir);
    try {
      expect((await accounts.list()).map((a) => `${a.provider}#${a.credentialId}`)).toEqual(['anthropic#1']);
    } finally {
      accounts.shutdown();
    }
  });

  test('signing out of another provider’s account; a provider no sign-in stores under is refused', async () => {
    expect(managedProvider('anthropic')).toBe(true);
    expect(managedProvider('github-copilot')).toBe(true);
    expect(managedProvider('zai')).toBe(true);
    expect(managedProvider('zai-coding-plan')).toBe(false); // an alias: its accounts are zai's
    expect(managedProvider('my-llm')).toBe(false);
    const omp = fakeRpc(
      { 'github-copilot': [{ credentialId: 5, type: 'oauth', label: 'Copilot account' }] },
      [{ id: 'github-copilot', name: 'GitHub Copilot', available: true, authenticated: true }],
    );
    const accounts = accountsOf(omp.bin, omp.dir);
    try {
      const { removed, accounts: left } = await accounts.logout('github-copilot', 5);
      expect(removed).toMatchObject({ provider: 'github-copilot', credentialId: 5 });
      expect(left.some((a) => a.provider === 'github-copilot')).toBe(false);
      expect(omp.commands()).toContain('logout github-copilot');
      await expect(accounts.logout('my-llm', 1)).rejects.toThrow(/doesn’t manage/);
    } finally {
      accounts.shutdown();
    }
  });
});
