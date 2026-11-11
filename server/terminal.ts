// Plain shells for the browser terminal (see shared/terminal-protocol.ts). Not omp: a login shell in a PTY,
// one per target (the town = workspace root, a project folder, or `<projectId>:<jobId>` = the folder that job works
// in — its own copy of the files when it has one), kept alive across reconnects.
//
// The shell runs under `setsid -c` so the PTY becomes its controlling terminal: without that bash has no job
// control and Ctrl+C never reaches the foreground program. Where there is no setsid (macOS), Bun's `detached` spawn
// does the same setsid() in the child. Either way the shell leads its own session and process group. Stopping a shell
// hangs it up (bash passes the hang-up on to its jobs), then kills whatever is still in its session — a background job
// can miss the hang-up when the shell exits on the closed terminal first — and the server's shutdown waits for that.
// A program the user deliberately detached into a session of its own (tmux, setsid) is left alone.
import type { ServerWebSocket, Subprocess } from 'bun';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  TERM_SCROLLBACK_BYTES, TERM_TOWN, type TermClientMsg, type TermServerMsg,
} from '../shared/terminal-protocol';
import { trackGroup } from './child-groups';
import type { CityStore, JobStore } from './contracts';
import type { WsData } from './hub';
import { errorMessage, log } from './util';
import { jobDir } from './worktrees';

export interface TermParams {
  target: string;
  cols: number;
  rows: number;
  sid: string | null;
  since: number | null;
}

const MAX_SESSIONS = 16;
/** A client this far behind (e.g. `cat` of a huge file over a slow link) is dropped; it reconnects and catches up. */
const MAX_BUFFERED = 8 * 1024 * 1024;
const KILL_GRACE_MS = 3000;
const OPEN = 1;

/** The shell gets a clean login environment (like an SSH login), not the server's: the server may have been
 *  started from a tool whose session variables and secrets must not leak into the user's shell. */
const ENV_KEEP = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'XDG_RUNTIME_DIR'];

interface Session {
  target: string;
  sid: string;
  cwd: string;
  shell: string;
  term: Bun.Terminal | null;
  proc: Subprocess | null;
  running: boolean;
  exitCode: number | null;
  cols: number;
  rows: number;
  /** Kept output: chunks[0] starts at stream offset `start`; `total` = bytes ever produced. */
  chunks: Uint8Array[];
  start: number;
  total: number;
  kept: number;
  clients: Set<ServerWebSocket<WsData>>;
}

export interface TerminalService {
  /** Validate the query of a /term upgrade. Returns params, or a user-facing error. */
  parse(url: URL): TermParams | { error: string };
  open(ws: ServerWebSocket<WsData>): void;
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void;
  close(ws: ServerWebSocket<WsData>): void;
  /** Hang up every shell; resolves once they are all gone (SIGKILL for any still there after the grace period). */
  shutdown(): Promise<void>;
}

function clampSize(v: string | null, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** The processes in session `sid` (a stopped shell's leftovers): /proc on Linux, `pgrep -s` elsewhere (macOS). */
export function sessionMembers(sid: number): number[] {
  if (!Number.isInteger(sid) || sid <= 1) return [];
  if (existsSync('/proc/self/stat')) {
    const out: number[] = [];
    let names: string[] = [];
    try {
      names = readdirSync('/proc');
    } catch {
      return [];
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        // pid (comm) state ppid pgrp session …: comm may hold spaces and parentheses, so count from the last ')'
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[3]) === sid) out.push(Number(name));
      } catch {
        /* gone meanwhile */
      }
    }
    return out;
  }
  try {
    const r = Bun.spawnSync(['pgrep', '-s', String(sid)], { stdout: 'pipe', stderr: 'ignore' });
    return r.stdout.toString().split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return [];
  }
}

function pickShell(): string {
  const s = process.env.SHELL;
  return s && existsSync(s) ? s : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('LC_') && v) env[k] = v;
  const home = env.HOME ?? homedir();
  env.LANG ??= 'C.UTF-8';
  env.PATH = [`${home}/.bun/bin`, `${home}/.local/bin`, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(':');
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'CAST';
  return env;
}

/** `<projectId>` or `<projectId>:<jobId>`. */
const TARGET = /^[\w.-]{1,96}(:[a-z0-9-]{1,48})?$/;

export function createTerminalService(deps: { city: CityStore; jobs?: Pick<JobStore, 'get' | 'onChange'> }): TerminalService {
  const { city, jobs } = deps;
  const sessions = new Map<string, Session>();
  const hasSetsid = existsSync('/usr/bin/setsid') || existsSync('/bin/setsid');
  const env = shellEnv();

  function cwdFor(target: string): string | null {
    const [projectId = '', jobId] = target.split(':');
    const project = target === TERM_TOWN ? undefined : city.project(projectId);
    const job = jobId && project ? jobs?.get(project.id, jobId) : undefined;
    const dir = target === TERM_TOWN ? city.workspaceRoot : jobId ? job && jobDir(project!, job) : project?.path;
    if (!dir) return null;
    try {
      return statSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  }

  function send(ws: ServerWebSocket<WsData>, msg: TermServerMsg) {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  }

  function sendBytes(ws: ServerWebSocket<WsData>, bytes: Uint8Array) {
    if (ws.readyState !== OPEN) return;
    if (ws.getBufferedAmount() > MAX_BUFFERED) {
      ws.close(1013, 'Terminal output backlog, reconnecting');
      return;
    }
    ws.send(bytes);
  }

  function broadcast(s: Session, msg: TermServerMsg) {
    for (const ws of s.clients) send(ws, msg);
  }

  function keep(s: Session, bytes: Uint8Array) {
    s.chunks.push(bytes);
    s.kept += bytes.length;
    s.total += bytes.length;
    while (s.kept - s.chunks[0].length >= TERM_SCROLLBACK_BYTES) {
      const dropped = s.chunks.shift()!;
      s.kept -= dropped.length;
      s.start += dropped.length;
    }
  }

  /** Kept output from stream offset `from` (start ≤ from ≤ total). */
  function since(s: Session, from: number): Uint8Array {
    const out = new Uint8Array(s.total - from);
    let pos = s.start;
    let w = 0;
    for (const c of s.chunks) {
      const end = pos + c.length;
      if (end > from) {
        const part = from > pos ? c.subarray(from - pos) : c;
        out.set(part, w);
        w += part.length;
      }
      pos = end;
    }
    return out;
  }

  function spawn(s: Session) {
    const term = new Bun.Terminal({
      cols: s.cols,
      rows: s.rows,
      name: 'xterm-256color',
      data(_t, data) {
        // Bun may reuse the buffer after the callback returns.
        const bytes = new Uint8Array(data);
        keep(s, bytes);
        for (const ws of s.clients) sendBytes(ws, bytes);
      },
    });
    const argv = hasSetsid ? ['setsid', '-c', s.shell, '-l'] : [s.shell, '-l'];
    const proc = Bun.spawn(argv, { terminal: term, cwd: s.cwd, env, detached: !hasSetsid });
    const untrack = trackGroup(proc.pid);
    void proc.exited.then(untrack, untrack);
    s.term = term;
    s.proc = proc;
    s.running = true;
    s.exitCode = null;
    log('term', `${s.target}: started ${s.shell} (pid ${proc.pid}) in ${s.cwd}`);
    proc.exited.then((code) => {
      if (s.proc !== proc) return;
      s.running = false;
      s.exitCode = code;
      s.proc = null;
      try {
        term.close();
      } catch {
        /* already closed */
      }
      s.term = null;
      log('term', `${s.target}: shell exited (${code})`);
      broadcast(s, { t: 'exit', code });
    });
  }

  /** Hang up the shell and everything in its process group; SIGKILL whatever ignores the hangup. Resolves once the
   *  shell has exited (at most a moment after the SIGKILL). */
  function stop(s: Session): Promise<void> {
    const proc = s.proc;
    const term = s.term;
    s.proc = null;
    s.term = null;
    s.running = false;
    if (!proc) return Promise.resolve();
    const pid = proc.pid;
    const group = (sig: NodeJS.Signals): boolean => {
      try {
        process.kill(-pid, sig); // the shell leads its group (setsid / detached above)
        return true;
      } catch {
        return false;
      }
    };
    const signal = (sig: NodeJS.Signals) => {
      if (group(sig) || proc.exitCode !== null || proc.signalCode !== null) return;
      try {
        proc.kill(sig);
      } catch {
        /* gone */
      }
    };
    signal('SIGHUP');
    try {
      term?.close();
    } catch {
      /* already closed */
    }
    const timer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
    return proc.exited.then(
      () => {
        clearTimeout(timer);
        // the shell is gone: whatever it left behind in its group or session goes too (the session id stays taken
        // while anything is in it, so these pids can't belong to anyone else)
        group('SIGKILL');
        for (const p of sessionMembers(pid)) {
          try {
            process.kill(p, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      },
      () => clearTimeout(timer),
    );
  }

  function forget(s: Session, reason: string) {
    void stop(s);
    sessions.delete(s.target);
    for (const ws of s.clients) {
      send(ws, { t: 'error', message: reason, fatal: true });
      ws.close(1000, 'Terminal closed');
    }
    s.clients.clear();
  }

  // A project that leaves the town takes its shells with it, a deleted job its own.
  city.onChange((c) => {
    const ids = new Set(c.projects.map((p) => p.id));
    for (const s of [...sessions.values()]) {
      if (s.target !== TERM_TOWN && !ids.has(s.target.split(':')[0]!)) forget(s, 'This project was removed from the town, so its terminal was closed.');
      // a house pointed at another folder: its shell was started in the old one
      else if (s.target !== TERM_TOWN && !s.target.includes(':') && c.projects.find((p) => p.id === s.target)?.path !== s.cwd) forget(s, 'This house now uses another folder, so its terminal was closed. Open it again to start in the new folder.');
    }
  });
  jobs?.onChange((projectId, list) => {
    for (const s of [...sessions.values()]) {
      const [p, j] = s.target.split(':');
      if (p === projectId && j && !list.some((x) => x.id === j)) forget(s, 'This job was deleted, so its terminal was closed.');
    }
  });

  return {
    parse(url) {
      const target = url.searchParams.get('target') ?? '';
      if (!TARGET.test(target)) return { error: 'Bad terminal target' };
      if (!cwdFor(target)) return { error: target === TERM_TOWN ? 'The workspace folder is missing' : 'No such project or job, or its folder is gone' };
      const sinceRaw = url.searchParams.get('since');
      const sinceN = sinceRaw === null ? null : Number(sinceRaw);
      return {
        target,
        cols: clampSize(url.searchParams.get('cols'), 10, 500, 100),
        rows: clampSize(url.searchParams.get('rows'), 4, 300, 30),
        sid: url.searchParams.get('sid'),
        since: sinceN !== null && Number.isSafeInteger(sinceN) && sinceN >= 0 ? sinceN : null,
      };
    },

    open(ws) {
      const p = ws.data.term!;
      let s = sessions.get(p.target);
      let mode: 'resume' | 'replay' | 'fresh' = 'replay';
      if (!s) {
        if (sessions.size >= MAX_SESSIONS) {
          send(ws, { t: 'error', message: `Too many terminals are open (${MAX_SESSIONS}). Close one first.`, fatal: true });
          ws.close(1000, 'Too many terminals');
          return;
        }
        const cwd = cwdFor(p.target);
        if (!cwd) {
          send(ws, { t: 'error', message: 'That folder is gone.', fatal: true });
          ws.close(1000, 'No folder');
          return;
        }
        s = {
          target: p.target, sid: randomBytes(9).toString('base64url'), cwd, shell: pickShell(),
          term: null, proc: null, running: false, exitCode: null, cols: p.cols, rows: p.rows,
          chunks: [], start: 0, total: 0, kept: 0, clients: new Set(),
        };
        sessions.set(p.target, s);
        try {
          spawn(s);
        } catch (err) {
          sessions.delete(p.target);
          log('term', `${p.target}: could not start a shell`, err);
          send(ws, { t: 'error', message: `Could not start a shell: ${errorMessage(err)}`, fatal: true });
          ws.close(1011, 'Spawn failed');
          return;
        }
        mode = 'fresh';
      } else if (p.sid === s.sid && p.since !== null && p.since >= s.start && p.since <= s.total) {
        mode = 'resume';
      }
      const from = mode === 'resume' ? p.since! : s.start;
      s.clients.add(ws);
      log('term', `${s.target}: attached ${ws.data.connId} (${ws.data.user ?? '?'}, ${mode})`);
      send(ws, { t: 'ready', sid: s.sid, target: s.target, cwd: s.cwd, shell: s.shell, mode, offset: from, exitCode: s.exitCode, running: s.running });
      if (from < s.total) sendBytes(ws, since(s, from));
      // The newest viewer decides the size (like tmux's "latest").
      if (s.term && (s.cols !== p.cols || s.rows !== p.rows)) {
        s.cols = p.cols;
        s.rows = p.rows;
        s.term.resize(p.cols, p.rows);
      }
    },

    message(ws, raw) {
      const s = sessions.get(ws.data.term!.target);
      if (!s || !s.clients.has(ws)) return;
      let msg: TermClientMsg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        return;
      }
      switch (msg?.t) {
        case 'in':
          if (typeof msg.d === 'string' && s.term && s.running) s.term.write(msg.d);
          break;
        case 'resize': {
          const cols = clampSize(String(msg.cols), 10, 500, s.cols);
          const rows = clampSize(String(msg.rows), 4, 300, s.rows);
          if (cols === s.cols && rows === s.rows) break;
          s.cols = cols;
          s.rows = rows;
          s.term?.resize(cols, rows);
          break;
        }
        case 'restart':
          if (s.running) break;
          if (!cwdFor(s.target)) {
            forget(s, 'That folder is gone.');
            break;
          }
          try {
            spawn(s);
            broadcast(s, { t: 'started' });
          } catch (err) {
            send(ws, { t: 'error', message: `Could not start a shell: ${errorMessage(err)}` });
          }
          break;
        case 'kill':
          log('term', `${s.target}: closed by ${ws.data.connId}`);
          forget(s, 'Terminal closed.');
          break;
      }
    },

    close(ws) {
      const target = ws.data.term?.target;
      if (target) sessions.get(target)?.clients.delete(ws);
    },

    async shutdown() {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => stop(s)));
    },
  };
}
