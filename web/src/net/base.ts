// Where this city's server is, seen from the page.
//
// A city on another machine is opened THROUGH the server the user paired with (the hub): the hub serves it under
// /city/<id>/ on its own origin and forwards those requests to that machine. The home city is at /.
// Every request meant for *this* city's server (API, WebSocket, uploads, file viewer) must go through apiUrl/wsUrl
// so the page works under either prefix. Requests meant for the hub itself (the list of cities) use hubUrl.
// Static assets under /assets/ are part of the CAST release and load from the origin root (shared browser cache).
const match = /^\/city\/([A-Za-z0-9_-]{1,64})\//.exec(typeof location === 'undefined' ? '/' : location.pathname); // no location: unit tests

/** The id of the city this page shows when it was opened through a hub; null for the hub's own (home) city. */
export const CITY_ID: string | null = match ? match[1] : null;
/** Path prefix of this city's server on this origin, always ending in '/'. */
export const BASE: string = match ? match[0] : '/';

/** A root-relative server path ('/api/x', '/ws?x=1') → the same path on this city's server. Other URLs pass through. */
export function apiUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  if (BASE !== '/' && path.startsWith(BASE)) return path; // already prefixed
  return BASE + path.slice(1);
}

/** ws(s)://host/<prefix>path for this city's server. */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${apiUrl(path)}`;
}

/** A path on the hub (the server this origin belongs to), e.g. '/api/cities'. Never prefixed. */
export function hubUrl(path: string): string {
  return path;
}
