// Cities: one CAST server per machine is one city. The server the browser is paired with is the hub; it lists the
// other cities the user added and serves each one under CITY_PREFIX/<id>/ on its own origin (server/city-proxy.ts),
// so switching city is a page navigation and every city runs the web app of its own server version.
// AI accounts are never shared: each city's agents run on its own machine with its own omp sign-ins.
//
// Hub HTTP API (authenticated, JSON; contract C4):
//   GET    /api/cities            → CitiesResponse
//   POST   /api/cities            AddCityInput → { city: CitySummary }
//   PATCH  /api/cities/<id>       { name?, pairing?, url? } → { city: CitySummary }   (rename and/or re-pair)
//   DELETE /api/cities/<id>       → { ok: true }
//   GET    /api/version           → VersionInfo (no auth needed; `name` only when the request is signed in)

export const CITY_PREFIX = '/city';
/** A city id: a short slug that stays the same when the city is renamed (URLs and per-city browser storage use it). */
export const CITY_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** /api/version.features of a server that can be added as a city (and can proxy cities itself). */
export const CITY_PROXY_FEATURE = 'city-proxy-v1';
/** Bumped when the hub ⇄ city wire changes incompatibly. */
export const CITY_PROTOCOL = 1;
export const MAX_CITY_NAME = 40;
export const MAX_CITIES = 32;

export type CityStatus = 'online' | 'offline' | 'error';

export interface CitySummary {
  id: string;
  name: string;
  url: string; // origin of that machine's CAST server, as the hub reaches it
  status: CityStatus;
  version?: string;
  error?: string; // a sentence for the user when status is 'offline' or 'error'
}

export interface CitiesResponse {
  home: { id: 'home'; name: string; version: string };
  cities: CitySummary[];
}

export interface AddCityInput {
  name?: string;
  url: string;
  /** That server's pairing link (…/?token=…) or its bare token. Used once to pair; never stored. */
  pairing: string;
}

export interface VersionInfo {
  app: 'cast';
  version: string;
  protocol: number;
  features: string[];
  /** Random per data folder (<dataDir>/instance-id): tells a hub it is about to add itself. */
  instanceId: string;
  /** Whether this request was signed in (pairing cookie or session); a hub uses it to see that a pairing still works. */
  paired: boolean;
  /** This city's own name (C1 cityName); only when paired. */
  name?: string;
}

/** Why adding/re-pairing failed, for the client (the message is already plain words). */
export type CityErrorCode = 'invalid' | 'unreachable' | 'not-cast' | 'too-old' | 'bad-token' | 'self' | 'duplicate' | 'rate-limited' | 'not-found' | 'limit';
