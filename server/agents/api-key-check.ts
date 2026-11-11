// Is a pasted API key good, before CAST saves it for omp (Models & providers → Paste API key)? One model-list call to
// the vendor: no tokens are used. The key goes only into that request's header; it is never logged or put into a
// message (redactSecrets on whatever text the vendor sends back).
import type { ApiKeyName } from '../../shared/protocol';
import { checkGeminiKey, redactSecrets, type KeyCheck } from './google-auth';

interface Vendor {
  name: string;
  url: string;
  headers(key: string): Record<string, string>;
  /** Where a new key is made (said when the vendor refuses this one). */
  where: string;
}

const VENDORS: Record<Exclude<ApiKeyName, 'GEMINI_API_KEY'>, Vendor> = {
  ANTHROPIC_API_KEY: {
    name: 'Anthropic',
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    where: 'the Claude Console',
  },
  OPENAI_API_KEY: {
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    where: 'the OpenAI dashboard',
  },
};

/** The vendor's error text out of its JSON answer (both use { error: { message } }), if any. */
function errorMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : undefined;
  const m = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  return typeof m === 'string' && m.trim() ? redactSecrets(m.trim()).slice(0, 300) : undefined;
}

async function checkVendorKey(v: Vendor, key: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await fetchImpl(v.url, { headers: v.headers(key), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, rejected: false, message: timedOut ? `${v.name} didn’t answer in time` : `Couldn’t reach ${v.name}` };
  }
  // 429: the key works, it is only over its limit right now.
  if (res.ok || res.status === 429) return { ok: true };
  if (res.status >= 500) return { ok: false, rejected: false, message: `${v.name} had a problem (HTTP ${res.status})` };
  const said = errorMessage(await res.text().catch(() => ''));
  if (res.status === 401) return { ok: false, rejected: true, message: `${v.name} says that key isn’t valid. Copy it again from ${v.where} (the whole key) and paste it here.` };
  if (res.status === 403) return { ok: false, rejected: true, message: `${v.name} accepted the key but won’t let it list models${said ? `: ${said}` : '.'} Check the key’s permissions in ${v.where}.` };
  return { ok: false, rejected: true, message: `${v.name} refused that key (HTTP ${res.status}${said ? `: ${said}` : ''}).` };
}

/** Ask the key's vendor whether it works. */
export function checkApiKey(name: ApiKeyName, key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<KeyCheck> {
  if (name === 'GEMINI_API_KEY') return checkGeminiKey(key, fetchImpl, timeoutMs);
  return checkVendorKey(VENDORS[name], key, fetchImpl, timeoutMs);
}
