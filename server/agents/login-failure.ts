// Why a sign-in (or a stored sign-in) failed, in plain words, for every provider — the cases found in omp's own texts
// (agent/packages/ai/src/registry: engine/common.ts token requests, oauth/*.ts device and callback flows,
// api-key-validation.ts, error/auth.ts) and in the network errors Bun / Node give for a failed fetch.
// Google's own refusals (a JSON body naming the Cloud project) are google-auth.ts; this file covers the rest and is the
// fallback for Google too. The caller keeps omp's whole text, redacted, under "Details".
import { loginLabel } from '../../shared/omp-logins';
import { redactSecrets } from './google-auth';

/** How CAST names an omp login provider in a sentence. */
const PROVIDER_NAME: Record<string, string> = {
  anthropic: 'Anthropic',
  'openai-codex': 'ChatGPT',
  'openai-codex-device': 'ChatGPT',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  google: 'Google',
  'google-gemini-cli': 'Google',
  'google-antigravity': 'Antigravity',
  'google-vertex': 'Vertex AI',
  'github-copilot': 'GitHub Copilot',
  xai: 'xAI',
  mistral: 'Mistral',
  kimi: 'Kimi',
  zai: 'Z.ai',
};

export function providerName(provider: string): string {
  const known = PROVIDER_NAME[provider] ?? loginLabel(provider); // omp's sign-in menu names the rest ("Cerebras")
  if (known) return known;
  const base = provider.replace(/[-_]+/g, ' ').trim();
  return base ? base[0]!.toUpperCase() + base.slice(1) : 'the provider';
}

/** The host a network error names (getaddrinfo ENOTFOUND host, connect ECONNREFUSED host:443, a URL in the text). */
function hostOf(text: string): string | undefined {
  const m =
    /\bgetaddrinfo\s+[A-Z_]+\s+([^\s,)'"]+)/i.exec(text) ??
    /\bconnect\s+[A-Z_]+\s+([^\s,)'":]+)/i.exec(text) ??
    /\bhttps?:\/\/([^/\s:'"]+)/i.exec(text);
  return m?.[1];
}

const NETWORK =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ETIMEOUT|ENETUNREACH|EHOSTUNREACH|FailedToOpenSocket|ConnectionRefused|ConnectionClosed)\b|Unable to connect|fetch failed|socket connection was closed unexpectedly|network (?:error|is unreachable)|getaddrinfo|Timed out waiting for|request to \S+ failed/i;
const TLS = /certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_[A-Z_]+|unable to get local issuer/i;

/** Plain words for a sign-in failure omp reported (`omp login`, or a stored sign-in failing later), or null when the
 *  text isn't one CAST knows. `provider`: omp's login provider id. */
export function explainLoginFailure(provider: string, raw: string): string | null {
  const text = raw.trim();
  const who = providerName(provider);

  // ── the machine: another sign-in holds the callback port, the network, the clock ──
  // omp's own words, or Node's when the callback server dies before omp can word it ("EADDRINUSE … 127.0.0.1:1455")
  const port = /\bport (\d+) is in use/i.exec(text) ?? /EADDRINUSE\b[^\n]*?:(\d{2,5})\b/.exec(text);
  if (port) {
    return `Another sign-in is still running on this machine (port ${port[1]} is taken) — for example \`cast-agent login\` in a terminal. Stop it, then try again.`;
  }
  if (/slow_down|clock drift/i.test(text)) {
    return `The ${who} sign-in timed out. This server’s clock may be off — sync it (or restart the VM), then try again.`;
  }

  // ── a stored sign-in that no longer works (refresh refused): sign in again ──
  if (
    /token refresh failed|refresh token (?:is )?(?:invalid|expired|revoked)|oauth refresh failed|credentials are missing \w+; sign in again|credential is invalid; sign in again|Use \/login to re-authenticate|session is invalid or expired/i.test(text) &&
    !NETWORK.test(text)
  ) {
    return `This ${who} sign-in expired — sign in again.`;
  }

  // ── the provider is busy or down (also during a token exchange): trying again later helps ──
  const status = Number(/\b(?:failed|status=)\s*:?\s*(\d{3})\b/i.exec(text)?.[1] ?? 0);
  if (status === 429) return `${who} is limiting sign-ins right now. Wait a minute, then try again.`;
  if (status >= 500) return `${who} had a problem during the sign-in (HTTP ${status}). Try again in a moment.`;

  // ── the OAuth code or the device code ──
  if (/invalid_grant|token exchange failed|Invalid 'code'/i.test(text) && !NETWORK.test(text)) {
    return 'The sign-in code was rejected — it expired or was already used. Start the sign-in again and paste the new address right after approving.';
  }
  if (/state mismatch/i.test(text)) {
    return 'That address belongs to an older sign-in attempt. Open the sign-in page again from this dialog and paste the new address.';
  }
  if (/access_denied|Authorization (?:failed|was denied)|user denied|consent_required/i.test(text)) {
    return `The sign-in was declined on ${who}’s page. Start again and choose Allow to connect.`;
  }
  if (/expired_token|code expired|Device (?:authorization|flow) timed out|Authentication timed out|did not complete login in time/i.test(text)) {
    return `The ${who} sign-in code expired before it was approved. Start again and approve it within a few minutes.`;
  }
  if (/No refresh token received/i.test(text)) {
    return `${who} didn’t hand over a lasting sign-in. Try again; if it repeats, remove the app from your ${who} account’s connected apps first.`;
  }
  if (/\b(?:Login|OAuth (?:login|callback)) cancelled\b|Device authorization cancelled/i.test(text)) {
    return 'The sign-in was cancelled.';
  }
  if (/Unknown OAuth provider/i.test(text)) {
    return `The agent (cast-agent) has no ${who} sign-in in this version. Update CAST, then try again.`;
  }

  // ── a pasted API key ──
  if (/API key is (?:required|empty)/i.test(text)) return 'The key was empty. Paste the whole key and try again.';
  const key = /API key validation failed \((\d{3})\)/i.exec(text);
  if (key) {
    const status = Number(key[1]);
    if (status === 401 || status === 403) return `${who} refused that key (HTTP ${status}). Copy it again from the key page — the whole key, no spaces — and try again.`;
    if (status === 402) return `The key works, but the ${who} account has no credit left. Add credit there, then try again.`;
    if (status === 429) return `${who} is limiting requests from this key right now. Wait a minute, then try again.`;
    if (status >= 500) return `${who} had a problem checking the key (HTTP ${status}). Try again in a moment.`;
    return `${who} didn’t accept that key (HTTP ${status}). Check that it is a ${who} key and try again.`;
  }

  // ── the network ──
  if (TLS.test(text) && /fetch|request|connect|certificate/i.test(text)) {
    const host = hostOf(text);
    return `The secure connection to ${host ?? who} failed its certificate check. A proxy or firewall on this network may be in the way — check it, then try again.`;
  }
  if (NETWORK.test(text)) {
    const host = hostOf(text);
    return `This server couldn’t reach ${host ?? who}. Check its internet connection (or proxy), then try again.`;
  }

  // ── the provider said no in another way ──
  if (status === 401 || status === 403) return `${who} refused the sign-in (HTTP ${status}). Check that this account can use it, then try again.`;
  return null;
}

/** A model error from a chat turn in plain words when it is about the sign-in or the key (null: say omp's words).
 *  For the chat: an expired sign-in or a refused key isn't fixed by trying again, only in Models & providers. */
export function explainAuthError(raw: string): string | null {
  const text = raw.trim();
  const provider = /\bprovider[: ]+([a-z][\w-]*)/i.exec(text)?.[1] ?? /^([a-z][\w-]*) token refresh failed/i.exec(text)?.[1];
  const who = provider ? providerName(provider) : 'the provider';
  if (/token refresh failed|oauth refresh failed|credentials are missing \w+; sign in again|Use \/login to re-authenticate|invalid_grant/i.test(text) && !NETWORK.test(text)) {
    return `The ${who} sign-in expired — sign in again under Models & providers, then send the message again.`;
  }
  if (/\b(?:401|403)\b/.test(text) && /invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|authentication_error|api key (?:not valid|is invalid)|invalid authentication/i.test(text)) {
    return `The key was refused (${who}). Replace it under Models & providers, then send the message again.`;
  }
  return null;
}

/** The text omp printed, redacted, as one block for "Details" and the log. */
export function redactedReason(text: string): string {
  return redactSecrets(text.trim());
}
