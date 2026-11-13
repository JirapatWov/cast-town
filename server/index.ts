// CAST — Bun bridge entry point.  `bun run server/index.ts`
// HTTP: static web/dist (SPA) + GET /api/health + chat images (POST/GET /api/uploads, server/uploads.ts)
//       + the viewer's files (GET /api/files/<key>/…, server/files.ts: the key is the auth, so it comes before auth).
// Every HTML page CAST serves may only be framed by CAST itself (pages.ts FRAME_GUARD_HEADERS).
// WS /ws: hello → snapshot → ClientMsg dispatch.
// WS /term: a plain shell per tab (server/terminal.ts), same auth.
// Cities (server/city-routes.ts): GET /api/version, /api/cities, and /city/<id>/… proxied to other machines' CAST.
// The Mac menu-bar app (server/app-routes.ts): GET /api/status, POST /api/login-link.
// CAST as an installed app (server/pwa.ts): /sw.js, the manifest and icons are public; Web Push (server/push).
// SIGTERM/SIGINT/SIGHUP: stop shells and omp, then exit — within 10 s, leaving no child behind (the Mac app's Quit,
// Ctrl+C, the terminal CAST was started in closing). Unhandled, SIGHUP killed the server on the spot, and a busy agent
// whose CAST is gone finishes its turn on its own (it drains what it accepted once its stdin closes). SIGKILL can't be
// handled: the next start stops whatever agent of this data folder is still running (process-pool.ts reapOrphans).
import { join } from 'node:path';
import { MAC_APP_FEATURE } from '../shared/app-status';
import { APP_NAME } from '../shared/brand';
import { OMP_TESTED_VERSION } from '../shared/omp-version';
import { WS_PATH, type ServerMsg } from '../shared/protocol';
import { TERM_DISABLED_MESSAGE, TERM_WS_PATH } from '../shared/terminal-protocol';
import { createAppRoutes } from './app-routes';
import { createAuth, type AllowDecision, type AuthDecision } from './auth';
import { exitIfBunTooOld } from './bun-version';
import { signalTrackedGroups } from './child-groups';
import { createCities, homeCityName, loadOrCreateInstanceId } from './cities';
import { createCityRoutes } from './city-routes';
import { createCityStore } from './city-store';
import { applyEnvAliases, ConfigError, loadConfig, type ServerConfig } from './config';
import { createDataRoutes } from './data-routes';
import { createDeviceSockets } from './device-sockets';
import type { AgentSystem, AgentSystemDeps } from './contracts';
import type { ServerWebSocket } from 'bun';
import { setToolImageStore } from './agents/normalize';
import { createDispatcher } from './dispatch';
import { createFileViewer } from './files';
import { createFsBrowser } from './fs-browse';
import { createGitService } from './git';
import { createHub, type WsData } from './hub';
import { ActivityLog, recordToasts } from './activity-log';
import { createJobStore } from './job-store';
import { createJobService } from './jobs';
import { machineInfo } from './machine-info';
import { createProjectService } from './projects';
import { guardFraming } from './pages';
import { pwaPublic } from './pwa';
import { createPush } from './push';
import { createStatic } from './static';
import { createTerminalService } from './terminal';
import { createUploads } from './uploads';
import { banner, ensureDataDirFree, pairingHint, prepareFolders, startupWarnings, terminalAccess, writeListenInfo } from './startup';
import { errorMessage, log } from './util';
import { MAX_FRAME_CHARS } from './validate';

// before anything else runs: an older Bun stops here with what to do (package.json engines.bun)
exitIfBunTooOld();

async function loadAgentSystem(cfg: ServerConfig, deps: AgentSystemDeps): Promise<AgentSystem> {
  if (cfg.stubAgents) {
    const stub = await import('./dev-stub-agents');
    return stub.createAgentSystem(deps);
  }
  const { createAgentSystem } = await import('./agents/index');
  return createAgentSystem(deps, { mockLlm: cfg.mockLlm });
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Cookies auth wants set (a legacy cookie upgraded to a session, a renewed session) ride on whatever answers. */
function withCookies(res: Response, d: AllowDecision | AuthDecision): Response {
  if (d.kind !== 'allow' || !d.setCookie?.length) return res;
  try {
    for (const c of d.setCookie) res.headers.append('set-cookie', c);
    return res;
  } catch {
    return res; // immutable headers (a proxied response): the next page load upgrades instead
  }
}

/** How long shutdown waits for omp and the shells before it kills what is left and exits. The Mac app SIGKILLs its
 *  server 10 s after SIGTERM: everything here must be over well before that. */
const SHUTDOWN_GRACE_MS = 7000;
/** A signal-started shutdown exits by this time whatever still runs (a hung `after` never applies to signals). */
const SHUTDOWN_HARD_MS = 9000;

/** Set once main() can shut down properly; a signal before that (still starting) exits at once. */
let stopHandler: ((signal: NodeJS.Signals) => void) | null = null;
function onSignal(signal: NodeJS.Signals): void {
  if (stopHandler) return stopHandler(signal);
  log('server', `${signal} while starting: exiting`);
  signalTrackedGroups('SIGKILL'); // omp checks that already run (child-groups.ts)
  process.exit(0);
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGHUP', () => onSignal('SIGHUP')); // the terminal CAST runs in was closed

async function main(): Promise<void> {
  applyEnvAliases(process.env); // CAST_X → RLT_X for every module that reads the environment itself
  const cfg = loadConfig();
  // before anything reads or writes the folder (a restart after "Delete all CAST data" waits for the old one to go)
  await ensureDataDirFree(cfg.dataDir, process.env.CAST_RESTARTED === 'wipe' ? 10_000 : 0);
  const startedAt = Date.now();
  prepareFolders(cfg);

  const auth = createAuth({ dataDir: cfg.dataDir, allowedUsers: cfg.allowedUsers, allowedOrigins: cfg.allowedOrigins, pairing: pairingHint(cfg), sessionInfo: () => ({ terminal: terminalAccess(cfg), cityName: cfg.cityName, pwa: { sw: cfg.serviceWorker, push: cfg.push } }) });
  const sockets = createDeviceSockets<ServerWebSocket<WsData>>();
  auth.onRevoke((e) => sockets.revoked(e));
  const push = createPush({ dataDir: cfg.dataDir, enabled: cfg.push, devices: auth.devices, contact: cfg.pushContact, extraEndpoints: cfg.pushExtraEndpoints, allowedOrigins: cfg.allowedOrigins });
  auth.onRevoke((e) => push.forget(e.deviceIds)); // a signed-out device gets no more notifications
  const activity = new ActivityLog(cfg.dataDir); // the Inbox's "Recent", the same on every device
  const hub = push.tap(recordToasts(createHub(), activity)); // Web Push looks at what is broadcast (push/notifier.ts)
  const instanceId = loadOrCreateInstanceId(cfg.dataDir);
  const homeName = homeCityName(cfg);
  const cityRoutes = createCityRoutes({
    cities: createCities({ dataDir: cfg.dataDir, instanceId, homeName, version: cfg.serverVersion }),
    instanceId,
    homeName,
    version: cfg.serverVersion,
    features: [MAC_APP_FEATURE],
  });
  const city = createCityStore(cfg.dataDir, cfg.workspaceRoot);
  const git = createGitService({ worktreesDir: join(cfg.dataDir, 'worktrees') });
  const fs = createFsBrowser(cfg.fsRoots);
  const machine = machineInfo(fs.roots); // who agents run as and where sign-ins live, for the UI's trust copy

  const jobs = createJobStore(cfg.dataDir, city);
  jobs.onChange((projectId, list) => hub.broadcast({ t: 'jobs', projectId, jobs: list }));
  const agents = await loadAgentSystem(cfg, { hub, city, jobs, git, dataDir: cfg.dataDir });
  jobs.setDefaultLeadModel(() => agents.defaultLead());
  push.attach({ snapshot: () => agents.snapshot(), projects: () => city.get().projects });
  const projects = createProjectService({ city, jobs, git, fs, agents, workspaceRoot: cfg.workspaceRoot, dataDir: cfg.dataDir });
  const jobService = createJobService({ city, jobs, agents, git, hub, dataDir: cfg.dataDir });
  agents.attachJobService?.((projectId, jobId, patch) => jobService.update(projectId, jobId, patch));
  const files = createFileViewer({ dataDir: cfg.dataDir, city, jobs, token: () => auth.token }) // a new pairing token ends every key;
  const dispatch = createDispatcher({ city, git, fs, projects, jobs: jobService, agents, files });
  const serveStatic = createStatic({ distDir: cfg.webDist, version: cfg.serverVersion, port: cfg.port, compiled: cfg.compiled });
  const terminals = createTerminalService({ city, jobs });
  const uploads = createUploads({ dataDir: cfg.dataDir });
  const dataRoutes = createDataRoutes({ cfg, city, restart: (after) => void shutdown('Delete all CAST data', after) });
  let listenPort = cfg.port;
  const appRoutes = createAppRoutes({
    version: cfg.serverVersion,
    cityName: homeName,
    host: cfg.host,
    port: () => listenPort,
    allowedOrigins: cfg.allowedOrigins,
    startedAt,
    agents,
    city,
    devices: auth.devices,
  });
  // Pictures in tool results (generate_image, a read of an image) are kept like chat uploads: transcripts hold ids.
  setToolImageStore((bytes) => {
    try {
      return uploads.store(bytes);
    } catch (err) {
      log('agents', `could not keep a tool image: ${errorMessage(err)}`);
      return null;
    }
  });
  city.onChange((c) => {
    for (const e of activity.list()) if (e.projectId && !c.projects.some((p) => p.id === e.projectId)) activity.forgetProject(e.projectId);
    hub.broadcast({ t: 'city', city: c });
  });

  let connSeq = 0;
  let server: ReturnType<typeof Bun.serve<WsData>>;
  try {
    server = Bun.serve<WsData>({
      hostname: cfg.host,
      port: cfg.port,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') {
          return json({ ok: true, name: 'cast', version: cfg.serverVersion, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
        }
        // The viewer's files: the key in the path is the auth (the sandboxed page's own loads carry no cookie).
        if (files.matches(url)) return files.handle(req, url);
        const pub = pwaPublic(req, url, serveStatic, { distDir: cfg.webDist, serviceWorker: cfg.serviceWorker }); // install files
        if (pub) return pub;
        const peer = srv.requestIP(req)?.address ?? null;
        if (url.pathname === '/api/pair') return auth.pair(req, peer); // trades a pairing token for a session
        const early = cityRoutes.beforeAuth(req, url); // a city's keyed files: the key is the auth there too
        if (early) return early;
        const isTerm = url.pathname === TERM_WS_PATH;
        const isWs = url.pathname === WS_PATH || isTerm;
        const isUpload = uploads.matches(url);
        // An upload stores something: like a WebSocket it must come from our own origin (no cross-site POSTs). A page
        // that rebinds its own domain to this machine passes that check, but its Tailscale login header doesn't count
        // (auth.ts tailnetHost), so it has no way in without the token.
        const writes = isUpload && req.method !== 'GET' && req.method !== 'HEAD';
        // GET /api/version answers everyone and says whether the caller is paired. It reuses this request's one auth
        // decision (checked without the query, so `?token=` there neither pairs nor counts as a failed attempt), and
        // any cookie that decision sets (a legacy cookie upgraded) rides on the answer.
        const isVersion = cityRoutes.isVersion(req, url);
        const decision = auth.check(req, isVersion ? new URL(url.origin + url.pathname) : url, {
          websocket: isWs || writes || cityRoutes.needsOrigin(req, url),
          peer,
        });
        if (isVersion) return withCookies(cityRoutes.version(req, decision.kind === 'allow'), decision);
        if (decision.kind === 'deny') {
          if (writes && decision.reason === 'bad-origin') {
            return new Response('Forbidden: cross-origin request\n', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
          }
          return guardFraming(auth.denyResponse(decision, req));
        }
        if (decision.kind === 'redirect') {
          const headers = new Headers({ location: decision.location, 'cache-control': 'no-store' });
          for (const c of decision.setCookie) headers.append('set-cookie', c);
          return new Response(null, { status: 302, headers });
        }
        let upgradeHeaders: Headers | undefined;
        if (decision.setCookie?.length) {
          upgradeHeaders = new Headers();
          for (const c of decision.setCookie) upgradeHeaders.append('set-cookie', c);
        }
        const cred = { user: decision.user, deviceId: decision.deviceId, via: decision.via };
        // /api/cities and /city/<id>/…: a bridged socket carries the device too, so signing it out closes it.
        const routed = cityRoutes.afterAuth(req, url, (c) => srv.upgrade(req, { data: { connId: `p${++connSeq}`, ...cred, city: c }, headers: upgradeHeaders }));
        if (routed !== null) return Promise.resolve(routed).then((r) => (r ? withCookies(r, decision) : r));
        if (isTerm) {
          if (!cfg.terminal) return new Response(`${TERM_DISABLED_MESSAGE}\n`, { status: 403, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
          const term = terminals.parse(url);
          if ('error' in term) return new Response(`${term.error}\n`, { status: 400, headers: { 'cache-control': 'no-store' } });
          const data: WsData = { connId: `t${++connSeq}`, ...cred, term };
          if (srv.upgrade(req, { data, headers: upgradeHeaders })) return undefined;
          return new Response('Expected a WebSocket upgrade\n', { status: 426 });
        }
        if (isWs) {
          const data: WsData = { connId: `c${++connSeq}`, ...cred };
          if (srv.upgrade(req, { data, headers: upgradeHeaders })) return undefined;
          return new Response('Expected a WebSocket upgrade\n', { status: 426 });
        }
        if (isUpload) return uploads.handle(req, url).then((r) => withCookies(r, decision));
        const own = auth.api(req, url, decision) ?? dataRoutes(req, url) ?? appRoutes(req, url) ?? push.routes(req, url, decision);
        if (own) return own.then((r) => withCookies(r, decision));
        if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
        return serveStatic(req, url).then(guardFraming).then((r) => withCookies(r, decision));
      },
      websocket: {
        maxPayloadLength: MAX_FRAME_CHARS * 4,
        idleTimeout: 120,
        open(ws) {
          sockets.add(ws);
          if (ws.data.city) return cityRoutes.ws.open(ws);
          if (ws.data.term) return terminals.open(ws);
          const conn = hub.attach(ws);
          const hello: ServerMsg = {
            t: 'hello',
            serverVersion: cfg.serverVersion,
            ompVersion: agents.ompVersion(),
            ompTested: OMP_TESTED_VERSION,
            user: conn.user,
            demoMode: agents.demoMode(),
            workspaceRoot: cfg.workspaceRoot,
            agents: agents.health?.(),
            ...machine,
          };
          conn.send(hello);
          try {
            const agentState = agents.snapshot();
            conn.send({ t: 'snapshot', city: city.get(), ...agentState, jobs: jobs.all(), activity: activity.list() });
          } catch (err) {
            log('ws', 'snapshot failed', err);
            conn.send({ t: 'error', message: `Could not load the town: ${errorMessage(err)}` });
          }
        },
        message(ws, raw) {
          if (ws.data.city) return cityRoutes.ws.message(ws, raw);
          if (ws.data.term) return terminals.message(ws, raw);
          const conn = hub.get(ws);
          if (!conn) return;
          const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
          dispatch(text, conn).catch((err) => log('ws', 'dispatch crashed', err));
        },
        close(ws, code, reason) {
          sockets.remove(ws);
          if (ws.data.city) return cityRoutes.ws.close(ws, code, reason);
          if (ws.data.term) return terminals.close(ws);
          hub.detach(ws);
        },
      },
      error(err) {
        log('http', 'unhandled error', err);
        return new Response('Something went wrong\n', { status: 500 });
      },
    });
  } catch (err) {
    log('server', `could not listen on ${cfg.host}:${cfg.port}: ${errorMessage(err)}`);
    await agents.shutdown().catch(() => {});
    signalTrackedGroups('SIGKILL');
    process.exit(1);
  }

  listenPort = server.port ?? cfg.port;
  const base = `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${server.port}`;
  // omp and the AI accounts are checked in the background (agents/omp-health.ts): an untested omp version is logged
  // with a WARNING when that check finishes, not here.
  const agentLine = cfg.stubAgents
    ? 'dev stub (CAST_STUB_AGENTS=1)'
    : `${agents.statusLine?.() ?? `cast-agent ${agents.ompVersion() ?? '—'}`} (checked in the background; the result follows below)`;
  // Never the pairing token here: this goes to server.log, and logs get pasted into issues.
  console.log(banner({ appName: APP_NAME, cfg, baseUrl: base, agents: agentLine, warnings: startupWarnings(cfg) }));
  writeListenInfo(cfg.dataDir, `${base}/`);
  if (process.env.CAST_RESTARTED === 'wipe') log('server', 'started fresh after "Delete all CAST data"');

  let stopping = false;
  /** after: work to do once nothing runs any more (Delete all CAST data wipes the folder and starts a fresh server);
   *  it may return the exit code. */
  async function shutdown(signal: string, after?: () => Promise<number | void>): Promise<void> {
    if (stopping) {
      log('server', 'second signal, exiting now');
      signalTrackedGroups('SIGKILL');
      process.exit(1);
    }
    stopping = true;
    const t0 = Date.now();
    log('server', `${signal}: shutting down…`);
    if (!after) {
      // A signal (the Mac app's Quit, systemd, Ctrl+C) gets an answer in time even if something below hangs.
      setTimeout(() => {
        log('server', `still stopping after ${SHUTDOWN_HARD_MS / 1000} s — exiting now`);
        signalTrackedGroups('SIGKILL');
        process.exit(1);
      }, SHUTDOWN_HARD_MS).unref();
    }
    hub.closeAll(1001, 'Server restarting');
    cityRoutes.closeAll();
    activity.flush();
    const shells = terminals.shutdown().catch((err) => log('term', 'shutdown failed', err));
    server.stop(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS)));
    const done = Promise.all([agents.shutdown().catch((err) => log('agents', 'shutdown failed', err)), shells]).then(() => 'done' as const);
    if ((await Promise.race([done, timeout])) === 'timeout') log('server', `an agent or a shell did not stop within ${SHUTDOWN_GRACE_MS / 1000} s — killing what is left`);
    clearTimeout(timer);
    // Whatever CAST started and is still there (an omp check, a sign-in, a straggler) goes now: nothing outlives us.
    const left = signalTrackedGroups('SIGKILL');
    if (left) log('server', `stopped ${left} leftover process group${left === 1 ? '' : 's'}`);
    auth.devices.flush();
    push.stop(); // a push still being sent must not write push.json back after a wipe
    let code = 0;
    if (after) code = (await after().catch((err) => log('server', 'after shutdown', err))) ?? 0;
    log('server', `bye (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    process.exit(code);
  }
  stopHandler = (signal) => void shutdown(signal);
}

// A bad message or a flaky subprocess must never take the whole town down.
process.on('unhandledRejection', (err) => log('server', 'unhandled rejection', err));
process.on('uncaughtException', (err) => log('server', 'uncaught exception', err));

main().catch((err) => {
  // A ConfigError is written for the person starting CAST: no stack trace in the way.
  if (err instanceof ConfigError) console.error(`${APP_NAME} could not start: ${err.message}`);
  else console.error(`${APP_NAME} failed to start:`, err);
  process.exit(1);
});
