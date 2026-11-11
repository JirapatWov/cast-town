// The server side of the contract with the CAST menu-bar app for the Mac (mac/CASTMenu). The app starts the server
// (or attaches to one already on port 4860 whose GET /api/version says app 'cast'), pairs once with POST /api/pair
// using <dataDir>/token, then polls GET /api/status and asks POST /api/login-link for every "Open CAST".
//
//   GET  /api/version     → { app: 'cast', …, features: [..., MAC_APP_FEATURE] }   (no sign-in needed)
//   GET  /api/status      → AppStatus                                               (signed in; cheap: memory only)
//   POST /api/login-link  { next?: '/…' } → LoginLink                              (signed in; same origin when sent)
//
// Extra fields may be added; the app ignores what it does not know.

/** /api/version.features of a server that implements /api/status and /api/login-link. */
export const MAC_APP_FEATURE = 'mac-app-v1';

/** omp as the menu shows it: 'too-old' = older than the release CAST is tested with (shared/omp-version.ts). */
export type AppOmpState = 'ok' | 'checking' | 'missing' | 'too-old' | 'error';

export interface AttentionItem {
  kind: 'approval' | 'question' | 'error';
  house: string; // the house's name
  person: string; // who waits (or failed), e.g. "Assistant"
  title: string; // one line, e.g. "Allow tool: bash" or the question asked
  since: number; // epoch ms
  /** Extras for the app (not in the first contract): a stable id per item, the house and person ids, and the
   *  same-origin path that opens CAST at that house (pass it as `next` to /api/login-link). */
  id: string;
  houseId: string;
  personId: string;
  next: string;
}

export interface AppStatus {
  app: 'cast';
  version: string;
  cityName: string;
  url: string; // this server's own loopback address, e.g. http://127.0.0.1:4860/
  uptimeSec: number;
  agents: {
    total: number; // every person in the town (helpers too)
    working: number; // busy or starting
    needsYou: number; // people waiting on the user: an approval, a question or a plan card
  };
  approvalsWaiting: number; // answers the user owes: approval and question cards plus plan cards
  runsActive: number; // team runs running or waiting for an approval
  houses: number;
  omp: { state: AppOmpState; version?: string };
  models: {
    connected: number; // providers with a working sign-in or key
    /** The AI-account check (`omp models`): 'checking' (the first one runs), 'ok', 'stale' (going by an earlier
     *  result), 'failed' (none has worked: nothing counts as connected). `connected` means "none" only once it is
     *  'ok' or 'stale'. Absent (older servers): treat as 'ok'. */
    state?: 'checking' | 'ok' | 'stale' | 'failed';
    demo: boolean; // deprecated: true only with the CAST_MOCK_LLM test model; use connected === 0
  };
  attention: AttentionItem[]; // at most 10, newest first
}

export interface LoginLink {
  url: string; // one-time sign-in link (single use, 10 minutes) on this server's loopback address, landing on `next`
  expiresAt: number; // epoch ms
}

/** At most this many attention items in /api/status. */
export const MAX_ATTENTION = 10;
