// OmpProcess: one `omp --mode rpc-ui` child speaking JSONL over stdio.
// Based on the verified research wrapper (research/omp-rpc-probe/omp-process.ts), plus:
//  - spawned `detached` so it leads its own process group; stop()/kill() signal the whole group
//    (omp's own children — bash tools, subagent workers — would otherwise survive us),
//  - protocol v2 chunk reassembly, typed callbacks instead of an EventEmitter.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { trackGroup } from '../child-groups';
import { tail } from './util';

export type OmpFrame = { type: string; [k: string]: unknown };
type Command = { type: string; [k: string]: unknown };

export interface OmpProcessOptions {
  bin: string;
  cwd: string;
  args: string[]; // everything after `--mode rpc-ui`
  env: Record<string, string | undefined>;
  /** How long omp may take to send `ready` (default 45 s). While omp still reports startup progress (its watchdog
   *  writes "Still starting after Ns — phase: …" to stderr every 10 s), the wait goes on, up to `maxReadyMs`. */
  readyTimeoutMs?: number;
  /** The longest wait while omp reports progress (default 4 × readyTimeoutMs). */
  maxReadyMs?: number;
}

/** omp didn't send `ready` in time. `progressed`: it reported startup progress meanwhile (slow, not hung). */
export class OmpStartTimeout extends Error {
  constructor(readonly seconds: number, readonly progressed: boolean, readonly stderr: string) {
    super(`The agent did not become ready within ${seconds}s.${stderr.trim() ? ` stderr: ${tail(stderr.trim(), 1500)}` : ''}`);
  }
}

/** omp's startup watchdog line (chalk colours stripped): "Still starting after 21s — phase: a > b". */
const WATCHDOG = /Still starting after (\d+)s(?:\s*[—-]+\s*phase:\s*([^\n]*))?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
/** A progress report counts while it is this fresh (omp writes one every 10 s). */
const PROGRESS_FRESH_MS = 15_000;

export class OmpCommandError extends Error {
  constructor(message: string, readonly command: string, readonly code?: string) {
    super(message);
  }
}

interface Pending {
  resolve: (f: OmpFrame) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OmpProcess {
  /** Every frame that is not a command response (events, prompt_result, UI requests, subagent frames…). */
  onFrame: (f: OmpFrame) => void = () => {};
  /** Fires once when the child exits (also after stop()). */
  onExit: (code: number | null, signal: string | null) => void = () => {};
  /** omp reported startup progress before `ready` (its watchdog line): seconds so far and the phase it is in. */
  onStartProgress: (seconds: number, phase: string) => void = () => {};

  #child?: ChildProcessWithoutNullStreams;
  #stderr = '';
  #seq = 0;
  #pending = new Map<string, Pending>();
  #promptWaiters = new Map<string, (f: OmpFrame) => void>();
  #chunks?: { id: string; count: number; parts: Buffer[] };
  #exited = false;
  #exitPromise?: Promise<void>;

  constructor(private readonly opts: OmpProcessOptions) {}

  get pid(): number | undefined {
    return this.#child?.pid;
  }
  get alive(): boolean {
    return !!this.#child && !this.#exited;
  }
  get stderr(): string {
    return this.#stderr;
  }

  /** Spawn and resolve on the `ready` frame; rejects with the stderr tail if omp exits first (e.g. no credentials). */
  start(): Promise<void> {
    const o = this.opts;
    const child = spawn(o.bin, ['--mode', 'rpc-ui', ...o.args], {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.#child = child;
    const untrack = trackGroup(child.pid); // the server's last step on shutdown kills what is still listed
    child.once('exit', untrack);
    child.once('error', untrack);
    child.stderr.setEncoding('utf8');
    let lastProgress = 0;
    let progressed = false;
    let isReady = false;
    child.stderr.on('data', (d: string) => {
      this.#stderr = (this.#stderr + d).slice(-64_000);
      if (isReady) return;
      const m = WATCHDOG.exec(d.replace(ANSI, ''));
      if (!m) return;
      lastProgress = Date.now();
      progressed = true;
      try {
        this.onStartProgress(Number(m[1]), (m[2] ?? '').trim());
      } catch {
        /* a display hook only */
      }
    });
    child.stdin.on('error', () => {}); // EPIPE after exit is reported via onExit
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.#onLine(line));

    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    this.#readyHook = () => {
      isReady = true;
      readyResolve();
    };
    const timeoutMs = o.readyTimeoutMs ?? 45_000;
    const maxMs = Math.max(timeoutMs, o.maxReadyMs ?? timeoutMs * 4);
    const t0 = Date.now();
    // A slow machine is not a hung omp: while omp keeps reporting startup progress, wait on (up to maxMs).
    const onDeadline = () => {
      const waited = Date.now() - t0;
      if (progressed && Date.now() - lastProgress < PROGRESS_FRESH_MS && waited < maxMs) {
        timer = setTimeout(onDeadline, Math.min(PROGRESS_FRESH_MS, maxMs - waited));
        return;
      }
      readyReject(new OmpStartTimeout(Math.round(waited / 1000), progressed, this.#stderr));
      this.kill();
    };
    let timer = setTimeout(onDeadline, timeoutMs);

    this.#exitPromise = new Promise<void>((resolveExit) => {
      child.once('error', (err) => {
        clearTimeout(timer);
        this.#exited = true;
        readyReject(new Error(`Could not start the agent (${o.bin}): ${err.message}`));
        this.#failPending(err);
        this.onExit(null, null);
        resolveExit();
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        this.#exited = true;
        const err = new Error(`The agent exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''}). ${this.#stderrSummary()}`);
        if (!isReady) readyReject(err);
        this.#failPending(err);
        this.onExit(code, signal);
        resolveExit();
      });
    });
    return ready.finally(() => clearTimeout(timer));
  }

  #readyHook: () => void = () => {};

  #stderrSummary(): string {
    const s = this.#stderr.trim();
    return s ? `stderr: ${tail(s, 1500)}` : '';
  }

  #failPending(err: Error) {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    const aborted: OmpFrame = { type: 'prompt_result', status: 'error', sessionSettled: true, error: { message: err.message } };
    for (const w of this.#promptWaiters.values()) w(aborted);
    this.#promptWaiters.clear();
  }

  #onLine(line: string) {
    if (!line.trim()) return;
    let frame: OmpFrame;
    try {
      frame = JSON.parse(line) as OmpFrame;
    } catch {
      return; // stdout carries only frames; ignore anything else
    }
    if (frame.type === 'rpc_chunk') {
      const c = frame as unknown as { chunkId: string; index: number; count: number; data: string };
      if (c.index === 0) this.#chunks = { id: c.chunkId, count: c.count, parts: [] };
      if (!this.#chunks || this.#chunks.id !== c.chunkId) {
        this.#chunks = undefined;
        return; // out-of-sequence chunk: drop the whole frame rather than crash
      }
      this.#chunks.parts.push(Buffer.from(c.data, 'base64'));
      if (this.#chunks.parts.length < this.#chunks.count) return;
      try {
        frame = JSON.parse(Buffer.concat(this.#chunks.parts).toString('utf8')) as OmpFrame;
      } finally {
        this.#chunks = undefined;
      }
    }
    switch (frame.type) {
      case 'ready':
        this.#readyHook();
        return;
      case 'response': {
        const id = frame.id as string | undefined;
        const p = id ? this.#pending.get(id) : undefined;
        if (p) {
          this.#pending.delete(id!);
          clearTimeout(p.timer);
          p.resolve(frame);
        }
        return; // late/duplicate responses are ignored
      }
      case 'prompt_result': {
        const w = this.#promptWaiters.get(frame.id as string);
        if (w) {
          this.#promptWaiters.delete(frame.id as string);
          w(frame);
        }
        break;
      }
    }
    try {
      this.onFrame(frame);
    } catch (err) {
      console.error('[omp] frame handler failed', err);
    }
  }

  write(obj: object): void {
    if (!this.alive) throw new Error('The agent process is not running');
    this.#child!.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /** Send a command and await its `response` frame (success or failure). */
  request(cmd: Command, timeoutMs = 30_000): Promise<OmpFrame> {
    const id = (cmd.id as string | undefined) ?? `c${++this.#seq}`;
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error('The agent process is not running'));
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The agent didn't answer the ${cmd.type} command in time`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.write({ ...cmd, id });
    });
  }

  /** Like request() but throws on success:false and returns `data`. */
  async call<T = unknown>(cmd: Command, timeoutMs?: number): Promise<T> {
    const r = await this.request(cmd, timeoutMs);
    if (!r.success) throw new OmpCommandError(String(r.error), String(r.command), r.code as string | undefined);
    return r.data as T;
  }

  /** prompt → resolves after admission; `result` resolves with the matching prompt_result
   *  (or a synthetic one when the turn was handled locally / the process died). omp shrinks attached images before
   *  it admits the prompt (seconds for big ones): give those a longer `ackTimeoutMs`. */
  async prompt(message: string, extra: Record<string, unknown> = {}, ackTimeoutMs = 60_000): Promise<{ result: Promise<OmpFrame> }> {
    const id = typeof extra.id === 'string' ? extra.id : `p${++this.#seq}`;
    const result = new Promise<OmpFrame>((res) => this.#promptWaiters.set(id, res));
    let ack: OmpFrame;
    try {
      ack = await this.request({ type: 'prompt', id, message, ...extra }, ackTimeoutMs);
    } catch (err) {
      this.#promptWaiters.delete(id);
      throw err;
    }
    if (!ack.success) {
      this.#promptWaiters.delete(id);
      throw new OmpCommandError(String(ack.error), 'prompt', ack.code as string | undefined);
    }
    if ((ack.data as { agentInvoked?: boolean } | undefined)?.agentInvoked === false) {
      this.#promptWaiters.delete(id);
      return { result: Promise.resolve({ type: 'prompt_result', id, status: 'completed', agentInvoked: false, sessionSettled: true }) };
    }
    return { result };
  }

  respondUi(id: string, payload: { value: string } | { confirmed: boolean } | { cancelled: true } | { answers: unknown[] }): void {
    if (this.alive) this.write({ type: 'extension_ui_response', id, ...payload });
  }

  /** Answer a `host_tool_call` (a tool RLT registered with set_host_tools). */
  respondHostTool(id: string, text: string, isError = false): void {
    if (this.alive) this.write({ type: 'host_tool_result', id, result: { content: [{ type: 'text', text }] }, isError });
  }

  /** Graceful stop: close stdin (omp drains and exits 0), then SIGTERM, then SIGKILL — always to the whole group. */
  async stop(graceMs = 3000): Promise<void> {
    if (!this.#child || this.#exited) return;
    try {
      this.#child.stdin.end();
    } catch {
      /* already closed */
    }
    const t1 = setTimeout(() => this.#signal('SIGTERM'), graceMs);
    const t2 = setTimeout(() => this.#signal('SIGKILL'), graceMs + 2000);
    await this.#exitPromise;
    clearTimeout(t1);
    clearTimeout(t2);
    // The leader is gone; make sure no stragglers (bash tools, workers) keep the group alive.
    this.#signal('SIGKILL');
  }

  /** Immediate SIGKILL of the whole process group. */
  kill(): void {
    this.#signal('SIGKILL');
  }

  #signal(sig: NodeJS.Signals) {
    const pid = this.#child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      /* group already gone */
    }
  }
}
