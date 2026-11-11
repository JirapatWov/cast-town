// Google in plain words: why "Sign in with Google" failed and how to fix it, and a check of a pasted Gemini API key.
//
// The sign-in texts come from omp (packages/ai/src/registry/oauth/google-gemini-cli.ts, discoverProject): a Workspace
// or standard-tier account needs GOOGLE_CLOUD_PROJECT ("This account requires setting the GOOGLE_CLOUD_PROJECT or
// GOOGLE_CLOUD_PROJECT_ID environment variable…"), and with a project set Google's own error comes back inside
// "loadCodeAssist failed: 403 Forbidden: {json}" / "onboardUser failed: …" — the API is off in that project, the
// account has no access or no Gemini Code Assist licence.
import type { LoginState } from '../../shared/protocol';

export const GOOGLE_PROJECT_DOCS = 'https://goo.gle/gemini-cli-auth-docs#workspace-gca';
export const GEMINI_KEY_PAGE = 'https://aistudio.google.com/apikey';
const CODE_ASSIST_SERVICE = 'cloudaicompanion.googleapis.com';

/** `fix: 'google-project'`: the app shows its project field, which carries the setup docs itself (so `link` is only
 *  set when it points somewhere else, like the page that turns the API on). */
export type LoginExplanation = Pick<LoginState, 'message' | 'fix' | 'link'>;

/** Tokens, keys and e-mail addresses out of a text that is logged or shown under "Details". */
export function redactSecrets(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<e-mail>')
    .replace(/\bya29\.[\w.-]+/g, '<token>')
    .replace(/\b1\/\/[\w.-]{20,}/g, '<token>')
    .replace(/\bAIza[\w-]{20,}/g, '<key>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '<key>') // Anthropic, OpenAI, DeepSeek, OpenRouter keys and OAuth tokens
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '<token>') // JWTs (OpenAI id/access tokens)
    .replace(/\b(Bearer)\s+[\w.~+/-]+=*/gi, '$1 <token>')
    .replace(/\b(access_token|refresh_token|id_token|code|client_secret)=[^&\s"']+/gi, '$1=<redacted>')
    .replace(/"(access_token|refresh_token|id_token|client_secret)"\s*:\s*"[^"]*"/gi, '"$1": "<redacted>"');
}

interface GoogleError {
  message?: string;
  status?: string;
  code?: number;
  reasons: string[];
  service?: string;
  consumer?: string; // "projects/123456"
}

/** Google's JSON error body inside an omp message ("onboardUser failed: 403 Forbidden: { … }"). */
export function parseGoogleError(text: string): GoogleError | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  let body: unknown;
  try {
    body = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const e = (body as { error?: unknown })?.error;
  if (!e || typeof e !== 'object') return null;
  const err = e as { message?: unknown; status?: unknown; code?: unknown; details?: unknown };
  const details = Array.isArray(err.details) ? (err.details as { reason?: unknown; metadata?: Record<string, unknown> }[]) : [];
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    message: str(err.message),
    status: str(err.status),
    code: typeof err.code === 'number' ? err.code : undefined,
    reasons: details.map((d) => str(d?.reason)).filter((r): r is string => !!r),
    service: details.map((d) => str(d?.metadata?.service)).find(Boolean),
    consumer: details.map((d) => str(d?.metadata?.consumer)).find(Boolean),
  };
}

const apiPage = (service: string, project: string) =>
  `https://console.cloud.google.com/apis/library/${encodeURIComponent(service)}?project=${encodeURIComponent(project)}`;

/** Why a Google sign-in failed, in plain words with the fix — or null when the text isn't one CAST knows.
 *  `project`: the Cloud project the attempt ran with (GOOGLE_CLOUD_PROJECT), when one was set. */
export function explainGoogleLogin(raw: string, project?: string): LoginExplanation | null {
  const text = raw.trim();
  if (/requires setting the GOOGLE_CLOUD_PROJECT/i.test(text)) {
    return { message: 'This Google account needs a Google Cloud project to sign in. Enter the project’s ID and try again.', fix: 'google-project' };
  }
  if (/Could not discover or provision a Google Cloud project/i.test(text)) {
    return { message: 'Google couldn’t set up a Cloud project for this account. Enter the ID of a Google Cloud project to use and try again.', fix: 'google-project' };
  }
  if (/Project provisioning did not complete/i.test(text)) {
    return { message: 'Google is still setting up a Cloud project for this account. Wait a minute, then try again.' };
  }
  const verify = /Account verification required.*?Visit (https:\/\/\S+?) to continue/i.exec(text);
  if (verify) {
    return { message: 'Google wants to verify this account first. Open the verification page, finish it, then sign in again.', link: { url: verify[1]!, label: 'Verify the account' } };
  }

  const g = parseGoogleError(text);
  const words = `${g?.message ?? ''} ${text}`;
  const named = /\bproject[s]?[ /:]+([a-z0-9][a-z0-9:.-]*[a-z0-9])\b/i.exec(g?.message ?? '')?.[1];
  // The ID the user typed reads better than the project number Google reports (projects/123456).
  const where = project ?? g?.consumer?.replace(/^projects\//, '') ?? named;
  const inProject = where ? `project ${where}` : 'your project';

  if (g?.reasons.includes('SERVICE_DISABLED') || /has not been used in project \S+ before or it is disabled/i.test(words)) {
    const service = g?.service ?? CODE_ASSIST_SERVICE;
    const api = service === CODE_ASSIST_SERVICE ? 'Gemini for Google Cloud API' : `${service} API`;
    return {
      message: `The ${api} is turned off in ${inProject}. Turn it on, wait a minute, then try again.`,
      fix: 'google-project',
      ...(where ? { link: { url: apiPage(service, where), label: 'Turn on the API' } } : {}),
    };
  }
  if (/licen[cs]e/i.test(words)) {
    return {
      message: 'This Google account has no Gemini Code Assist licence. Work and school accounts get one from their Google Workspace admin. Or use an AI Studio API key instead (Paste API key).',
      link: { url: GOOGLE_PROJECT_DOCS, label: 'About Gemini Code Assist licences' },
    };
  }
  if (g?.status === 'PERMISSION_DENIED' || g?.reasons.includes('IAM_PERMISSION_DENIED') || /caller does not have permission|permission denied/i.test(words)) {
    return {
      message: `This Google account can’t use ${inProject}. It needs the Gemini for Google Cloud User role there (or Owner/Editor), and work accounts also need a Gemini Code Assist licence. Check the project ID, or pick another project.`,
      fix: 'google-project',
    };
  }
  if (g?.message && /^(loadCodeAssist|onboardUser) failed/i.test(text)) {
    return { message: `Google refused the sign-in: ${redactSecrets(g.message)}` };
  }
  return null;
}

export type KeyCheck =
  | { ok: true }
  /** Google answered and refused the key: not saved. */
  | { ok: false; rejected: true; message: string }
  /** Google couldn't be asked (offline, timeout, an outage): the caller may save the key anyway. */
  | { ok: false; rejected: false; message: string };

/** Ask Google whether a Gemini API key works (one model-list call; no tokens are used). */
export async function checkGeminiKey(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, rejected: false, message: timedOut ? 'Google didn’t answer in time' : 'Couldn’t reach Google' };
  }
  // 429: the key works, it is only over its limit right now.
  if (res.ok || res.status === 429) return { ok: true };
  if (res.status >= 500) return { ok: false, rejected: false, message: `Google had a problem (HTTP ${res.status})` };
  const g = parseGoogleError(await res.text().catch(() => ''));
  const reasons = g?.reasons ?? [];
  if (reasons.includes('API_KEY_INVALID') || /API key not valid/i.test(g?.message ?? '')) {
    return { ok: false, rejected: true, message: 'Google says that key isn’t valid. Copy it again from Google AI Studio (the whole key) and paste it here.' };
  }
  if (reasons.includes('SERVICE_DISABLED')) {
    return { ok: false, rejected: true, message: 'That key belongs to a Google Cloud project where the Gemini API (Generative Language API) is turned off. Turn it on there, or create a key in Google AI Studio.' };
  }
  if (reasons.includes('API_KEY_SERVICE_BLOCKED') || reasons.includes('API_KEY_HTTP_REFERRER_BLOCKED') || reasons.includes('API_KEY_IP_ADDRESS_BLOCKED')) {
    return { ok: false, rejected: true, message: 'That key’s restrictions don’t allow the Gemini API from this server. Loosen them in the Google Cloud console, or create a new key in Google AI Studio.' };
  }
  return { ok: false, rejected: true, message: `Google refused that key (HTTP ${res.status}${g?.message ? `: ${redactSecrets(g.message)}` : ''}).` };
}
