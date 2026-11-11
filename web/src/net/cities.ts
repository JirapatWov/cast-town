// The hub's list of cities (shared/cities.ts), for the city switcher and anything that says which city it shows.
// Always the hub's /api/cities (hubUrl): a city opened through a hub shares the hub's origin, so even under
// /city/<id>/ this is the hub talking, never that city's own server.
import type { AddCityInput, CitiesResponse, CitySummary } from '../../../shared/cities';
import { cityStorage, deviceStorage, storage } from '../ui/dom';
import { BASE, CITY_ID, hubUrl } from './base';

/** deviceStorage key: the city this device was in last ('home' or an id). The installed app starts there. */
export const LAST_CITY_KEY = 'rlt.city.last';
/** Per-city storage key: the house (address hash) the user was in when they last switched away from that city. */
export const LAST_PLACE_KEY = 'rlt.city.place';
const REFRESH_MS = 30_000;

export interface CitiesView {
  /** null until the first answer (or when this server can't list cities: an older hub). */
  data: CitiesResponse | null;
  error: string | null;
  loading: boolean;
}

const view: CitiesView = { data: null, error: null, loading: false };
const listeners = new Set<(v: CitiesView) => void>();
let inflight: Promise<CitiesView> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  for (const fn of [...listeners]) {
    try {
      fn(view);
    } catch (err) {
      console.error('[cities] listener threw', err);
    }
  }
}

/** A failed hub request → one sentence (the hub's own `error` when it sent one). */
export async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    /* not JSON */
  }
  if (res.status === 403) return 'This browser isn’t signed in to this CAST anymore. Reload the page.';
  return `The CAST server answered ${res.status}.`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(hubUrl(path), { credentials: 'same-origin', cache: 'no-store', ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  } catch {
    throw new Error('Could not reach your CAST server. Check the connection and try again.');
  }
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as T;
}

export function citiesView(): CitiesView {
  return view;
}

/** Subscribe to list changes; returns the unsubscribe. */
export function onCities(fn: (v: CitiesView) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** (Re)load the list. Statuses are probed by the hub (cached ~10 s there). */
export function loadCities(): Promise<CitiesView> {
  if (inflight) return inflight;
  view.loading = true;
  emit();
  inflight = call<CitiesResponse>('/api/cities')
    .then((data) => {
      view.data = data;
      view.error = null;
      return view;
    })
    .catch((err: Error) => {
      view.error = err.message;
      return view;
    })
    .finally(() => {
      view.loading = false;
      inflight = null;
      emit();
      schedule();
    });
  return inflight;
}

function schedule() {
  if (timer) clearTimeout(timer);
  // Keep the statuses fresh while the page is open (a city going offline shows in the switcher).
  timer = setTimeout(() => {
    timer = null;
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void loadCities();
    else schedule();
  }, REFRESH_MS);
}

export async function addCity(input: AddCityInput): Promise<CitySummary> {
  const { city } = await call<{ city: CitySummary }>('/api/cities', { method: 'POST', body: JSON.stringify(input) });
  await loadCities();
  return city;
}

export async function updateCity(id: string, patch: { name?: string; pairing?: string; url?: string }): Promise<CitySummary> {
  const { city } = await call<{ city: CitySummary }>(`/api/cities/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  await loadCities();
  return city;
}

export async function removeCity(id: string): Promise<void> {
  await call<{ ok: true }>(`/api/cities/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await loadCities();
}

/** What the menu says about a city's state, in a word or two. */
export function cityStatusText(c: Pick<CitySummary, 'status' | 'version' | 'error'>): string {
  if (c.status === 'online') return c.version ? `v${c.version}` : 'Online';
  if (c.status === 'offline') return 'Offline';
  return /pair/i.test(c.error ?? '') ? 'Needs re-pairing' : 'Problem';
}

/** The id of the city this page shows ('home' for the hub's own). */
export const currentCityId = (): string => CITY_ID ?? 'home';

/** This page's city as the hub lists it; null while unknown. */
export function currentCity(v: CitiesView = view): { id: string; name: string; status: CitySummary['status']; version?: string } | null {
  if (!v.data) return null;
  if (!CITY_ID) return { id: 'home', name: v.data.home.name, status: 'online', version: v.data.home.version };
  return v.data.cities.find((c) => c.id === CITY_ID) ?? null;
}

/** The name to show for this page's city (falls back to its id, or "Home"). */
export function currentCityName(v: CitiesView = view): string {
  return currentCity(v)?.name ?? (CITY_ID ?? 'Home');
}

/** More than one city exists (then UI that is per machine, like AI accounts, says which city it is about). */
export function hasManyCities(v: CitiesView = view): boolean {
  return !!v.data && v.data.cities.length > 0;
}

/** The page of a city: '/' for home, '/city/<id>/' for the others. */
export function cityHref(id: string): string {
  return id === 'home' ? '/' : `/city/${encodeURIComponent(id)}/`;
}

/** A place in a city worth coming back to: a house (and job) address, nothing else. */
export function placeHash(hash: string | null | undefined): string {
  return hash && /^#\/house\/[^\s#]{1,200}$/.test(hash) ? hash : '';
}

/** Where switching to a city lands: its page, back in the house the user left it in (`stored`, its LAST_PLACE_KEY). */
export function returnHref(id: string, stored: string | null): string {
  return cityHref(id) + placeHash(stored);
}

/** Go to another city (a page load: that city runs its own server's app), remembering it for next time — and in which
 *  house this city was left, so switching back returns there (each city keeps its own, in its own storage). */
export function switchCity(id: string): void {
  deviceStorage.set(LAST_CITY_KEY, id);
  if (cityHref(id) === BASE) return;
  if (typeof location !== 'undefined') {
    const here = placeHash(location.hash);
    if (here) storage.set(LAST_PLACE_KEY, here);
    else storage.remove(LAST_PLACE_KEY);
  }
  location.assign(returnHref(id, cityStorage(id).get(LAST_PLACE_KEY)));
}

/** The installed app always starts at the hub's / (its manifest's start_url): take it back to the city it was in.
 *  Only in the standalone app, only on its first page of the session and only to a city that is online — a browser
 *  tab's URL already says which city it shows. */
export function restoreLastCity(v: CitiesView): boolean {
  if (CITY_ID || !v.data || typeof window === 'undefined') return false;
  const last = deviceStorage.get(LAST_CITY_KEY);
  if (!last || last === 'home') return false;
  let standalone = false;
  try {
    standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    /* no matchMedia */
  }
  if (!standalone || document.referrer || history.length > 1) return false;
  const city = v.data.cities.find((c) => c.id === last);
  if (!city || city.status !== 'online') return false;
  location.replace(returnHref(city.id, cityStorage(city.id).get(LAST_PLACE_KEY)));
  return true;
}

/** The page is the home city: remember it (so the installed app starts at home next time). */
export function rememberCurrentCity(): void {
  if (deviceStorage.get(LAST_CITY_KEY) !== currentCityId()) deviceStorage.set(LAST_CITY_KEY, currentCityId());
}
