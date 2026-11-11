// Real Life Terminal — plain shell channel. A real login shell on this machine (in a PTY), NOT an omp session:
// nothing typed here goes to a model, and agents do not see it.
//
// Transport: one WebSocket per terminal tab at TERM_WS_PATH, same auth as /ws (Tailscale allowlist or pairing token,
// same-origin only).  Query: ?target=<TERM_TOWN | projectId | projectId:jobId>&cols=&rows=[&sid=&since=]
//   server → client  text frames: TermServerMsg JSON;  binary frames: raw PTY output (one ordered byte stream)
//   client → server  text frames: TermClientMsg JSON
// Targets (one shell each): TERM_TOWN — the workspace root; projectId — the house folder (Project.path);
// projectId:jobId — the folder that job works in: its own copy of the files when it has one (Job.worktree.path), else
// the house folder. The web uses the job form only for jobs with their own copy (jobs sharing the house folder share
// its shell). Removing the project or deleting the job closes its shells (a fatal `error`).
// The server keeps each shell alive across page reloads and reconnects (until it exits, is killed, or the server
// restarts) plus the last TERM_SCROLLBACK_BYTES of output, so a client that reconnects with ?sid=&since=<bytes seen>
// gets exactly the bytes it missed.

export const TERM_WS_PATH = '/term';
/** Target for the town shell, started in the workspace root (where RLT creates projects). */
export const TERM_TOWN = 'town';
export const TERM_SCROLLBACK_BYTES = 1024 * 1024;
/** Clients split pasted input into frames no larger than this. */
export const TERM_INPUT_CHUNK = 32 * 1024;

export type TermServerMsg =
  /** First frame after connecting. `offset` is the stream position of the next binary frame.
   *  mode: 'resume' — continues exactly where this client left off (same sid, nothing lost);
   *        'replay' — the whole kept scrollback follows; clear the screen first;
   *        'fresh'  — a new shell was just started for this target. */
  | { t: 'ready'; sid: string; target: string; cwd: string; shell: string; mode: 'resume' | 'replay' | 'fresh'; offset: number; exitCode: number | null; running: boolean }
  | { t: 'exit'; code: number | null }
  | { t: 'started' } // the shell was restarted after an exit; output continues on the same stream
  | { t: 'error'; message: string; fatal?: boolean };

export type TermClientMsg =
  | { t: 'in'; d: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'restart' } // start a new shell after the old one exited
  | { t: 'kill' }; // stop this shell and forget it (closing the tab)

/** GET /api/session → terminal: whether this server offers the browser terminal, and who its shells run as — the page
 *  warns before the first shell ("a real shell on <host> as <user>") and marks a root shell. enabled false: the owner
 *  turned the terminal off (config `terminal: false` / CAST_TERMINAL=0); /term refuses every connection. */
export interface TerminalAccess {
  enabled: boolean;
  user: string;
  host: string;
  root: boolean;
}

/** What /term answers (403) and the page shows when the terminal is turned off. */
export const TERM_DISABLED_MESSAGE = 'The terminal is turned off on this server (terminal: false in config.json, or CAST_TERMINAL=0).';
