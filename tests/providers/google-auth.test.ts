// Sign in with Google in plain words (F1): omp's exact texts (packages/ai/src/registry/oauth/google-gemini-cli.ts) and
// Google's JSON error bodies after a project is set; plus the check of a pasted Gemini API key (F2) against a fake fetch.
import { describe, expect, test } from 'bun:test';
import { checkGeminiKey, explainGoogleLogin, GOOGLE_PROJECT_DOCS, redactSecrets } from '../../server/agents/google-auth.ts';
import { describeLoginFailure } from '../../server/agents/provider-login.ts';

// omp's discoverProject, word for word
const NEEDS_PROJECT =
  'This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. See https://goo.gle/gemini-cli-auth-docs#workspace-gca';
const NO_PROVISION =
  'Could not discover or provision a Google Cloud project. Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. See https://goo.gle/gemini-cli-auth-docs#workspace-gca';

const googleBody = (error: Record<string, unknown>) => JSON.stringify({ error }, null, 2);
const SERVICE_DISABLED = `onboardUser failed: 403 Forbidden: ${googleBody({
  code: 403,
  message: 'Gemini for Google Cloud API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/cloudaicompanion.googleapis.com/overview?project=123456789012 then retry.',
  status: 'PERMISSION_DENIED',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com', metadata: { service: 'cloudaicompanion.googleapis.com', consumer: 'projects/123456789012' } }],
})}`;
const NO_PERMISSION = `loadCodeAssist failed: 403 Forbidden: ${googleBody({ code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' })}`;
const NO_LICENCE = `onboardUser failed: 403 Forbidden: ${googleBody({ code: 403, message: 'User does not have a valid Gemini Code Assist license.', status: 'PERMISSION_DENIED' })}`;

describe('explainGoogleLogin', () => {
  test('the GOOGLE_CLOUD_PROJECT error → ask for a project ID (the fix; its field carries the docs)', () => {
    const e = explainGoogleLogin(NEEDS_PROJECT)!;
    expect(e.fix).toBe('google-project');
    expect(e.message).toContain('needs a Google Cloud project');
    expect(e.link).toBeUndefined();
    expect(explainGoogleLogin(NO_PROVISION)?.fix).toBe('google-project');
  });

  test('API turned off in the project → plain words naming the project the user typed, and the page that turns it on', () => {
    const e = explainGoogleLogin(SERVICE_DISABLED, 'my-project-123')!;
    expect(e.message).toBe('The Gemini for Google Cloud API is turned off in project my-project-123. Turn it on, wait a minute, then try again.');
    expect(e.link).toEqual({ url: 'https://console.cloud.google.com/apis/library/cloudaicompanion.googleapis.com?project=my-project-123', label: 'Turn on the API' });
    expect(e.fix).toBe('google-project');
    // without a typed project: the one Google names
    expect(explainGoogleLogin(SERVICE_DISABLED)!.message).toContain('project 123456789012');
    // the text alone (no JSON) is recognised too
    expect(explainGoogleLogin('Gemini for Google Cloud API has not been used in project foo-bar-1 before or it is disabled.')!.message).toContain('turned off');
  });

  test('no access / no licence', () => {
    const p = explainGoogleLogin(NO_PERMISSION, 'my-project-123')!;
    expect(p.message).toContain('can’t use project my-project-123');
    expect(p.message).toContain('Gemini for Google Cloud User role');
    expect(p.fix).toBe('google-project');
    const l = explainGoogleLogin(NO_LICENCE, 'my-project-123')!;
    expect(l.message).toContain('no Gemini Code Assist licence');
    expect(l.message).toContain('AI Studio API key');
    expect(l.fix).toBeUndefined();
    expect(l.link?.url).toBe(GOOGLE_PROJECT_DOCS); // no project field here: the docs come as a link
  });

  test('verification, slow provisioning, other Google refusals; unknown text → null', () => {
    const v = explainGoogleLogin('Account verification required for <e-mail>. Visit https://accounts.google.com/signin/continue?x=1 to continue, then sign in again.')!;
    expect(v.link?.url).toBe('https://accounts.google.com/signin/continue?x=1');
    expect(explainGoogleLogin('Project provisioning did not complete after 24 attempts')!.message).toContain('still setting up');
    expect(explainGoogleLogin(`loadCodeAssist failed: 400 Bad Request: ${googleBody({ code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' })}`)!.message).toBe(
      'Google refused the sign-in: Request contains an invalid argument.',
    );
    expect(explainGoogleLogin('port 8085 is in use')).toBeNull();
  });
});

describe('describeLoginFailure (what the sign-in panel shows)', () => {
  test('Google: plain words + omp’s whole text (redacted) under Details', () => {
    const f = describeLoginFailure('google-gemini-cli', SERVICE_DISABLED, 'my-project-123');
    expect(f.message).toContain('turned off in project my-project-123');
    expect(f.details).toContain('"reason": "SERVICE_DISABLED"'); // the lines after the first one are kept now
    expect(f.fix).toBe('google-project');
  });

  test('Antigravity finds its own project: no project field for it', () => {
    expect(describeLoginFailure('google-antigravity', NO_PERMISSION).fix).toBeUndefined();
  });

  test('other providers keep their first-line wording; no Details when it says everything', () => {
    const f = describeLoginFailure('anthropic', 'Token exchange failed: invalid_grant');
    expect(f.message).toContain('sign-in code was rejected');
    expect(f.details).toBe('Token exchange failed: invalid_grant');
    expect(describeLoginFailure('deepseek', 'Something odd').details).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  test('e-mails, OAuth tokens, API keys and code= parameters', () => {
    const out = redactSecrets('user a.b@example.com token ya29.a0AfB_x-y Bearer abc.def AIzaSyA1234567890abcdefghijklmnop ?code=4/0Adeu&state=s refresh "refresh_token": "1//0g-secret"');
    expect(out).not.toMatch(/example\.com|ya29\.|abc\.def|AIzaSy|4\/0Adeu|1\/\/0g/);
    expect(out).toContain('state=s');
  });
});

describe('checkGeminiKey', () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const KEY = 'AIzaFakeKeyForCastTests0123456789abcd';

  test('200 and 429 (over its limit, but valid) → ok; the key goes in a header, not the URL', async () => {
    let seen: { url: string; key: string | null } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, key: new Headers(init.headers).get('x-goog-api-key') };
      return new Response('{"models":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await checkGeminiKey(KEY, f)).toEqual({ ok: true });
    expect(seen!.url).not.toContain(KEY);
    expect(seen!.key).toBe(KEY);
    expect(await checkGeminiKey(KEY, reply(429, {}))).toEqual({ ok: true });
  });

  test('Google’s answer for a bad key (as it really looks) → rejected in plain words', async () => {
    const r = await checkGeminiKey(KEY, reply(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } }] } }));
    expect(r).toEqual({ ok: false, rejected: true, message: expect.stringContaining('isn’t valid') });
    const off = await checkGeminiKey(KEY, reply(403, { error: { code: 403, message: 'Generative Language API has not been used…', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }));
    expect(off.ok === false && off.rejected && off.message).toContain('turned off');
    const blocked = await checkGeminiKey(KEY, reply(403, { error: { code: 403, message: 'blocked', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }));
    expect(blocked.ok === false && blocked.rejected && blocked.message).toContain('restrictions');
  });

  test('Google unreachable or failing → not rejected (the caller saves it with a warning)', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await checkGeminiKey(KEY, down)).toEqual({ ok: false, rejected: false, message: 'Couldn’t reach Google' });
    expect(await checkGeminiKey(KEY, reply(503, {}))).toEqual({ ok: false, rejected: false, message: 'Google had a problem (HTTP 503)' });
  });
});
