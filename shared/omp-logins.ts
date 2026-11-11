// Lookups over omp's sign-ins (shared/omp-login-providers.ts, generated from omp's source): which provider ids may be
// passed to `omp login` (the server runs no other), which provider a sign-in stores its credential under, and what to
// call a provider in a sentence.
import { OMP_LOGIN_PROVIDERS, type OmpLoginProvider } from './omp-login-providers';

export { OMP_LOGIN_PROVIDERS, OMP_LOGIN_PROVIDERS_VERSION, type OmpLoginGroup, type OmpLoginKind, type OmpLoginProvider } from './omp-login-providers';

const BY_ID = new Map<string, OmpLoginProvider>(OMP_LOGIN_PROVIDERS.map((p) => [p.id, p]));

/** The sign-in `omp login <id>` runs; undefined for an id omp's menu doesn't have. */
export function loginProvider(id: string): OmpLoginProvider | undefined {
  return BY_ID.get(id);
}

/** `id` is one of omp's sign-ins: the only ids the server passes to `omp login`. */
export function isLoginProvider(id: unknown): boolean {
  return typeof id === 'string' && BY_ID.has(id);
}

/** The provider omp keeps a sign-in's credential under ('openai-codex-device' → 'openai-codex'); the id itself else. */
export function credentialProviderOf(id: string): string {
  return BY_ID.get(id)?.storeAs ?? id;
}

/** Every provider a sign-in stores credentials under (what list_accounts asks omp about, what logout accepts). */
export const LOGIN_CREDENTIAL_PROVIDERS: ReadonlySet<string> = new Set(OMP_LOGIN_PROVIDERS.map((p) => p.storeAs ?? p.id));

/** The sign-in that names a credential provider: its own entry ('zai' → Z.AI's key sign-in), else the first that
 *  stores there. */
export function loginOfCredential(provider: string): OmpLoginProvider | undefined {
  return BY_ID.get(provider) ?? OMP_LOGIN_PROVIDERS.find((p) => p.storeAs === provider);
}

/** A provider's name for a sentence or a card ("GitHub Copilot", "Cursor"); undefined when omp's menu lacks it. */
export function loginLabel(provider: string): string | undefined {
  return loginOfCredential(provider)?.label;
}
