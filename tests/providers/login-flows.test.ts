// Every kind of sign-in omp's menu has, relayed by ProviderLogin from a fake `omp login` that prints what omp's own
// flows print (packages/ai/src/registry/oauth/*.ts, engine/*.ts; the terminal writes prompts as "<message> (<placeholder>): "
// and status lines ending in "..."):
//   - a provider omp doesn't offer never starts omp at all;
//   - several prompts in a row (Cloudflare AI Gateway: token, account ID, gateway ID) — the second is no "retry";
//   - a prompt before any page that may be left empty (GitHub Copilot's Enterprise domain), then a device code;
//   - a choice before the key page (Alibaba: "1=International (default)") — after it the page shows, then the key;
//   - the redirect address asked again (no code in it) says so;
//   - Claude's sign-in runs with its redirect on Claude's code page: the code is what's pasted, and a retry says "code";
//   - a sign-in that runs out of time (CAST's deadline, or omp's own wait) says so and carries the time left until then;
//   - "Enter code: ABCD" split across two writes is not taken for a prompt.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CODE_PAGE, ProviderLogin, TIMED_OUT } from '../../server/agents/provider-login.ts';
import type { LoginState } from '../../shared/protocol.ts';

const root = mkdtempSync(join(tmpdir(), 'cast-test-flows-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fake omp whose `login <provider>` runs `body` (bash). */
function fakeOmp(body: string): string {
  const bin = join(root, `omp-${++n}.sh`);
  writeFileSync(bin, `#!/bin/bash\n[ "$1" = "login" ] || exit 3\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function world(body: string, promptSettleMs?: number, env: Record<string, string> = {}) {
  const states: LoginState[] = [];
  const login = new ProviderLogin({ ompBin: fakeOmp(body), env: { HOME: root, PATH: process.env.PATH, ...env }, emit: (s) => states.push({ ...s }), onConnected: async () => {}, promptSettleMs });
  const until = async (f: () => boolean, what: string) => {
    const t0 = Date.now();
    while (!f()) {
      if (Date.now() - t0 > 5000) throw new Error(`timeout: ${what} — got ${JSON.stringify(states.at(-1))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  /** The next state that waits for an answer to a prompt matching `re`. */
  const prompt = async (re: RegExp) => {
    await until(() => states.some((s) => s.phase === 'waiting' && re.test(s.prompt ?? '')), `prompt ${re}`);
    return states.find((s) => s.phase === 'waiting' && re.test(s.prompt ?? ''))!;
  };
  const end = async () => {
    await until(() => states.some((s) => s.phase === 'done' || s.phase === 'failed'), 'the end');
    return states.find((s) => s.phase === 'done' || s.phase === 'failed')!;
  };
  return { states, login, until, prompt, end };
}

describe('sign-in flows of omp’s menu', () => {
  test('a provider omp doesn’t offer: failed at once, omp never runs', async () => {
    const marker = join(root, 'ran');
    const w = world(`touch ${marker}`);
    w.login.start('not-a-provider');
    expect(w.states).toHaveLength(1);
    expect(w.states[0]).toMatchObject({ provider: 'not-a-provider', phase: 'failed' });
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(marker)).toBe(false);
    expect(w.login.active).toBe(false);
  });

  test('three prompts in a row (Cloudflare AI Gateway): masked key, then two plain fields, none called a retry', async () => {
    const w = world(`
echo ""
echo "Open this URL in your browser:"
echo "https://developers.cloudflare.com/ai-gateway/configuration/authentication/"
echo "Create an AI Gateway token with Run permission, then copy it here."
echo ""
printf "Paste your Cloudflare AI Gateway token/API key (cfut_...): "; read -r key
printf "Enter your Cloudflare account ID (32-character account ID): "; read -r acct
printf "Enter your Cloudflare AI Gateway ID (default): "; read -r gw
[ -n "$key" ] && [ "$acct" = "acc123" ] && [ "$gw" = "gw1" ] || { echo "Login failed: bad answers" >&2; exit 1; }
echo ""
echo "Logged in to Cloudflare AI Gateway"`);
    w.login.start('cloudflare-ai-gateway');
    const key = await w.prompt(/token\/API key/);
    expect(key).toMatchObject({ secret: true, url: 'https://developers.cloudflare.com/ai-gateway/configuration/authentication/' });
    expect(key.message).toBeUndefined();
    expect(w.login.input(key.loginId, 'cfut_secret')).toBe(true);
    const acct = await w.prompt(/account ID/);
    expect(acct.secret).toBe(false);
    expect(acct.message).toBeUndefined(); // a new question, not "that didn't match"
    expect(acct.allowEmpty).toBeUndefined();
    w.login.input(acct.loginId, 'acc123');
    const gw = await w.prompt(/Gateway ID/);
    expect(gw.message).toBeUndefined();
    w.login.input(gw.loginId, 'gw1');
    expect(await w.end()).toMatchObject({ phase: 'done', message: 'Logged in to Cloudflare AI Gateway' });
  });

  test('a question before any page that may be blank (GitHub Copilot), then a device code to enter', async () => {
    const w = world(`
printf "GitHub Enterprise URL/domain (blank for github.com) (company.ghe.com): "; read -r domain
[ -z "$domain" ] || { echo "Login failed: expected blank" >&2; exit 1; }
echo ""
echo "Open this URL in your browser:"
echo "https://github.com/login/device"
echo "Enter code: ABCD-1234"
echo ""
echo "Waiting for device authorization..."
read -r never_answered
echo "Logged in to GitHub Copilot"`);
    w.login.start('github-copilot');
    const q = await w.prompt(/Enterprise/);
    expect(q).toMatchObject({ allowEmpty: true, secret: false });
    expect(q.url).toBeUndefined();
    expect(w.login.input(q.loginId, '')).toBe(true); // an empty answer goes to omp
    await w.until(() => w.states.some((s) => s.userCode === 'ABCD-1234' && s.phase === 'waiting'), 'the device code');
    const page = w.states.find((s) => s.userCode)!;
    expect(page).toMatchObject({ url: 'https://github.com/login/device', phase: 'waiting', instructions: 'Enter code: ABCD-1234' });
    expect(page.prompt).toBeUndefined();
    await w.until(() => w.states.some((s) => s.progress === 'Waiting for device authorization...'), 'the status line');
    w.login.cancel(q.loginId);
    expect(w.states.at(-1)).toMatchObject({ phase: 'cancelled' });
    expect(w.states.at(-1)!.progress).toBeUndefined();
  });

  test('a choice with a default before the key page (Alibaba): blank is fine, then the page, then the key', async () => {
    const w = world(`
printf "Select Alibaba Coding Plan endpoint: 1=International (default), 2=China, 3=Custom — enter 1, 2, or 3 (1): "; read -r choice
echo ""
echo "Open this URL in your browser:"
echo "https://modelstudio.console.alibabacloud.com/"
echo "Copy your API key from the Alibaba Cloud DashScope console (International)"
echo ""
printf "Paste your Alibaba Coding Plan API key (sk-...): "; read -r key
echo "Validating API key..."
echo "Logged in to Alibaba Coding Plan"`);
    w.login.start('alibaba-coding-plan');
    const choice = await w.prompt(/endpoint/);
    expect(choice.allowEmpty).toBe(true);
    w.login.input(choice.loginId, '');
    // the page after the answer: waiting for the user (not stuck on "checking")
    await w.until(() => w.states.some((s) => s.phase === 'waiting' && !!s.url && !s.prompt), 'the key page');
    const key = await w.prompt(/API key/);
    expect(key).toMatchObject({ secret: true, url: 'https://modelstudio.console.alibabacloud.com/' });
    expect(key.message).toBeUndefined();
    w.login.input(key.loginId, 'sk-x');
    expect((await w.end()).phase).toBe('done');
    expect(w.states.some((s) => s.phase === 'verifying' && s.progress === 'Validating API key...')).toBe(true);
  });

  test('the redirect address asked again (no code in it): said so; the first time: not', async () => {
    const w = world(`
echo "Open this URL in your browser:"
echo "https://claude.ai/oauth/authorize?x=1"
echo ""
echo "Waiting for browser authentication..."
printf "Paste the authorization code (or full redirect URL): "; read -r a
printf "Paste the authorization code (or full redirect URL): "; read -r b
echo "Logged in to Anthropic (Claude Pro/Max)"`);
    w.login.start('anthropic');
    const first = await w.prompt(/authorization code/);
    expect(first.message).toBeUndefined();
    expect(first.progress).toBeUndefined(); // the prompt replaces the status line
    w.login.input(first.loginId, 'nonsense');
    await w.until(() => w.states.filter((s) => s.phase === 'waiting' && !!s.prompt).length === 2, 'the second prompt');
    const again = w.states.filter((s) => s.phase === 'waiting' && !!s.prompt)[1]!;
    expect(again.message).toMatch(/didn’t match/);
    w.login.input(again.loginId, 'http://localhost:54545/callback?code=c&state=s');
    expect((await w.end()).phase).toBe('done');
  });

  test('Claude: the page sends the browser to Claude’s code page; the pasted code#state reaches omp, a wrong one is called a code', async () => {
    const w = world(`
echo "Open this URL in your browser:"
echo "https://claude.ai/oauth/authorize?code=true&redirect_uri=$ANTHROPIC_OAUTH_REDIRECT_URI&state=st"
echo ""
printf "Paste the authorization code (or full redirect URL): "; read -r a
printf "Paste the authorization code (or full redirect URL): "; read -r b
[ "$b" = "abc#st" ] || { echo "Login failed: got $b" >&2; exit 1; }
echo "Logged in to Anthropic (Claude Pro/Max)"`);
    w.login.start('anthropic');
    const first = await w.prompt(/authorization code/);
    expect(new URL(first.url!).searchParams.get('redirect_uri')).toBe(CLAUDE_CODE_PAGE);
    expect(first.pasteCode).toBe(true);
    w.login.input(first.loginId, 'wrong');
    await w.until(() => w.states.filter((s) => s.phase === 'waiting' && !!s.prompt).length === 2, 'the second prompt');
    const again = w.states.filter((s) => s.phase === 'waiting' && !!s.prompt)[1]!;
    expect(again.message).toMatch(/code didn’t match/);
    w.login.input(again.loginId, ' abc#st ');
    expect((await w.end()).phase).toBe('done');
  });

  test('CAST’s deadline: running states count down to it, then the sign-in fails as timed out and omp is stopped', async () => {
    const marker = join(root, 'omp-pid');
    const w = world(
      `
echo "$$ $PI_OAUTH_CALLBACK_TIMEOUT_MS" > ${marker}
echo "Open this URL in your browser:"
echo "https://claude.ai/oauth/authorize?x=1"
echo ""
sleep 30`,
      undefined,
      { CAST_LOGIN_TIMEOUT: '0.4' },
    );
    w.login.start('anthropic');
    const end = await w.end();
    expect(end).toMatchObject({ phase: 'failed', timedOut: true, message: TIMED_OUT });
    expect(end.timeLeftMs).toBeUndefined();
    const running = w.states.filter((s) => s.phase !== 'failed');
    expect(running.length).toBeGreaterThan(0);
    expect(running.every((s) => s.timeLeftMs! >= 0 && s.timeLeftMs! <= 400)).toBe(true);
    const [pid, ompWait] = (await Bun.file(marker).text()).trim().split(' ').map(Number);
    // omp's own wait for the browser outlasts CAST's deadline, so CAST's is the one the page counted down to
    expect(ompWait).toBeGreaterThan(400);
    const alive = () => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    await w.until(() => !alive(), 'omp stopped');
  });

  test('omp giving up on the browser itself reads as timed out too, not as cancelled', async () => {
    const w = world(`echo "Login failed: OAuth callback cancelled: TimeoutError" >&2; exit 1`);
    w.login.start('anthropic');
    expect(await w.end()).toMatchObject({ phase: 'failed', timedOut: true, message: TIMED_OUT });
  });

  test('"Enter code: ABCD" written in two pieces is the instructions, not a prompt', async () => {
    // the gap between the two writes is the fake's `sleep 0.02`, which a busy machine can stretch past the 60 ms
    // default; a long settle time keeps this about the split, not about how fast this machine is
    const w = world(
      `
echo "Open this URL in your browser:"
echo "https://auth.kimi.com/device"
printf "Enter code:"
sleep 0.02
echo " WXYZ-9876"
echo ""
read -r never_answered`,
      2000,
    );
    w.login.start('kimi-code');
    await w.until(() => w.states.some((s) => s.phase === 'waiting' && !!s.userCode), 'the code');
    await new Promise((r) => setTimeout(r, 120));
    expect(w.states.some((s) => !!s.prompt)).toBe(false);
    expect(w.states.find((s) => s.userCode)!.userCode).toBe('WXYZ-9876');
    w.login.shutdown();
  });
});
