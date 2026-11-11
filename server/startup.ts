// First-start chores and messages: make the folders CAST needs (with errors a person can act on), the startup banner
// (which never prints the pairing token — logs get pasted into issues), warnings about risky setups, and the
// listen.json note `bun run pair` reads to build the pairing link.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import type { TerminalAccess } from '../shared/terminal-protocol';
import { ConfigError, type ServerConfig } from './config';
import type { PairingHint } from './pages';
import { selfCommand } from './runtime';
import { errorMessage, log, writeFileAtomic } from './util';

/** `/home/me/x` → `~/x` (shorter, and the 403 page doesn't need to show the account name). */
export function tildify(p: string, home = homedir()): string {
  if (home && (p === home || p.startsWith(home + sep))) return `~${p.slice(home.length)}`;
  return p;
}

const shellQuote = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The command that prints this server's pairing link. The data folder is spelled out when `bun run pair` could not
 *  find it by itself (it was set in the server's environment). */
export function pairCommand(cfg: Pick<ServerConfig, 'dataDir' | 'dataDirSource'>): string {
  return cfg.dataDirSource === 'env' ? `bun run pair --data-dir ${shellQuote(tildify(cfg.dataDir))}` : 'bun run pair';
}

/** Only the CAST menu-bar app (CAST_LAUNCHED_BY=mac-app) makes the pairing links from its menu (Open CAST, Pair a
 *  phone…). */
const usesMenuBar = (cfg: Partial<Pick<ServerConfig, 'launchedBy'>>) => cfg.launchedBy === 'mac-app';

/** A compiled CAST outside the Mac app (the Linux tarball) has no checkout and maybe no Bun to run `bun run pair`:
 *  print the link with the shell alone. `~/` stays outside the quotes so the shell still expands it. */
export function echoPairCommand(cfg: Pick<ServerConfig, 'dataDir' | 'port'>): string {
  const file = tildify(join(cfg.dataDir, 'token'));
  const path = file.startsWith('~/') ? `~/${shellQuote(file.slice(2))}` : shellQuote(file);
  return `echo "http://127.0.0.1:${cfg.port}/?token=$(cat ${path})"`;
}

type HintConfig = Pick<ServerConfig, 'dataDir' | 'dataDirSource'> & Partial<Pick<ServerConfig, 'compiled' | 'launchedBy' | 'port'>>;

export function pairingHint(cfg: HintConfig): PairingHint {
  const command = cfg.compiled && cfg.port !== undefined ? echoPairCommand({ dataDir: cfg.dataDir, port: cfg.port }) : pairCommand(cfg);
  return { tokenFile: tildify(join(cfg.dataDir, 'token')), command, ...(usesMenuBar(cfg) ? { menuBar: true } : {}) };
}

function why(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EROFS') return 'the disk is read-only';
  if (code === 'ENOTDIR') return 'part of the path is a file';
  return errorMessage(err);
}

/** Create the data folder (fatal when impossible) and the workspace (only a notice: CAST runs, new projects can't be
 *  created until it is fixed). Missing folder-browser roots are reported too. Returns whether the workspace exists. */
export function prepareFolders(cfg: ServerConfig): { workspaceReady: boolean } {
  try {
    mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new ConfigError(`CAST could not create its data folder ${cfg.dataDir} (${why(err)}). Set CAST_DATA_DIR to a folder you can write to.`);
  }
  closeDataFolder(cfg);
  let workspaceReady = true;
  try {
    mkdirSync(cfg.workspaceRoot, { recursive: true });
  } catch (err) {
    workspaceReady = false;
    cfg.notices.push(`Could not create the workspace folder ${cfg.workspaceRoot} (${why(err)}). New projects can't be created there — set CAST_WORKSPACE to a folder you can write to.`);
  }
  const missing = cfg.fsRoots.filter((r) => !existsSync(r));
  if (missing.length) {
    cfg.notices.push(`${missing.length === cfg.fsRoots.length ? 'None of the folders' : 'Some folders'} the folder picker may browse exist (${missing.join(', ')}). Set CAST_FS_ROOTS.`);
  }
  return { workspaceReady };
}

/** The data folder holds chats, omp sessions and the pairing token: only its owner may look inside. A new one is made
 *  0700 above; one made by an older CAST (or by hand) may be open to other accounts, so it is closed here. */
export function closeDataFolder(cfg: Pick<ServerConfig, 'dataDir' | 'notices'>): void {
  if (process.platform === 'win32') return; // no POSIX modes there (ACLs decide)
  try {
    const st = statSync(cfg.dataDir);
    const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
    if (!mine || (st.mode & 0o077) === 0) return;
    chmodSync(cfg.dataDir, st.mode & 0o700);
    cfg.notices.push(`Closed the data folder ${cfg.dataDir} to other accounts (it held chats and sign-in data they could read).`);
  } catch (err) {
    cfg.notices.push(`Could not close the data folder ${cfg.dataDir} to other accounts (${why(err)}). Run: chmod 700 ${cfg.dataDir}`);
  }
}

export function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function loopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** The account the shell really runs as: the process's own user (uid), not $USER — `sudo -E` or `env USER=…` leave $USER
 *  naming someone else, and the chip must never say "alice@host" over a root shell. $USER only when there is no passwd
 *  entry for the uid. */
export function shellUser(info: () => { username: string }, envUser: string | undefined): string {
  try {
    const name = info().username;
    if (name) return name;
  } catch {
    /* no passwd entry for this uid */
  }
  return envUser || 'unknown';
}

/** Who the browser terminal's shell runs as, for the client's warning (hello.terminal). */
export function terminalAccess(cfg: Pick<ServerConfig, 'terminal'>): TerminalAccess {
  return { enabled: cfg.terminal, user: shellUser(userInfo, process.env.USER), host: hostname().split('.')[0] || 'this machine', root: runningAsRoot() };
}

/** The heading in SECURITY.md that the root warning sends people to (a test checks it exists). */
export const ROOT_ADVICE_HEADING = 'Run it as a normal user, never as root';
export const ROOT_WARNING = `CAST is running as root. The browser terminal and every AI agent can change anything on this machine. Run CAST as a normal user instead (SECURITY.md, "${ROOT_ADVICE_HEADING}").`;

/** Loud lines for setups that hand out more power than people expect. */
export function startupWarnings(cfg: ServerConfig): string[] {
  const out: string[] = [];
  if (runningAsRoot()) {
    out.push(ROOT_WARNING);
  }
  if (!loopbackHost(cfg.host)) {
    out.push(`CAST is listening on ${cfg.host}, not just this machine: anyone who can reach port ${cfg.port} can try to pair. Prefer \`tailscale serve\` or an SSH tunnel, and never share a pairing link.`);
  }
  if (cfg.allowedUsers.length && !loopbackHost(cfg.host)) {
    out.push('Tailnet logins (CAST_ALLOWED_USERS) only count for requests that come through `tailscale serve` on this machine.');
  }
  return out;
}

export function banner(o: {
  appName: string;
  cfg: ServerConfig;
  baseUrl: string;
  agents: string;
  warnings: string[];
}): string {
  const { cfg } = o;
  const term = terminalAccess(cfg);
  const lines = [
    `${o.appName} v${cfg.serverVersion}  —  ${cfg.cityName}`,
    `  Open      ${o.baseUrl}/`,
    usesMenuBar(cfg)
      ? `  Pair      the CAST menu-bar app: Open CAST (this Mac) or Pair a phone… (token file: ${join(cfg.dataDir, 'token')})`
      : cfg.compiled
        ? `  Pair      run \`${echoPairCommand(cfg)}\` for this device's pairing link (token file: ${join(cfg.dataDir, 'token')})`
        : `  Pair      run \`${pairCommand(cfg)}\` in the CAST folder for this device's pairing link (token file: ${join(cfg.dataDir, 'token')})`,
    `  Tailnet   ${cfg.allowedUsers.length ? `no pairing needed for ${cfg.allowedUsers.length} login${cfg.allowedUsers.length === 1 ? '' : 's'} in CAST_ALLOWED_USERS (via tailscale serve)` : 'pairing required (set CAST_ALLOWED_USERS to let tailnet logins in without it)'}`,
    `  Terminal  ${term.enabled ? `on — shells run as ${term.user}@${term.host}${term.root ? ' (root!)' : ''}` : 'off (terminal: false / CAST_TERMINAL=0)'}`,
    `  Data      ${cfg.dataDir}`,
    `  Workspace ${cfg.workspaceRoot}`,
    `  Agents    ${o.agents}`,
    ...cfg.notices.map((n) => `  Note      ${n}`),
    ...o.warnings.map((w) => `  WARNING   ${w}`),
  ];
  return `\n  ${lines.join('\n  ')}\n`;
}

/** Where this server listens, for `bun run pair` (no secrets in it). */
export function writeListenInfo(dataDir: string, url: string): void {
  try {
    writeFileAtomic(join(dataDir, 'listen.json'), `${JSON.stringify({ url, pid: process.pid, startedAt: Date.now() })}\n`, 0o600);
  } catch {
    /* only a convenience for `bun run pair` */
  }
}

export function readListenInfo(dataDir: string): { url: string } | null {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, 'listen.json'), 'utf8')) as { url?: unknown };
    return typeof v.url === 'string' && /^https?:\/\//.test(v.url) ? { url: v.url } : null;
  } catch {
    return null;
  }
}

/** The command line of a running process ('' when it isn't running or can't be read): /proc on Linux, `ps` elsewhere. */
function processCommand(pid: number): string {
  try {
    if (existsSync('/proc/self/cmdline')) return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const ps = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='], { stdout: 'pipe', stderr: 'ignore' });
    return ps.exitCode === 0 ? ps.stdout.toString() : '';
  } catch {
    return '';
  }
}

/** Another CAST server that serves `dataDir` now: its listen.json names a live CAST server process (a stale file, or
 *  a pid the system has since given to some other program, doesn't count). */
export function dataDirOwner(dataDir: string, self = process.pid): { pid: number; url: string } | null {
  let v: { url?: unknown; pid?: unknown };
  try {
    v = JSON.parse(readFileSync(join(dataDir, 'listen.json'), 'utf8')) as typeof v;
  } catch {
    return null;
  }
  const pid = typeof v.pid === 'number' && Number.isInteger(v.pid) ? v.pid : 0;
  if (pid <= 1 || pid === self) return null;
  return /server[\\/]index\.ts|cast-server/.test(processCommand(pid)) ? { pid, url: typeof v.url === 'string' ? v.url : '' } : null;
}

/** One server per data folder. A second one would take the first one's AI agents for leftovers of a crash and kill
 *  them (agents/process-pool.ts reapOrphans), and both would write the same town, chats and token. `waitMs`: how long
 *  a server that is stopping may take to go (the copy "Delete all CAST data" starts, respawn above). */
export async function ensureDataDirFree(dataDir: string, waitMs = 0): Promise<void> {
  const end = Date.now() + waitMs;
  for (let owner = dataDirOwner(dataDir); owner; owner = dataDirOwner(dataDir)) {
    if (Date.now() >= end) {
      throw new ConfigError(
        `another CAST server (pid ${owner.pid}${owner.url ? `, ${owner.url}` : ''}) is already using the data folder ${dataDir}. Stop that one first, or give this one its own folder with CAST_DATA_DIR.`,
      );
    }
    await Bun.sleep(200);
  }
}

/** Exit code of a server that stopped to be started again by the CAST menu-bar app (EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75;

/** Start a fresh copy of this server (same command, environment and data folder) and let it take over the port once
 *  this one has exited — "Delete all CAST data" from a phone must not leave nobody to answer. Under the CAST menu-bar
 *  app nothing is spawned: the app restarts its server when it exits (a copy started here would be one the app neither
 *  knows nor stops on Quit, and would race the app's own restart for the port). Returns the exit code to use. */
export function respawn(cfg: Pick<ServerConfig, 'dataDir'> & Partial<Pick<ServerConfig, 'launchedBy'>>): number {
  if (cfg.launchedBy === 'mac-app') {
    log('server', 'the CAST menu-bar app starts a fresh server now');
    return RESTART_EXIT_CODE;
  }
  const argv = selfCommand();
  // A second's head start for this process to exit and free the port (and, with CAST_MOCK_LLM, the scripted
  // model's) first.
  const cmd = existsSync('/bin/sh') ? ['/bin/sh', '-c', 'sleep 1; exec "$0" "$@"', ...argv] : argv;
  const child = Bun.spawn(cmd, {
    cwd: process.cwd(),
    env: { ...process.env, CAST_DATA_DIR: cfg.dataDir, CAST_RESTARTED: 'wipe' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  return 0;
}
