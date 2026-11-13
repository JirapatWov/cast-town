// How many AI accounts work right now, counted the same way by the page (the top bar, the welcome, Help) and the server
// (GET /api/status for the Mac menu bar), so the two never disagree on "nobody can work". Pure.
import type { ModelInfo, ProviderStatus } from './protocol';

/** What the town runs on, as far as the caller knows. */
export interface ModelState {
  providers: ProviderStatus[];
  models: ModelInfo[];
}

/** Providers (or vendors of a custom provider's models) that are signed in right now. */
export function liveProviders(s: ModelState): number {
  const cards = s.providers.filter((p) => p.connected).length;
  return cards || new Set(s.models.filter((m) => m.available).map((m) => m.vendor)).size;
}
