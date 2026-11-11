// F1 end to end on the server side: "Sign in with Google" through a fake `omp login google-gemini-cli` that behaves like
// omp's discoverProject — without GOOGLE_CLOUD_PROJECT it fails with omp's exact text (→ the app asks for a project),
// with one saved in config.json ompEnv the next sign-in runs with it, and Google's multi-line refusal for a project
// with the API turned off comes out in plain words with the raw text under Details.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OmpEnv } from '../../server/agents/omp-env.ts';
import { ProviderLogin } from '../../server/agents/provider-login.ts';
import type { LoginState } from '../../shared/protocol.ts';

const root = mkdtempSync(join(tmpdir(), 'cast-test-login-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NEEDS_PROJECT =
  'This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. See https://goo.gle/gemini-cli-auth-docs#workspace-gca';

/** Prints omp's sign-in steps, waits for the pasted address, then answers by GOOGLE_CLOUD_PROJECT. */
function fakeOmp(): string {
  const bin = join(root, 'omp-login.sh');
  writeFileSync(
    bin,
    `#!/bin/bash
[ "$1" = "login" ] || exit 3
echo "Open this URL in your browser:"
echo "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake"
echo "Complete the sign-in in your browser."
echo ""
printf "Paste the redirect URL: "
read -r answer
if [ -z "$GOOGLE_CLOUD_PROJECT" ]; then echo "Login failed: ${NEEDS_PROJECT}" >&2; exit 1; fi
if [ "$GOOGLE_CLOUD_PROJECT" = "api-off-project" ]; then
  printf 'Login failed: onboardUser failed: 403 Forbidden: {\\n  "error": {\\n    "code": 403,\\n    "message": "Gemini for Google Cloud API has not been used in project 555 before or it is disabled.",\\n    "status": "PERMISSION_DENIED",\\n    "details": [{"reason": "SERVICE_DISABLED", "metadata": {"service": "cloudaicompanion.googleapis.com", "consumer": "projects/555"}}]\\n  }\\n}\\n' >&2
  exit 1
fi
echo ""
echo "Logged in to Google Cloud Code Assist (Gemini CLI) as someone"
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function world() {
  const env: Record<string, string | undefined> = { HOME: root, PATH: process.env.PATH };
  const ompEnv = new OmpEnv({ configFile: join(mkdtempSync(join(root, 'data-')), 'config.json'), env }).load();
  const states: LoginState[] = [];
  const connected: string[] = [];
  const login = new ProviderLogin({
    ompBin: fakeOmp(),
    env,
    emit: (s) => states.push(s),
    onConnected: async (p) => void connected.push(p),
  });
  const until = async (f: () => boolean, what: string) => {
    const t0 = Date.now();
    while (!f()) {
      if (Date.now() - t0 > 5000) throw new Error(`timeout: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  /** One sign-in: start, paste an address when asked, wait for the end. */
  const run = async (): Promise<LoginState> => {
    const from = states.length;
    login.start('google-gemini-cli');
    await until(() => states.slice(from).some((s) => s.phase === 'waiting' && !!s.prompt), 'the paste prompt');
    const waiting = states.slice(from).find((s) => s.prompt)!;
    expect(waiting.url).toContain('accounts.google.com');
    expect(login.input(waiting.loginId, 'http://localhost:8085/oauth2callback?code=x&state=y')).toBe(true);
    await until(() => states.slice(from).some((s) => s.phase === 'done' || s.phase === 'failed'), 'the end of the sign-in');
    return states.slice(from).find((s) => s.phase === 'done' || s.phase === 'failed')!;
  };
  return { env, ompEnv, login, states, connected, run };
}

describe('Sign in with Google that needs a Cloud project (F1)', () => {
  test('omp’s project error → failed with the project fix; saved project → the retry runs with it and signs in', async () => {
    const w = world();
    const first = await w.run();
    expect(first.phase).toBe('failed');
    expect(first.fix).toBe('google-project');
    expect(first.project).toBeUndefined();
    expect(first.message).toContain('needs a Google Cloud project');
    expect(first.details).toContain('requires setting the GOOGLE_CLOUD_PROJECT'); // omp's words stay behind Details

    // what the app does with the field: set_omp_env → config.json → the env object every omp copies
    w.ompEnv.set({ GOOGLE_CLOUD_PROJECT: 'my-project-123' });
    const second = await w.run();
    expect(second.project).toBe('my-project-123');
    expect(second.phase).toBe('done');
    expect(second.message).toContain('Logged in to Google Cloud Code Assist');
    expect(w.connected).toEqual(['google-gemini-cli']);
    w.login.shutdown();
  });

  test('the next refusal (API off in that project) in plain words, with the page to turn it on and Details', async () => {
    const w = world();
    w.ompEnv.set({ GOOGLE_CLOUD_PROJECT: 'api-off-project' });
    const end = await w.run();
    expect(end.phase).toBe('failed');
    expect(end.message).toBe('The Gemini for Google Cloud API is turned off in project api-off-project. Turn it on, wait a minute, then try again.');
    expect(end.link?.url).toBe('https://console.cloud.google.com/apis/library/cloudaicompanion.googleapis.com?project=api-off-project');
    expect(end.fix).toBe('google-project'); // another project can be tried from the same panel
    expect(end.details).toContain('SERVICE_DISABLED'); // not cut at "403 Forbidden: {" any more
    w.login.shutdown();
  });
});
