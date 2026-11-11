// One `omp --mode rpc-ui` child, spawned and booted the way CAST does it (server/agents/process-pool.ts and
// omp-process.ts): the same argument order, its own process group, JSONL over stdio with protocol v2 chunk
// reassembly, and the same boot calls. Unlike CAST's OmpProcess it keeps every frame so checks can look back.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type Frame = { type: string; [k: string]: any };

/** What CAST's ProcessSpec turns into spawn arguments (process-pool.ts #spawn). */
export interface CastSpec {
  model: string;
  approvalMode: string;
  systemPrompt: string;
  sessionDir: string;
  thinking?: string;
  extensionDir?: string;
  configFile?: string;
  resumeFile?: string;
}

/** `omp --mode rpc-ui` + exactly CAST's argument list for a person. */
export function castArgs(s: CastSpec): string[] {
  const args = ['--model', s.model, '--approval-mode', s.approvalMode, '--append-system-prompt', s.systemPrompt, '--session-dir', s.sessionDir, '--no-title'];
  if (s.thinking) args.push('--thinking', s.thinking);
  if (s.extensionDir) args.push('--extension', s.extensionDir);
  if (s.configFile) args.push('--config', s.configFile);
  if (s.resumeFile) args.push('--resume', s.resumeFile);
  return args;
}

/** Every omp this run started and hasn't seen exit (killAll() on Ctrl-C). */
const live = new Set<Omp>();

/** SIGKILL the process group of every omp still running. */
export function killAll(): void {
  for (const o of live) o.kill();
}

export interface UiPolicy {
  /** Return true when the frame was handled (answered or deliberately left open). */
  (f: Frame, omp: Omp): boolean | void;
}

export class Omp {
  frames: Frame[] = [];
  /** Raw rpc_chunk frames as they came (before reassembly). */
  chunks: Frame[] = [];
  stderr = '';
  exited = false;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  readyAt = 0;
  /** Approvals and dialogs omp asked for (extension_ui_request with a dialog method). */
  ui: Frame[] = [];
  /** Test hook, tried before the default policy. */
  uiHook?: UiPolicy;
  /** Test hook for host_tool_call; return true when handled. Default: answer `HOST-RESULT <tool>`. */
  hostHook?: (f: Frame, omp: Omp) => boolean | void;
  /** Answer omp's approvals the way CAST's auto review does (the "Approve"/"Approve once" option). */
  autoApprove = true;
  /** Dialogs omp asked for that nobody answered yet (id → frame). */
  openDialogs = new Map<string, Frame>();
  /** Set after a failed step when omp no longer answered an abort: the group's remaining steps are skipped. */
  wedged = false;

  #child?: ChildProcessWithoutNullStreams;
  #seq = 0;
  #pending = new Map<string, (f: Frame) => void>();
  #waiters: { pred: (f: Frame) => boolean; res: (f: Frame) => void }[] = [];
  #chunk?: { id: string; count: number; parts: Buffer[] };
  #exit: Promise<void>;
  #exitResolve!: () => void;
  #log: string;

  constructor(
    readonly name: string,
    readonly opts: { bin: string; cwd: string; args: string[]; env: Record<string, string>; logDir: string; protocolArgs?: boolean },
  ) {
    mkdirSync(opts.logDir, { recursive: true });
    this.#log = join(opts.logDir, `${name}.frames.jsonl`);
    writeFileSync(this.#log, '');
    this.#exit = new Promise((r) => (this.#exitResolve = r));
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get alive(): boolean {
    return !!this.#child && !this.exited;
  }

  /** Spawn; resolves on the `ready` frame, rejects when omp exits first or after `timeoutMs` (CAST: 45 s). */
  start(timeoutMs = 45_000): Promise<void> {
    const child = spawn(this.opts.bin, ['--mode', 'rpc-ui', ...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.#child = child;
    live.add(this);
    child.once('exit', () => live.delete(this));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-64_000)));
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => this.#line(l));
    return new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const timer = setTimeout(() => {
        reject(new Error(`no ready frame within ${timeoutMs / 1000}s; stderr: ${this.stderr.trim().slice(-600)}`));
        this.kill();
      }, timeoutMs);
      this.waitFor((f) => f.type === 'ready', timeoutMs + 1000)
        .then(() => {
          clearTimeout(timer);
          this.readyAt = Date.now() - t0;
          resolve();
        })
        .catch(() => {});
      child.once('error', (err) => {
        clearTimeout(timer);
        this.exited = true;
        this.#exitResolve();
        reject(new Error(`could not start ${this.opts.bin}: ${err.message}`));
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        this.exited = true;
        this.exitCode = code;
        this.exitSignal = signal;
        appendFileSync(this.#log, `${JSON.stringify({ type: '__exit', code, signal })}\n`);
        this.#exitResolve();
        reject(new Error(`omp exited (code ${code}${signal ? `, ${signal}` : ''}) before ready; stderr: ${this.stderr.trim().slice(-600)}`));
      });
    });
  }

  #line(line: string) {
    if (!line.trim()) return;
    let f: Frame;
    try {
      f = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    if (f.type === 'rpc_chunk') {
      this.chunks.push({ ...f, data: `<${String(f.data ?? '').length} b64 chars>` });
      if (f.index === 0) this.#chunk = { id: f.chunkId, count: f.count, parts: [] };
      if (!this.#chunk || this.#chunk.id !== f.chunkId) {
        this.#chunk = undefined;
        return;
      }
      this.#chunk.parts.push(Buffer.from(String(f.data), 'base64'));
      if (this.#chunk.parts.length < this.#chunk.count) return;
      const whole = Buffer.concat(this.#chunk.parts).toString('utf8');
      this.#chunk = undefined;
      try {
        f = JSON.parse(whole) as Frame;
        f.__chunked = true;
      } catch {
        return;
      }
    }
    f.__t = Date.now();
    this.frames.push(f);
    if (f.type !== 'message_update') {
      const s = JSON.stringify(f);
      appendFileSync(this.#log, `${s.length > 20_000 ? `${s.slice(0, 20_000)}…` : s}\n`);
    }
    if (f.type === 'response' && f.id && this.#pending.has(f.id)) {
      const res = this.#pending.get(f.id)!;
      this.#pending.delete(f.id);
      res(f);
    }
    if (f.type === 'extension_ui_request') this.#onUi(f);
    if (f.type === 'host_tool_call') {
      if (!this.hostHook?.(f, this)) this.respondHostTool(f.id, `HOST-RESULT ${f.toolName}`);
    }
    for (const w of [...this.#waiters]) {
      if (w.pred(f)) {
        this.#waiters.splice(this.#waiters.indexOf(w), 1);
        w.res(f);
      }
    }
  }

  #onUi(f: Frame) {
    const method = String(f.method ?? '');
    if (!['select', 'confirm', 'input', 'editor', 'ask', 'cancel'].includes(method)) return; // notify / status noise
    this.ui.push(f);
    if (method === 'cancel') {
      this.openDialogs.delete(String(f.targetId));
      return;
    }
    this.openDialogs.set(String(f.id), f);
    if (this.uiHook?.(f, this)) return;
    if (method === 'select' && String(f.title ?? '').startsWith('Allow tool: ') && this.autoApprove) {
      const opts = (f.options ?? []).map(String);
      const approve = opts.find((o: string) => /^approve( once)?$/i.test(o)) ?? opts.find((o: string) => /^approve/i.test(o));
      if (approve) return this.respondUi(f.id, { value: approve });
    }
    if (method === 'ask') {
      const qs = (f.questions ?? []) as { id: string; options?: { label: string }[] }[];
      return this.respondUi(f.id, { answers: qs.map((q) => ({ id: q.id, selectedOptions: [q.options?.[0]?.label ?? ''] })) });
    }
    if (method === 'confirm') return this.respondUi(f.id, { confirmed: true });
    this.respondUi(f.id, { cancelled: true });
  }

  write(obj: object): void {
    if (!this.alive) throw new Error(`${this.name}: omp is not running`);
    this.#child!.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /** Send a command; resolves with its first `response` frame. */
  request(cmd: { type: string; [k: string]: unknown }, timeoutMs = 30_000): Promise<Frame> {
    const id = (cmd.id as string | undefined) ?? `c${++this.#seq}`;
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error(`${this.name}: omp is not running (exit ${this.exitCode}); stderr: ${this.stderr.trim().slice(-300)}`));
      const t = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${cmd.type}: no response within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.#pending.set(id, (f) => {
        clearTimeout(t);
        resolve(f);
      });
      this.write({ ...cmd, id });
    });
  }

  /** request() that throws on success:false and returns `data`. */
  async call<T = any>(cmd: { type: string; [k: string]: unknown }, timeoutMs?: number): Promise<T> {
    const r = await this.request(cmd, timeoutMs);
    if (!r.success) throw new Error(`${cmd.type} failed: ${String(r.error)}`);
    return r.data as T;
  }

  /** CAST's prompt: always with a streamingBehavior; returns the ack. */
  prompt(id: string, message: string, behavior: 'steer' | 'followUp' = 'followUp', extra: Record<string, unknown> = {}): Promise<Frame> {
    return this.request({ type: 'prompt', id, message, streamingBehavior: behavior, ...extra }, 60_000);
  }

  respondUi(id: string, payload: Record<string, unknown>): void {
    this.openDialogs.delete(id);
    if (this.alive) this.write({ type: 'extension_ui_response', id, ...payload });
  }

  respondHostTool(id: string, text: string, isError = false): void {
    if (this.alive) this.write({ type: 'host_tool_result', id, result: { content: [{ type: 'text', text }] }, isError });
  }

  /** Index to pass to waitFor/since so later checks only look at newer frames. */
  mark(): number {
    return this.frames.length;
  }

  since(from: number, pred?: (f: Frame) => boolean): Frame[] {
    const s = this.frames.slice(from);
    return pred ? s.filter(pred) : s;
  }

  /** The first frame (at or after `from`, when given) matching `pred`. */
  waitFor(pred: (f: Frame) => boolean, timeoutMs = 30_000, from?: number, what = 'frame'): Promise<Frame> {
    if (from !== undefined) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const w = { pred, res: resolve };
      this.#waiters.push(w);
      const t = setTimeout(() => {
        const i = this.#waiters.indexOf(w);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new Error(`${this.name}: timed out after ${timeoutMs / 1000}s waiting for ${what}`));
      }, timeoutMs);
      const res = w.res;
      w.res = (f) => {
        clearTimeout(t);
        res(f);
      };
    });
  }

  promptResult(id: string, from: number, timeoutMs = 60_000): Promise<Frame> {
    return this.waitFor((f) => f.type === 'prompt_result' && f.id === id, timeoutMs, from, `prompt_result ${id}`);
  }

  settled(from: number, timeoutMs = 60_000): Promise<Frame> {
    return this.waitFor((f) => f.type === 'session_settled', timeoutMs, from, 'session_settled');
  }

  /** Graceful stop like CAST: close stdin, SIGTERM the group after `graceMs`, SIGKILL 2 s later. */
  async stop(graceMs = 3000): Promise<{ graceful: boolean; ms: number }> {
    const t0 = Date.now();
    if (!this.#child || this.exited) return { graceful: true, ms: 0 };
    try {
      this.#child.stdin.end();
    } catch {
      /* closed */
    }
    let graceful = true;
    const t1 = setTimeout(() => {
      graceful = false;
      this.#signal('SIGTERM');
    }, graceMs);
    const t2 = setTimeout(() => this.#signal('SIGKILL'), graceMs + 2000);
    await this.#exit;
    clearTimeout(t1);
    clearTimeout(t2);
    this.#signal('SIGKILL'); // stragglers in the group
    return { graceful, ms: Date.now() - t0 };
  }

  kill(): void {
    this.#signal('SIGKILL');
  }

  #signal(sig: NodeJS.Signals) {
    const pid = this.#child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      /* gone */
    }
  }
}
