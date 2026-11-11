// F3 for every provider: what `omp login <provider>` prints after "Login failed:" (texts built exactly as omp builds
// them — packages/ai/src/registry/engine/common.ts, oauth/openai-codex.ts, oauth/callback-server.ts, oauth/kilo.ts,
// oauth/github-copilot.ts, api-key-validation.ts, error/auth.ts — and the fetch errors Bun and Node give) in plain
// words, with omp's whole text redacted under Details; and a sign-in through a fake omp whose failure spans lines.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainAuthError, explainLoginFailure, providerName } from '../../server/agents/login-failure.ts';
import { describeLoginFailure, ProviderLogin } from '../../server/agents/provider-login.ts';
import type { LoginState } from '../../shared/protocol.ts';

const root = mkdtempSync(join(tmpdir(), 'cast-test-loginfail-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// ── recorded texts (omp's formats, fake values) ──
const ANTHROPIC_CODE = `anthropic token exchange failed: 400 {"error":"invalid_grant","error_description":"Invalid 'code' in request."}`;
const CODEX_CODE = 'Token exchange failed: 400 invalid_grant: Authorization code is invalid or has expired';
const ANTHROPIC_REFRESH = `OAuth token refresh failed for provider anthropic: anthropic token refresh failed: 400 {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}`;
const CODEX_REFRESH = 'oauth refresh failed: Error: openai-codex token refresh failed: 401 {"error":{"message":"Your refresh token has already been used","code":"refresh_token_reused"}}';
const DEEPSEEK_401 = 'deepseek API key validation failed (401): {"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid","type":"authentication_error","code":"invalid_request_error"}}';
const DEEPSEEK_402 = 'deepseek API key validation failed (402): {"error":{"message":"Insufficient Balance","type":"unknown_error"}}';
const OPENROUTER_403 = 'openrouter API key validation failed (403): {"error":{"message":"Key disabled sk-or-v1-0123456789abcdef0123456789abcdef","code":403}}';
const BUN_OFFLINE = 'anthropic request to https://console.anthropic.com/v1/oauth/token failed: Unable to connect. Is the computer able to access the url? (cause: ConnectionRefused)';
const NODE_DNS = 'openai-codex request to https://auth.openai.com/oauth/token failed: fetch failed (cause: getaddrinfo ENOTFOUND auth.openai.com)';
const TIMEOUT = 'Timed out waiting for https://console.anthropic.com/v1/oauth/token';
const TLS = 'anthropic request to https://console.anthropic.com/v1/oauth/token failed: unable to verify the first certificate (cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE)';
const PORT = 'OAuth callback port 1455 is in use. The OAuth provider validates redirect URIs against its registered callback, so falling back to a random port would be rejected. Free port 1455 (e.g. stop the process bound to it) and retry, or set oauth.callbackPort/oauth.redirectUri to a port the provider has registered.';
const DENIED = 'Authorization failed: The user denied the request';
const DEVICE_TIMEOUT = 'Device authorization timed out — user did not complete login in time';
const CLOCK = 'Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.';
const KILO_EXPIRED = 'Authorization code expired. Please try again.';
const UNKNOWN = "Unknown OAuth provider 'acme'. Run `omp login` to pick one.";
const EMPTY_KEY = 'API key is required';
const RATE = 'anthropic token exchange failed: 429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}';

describe('explainLoginFailure: the common cases of every provider', () => {
  const cases: [string, string, RegExp][] = [
    ['anthropic', ANTHROPIC_CODE, /^The sign-in code was rejected — it expired or was already used/],
    ['openai-codex', CODEX_CODE, /^The sign-in code was rejected/],
    ['anthropic', ANTHROPIC_REFRESH, /^This Anthropic sign-in expired — sign in again\.$/],
    ['openai-codex', CODEX_REFRESH, /^This ChatGPT sign-in expired — sign in again\.$/],
    ['deepseek', DEEPSEEK_401, /^DeepSeek refused that key \(HTTP 401\)/],
    ['deepseek', DEEPSEEK_402, /no credit left/],
    ['openrouter', OPENROUTER_403, /^OpenRouter refused that key \(HTTP 403\)/],
    ['anthropic', BUN_OFFLINE, /^This server couldn’t reach console\.anthropic\.com\. Check its internet connection/],
    ['openai-codex', NODE_DNS, /^This server couldn’t reach auth\.openai\.com/],
    ['anthropic', TIMEOUT, /couldn’t reach console\.anthropic\.com/],
    ['anthropic', TLS, /certificate check/],
    ['openai-codex', PORT, /^Another sign-in is still running on this machine \(port 1455 is taken\)/],
    ['anthropic', DENIED, /^The sign-in was declined on Anthropic’s page/],
    ['openai-codex-device', DEVICE_TIMEOUT, /^The ChatGPT sign-in code expired before it was approved/],
    ['github-copilot', CLOCK, /clock may be off/],
    ['kilo', KILO_EXPIRED, /^The Kilo Gateway sign-in code expired/],
    ['acme', UNKNOWN, /^The agent \(cast-agent\) has no Acme sign-in in this version\. Update CAST/],
    ['deepseek', EMPTY_KEY, /^The key was empty/],
    ['anthropic', RATE, /limiting sign-ins right now/],
  ];
  for (const [provider, text, want] of cases) {
    test(`${provider}: ${text.slice(0, 60)}`, () => {
      expect(explainLoginFailure(provider, text) ?? '').toMatch(want);
    });
  }

  test('an unknown text stays omp’s own (null here)', () => {
    expect(explainLoginFailure('anthropic', 'Something odd happened')).toBeNull();
  });

  test('provider names', () => {
    expect(providerName('openai-codex')).toBe('ChatGPT');
    expect(providerName('google-antigravity')).toBe('Antigravity');
    expect(providerName('my-proxy')).toBe('My proxy');
    expect(providerName('github-copilot')).toBe('GitHub Copilot'); // omp's sign-in menu names the rest
    expect(providerName('cerebras')).toBe('Cerebras');
  });
});

describe('describeLoginFailure: plain words + the whole reason, redacted, under Details', () => {
  test('a refused key: the key, the e-mail and the token never reach the panel', () => {
    const f = describeLoginFailure('openrouter', `${OPENROUTER_403}\n  for someone@example.com, Bearer abc.def`);
    expect(f.message).toMatch(/^OpenRouter refused that key/);
    expect(f.details).toContain('API key validation failed (403)');
    expect(f.details).not.toMatch(/sk-or-v1-0123|example\.com|abc\.def/);
  });

  test('Google still gets its own words first, the generic ones only when Google’s don’t apply', () => {
    expect(describeLoginFailure('google-antigravity', PORT).message).toMatch(/^Another sign-in is still running/);
    expect(describeLoginFailure('google-gemini-cli', NODE_DNS).message).toMatch(/couldn’t reach auth\.openai\.com/);
  });
});

describe('explainAuthError: a chat turn that fails on the sign-in or the key', () => {
  test('expired sign-in and refused key → where to fix it; anything else → null', () => {
    expect(explainAuthError(ANTHROPIC_REFRESH)).toBe('The Anthropic sign-in expired — sign in again under Models & providers, then send the message again.');
    expect(explainAuthError('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toMatch(/^The key was refused/);
    expect(explainAuthError('529 Overloaded')).toBeNull();
    expect(explainAuthError(BUN_OFFLINE)).toBeNull();
  });
});

describe('a sign-in through a fake omp whose failure spans lines (F3)', () => {
  function fakeOmp(stderr: string, code: number): string {
    const bin = join(root, `omp-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(bin, `#!/bin/bash\n[ "$1" = login ] || exit 3\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit ${code}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }
  async function run(bin: string, provider: string): Promise<LoginState> {
    const states: LoginState[] = [];
    const login = new ProviderLogin({ ompBin: bin, env: { HOME: root, PATH: process.env.PATH }, emit: (s) => states.push(s), onConnected: async () => {} });
    login.start(provider);
    const t0 = Date.now();
    while (!states.some((s) => s.phase === 'failed' || s.phase === 'done')) {
      if (Date.now() - t0 > 5000) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
    login.shutdown();
    return states.find((s) => s.phase === 'failed' || s.phase === 'done')!;
  }

  test('ChatGPT: the second line (omp’s JSON) is kept under Details; the message is plain', async () => {
    const end = await run(fakeOmp(`Login failed: Token exchange failed: 400 invalid_grant:\n{"error":"invalid_grant","error_description":"Code expired","id_token":"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl"}`, 1), 'openai-codex');
    expect(end.phase).toBe('failed');
    expect(end.message).toMatch(/^The sign-in code was rejected/);
    expect(end.details).toContain('"error_description":"Code expired"');
    expect(end.details).not.toContain('eyJhbGci');
  });

  test('omp dying without "Login failed:" says so, with its last lines as Details', async () => {
    const end = await run(fakeOmp('panic: something broke\n  at frame 1', 2), 'anthropic');
    expect(end.phase).toBe('failed');
    expect(end.message).toBe('cast-agent login stopped with exit code 2 before the sign-in finished. Try again.');
    expect(end.details).toContain('panic: something broke');
  });

  test('…but lines CAST knows get its plain words: the callback server dying on a taken port', async () => {
    const crash = 'Error: listen EADDRINUSE: address already in use 127.0.0.1:1455\n    at Server.setupListenHandle [as _listen2] (node:net:1937:16)';
    const end = await run(fakeOmp(crash, 1), 'openai-codex');
    expect(end.message).toMatch(/^Another sign-in is still running on this machine \(port 1455 is taken\)/);
    expect(end.details).toContain('EADDRINUSE');
  });
});
