// The hub's HTTP surface for cities (contract C4), in the order server/index.ts calls it:
//   beforeAuth  the keyed file requests of a city (/city/<id>/api/files/<key>/…: the key is the auth, like the hub's
//               own files)
//   isVersion / version
//               GET /api/version (no sign-in needed: a hub checks a server before pairing). The server answers it
//               with the request's own auth decision, so auth runs once per request (it can upgrade a legacy cookie).
//   needsOrigin which requests must pass auth's Origin check (they change something, or open a WebSocket)
//   afterAuth   /api/cities[/<id>] and /city/<id>/… (HTTP and WebSocket) — only for signed-in requests
// The proxied sockets' open/message/close are forwarded here by the server's websocket handlers (WsData.city).
import type { ServerWebSocket } from 'bun';
import { CITY_PROTOCOL, CITY_PROXY_FEATURE, type VersionInfo } from '../shared/cities';
import { CityError, type Cities } from './cities';
import { createCityProxy, isKeyedFileRequest, parseCityPath, type CityProxy, type CitySocket } from './city-proxy';
import { errorMessage, log, readTextCapped } from './util';

const MAX_BODY = 16 * 1024;

export interface CityRoutesOptions {
  cities: Cities;
  instanceId: string;
  version: string;
  homeName: string;
  proxy?: CityProxy;
  /** More /api/version features of this server (e.g. 'mac-app-v1'), after the city proxy's. */
  features?: string[];
}

type Ws = ServerWebSocket<{ city?: CitySocket }>;

export interface CityRoutes {
  beforeAuth(req: Request, url: URL): Response | Promise<Response> | null;
  /** GET/HEAD /api/version, which every caller may ask. */
  isVersion(req: Request, url: URL): boolean;
  /** The /api/version answer; paired: this request's auth decision allowed it (the server checked it once). */
  version(req: Request, paired: boolean): Response;
  needsOrigin(req: Request, url: URL): boolean;
  /** null: not a cities route. undefined: the request was upgraded to a WebSocket (through `upgrade`, which the server
   *  implements with srv.upgrade and its own WsData around `city`). */
  afterAuth(req: Request, url: URL, upgrade: (city: CitySocket) => boolean): Response | Promise<Response | undefined> | undefined | null;
  readonly ws: { open(ws: Ws): void; message(ws: Ws, raw: string | Buffer): void; close(ws: Ws, code: number, reason: string): void };
  closeAll(): void;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

function isUpgrade(req: Request): boolean {
  return (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
}

async function readJsonBody(req: Request): Promise<unknown> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new CityError('Send JSON (Content-Type: application/json).', 'invalid', 415);
  const text = await readTextCapped(req, MAX_BODY); // never holds more than MAX_BODY bytes, also without Content-Length
  if (text === null) throw new CityError('That request is too large.', 'invalid', 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new CityError('That request isn’t valid JSON.', 'invalid');
  }
}

function failure(err: unknown): Response {
  if (err instanceof CityError) return json({ error: err.message, code: err.code }, err.status);
  log('cities', 'request failed:', errorMessage(err));
  return json({ error: 'Something went wrong on this CAST server.' }, 500);
}

export function createCityRoutes(opts: CityRoutesOptions): CityRoutes {
  const { cities } = opts;
  const proxy = opts.proxy ?? createCityProxy({ cities });

  function version(req: Request, paired: boolean): Response {
    const body: VersionInfo = {
      app: 'cast',
      version: opts.version,
      protocol: CITY_PROTOCOL,
      features: [CITY_PROXY_FEATURE, ...(opts.features ?? [])],
      instanceId: opts.instanceId,
      paired,
      ...(paired ? { name: opts.homeName } : {}),
    };
    return new Response(req.method === 'HEAD' ? null : JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const rest = url.pathname.slice('/api/cities'.length);
    try {
      if (rest === '' || rest === '/') {
        if (req.method === 'GET' || req.method === 'HEAD') return json(await cities.list());
        if (req.method === 'POST') return json({ city: await cities.add(await readJsonBody(req)) }, 201);
        return json({ error: 'Method not allowed' }, 405);
      }
      const id = decodeURIComponent(rest.slice(1));
      if (!/^[a-z0-9-]{1,32}$/.test(id)) return json({ error: 'There’s no such city here.', code: 'not-found' }, 404);
      if (req.method === 'PATCH') return json({ city: await cities.update(id, await readJsonBody(req)) });
      if (req.method === 'DELETE') return cities.remove(id) ? json({ ok: true }) : json({ error: 'There’s no such city here.', code: 'not-found' }, 404);
      return json({ error: 'Method not allowed' }, 405);
    } catch (err) {
      return failure(err);
    }
  }

  return {
    beforeAuth(req, url) {
      const path = parseCityPath(url.pathname);
      if (path && isKeyedFileRequest(req.method, path.rest) && !isUpgrade(req)) return proxy.http(req, url, path);
      return null;
    },

    isVersion(req, url) {
      return url.pathname === '/api/version' && (req.method === 'GET' || req.method === 'HEAD');
    },

    version,

    needsOrigin(req, url) {
      const hubApi = url.pathname === '/api/cities' || url.pathname.startsWith('/api/cities/');
      const city = url.pathname.startsWith('/city/');
      if (!hubApi && !city) return false;
      // The city can't check the browser's Origin (the proxy drops it), so the hub checks it for the city.
      return isUpgrade(req) || (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS');
    },

    afterAuth(req, url, upgrade) {
      if (url.pathname === '/api/cities' || url.pathname.startsWith('/api/cities/')) return api(req, url);
      if (!url.pathname.startsWith('/city/')) return null;
      const path = parseCityPath(url.pathname);
      if (!path) return json({ error: 'There’s no such city here.' }, 404);
      if (isUpgrade(req)) {
        // The city's socket first: only once it is open does the browser's handshake succeed.
        return proxy.socket(req, url, path).then((ready) => {
          if (ready instanceof Response) return ready;
          if (upgrade(ready.data)) return undefined;
          try {
            ready.data.up.close();
          } catch {
            /* ignore */
          }
          return new Response('Expected a WebSocket upgrade\n', { status: 426 });
        });
      }
      return proxy.http(req, url, path);
    },

    ws: { open: proxy.open, message: proxy.message, close: proxy.close },
    closeAll: proxy.closeAll,
  };
}
