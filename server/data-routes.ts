// POST /api/data/wipe — "Delete all CAST data" (Settings → Your data). Authenticated like every API route, same-origin
// only, and the request must carry the typed confirmation. The server answers first, then stops everything, deletes
// its data (data-wipe.ts) plus CAST's run notes in every house, and starts a fresh copy of itself (under the CAST menu-bar
// app: exits for the app to start it again): the town starts empty, a new pairing token is made, and every device — this
// one too — has to pair again.
import { originAllowed } from './auth';
import type { CoreCityStore } from './city-store';
import type { ServerConfig } from './config';
import { removeHouseArtifacts, wipeDataDir, WIPE_CONFIRM_TEXT } from './data-wipe';
import { respawn } from './startup';
import { log } from './util';

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export interface DataRouteDeps {
  cfg: Pick<ServerConfig, 'dataDir' | 'allowedOrigins'> & Partial<Pick<ServerConfig, 'launchedBy'>>;
  city: Pick<CoreCityStore, 'get'>;
  /** Stop the server (sockets, shells, agents), run `after`, exit (with the code `after` returns, else 0). */
  restart(after: () => Promise<number | void>): void;
  /** Tests: replaces respawn(). */
  spawnFresh?: () => number | void;
}

export function createDataRoutes(d: DataRouteDeps): (req: Request, url: URL) => Promise<Response> | null {
  let wiping = false;
  return (req, url) => {
    if (url.pathname !== '/api/data/wipe') return null;
    return (async () => {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (!originAllowed(req, d.cfg.allowedOrigins)) return json({ error: 'Forbidden: cross-origin request' }, 403);
      const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
      if (typeof body?.confirm !== 'string' || body.confirm.trim().toLowerCase() !== WIPE_CONFIRM_TEXT) {
        return json({ error: `Type “${WIPE_CONFIRM_TEXT}” to confirm.` }, 400);
      }
      if (wiping) return json({ ok: true, already: true }, 202);
      wiping = true;
      const houses = d.city.get().projects.map((p) => ({ path: p.path, isGit: p.isGit }));
      log('server', 'Delete all CAST data: stopping, then deleting the data folder and restarting');
      // Let this answer reach the browser before the sockets close.
      setTimeout(() => {
        d.restart(async () => {
          for (const h of houses) await removeHouseArtifacts(h, 'all');
          const r = wipeDataDir(d.cfg.dataDir);
          log('server', `deleted ${r.removed.length} item${r.removed.length === 1 ? '' : 's'} from ${d.cfg.dataDir}${r.failed.length ? ` (could not delete: ${r.failed.join(', ')})` : ''}; kept ${r.kept.join(', ') || 'nothing'}`);
          return (d.spawnFresh ?? (() => respawn(d.cfg)))();
        });
      }, 300);
      return json({ ok: true }, 202);
    })();
  };
}
