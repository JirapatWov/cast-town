// ProcessPool: at most one live omp process per person, spawned lazily, LRU-capped and idle-killed.
//
// Spawn: omp --mode rpc-ui --model <selector> --approval-mode <mode> --append-system-prompt <persona+role marker>
//        --session-dir <person's session dir> --no-title [--thinking x] [--resume <current thread's session file>]
//        [--extension <RLT's helpers root> (helper-agents.ts: task-tool helpers on other models; real models only)]
//        [--config <dataDir>/omp-config/<hash>.yml (the spec's settings overlay: leads' goal mode and advisor)]
//        [--config <dataDir>/omp-config/accounts.yml (CAST's account order; real models only)]
// (--resume, not --continue: a person can have several chats and must come back to the one that is current.)
// Boot:  negotiate_protocol v2 → set_event_filter delta → set_subagent_subscription progress → set_ask_dialog
//        → set_interrupt_mode wait → set_host_tools (leads: RLT's team tools) → get_state model check (strict: the
//        resolved model must be exactly the one requested).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OmpProcess, OmpStartTimeout, type OmpFrame } from './omp-process';
import { log } from './util';

export interface ProcessSpec {
  agentId: string;
  projectId: string;
  roleId: string;
  cwd: string;
  model: string; // effective omp selector (real provider/id, or rlt-demo/<id> on the scripted test model)
  demo: boolean;
  approvalMode: string;
  systemPrompt: string; // appended persona incl. the [rlt-role:…] marker
  thinking?: string;
  sessionDir: string; // omp --session-dir (data-layout.ts sessionDirFor)
  /** The current thread's omp session file to reopen (only when it exists on disk); otherwise a fresh session. */
  resumeFile?: string;
  /** The thread this spawn is for: the session file omp reports after booting belongs to it (not to whatever
   *  thread is current by then). */
  threadId?: string;
  /** Tools RLT itself runs for this person (omp set_host_tools; calls arrive as host_tool_call frames). */
  hostTools?: HostToolDef[];
  /** An omp extension root whose agents/ holds RLT's helpers by model (`--extension`; a constant path). */
  extensionDir?: string;
  /** omp settings for this process only (config.yml-style YAML, e.g. goal mode and the advisor): written once to a
   *  file named by its hash and passed as `--config`. */
  settingsOverlay?: string;
}

/** What omp's get_state said right after booting (the model check reads it anyway). */
export interface BootState {
  sessionFile?: string;
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number };
  goal?: { goal?: unknown } | null; // omp's GoalModeState
}

/** omp RpcHostToolDefinition. */
export interface HostToolDef {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 'essential': always in the model's tool list (omp's default for host tools hides them behind xd://). */
  loadMode?: 'essential' | 'discoverable';
}

/** A start that stop()/stopWhere() called off (the person moved out or settings changed) — not an omp failure. */
export class StartCancelled extends Error {
  constructor(agentId: string) {
    super(`${agentId}: the agent's start was cancelled`);
  }
}

export interface PoolOptions {
  ompBin: string;
  baseEnv: Record<string, string | undefined>;
  /** The scripted model's agent dir (CAST_MOCK_LLM only; absent: a spec on rlt-demo/* is refused). */
  demoAgentDir?: string;
  dataDir: string;
  maxLive?: number;
  idleMs?: number;
  /** How long a person's omp may take to start (CAST_AGENT_START_TIMEOUT; omp-process.ts waits longer while omp
   *  reports progress). Default 45 s. */
  startTimeoutMs?: number;
  /** omp is still starting and said how far it got (its watchdog line, every 10 s): shown on the person. */
  onStartProgress?(agentId: string, seconds: number, phase: string): void;
  onFrame(agentId: string, frame: OmpFrame): void;
  onExit(agentId: string, info: { code: number | null; signal: string | null; stderr: string; expected: boolean }): void;
  /** Keep this omp up: no idle stop, never stopped to make room. */
  isBusy(agentId: string): boolean;
  /** Working right now, so new settings must wait for the next acquire (default: isBusy). A lead whose goal is active
   *  is busy, but between the goal's turns it can be restarted. */
  inFlight?(agentId: string): boolean;
  /** omp reported which session file this freshly booted process is on (spec.threadId names its thread). */
  onSession?(agentId: string, sessionFile: string | undefined, spec: ProcessSpec): void;
  /** CAST's account order for omp (account-order.ts): a --config file every real-model omp gets after the spec's own
   *  overlay — a constant path omp hot-reloads, so not part of the spec. Returns its path once it exists. */
  accountsOverlay?(): string | undefined;
  /** Bumped when the extra omp environment changed (omp-env.ts): a real-model omp started before that is restarted on
   *  its next acquire while idle, like a settings change (a busy one keeps going until then). */
  envGeneration?(): number;
}

interface Entry {
  proc: OmpProcess;
  spec: ProcessSpec;
  key: string;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  stopping: boolean;
  ready: boolean; // finished the boot sequence (exits before that are start failures, not crashes)
  boot?: BootState;
  envGen: number; // envGeneration() when it was spawned
}

/** A spawn in progress. stop() flags it and kills the half-booted process instead of letting it finish. */
interface Pending {
  promise: Promise<OmpProcess>;
  spec: ProcessSpec;
  cancelled: boolean;
  proc?: OmpProcess;
}

// resumeFile is not part of the key: a live process changes chats with switch_session / new_session instead.
const specKey = (s: ProcessSpec) =>
  JSON.stringify([s.cwd, s.model, s.demo, s.approvalMode, s.systemPrompt, s.thinking ?? '', s.sessionDir, s.hostTools ?? [], s.extensionDir ?? '', s.settingsOverlay ?? '']);

/** The overlay file for this YAML text: `<dataDir>/omp-config/<sha256 first 16>.yml`, written once (omp exits before
 *  `ready` when a --config file is missing, and watches it, so a file is never rewritten in place). */
export function writeSettingsOverlay(dataDir: string, yaml: string): string {
  const dir = join(dataDir, 'omp-config');
  const file = join(dir, `${createHash('sha256').update(yaml).digest('hex').slice(0, 16)}.yml`);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, yaml);
  renameSync(tmp, file);
  return file;
}

/** BUN_OPTIONS plus Bun's `--dns-result-order=ipv4first`, unless it already picks an order. */
function withIpv4First(opts: string | undefined): string {
  if (opts?.includes('--dns-result-order')) return opts;
  return opts ? `--dns-result-order=ipv4first ${opts}` : '--dns-result-order=ipv4first';
}

/** omp's own helpers don't count as the person's background work: its Python kernel, its worker processes
 *  (`cli.js __omp_worker_*`: daemon, JS eval) and the browser it drives. */
const OMP_HELPER = /omp-python-runner|__omp_worker|chrom(e|ium)|headless_shell|chrome_crashpad/i;

/** Programs still running under this omp that the person started (dev servers, watchers, long scripts). Linux /proc. */
export function backgroundJobs(rootPid: number): string[] {
  const kids = new Map<number, number[]>();
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid)!.push(Number(name));
      } catch {
        /* exited meanwhile */
      }
    }
  } catch {
    return []; // no /proc (macOS): idle stop as before
  }
  const jobs: string[] = [];
  const queue = [...(kids.get(rootPid) ?? [])];
  while (queue.length) {
    const pid = queue.shift()!;
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      continue;
    }
    if (OMP_HELPER.test(cmd)) continue; // and whatever it spawned
    if (cmd) jobs.push(cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd);
    queue.push(...(kids.get(pid) ?? []));
  }
  return jobs;
}

export class ProcessPool {
  #live = new Map<string, Entry>();
  #starting = new Map<string, Pending>();
  /** Stops in flight: a new spawn for the same person waits for the old process to be gone (same session file). */
  #stopping = new Map<string, Promise<void>>();
  #pidFile: string;
  #shuttingDown = false;
  readonly maxLive: number;
  readonly idleMs: number;

  constructor(private readonly o: PoolOptions) {
    this.maxLive = o.maxLive ?? 10;
    this.idleMs = o.idleMs ?? 10 * 60_000;
    this.#pidFile = join(o.dataDir, 'omp-pids.json');
  }

  #envGen(): number {
    return this.o.envGeneration?.() ?? 0;
  }

  get(agentId: string): OmpProcess | undefined {
    const e = this.#live.get(agentId);
    return e && e.proc.alive && !e.stopping ? e.proc : undefined;
  }

  isStarting(agentId: string): boolean {
    return this.#starting.has(agentId);
  }

  /** What omp reported when the person's live process booted (context usage, goal, session file). */
  bootState(agentId: string): BootState | undefined {
    const e = this.#live.get(agentId);
    return e && e.proc.alive && !e.stopping ? e.boot : undefined;
  }

  /** The spec the person's live (or booting-done) process runs with. */
  spec(agentId: string): ProcessSpec | undefined {
    const e = this.#live.get(agentId);
    return e && e.proc.alive && !e.stopping ? e.spec : undefined;
  }

  /** The live process was switched to `spec` without a restart (omp set_model / set_thinking_level): the next acquire
   *  with it keeps the process. Only the model and the thinking level may differ; false (nothing changed) otherwise,
   *  or when the person has no ready process. */
  retarget(agentId: string, spec: ProcessSpec): boolean {
    const e = this.#live.get(agentId);
    if (!e || !e.proc.alive || e.stopping || !e.ready || this.#starting.has(agentId)) return false;
    if (specKey({ ...e.spec, model: spec.model, thinking: spec.thinking }) !== specKey(spec)) return false;
    e.spec = { ...e.spec, model: spec.model, thinking: spec.thinking };
    e.key = specKey(e.spec);
    return true;
  }

  /** The live process could switch to `spec` in place: ready, and only the model or thinking level differ. */
  canRetarget(agentId: string, spec: ProcessSpec): boolean {
    const e = this.#live.get(agentId);
    if (!e || !e.proc.alive || e.stopping || !e.ready || this.#starting.has(agentId)) return false;
    return e.key !== specKey(spec) && specKey({ ...e.spec, model: spec.model, thinking: spec.thinking }) === specKey(spec);
  }

  liveIds(): string[] {
    return [...this.#live.keys()];
  }

  /** Mark activity (resets the idle-kill timer). */
  touch(agentId: string): void {
    const e = this.#live.get(agentId);
    if (!e) return;
    e.lastUsed = Date.now();
    this.#armIdle(agentId, e);
  }

  /** Live process for this spec, spawning (or respawning on spec change while idle) as needed. */
  async acquire(spec: ProcessSpec): Promise<OmpProcess> {
    if (this.#shuttingDown) throw new Error('CAST is shutting down');
    // Never omp on rlt-demo/* without the scripted model: it would call whatever listens on its port.
    if (spec.demo && !this.o.demoAgentDir) throw new Error('No AI account is connected for this model — connect one under Models & providers.');
    const pending = this.#starting.get(spec.agentId);
    if (pending && !pending.cancelled) return pending.promise;
    if (pending) await pending.promise.catch(() => {}); // a called-off boot is still winding down
    await this.#stopping.get(spec.agentId);
    const cur = this.#live.get(spec.agentId);
    if (cur && cur.proc.alive && !cur.stopping) {
      const envChanged = !spec.demo && cur.envGen !== this.#envGen();
      if ((cur.key === specKey(spec) && !envChanged) || (this.o.inFlight ? this.o.inFlight(spec.agentId) : this.o.isBusy(spec.agentId))) {
        this.touch(spec.agentId);
        return cur.proc;
      }
      log('pool', `${spec.agentId}: ${cur.key === specKey(spec) ? 'agent environment' : 'settings'} changed → restarting the agent`);
      await this.stop(spec.agentId);
    }
    // Another acquire may have started a spawn while this one waited.
    const raced = this.#starting.get(spec.agentId);
    if (raced && !raced.cancelled) return raced.promise;
    const job: Pending = { spec, cancelled: false } as Pending;
    job.promise = this.#spawn(spec, job)
      .catch(async (err: unknown) => {
        // One retry when omp died while booting (not for a model mismatch): a first start in a fresh agent dir can
        // race another process booting at the same moment. And one when it hung without a word (no startup progress
        // at all) — a slow start that kept reporting progress already had its long wait: another would be as slow.
        if (job.cancelled || this.#shuttingDown || !(err instanceof Error)) throw err;
        const silentHang = err instanceof OmpStartTimeout && !err.progressed;
        if (!silentHang && !/^The agent exited/.test(err.message)) throw err;
        if (/No API key|No default model|credential|not found|Invalid|Unknown/i.test(err.message)) throw err; // won't fix itself
        await new Promise((r) => setTimeout(r, 700));
        if (job.cancelled) throw new StartCancelled(spec.agentId);
        if (this.#shuttingDown) throw err;
        log('pool', `${spec.agentId}: retrying the agent's start once`);
        return this.#spawn(spec, job);
      })
      .finally(() => {
        if (this.#starting.get(spec.agentId) === job) this.#starting.delete(spec.agentId);
      });
    this.#starting.set(spec.agentId, job);
    return job.promise;
  }

  async #spawn(spec: ProcessSpec, job: Pending): Promise<OmpProcess> {
    await this.#makeRoom();
    if (job.cancelled) throw new StartCancelled(spec.agentId);
    const sessionDir = spec.sessionDir;
    mkdirSync(sessionDir, { recursive: true });
    const args = [
      '--model', spec.model,
      '--approval-mode', spec.approvalMode,
      '--append-system-prompt', spec.systemPrompt,
      '--session-dir', sessionDir,
      '--no-title',
    ];
    if (spec.thinking) args.push('--thinking', spec.thinking);
    if (spec.extensionDir) args.push('--extension', spec.extensionDir);
    if (spec.settingsOverlay) args.push('--config', writeSettingsOverlay(this.o.dataDir, spec.settingsOverlay));
    const accounts = spec.demo ? undefined : this.o.accountsOverlay?.();
    if (accounts) args.push('--config', accounts);
    // omp exits with "Session not found" for a missing file, so only resume what is really there.
    // A session recorded in another folder would make omp move there (it follows the session header's cwd),
    // e.g. after a removed project's id was given to a new one: start fresh instead.
    const resuming = !!spec.resumeFile && existsSync(spec.resumeFile) && sessionCwdMatches(spec.resumeFile, spec.cwd);
    if (spec.resumeFile && !resuming) log('pool', `${spec.agentId}: not resuming ${spec.resumeFile} (missing or recorded in another folder) → fresh session`);
    if (resuming) args.push('--resume', spec.resumeFile!);
    const env: Record<string, string | undefined> = { ...this.o.baseEnv };
    if (spec.demo) env.PI_CODING_AGENT_DIR = this.o.demoAgentDir;
    // IPv6 to api.anthropic.com crawls on this host (KB/s uploads) and omp's Anthropic transport (node:https) dials
    // the first dns.lookup() answer, which is IPv6. Bun reads BUN_OPTIONS at startup: lookups go IPv4-first for this
    // omp (and the bun programs it starts) only — nothing system-wide; IPv6 stays the fallback.
    env.BUN_OPTIONS = withIpv4First(env.BUN_OPTIONS);
    const proc = new OmpProcess({ bin: this.o.ompBin, cwd: spec.cwd, args, env, readyTimeoutMs: this.o.startTimeoutMs });
    job.proc = proc;
    proc.onStartProgress = (seconds, phase) => {
      if (!job.cancelled) this.o.onStartProgress?.(spec.agentId, seconds, phase);
    };
    const entry: Entry = { proc, spec, key: specKey(spec), lastUsed: Date.now(), stopping: false, ready: false, envGen: this.#envGen() };
    proc.onFrame = (f) => {
      entry.lastUsed = Date.now();
      this.o.onFrame(spec.agentId, f);
    };
    proc.onExit = (code, signal) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (this.#live.get(spec.agentId) === entry) this.#live.delete(spec.agentId);
      this.#savePids();
      // A process that never finished booting is reported by acquire() (the caller gets the error), not as a crash.
      this.o.onExit(spec.agentId, { code, signal, stderr: proc.stderr, expected: entry.stopping || this.#shuttingDown || !entry.ready });
    };
    const t0 = Date.now();
    const check = () => {
      if (job.cancelled) throw new StartCancelled(spec.agentId);
    };
    try {
      await proc.start();
      check();
      this.#live.set(spec.agentId, entry);
      this.#savePids();
      await proc.call({ type: 'negotiate_protocol', protocolVersion: 2 });
      await proc.call({ type: 'set_event_filter', events: null, messageUpdates: 'delta' });
      await proc.call({ type: 'set_subagent_subscription', level: 'progress' });
      await proc.call({ type: 'set_ask_dialog', enabled: true });
      // A message sent with "Send now" waits for the running command instead of pushing it into a background job
      // (which would wake the person again later). Not fatal: the default only behaves differently.
      await proc.call({ type: 'set_interrupt_mode', mode: 'wait' }).catch((err: unknown) => log('pool', `${spec.agentId}: set_interrupt_mode failed: ${err instanceof Error ? err.message : String(err)}`));
      if (spec.hostTools?.length) await proc.call({ type: 'set_host_tools', tools: spec.hostTools });
      check();
      entry.boot = await this.#verifyModel(proc, spec);
      check();
      entry.ready = true;
      this.o.onSession?.(spec.agentId, entry.boot.sessionFile, spec);
    } catch (err) {
      entry.stopping = true;
      if (this.#live.get(spec.agentId) === entry) this.#live.delete(spec.agentId);
      if (job.cancelled) {
        log('pool', `${spec.agentId}: start called off after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } else {
        log('pool', `${spec.agentId} could not start the agent after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err instanceof Error ? err.message : String(err)}`);
      }
      await proc.stop(500).catch(() => proc.kill());
      this.#savePids();
      throw job.cancelled ? new StartCancelled(spec.agentId) : err;
    }
    this.#armIdle(spec.agentId, entry);
    log('pool', `${spec.agentId} ready on ${spec.model}${spec.demo ? ' (scripted)' : ''}${resuming ? ' · resumed its chat' : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s, pid ${proc.pid}`);
    return proc;
  }

  /** Strict model check: omp must have resolved exactly the requested model (never a silent fallback).
   *  Returns the rest of what omp said (session file, context usage, goal). */
  async #verifyModel(proc: OmpProcess, spec: ProcessSpec): Promise<BootState> {
    const state = await proc.call<BootState & { model?: { provider?: string; id?: string } }>({ type: 'get_state' }, 20_000);
    const got = state.model ? `${state.model.provider}/${state.model.id}` : 'no model';
    if (got !== spec.model) {
      throw new Error(`The agent resolved ${got} instead of the requested ${spec.model}; refusing to run on a different model`);
    }
    return { sessionFile: state.sessionFile, contextUsage: state.contextUsage, goal: state.goal };
  }

  #armIdle(agentId: string, e: Entry) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    e.idleTimer = setTimeout(() => {
      if (this.o.isBusy(agentId)) return this.#armIdle(agentId, e);
      // a server or watcher the person started dies with omp (the link they gave would go dead): keep them
      const jobs = e.proc.pid ? backgroundJobs(e.proc.pid) : [];
      if (jobs.length) {
        log('pool', `${agentId} idle but still running ${jobs[0]}${jobs.length > 1 ? ` (+${jobs.length - 1} more)` : ''} → keeping the agent`);
        return this.#armIdle(agentId, e);
      }
      log('pool', `${agentId} idle for ${Math.round(this.idleMs / 60000)} min → stopping the agent`);
      void this.stop(agentId);
    }, this.idleMs);
  }

  /** Enforce the live-process cap by stopping the least recently used idle person. */
  async #makeRoom() {
    while (this.#live.size >= this.maxLive) {
      const victim = [...this.#live.entries()]
        .filter(([id, e]) => !e.stopping && !this.o.isBusy(id))
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!victim) {
        log('pool', `cap of ${this.maxLive} live processes reached and all are busy — spawning anyway`);
        return;
      }
      log('pool', `cap reached → stopping least recently used ${victim[0]}`);
      await this.stop(victim[0]);
    }
  }

  /** Stop this person's omp — also a process that is still booting (its acquire() rejects with StartCancelled). */
  async stop(agentId: string): Promise<void> {
    const pending = this.#starting.get(agentId);
    if (pending) {
      pending.cancelled = true;
      void pending.proc?.stop(500).catch(() => pending.proc?.kill());
      await pending.promise.catch(() => {});
    }
    const e = this.#live.get(agentId);
    if (!e) return this.#stopping.get(agentId);
    if (e.stopping) return this.#stopping.get(agentId);
    e.stopping = true;
    if (e.idleTimer) clearTimeout(e.idleTimer);
    const done = e.proc
      .stop(3000)
      .catch(() => e.proc.kill())
      .finally(() => {
        if (this.#live.get(agentId) === e) this.#live.delete(agentId);
        if (this.#stopping.get(agentId) === done) this.#stopping.delete(agentId);
        this.#savePids();
      });
    this.#stopping.set(agentId, done);
    return done;
  }

  /** Stop every live or booting process whose spec matches. */
  async stopWhere(pred: (spec: ProcessSpec) => boolean): Promise<void> {
    const ids = new Set<string>();
    for (const e of this.#live.values()) if (pred(e.spec)) ids.add(e.spec.agentId);
    for (const p of this.#starting.values()) if (pred(p.spec)) ids.add(p.spec.agentId);
    await Promise.all([...ids].map((id) => this.stop(id)));
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    await Promise.all([...new Set([...this.#starting.keys(), ...this.#live.keys()])].map((id) => this.stop(id)));
    this.#savePids();
  }

  #savePids() {
    try {
      const pids = [...this.#live.values()].map((e) => e.proc.pid).filter((p): p is number => !!p);
      writeFileSync(this.#pidFile, JSON.stringify(pids));
    } catch {
      /* best effort */
    }
  }

  /** Kill omp process groups left behind by a previous RLT run that crashed (only ones using our data dir). */
  reapOrphans(): void {
    if (!existsSync(this.#pidFile)) return;
    let pids: number[] = [];
    try {
      pids = JSON.parse(readFileSync(this.#pidFile, 'utf8')) as number[];
    } catch {
      return;
    }
    for (const pid of pids) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes('rpc-ui') && cmd.includes(join(this.o.dataDir, 'sessions'))) {
          process.kill(-pid, 'SIGKILL');
          log('pool', `reaped orphaned agent process group ${pid}`);
        }
      } catch {
        /* not running */
      }
    }
    this.#savePids();
  }
}


/** True when the omp session file was recorded in `cwd` (its `session` header line). omp --resume and
 *  switch_session move the process into the recorded folder, so a session from another folder must not be reopened. */
export function sessionCwdMatches(file: string, cwd: string): boolean {
  const recorded = sessionCwd(file);
  return recorded === undefined || resolve(recorded) === resolve(cwd);
}

/** The cwd in an omp session file's header (undefined when the file has none or cannot be read). */
export function sessionCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(16_384);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n').slice(0, 6)) {
      if (!line.includes('"session"')) continue;
      try {
        const h = JSON.parse(line) as { type?: string; cwd?: unknown };
        if (h.type === 'session') return typeof h.cwd === 'string' ? h.cwd : undefined;
      } catch {
        /* a padded or torn line */
      }
    }
  } catch {
    /* unreadable: let omp decide */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}
