// AgentRuntime: the life of one person (resident or workflow role) — prompts, activity, status, transcript.
//
// Activity policy (ARCHITECTURE "Event normalization"):
//   prompt → listening (≥1.2 s) → thinking on first delta → tool activity by tool name → thinking …
//   approval pending → waiting_approval · prompt_result completed → done → idle ~5 s after session_settled
//   prompt_result error → error. Helpers still out after the parent's turn ended → delegating "N helpers working" and
//   `available` (still busy for the pool and workflows, but a new message starts a turn right away).
// A message sent while the person works goes to omp's queues (queue: read when it would have finished; steer: read at
// its next step) and shows as an AgentInfo.queue chip; it becomes a chat bubble only when omp hands it to the model
// (the user message_start). A message sent while idle is a bubble at once.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isQuestion } from '../../shared/ask';
import type { Activity, AgentInfo, ContextUsage, GoalInfo, ImageRef, QueuedMessage, TranscriptItem } from '../../shared/protocol';
import { UserError } from '../util';
import type { AccountPlan } from './account-order';
import type { AgentStore } from './agent-store';
import { approvalOrigin, type ApprovalBook, type RunningCall } from './approvals';
import type { GitRefresher } from './git-refresh';
import { FrameNormalizer, parseOmpGoal, type AgentEvent, type OmpGoal } from './normalize';
import type { OmpFrame, OmpProcess } from './omp-process';
import { sessionCwdMatches, StartCancelled, type BootState, type ProcessPool, type ProcessSpec } from './process-pool';
import { splitSelector } from './models';
import type { SubagentTracker } from './subagents';
import type { ThreadBook, ThreadRecord } from './thread-store';
import { describeStartFailure } from './start-failure';
import { EmptyStreak, retriesOf, stuckKind, stuckText, type StuckKind } from './empty-answer';
import { explainAuthError } from './login-failure';
import type { JournalEntry, JournalMessage } from './work-journal';
import { activityForTool, mayChangeFiles } from './tool-display';
import { errorText, hash32, log, tail, truncate } from './util';

/** Minimum time an activity stays on screen before a calmer one (thinking/done/idle) replaces it. */
const DWELL_MS: Partial<Record<Activity, number>> = { listening: 1200, reading: 1500, writing: 1500, running: 1500, searching: 1500 };
const DONE_TO_IDLE_MS = 5000;
const ERROR_TO_IDLE_MS = 8000;
/** omp shrinks attached images before it admits a prompt: seconds for big ones, ~15 s for several. */
const IMAGE_ACK_MS = 180_000;
/** A compaction summarizes the chat with the model: minutes for a long one. */
const COMPACT_MS = 10 * 60_000;
const STATS_MS = 5000;
const MAX_CHIP = 300;

export interface PromptOutcome {
  status: 'completed' | 'aborted' | 'error';
  text: string; // final assistant text ('' when none)
  error?: string;
}

export interface PromptOptions {
  /** Images for omp (base64), and the same images as uploads (`imageRefs`, what the chat shows — never base64). */
  images?: { mimeType: string; data: string }[];
  imageRefs?: ImageRef[];
  /** Only matters while the person works: 'queue' (default) → read when it would have finished; 'steer' → at its next step. */
  mode?: 'queue' | 'steer';
  by?: 'user' | 'rlt';
  /** RLT's own message (a team update; implies by 'rlt'): the chat shows this line instead of a user bubble. */
  shown?: string;
  /** A chat message the user typed (not a workflow step): kept in in-flight.json until it is answered, so a restart
   *  can say it was interrupted (work-journal.ts). */
  chat?: boolean;
}

/** A message the person hadn't read, handed back to the composer (Stop, or × on its chip). */
export interface Draft {
  text: string;
  images: ImageRef[];
}

/** A message RLT sent that omp hasn't handed to the model yet. */
interface Sent {
  key: string; // QueuedMessage.key
  promptId: string;
  text: string;
  images: ImageRef[];
  mode: 'steer' | 'queue';
  by: 'user' | 'rlt';
  shown?: string;
  /** Sent while idle: its bubble is already in the chat (no chip; its user message_start adds nothing). */
  echoed: boolean;
  /** That bubble (or RLT's line), taken out again if omp hands the message back unread (Stop). */
  itemId?: string;
  /** The user's own chat message (PromptOptions.chat). */
  chat: boolean;
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Why a chat can't change (new chat, switch, compact) while its goal is active — even with omp idle between turns. */
export const GOAL_BLOCKS = (name: string, what: string) =>
  `${name} is working toward a goal in this chat — pause or drop the goal first to ${what}.`;
/** 120k / 9.6k / 850 */
const fmtTokens = (n: number) => (n >= 9_950 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export interface RuntimeDeps {
  store: AgentStore;
  pool: ProcessPool;
  approvals: ApprovalBook;
  subagents: SubagentTracker;
  git: GitRefresher;
  threads: ThreadBook;
  /** Fresh process spec for this agent (project path, model resolution, persona) or null when it no longer exists. */
  specFor(agentId: string): ProcessSpec | null;
  /** A tool that may change files finished (workflow runs note who else worked in the folder meanwhile). */
  onFileTool?(agentId: string, tool: string, args: unknown): void;
  toast(level: 'info' | 'success' | 'warn' | 'error', text: string, projectId?: string, agentId?: string): void;
  /** The current chat's account as RLT wants it now (its own pick, else the order; account-order.ts); null → none to
   *  manage (the scripted test model or an API-key model, a temporary person, a single account). */
  accountPlan?(agentId: string): (AccountPlan & { read: boolean }) | null;
  /** What RLT knows of the chat's account changed (AgentInfo.account is worked out again). */
  accountChanged?(agentId: string): void;
  /** Resolves when omp can have reloaded a just rewritten account order (a message right after it would still go
   *  out by the old order). */
  accountsSettled?(agentId: string): Promise<void>;
  /** Something to wait for before omp may start (the first AI-account check): shown as `detail` meanwhile. */
  beforeStart?(agentId: string): { detail: string; promise: Promise<void> } | null;
  /** Why the person can't start now (their model isn't connected while another one is), or null. */
  blocked?(agentId: string): string | null;
  /** CAST_AGENT_START_TIMEOUT in seconds, for the "took too long" message. */
  startTimeoutS?: number;
  /** What CAST runs as omp, for the "not installed" message. */
  ompBin?: string;
  /** What the person is doing for the user changed: kept on disk for the next start (work-journal.ts). */
  journal?(agentId: string, entry: JournalEntry | null): void;
  /** Per-turn undo (turn-changes.ts): begin before a chat message of the user starts a turn, end when it settles. */
  turns?: { begin(agentId: string): Promise<void>; end(agentId: string): void; cancel(agentId: string): void };
}

interface Waiter {
  id: string;
  phase: 'result' | 'settle';
  status: PromptOutcome['status'];
  error?: string;
  resolve: (o: PromptOutcome) => void;
}

type Base = { activity: Activity; detail?: string; tool?: string };

let promptSeq = 0;
/** Transcript item ids are persisted per thread, so they must stay unique across server restarts. */
const uid = () => `${Date.now().toString(36)}${(++promptSeq).toString(36)}`;

export class AgentRuntime {
  #normalizer?: FrameNormalizer;
  #gen = 0;
  #working = false; // between agent_start (or our prompt) and session_settled
  #waiters: Waiter[] = [];
  #tools = new Map<string, RunningCall>(); // running toolCallId → tool
  #autoCleared = new Set<string>(); // toolCallIds Auto mode's rules let run without asking (labelled in the chat)
  #base: Base = { activity: 'idle' };
  #holdUntil = 0;
  #deferTimer?: ReturnType<typeof setTimeout>;
  #idleTimer?: ReturnType<typeof setTimeout>;
  #lastError?: string;
  #lastText = '';
  /** Between prompt() and a live process: an expected exit now is the pool restarting omp for new settings. */
  #acquiring = false;
  #mismatchWarned = false;
  /** Moved out (job/project deleted, role dropped): nothing may start or report for this person any more. */
  #retired = false;
  /** Waiting for the user outside omp's approvals (a plan card): shown like an approval until it is answered. */
  #waitingFor: string | null = null;
  /** Bumped by every Stop: a prompt still waiting for omp to boot sees it changed and is never sent. */
  #stops = 0;
  /** What RLT sent that omp hasn't handed to the model yet (send order): queue chips, and bubbles shown at send. */
  #sent: Sent[] = [];
  /** Of those, the ones still waiting for a live omp: an exit meanwhile (the pool restarting omp for new settings)
   *  is the old process's — they go to the new one, so their records stay. */
  #booting = new Set<Sent>();
  /** Prompts taken back out of omp's queue (× on a chip): omp still reports them finished later — that means nothing. */
  #withdrawn = new Set<string>();
  /** This Stop's "Stopped." line is in the chat (omp reports every prompt the Stop ended as aborted). */
  #stopNoted = false;
  #compacting = false;
  /** The process whose boot report (context, goal) was taken. */
  #proc?: OmpProcess;
  #refreshing = false;
  #refreshAgain = false;
  #lastNotice = '';
  /** Per advisor transcript (__advisor.jsonl): bytes whose spend is already counted. */
  #advisorRead = new Map<string, number>();
  /** omp was restarted for new settings while the goal was active: it comes back paused, so resume it once the
   *  message that restarted it is in (a restart omp didn't ask for — a crash, RLT's — leaves it paused). */
  #resumeGoal = false;
  /** RLT's own session commands on the live omp (account pin / fork, model switch, chat switch) and the sending of a
   *  prompt run one after another: a fork or pin must never meet a turn RLT is just starting. */
  #ops: Promise<unknown> = Promise.resolve();
  /** This process already checked that omp is on this chat's own account (once per process and chat). */
  #accountChecked?: { proc: OmpProcess; threadId: string };
  /** The model the person was on when theirs changed mid-turn: its answers until the turn ends are no surprise. */
  #prevModel?: string;
  /** The user's chat message the current turn works on (for in-flight.json). */
  #turn?: JournalMessage;
  /** Consecutive identical empty answers (empty-answer.ts): from the 2nd one the chat shows the way out. */
  #empty = new EmptyStreak();

  constructor(readonly agentId: string, readonly projectId: string, private readonly d: RuntimeDeps) {}

  /** True while anything is in flight or a lead's goal is active (omp keeps working on it between turns of its own):
   *  the pool never idle-stops such a person, nor stops them to make room. */
  get busy(): boolean {
    return this.inFlight || this.goalActive();
  }

  /** Something is under way right now (a turn, a compaction, omp booting, helpers out): only then do new settings
   *  (model, brief, advisor) wait — between a goal's turns they restart omp, and the goal is resumed (#resumeGoal). */
  get inFlight(): boolean {
    return (
      this.#working ||
      this.#compacting ||
      this.#waiters.length > 0 ||
      this.d.pool.isStarting(this.agentId) ||
      this.d.subagents.activeFor(this.agentId) > 0
    );
  }

  get info(): AgentInfo | undefined {
    return this.d.store.get(this.agentId);
  }

  /** The chat: send a message and resolve once omp has it — started, or queued while the person works (`mode`).
   *  Throws a UserError when it couldn't be sent (the composer keeps the text then). Workflow steps use ask(). */
  /** Resolves once omp has the message. calledOff: a Stop came while omp was starting, so it never went (the
   *  composer keeps it). */
  async prompt(text: string, opts: PromptOptions): Promise<{ calledOff?: boolean }> {
    const r = await this.#send(text, opts);
    return r.calledOff ? { calledOff: true } : {};
  }

  /** Send a prompt and wait for the answer: resolves when the agent has answered AND the session settled (helpers
   *  included). Never throws. */
  async ask(text: string, opts: PromptOptions = {}): Promise<PromptOutcome> {
    if (this.#retired || !this.d.specFor(this.agentId)) return { status: 'aborted', text: '', error: 'This person no longer lives here.' };
    try {
      return await (await this.#send(text, opts)).outcome;
    } catch (err) {
      return { status: 'error', text: '', error: errorText(err) };
    }
  }

  async #send(text: string, opts: PromptOptions): Promise<{ outcome: Promise<PromptOutcome>; calledOff?: boolean }> {
    const spec = this.#retired ? null : this.d.specFor(this.agentId);
    if (!spec) throw new UserError('This person no longer lives here.');
    if (this.#compacting) throw new UserError(`${this.#name} is compacting the chat — send it again in a moment.`);
    const id = `p${hash32(this.agentId).toString(36)}-${++promptSeq}`;
    const live = this.d.pool.get(this.agentId);
    // Mid-turn (not just helpers out): omp queues it, and it becomes a bubble when the model reads it.
    const queued = !!live && this.#working && !this.info?.available;
    const sent: Sent = {
      key: `q-${uid()}`,
      promptId: id,
      text,
      images: opts.imageRefs ?? [],
      mode: opts.mode === 'steer' ? 'steer' : 'queue',
      by: opts.by ?? (opts.shown ? 'rlt' : 'user'),
      shown: opts.shown,
      echoed: !queued,
      chat: !!opts.chat && !opts.shown,
    };
    this.#sent.push(sent);
    if (!opts.shown) this.#dropNotSent(sent); // sent again (Retry, or typed again): the old "Not sent" copy goes
    if (this.info?.interrupted) this.d.store.patch(this.agentId, { interrupted: undefined }, true);
    if (queued) this.#publishQueue();
    else {
      this.#clearTimers();
      this.#lastError = undefined;
      this.#lastText = '';
      this.#stopNoted = false;
      this.#setAvailable(false);
      if (opts.shown) sent.itemId = this.#system('info', opts.shown);
      else {
        const bubble = this.#bubble(sent, false);
        sent.itemId = bubble.id;
        this.d.store.upsertItem(this.agentId, bubble);
      }
      this.#setBase({ activity: 'listening', detail: live ? 'Listening…' : 'Getting ready…' });
      this.#status(live ? 'busy' : 'starting', true);
    }
    this.#journal();

    let proc: OmpProcess;
    let startSpec = spec;
    const stops = this.#stops;
    this.#acquiring = true;
    this.#booting.add(sent);
    try {
      // The first AI-account check still runs: wait for it (Stop meanwhile calls the message off, see abort()).
      const wait = live ? null : this.d.beforeStart?.(this.agentId);
      if (wait) {
        if (!queued) this.#setBase({ activity: 'listening', detail: wait.detail });
        await wait.promise;
        if (this.#stops !== stops || this.#retired) return { outcome: Promise.resolve(this.#stoppedBeforeStart(sent, queued)), calledOff: true };
        const fresh = this.d.specFor(this.agentId);
        if (!fresh) {
          const why = this.d.blocked?.(this.agentId) ?? 'This person no longer lives here.';
          this.#unsend(sent);
          if (!queued) this.#failBlocked(why, sent);
          throw new UserError(why);
        }
        startSpec = fresh;
        if (!queued) this.#setBase({ activity: 'listening', detail: 'Getting ready…' });
      }
      try {
        proc = await this.d.pool.acquire(startSpec);
      } catch (err) {
        this.#unsend(sent);
        if (this.#retired || err instanceof StartCancelled) return { outcome: Promise.resolve(this.#calledOff()), calledOff: true };
        throw new UserError(this.#failStart(err, startSpec, sent).error ?? errorText(err));
      }
    } finally {
      this.#acquiring = false;
      this.#booting.delete(sent);
    }
    // The person may have moved out while omp booted: never let that process work for a job that is gone.
    if (this.#retired || !this.d.specFor(this.agentId)) {
      this.#unsend(sent);
      if (!this.d.specFor(this.agentId)) void this.d.pool.stop(this.agentId);
      return { outcome: Promise.resolve(this.#calledOff()), calledOff: true };
    }
    // Stop pressed while omp booted (Stop on the person or their run, or a failing parallel sibling): omp stays up
    // for later, but this message is never sent.
    if (this.#stops !== stops) return { outcome: Promise.resolve(this.#stoppedBeforeStart(sent, queued)), calledOff: true };
    if (proc !== this.#proc) this.#booted(proc);
    if (!queued) {
      this.#setBase({ activity: 'listening', detail: 'Listening…' }); // not "Still getting ready" once omp is up
      this.#status('busy');
    }
    this.#working = true;

    const outcome = new Promise<PromptOutcome>((resolve) => {
      this.#waiters.push({ id, phase: 'result', status: 'completed', resolve });
    });
    const images = opts.images?.length ? opts.images.map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data })) : undefined;
    try {
      // Always a streaming behavior: omp refuses a plain prompt while it works. While idle both just start a turn.
      const extra = { id, streamingBehavior: sent.mode === 'steer' ? 'steer' : 'followUp', ...(images ? { images } : {}) };
      const { result } = await this.#exclusive(async () => {
        if (!queued) {
          // The model or effort changed while omp was starting: switch in place rather than restart next time.
          const fresh = this.d.specFor(this.agentId);
          if (fresh && this.d.pool.canRetarget(this.agentId, fresh)) await this.#retargetIn(fresh);
          // The chat's account (its own pick pinned, a dropped pick forked away): omp is idle until this prompt.
          await this.#syncAccountIn(proc, true);
          await this.d.accountsSettled?.(this.agentId);
          // The user's message starts a turn: the folder as it is now, so the turn's changes can be undone.
          if (sent.chat) await this.d.turns?.begin(this.agentId);
        }
        return proc.prompt(text, extra, images ? IMAGE_ACK_MS : undefined);
      });
      void result.then((f) => {
        // agentInvoked:false (a builtin slash command) never produces a real prompt_result frame.
        if (f.agentInvoked === false) this.#onEvent({ kind: 'prompt_result', id, status: 'completed', sessionSettled: true });
      });
      if (this.#resumeGoal) void this.#resumeGoalAfterRestart(proc);
    } catch (err) {
      this.#unsend(sent);
      this.#dropWaiter(id, { status: 'error', text: '', error: errorText(err) });
      const msg = `Couldn't send the message: ${errorText(err)}`;
      // Queued while it works: the turn goes on, only this message didn't make it.
      if (!queued) {
        this.d.turns?.cancel(this.agentId);
        this.#working = false;
        this.#fail(msg);
      }
      throw new UserError(msg);
    }
    return { outcome };
  }

  /** A workflow step's person can take a note into the turn they work on now: omp is up and mid-turn (a note while
   *  omp still starts, or between turns, would start a turn of its own outside the run). */
  canSteerStep(): boolean {
    return !this.#retired && !this.#compacting && !!this.d.pool.get(this.agentId) && this.#working && !this.info?.available;
  }

  /** A note for the workflow step this person works on now (a running team's "Send a note", team_edit's note):
   *  steered into their turn — they read it at their next step — and shown in the chat as `shown`. Its queue key (to
   *  take it back if their step ends first), or null when it can't go now (canSteerStep). */
  steerStep(text: string, shown: string): string | null {
    if (!this.canSteerStep()) return null;
    const at = this.#sent.length;
    // #send records the message before its first await: the key is known right away
    void this.#send(text, { mode: 'steer', by: 'rlt', shown })
      .then((r) => r.outcome)
      .catch(() => {});
    const s = this.#sent[at];
    return s && s.text === text ? s.key : null;
  }

  /** Take back a steered step note the person hasn't read (their step ended first). True when it was taken back. */
  async withdrawSteer(key: string): Promise<boolean> {
    const s = this.#sent.find((x) => x.key === key && !x.echoed);
    const proc = this.d.pool.get(this.agentId);
    if (!s || !proc) return false;
    for (const queue of s.mode === 'steer' ? ['steering', 'followUp'] : ['followUp', 'steering']) {
      const r = await proc.call<{ removed?: boolean }>({ type: 'remove_queued_message', message: s.text, queue }, 10_000).catch(() => null);
      if (!r?.removed) continue;
      this.#withdrawn.add(s.promptId);
      this.#unsend(s);
      this.#dropWaiter(s.promptId, { status: 'aborted', text: '', error: 'taken back' });
      return true;
    }
    return false;
  }

  /** A queued message (AgentInfo.queue key): 'remove' takes it back (→ the composer), 'steer' has it read at the
   *  person's next step instead of when they would have finished. */
  async queueAction(key: string, action: 'remove' | 'steer'): Promise<Draft | void> {
    const s = this.#sent.find((x) => x.key === key && !x.echoed);
    if (!s) throw new UserError('They already read that message.');
    if (s.by === 'rlt') throw new UserError('That’s CAST’s own update — it can’t be moved or taken back.');
    const proc = this.d.pool.get(this.agentId);
    if (!proc) throw new UserError('They already read that message.');
    const call = <T>(cmd: { type: string; [k: string]: unknown }) =>
      proc.call<T>(cmd, 10_000).catch((err: unknown) => {
        throw new UserError(`Couldn’t change the queue: ${errorText(err)}`);
      });
    if (action === 'steer') {
      if (s.mode === 'steer') return;
      const r = await call<{ promoted?: boolean }>({ type: 'promote_queued_message', message: s.text });
      if (!r?.promoted) throw new UserError('Too late — they already read it.');
      s.mode = 'steer';
      this.#publishQueue();
      return;
    }
    // omp matches the text in one of its two queues: try the one RLT believes first.
    for (const queue of s.mode === 'steer' ? ['steering', 'followUp'] : ['followUp', 'steering']) {
      const r = await call<{ removed?: boolean }>({ type: 'remove_queued_message', message: s.text, queue });
      if (!r?.removed) continue;
      this.#withdrawn.add(s.promptId);
      this.#unsend(s);
      this.#dropWaiter(s.promptId, { status: 'aborted', text: '', error: 'taken back' });
      return { text: s.text, images: s.images };
    }
    throw new UserError('Too late — they already read it.');
  }

  /** The person moves out: settle everything waiting on them (a workflow step awaiting prompt() included) and ignore
   *  whatever their process still reports. The caller stops the process. */
  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.d.turns?.cancel(this.agentId);
    this.#working = false;
    this.#tools.clear();
    this.#clearTimers();
    this.#sent = [];
    this.#turn = undefined;
    this.d.journal?.(this.agentId, null);
    for (const w of this.#waiters.splice(0)) w.resolve({ status: 'aborted', text: '', error: 'moved out' });
  }

  get retired(): boolean {
    return this.#retired;
  }

  /** Stop everything this person is doing (queued messages and helpers included; omp pauses an active goal).
   *  Returns the user's messages it hadn't read yet, oldest first, for the composer. */
  async abort(): Promise<Draft[]> {
    this.#stops++; // also a message still waiting for omp to start
    this.#stopNoted = false;
    const proc = this.d.pool.get(this.agentId);
    if (!proc) return this.#cancelStart();
    const onlyHelpers = !!this.info?.available; // no turn running: "Stop helpers"
    const wasWorking = this.#working;
    this.d.approvals.dismissForAgent(this.agentId, true);
    let restored: Draft[] = [];
    try {
      const subs = await proc.call<{ subagents?: { id: string }[] }>({ type: 'get_subagents' }, 5000).catch(() => ({ subagents: [] }));
      for (const s of subs.subagents ?? []) void proc.call({ type: 'cancel_subagent', subagentId: s.id }, 5000).catch(() => {});
      const sent = this.#sent.slice(); // omp may report the withdrawn prompts aborted before it answers
      const r = await proc.call<{ steering?: { text?: unknown }[]; followUp?: { text?: unknown }[] }>({ type: 'abort_and_restore_queue' }, 15_000);
      restored = this.#restore([...(r?.steering ?? []), ...(r?.followUp ?? [])], sent);
    } catch {
      /* the process may already be finishing */
    }
    // One line per Stop: the prompts it ended are reported aborted one by one (after this answer) and add nothing.
    if (wasWorking) this.#noteStopped();
    // omp folds the cancelled helpers' results in without a turn and sends no session_settled then: settle here
    // (unless a turn started meanwhile).
    if (onlyHelpers && this.#working && this.info?.available) this.#settled();
    return restored;
  }

  /** Stop while omp is still starting (or the first AI-account check runs): the start is called off now — the person
   *  is idle at once and the messages that were waiting for it go back to the composer — instead of letting omp boot
   *  for nothing and the message wait behind it (#send sees the Stop and never sends it). */
  async #cancelStart(): Promise<Draft[]> {
    const waiting = [...this.#booting];
    if (!waiting.length && !this.d.pool.isStarting(this.agentId)) return [];
    const drafts: Draft[] = [];
    for (const s of waiting) {
      this.#unsend(s);
      if (s.itemId) this.d.store.removeItem(this.agentId, s.itemId); // never reached them: back to the composer
      if (s.by === 'user') drafts.push({ text: s.text, images: s.images });
    }
    if (waiting.length) this.#noteStopped();
    if (!this.#working && !this.#compacting) {
      this.#clearTimers();
      this.#base = { activity: 'idle' };
      this.d.store.patch(this.agentId, { status: 'offline', activity: 'idle', detail: undefined, tool: undefined }, true);
    }
    await this.d.pool.stop(this.agentId).catch(() => {}); // a booting omp is killed (its acquire rejects: called off)
    return drafts;
  }

  /** #send noticed a Stop that came while omp was starting: the message is never sent. */
  #stoppedBeforeStart(sent: Sent, queued: boolean): PromptOutcome {
    this.#unsend(sent);
    if (!queued) {
      this.#noteStopped();
      this.#setBase({ activity: 'idle' });
      this.#status(this.d.pool.get(this.agentId) ? 'idle' : 'offline', true);
    }
    return { status: 'aborted', text: '', error: 'stopped' };
  }

  /** The message is sent again: its earlier copies that never went ("Not sent" bubbles of the same text and images)
   *  go, and a "Run again" for it (work a restart interrupted) has done its job. */
  #dropNotSent(s: Sent) {
    const key = s.images.map((i) => i.id).join(',');
    const same = (text: string, images: ImageRef[] | undefined) => text === s.text && (images ?? []).map((i) => i.id).join(',') === key;
    const items = this.d.store.transcript(this.agentId);
    for (const it of items.slice(-40)) {
      if (it.kind === 'user' && it.notSent && same(it.text, it.images)) this.d.store.removeItem(this.agentId, it.id);
      else if (it.kind === 'system' && it.resend && same(it.resend.text, it.resend.images)) {
        const { resend: _, ...rest } = it;
        this.d.store.upsertItem(this.agentId, rest);
      }
    }
  }

  /** The message never reached the person: its bubble says "Not sent" (with Retry) and counts as no message. */
  #markNotSent(s: Sent) {
    if (!s.itemId || s.shown) return;
    const item = this.d.store.findItem(this.agentId, s.itemId);
    if (item?.kind === 'user') this.d.store.upsertItem(this.agentId, { ...item, notSent: true });
  }

  /** omp withdrew its queues (abort_and_restore_queue): their messages back to the composer with the uploads RLT
   *  sent them with (omp hands back re-encoded images), in send order; RLT's own updates are dropped. A message shown
   *  at once but queued by omp after all (sent while omp was starting, right behind another) loses its bubble. */
  #restore(back: { text?: unknown }[], sent: Sent[]): Draft[] {
    const order = sent;
    // Chips first: those are known to be in omp's queues.
    const left = [...sent.filter((s) => !s.echoed), ...sent.filter((s) => s.echoed)];
    const found: Sent[] = [];
    const unknown: Draft[] = [];
    for (const b of back) {
      const text = typeof b.text === 'string' ? b.text : '';
      const i = left.findIndex((s) => s.text === text);
      if (i >= 0) found.push(left.splice(i, 1)[0]!);
      else if (text.trim()) unknown.push({ text, images: [] });
    }
    // omp's queues are empty now: what is left is a message it is reading (its user message_start still to come).
    this.#sent = this.#sent.filter((s) => s.echoed && !found.includes(s));
    for (const s of found) if (s.echoed && s.itemId) this.d.store.removeItem(this.agentId, s.itemId);
    this.#publishQueue();
    found.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return [...found.filter((s) => s.by === 'user').map((s) => ({ text: s.text, images: s.images })), ...unknown];
  }

  /** Shrink the chat's context now (omp compact; its own queue blocks meanwhile, so nothing else is asked). Only
   *  while the person is idle or offline (callers also check helpers and a running team); starts omp when needed.
   *  "Nothing to compact" / "Already compacted" → `nothing`. */
  async compact(): Promise<{ tokensBefore?: number; nothing?: true }> {
    if (this.goalActive()) throw new UserError(GOAL_BLOCKS(this.#name, 'compact the chat'));
    if (this.busy) throw new UserError(`${this.#name} is still working — compact the chat when they’re done.`);
    const spec = this.#retired ? null : this.d.specFor(this.agentId);
    if (!spec) throw new UserError('This person no longer lives here.');
    const live = !!this.d.pool.get(this.agentId);
    this.#compacting = true; // busy: no idle stop, no new chat, no prompt meanwhile
    this.#clearTimers();
    this.#setBase({ activity: 'thinking', detail: live ? 'Compacting the chat…' : 'Getting ready…' });
    this.#status(live ? 'busy' : 'starting', true);
    try {
      let proc: OmpProcess;
      this.#acquiring = true;
      try {
        proc = await this.d.pool.acquire(spec);
      } catch (err) {
        if (this.#retired || err instanceof StartCancelled) throw new UserError('Stopped before the chat was compacted.');
        throw new UserError(describeStartFailure(err, { name: this.#name, modelLabel: this.info?.modelLabel ?? spec.model, ompBin: this.d.ompBin ?? 'cast-agent', startTimeoutS: this.d.startTimeoutS ?? 45 }).summary);
      } finally {
        this.#acquiring = false;
      }
      if (proc !== this.#proc) this.#booted(proc);
      this.#status('busy');
      this.#setBase({ activity: 'thinking', detail: 'Compacting the chat…' });
      let r: { tokensBefore?: unknown } | undefined;
      try {
        r = await proc.call<{ tokensBefore?: unknown }>({ type: 'compact' }, COMPACT_MS);
      } catch (err) {
        const msg = errorText(err);
        if (/nothing to compact|already compacted/i.test(msg)) return { nothing: true };
        throw new UserError(`Couldn’t compact the chat: ${msg}`);
      }
      this.#compacting = false;
      const before = count(r?.tokensBefore);
      const at = Date.now();
      await this.#refreshContext();
      const ctx = this.info?.context;
      const after = ctx?.live && ctx.at >= at ? ctx.tokens : undefined;
      this.#system('info', before !== undefined && after !== undefined ? `Compacted the chat (≈${fmtTokens(before)} → ${fmtTokens(after)} tokens).` : 'Compacted the chat.');
      return before !== undefined ? { tokensBefore: before } : {};
    } finally {
      this.#compacting = false;
      if (!this.#working && !this.#retired) {
        this.#setBase({ activity: 'idle' });
        this.#status(this.d.pool.get(this.agentId) ? 'idle' : 'offline', true);
      }
    }
  }

  /** Leads: goal mode for the current chat (omp `goal`): 'create' (objective, optional token budget) starts working
   *  toward it on its own; omp sends the turns (no prompt). Starts omp when needed. */
  async goal(op: 'create' | 'pause' | 'resume' | 'drop', objective?: string, tokenBudget?: number): Promise<void> {
    if (this.#compacting) throw new UserError(`${this.#name} is compacting the chat — try again in a moment.`);
    this.#resumeGoal = false; // the user decides about the goal now
    const spec = this.#retired ? null : this.d.specFor(this.agentId);
    let proc = this.#retired ? undefined : this.d.pool.get(this.agentId);
    // pause and drop start no turn: a running omp takes them even when its model isn't connected any more
    const toLive = !!proc && (op === 'pause' || op === 'drop');
    if (!spec && !toLive) throw new UserError('This person no longer lives here.');
    const text = objective?.trim() ?? '';
    if (op === 'create' && !text) throw new UserError('Write what the goal is first.');
    if (!proc) {
      this.#clearTimers();
      this.#setBase({ activity: 'listening', detail: 'Getting ready…' });
      this.#status('starting', true);
      this.#acquiring = true;
      try {
        proc = await this.d.pool.acquire(spec!); // no live omp: toLive is false, so there is a spec
      } catch (err) {
        if (this.#retired || err instanceof StartCancelled) {
          this.#calledOff();
          throw new UserError('Stopped before the agent was ready.');
        }
        throw new UserError(this.#failStart(err, spec!).error ?? errorText(err));
      } finally {
        this.#acquiring = false;
      }
      if (proc !== this.#proc) this.#booted(proc);
      if (!this.#working) {
        this.#setBase({ activity: 'idle' });
        this.#status('idle', true);
      }
    }
    const cmd: { type: string; [k: string]: unknown } = { type: 'goal', op };
    if (op === 'create') {
      cmd.objective = text;
      if (tokenBudget && tokenBudget > 0) cmd.token_budget = Math.round(tokenBudget);
    }
    let r: { goal?: unknown } | undefined;
    try {
      r = await proc.call<{ goal?: unknown }>(cmd, 30_000);
    } catch (err) {
      const verb = { create: 'set', pause: 'pause', resume: 'resume', drop: 'drop' }[op];
      throw new UserError(`Couldn’t ${verb} the goal: ${errorText(err)}`);
    }
    // Its turns start without a prompt of RLT's: an error of an earlier message is over.
    if (op === 'create' || op === 'resume') this.#lastError = undefined;
    this.#applyGoal(parseOmpGoal(r?.goal));
  }

  /** The goal was active when omp restarted for new settings: on again (omp decides the next goal turn when the
   *  message that restarted it is done). */
  async #resumeGoalAfterRestart(proc: OmpProcess) {
    this.#resumeGoal = false;
    if (this.info?.goal?.status !== 'paused') return; // omp didn't bring it back (another chat, or it's gone)
    try {
      const r = await proc.call<{ goal?: unknown }>({ type: 'goal', op: 'resume' }, 30_000);
      if (this.d.pool.get(this.agentId) === proc && !this.#retired) this.#applyGoal(parseOmpGoal(r?.goal));
    } catch (err) {
      log('agents', `${this.agentId}: couldn't resume the goal after restarting the agent: ${errorText(err)}`);
    }
  }

  /** A goal is active (omp works on it between turns of its own; the team-run guard counts per goal then). */
  goalActive(): boolean {
    return this.info?.goal?.status === 'active';
  }

  /** Compacting the chat now: omp takes no message until it is done. */
  get compacting(): boolean {
    return this.#compacting;
  }

  /** Workflow handoff: carry the result over to the next person for a moment, then relax. */
  showHandoff(detail: string, ms: number): void {
    this.#clearTimers();
    this.#setBase({ activity: 'handoff', detail });
    this.#idleTimer = setTimeout(() => {
      if (this.#base.activity === 'handoff') this.#setBase({ activity: 'idle' });
    }, ms);
  }

  /** Start a fresh chat: a new thread and a new omp session (the old chat stays reopenable). Workflow runs give
   *  each role a clean context this way. A current chat that is still empty is reused. Callers check `busy`. */
  async newThread(opts: { title?: string; note?: string } = {}): Promise<ThreadRecord> {
    const { threads, store, pool } = this.d;
    this.#resumeGoal = false; // the goal was the old chat's
    const { thread, fresh } = threads.create(this.agentId, opts.title);
    if (fresh) {
      const items: TranscriptItem[] = [];
      store.setTranscript(this.agentId, items, true);
      threads.observe(this.agentId, items);
      store.patch(this.agentId, { context: undefined, goal: undefined }, true); // a new session: read once omp is on it
      const proc = pool.get(this.agentId);
      if (proc) {
        await this.#exclusive(async () => {
          try {
            const r = await proc.call<{ cancelled?: boolean }>({ type: 'new_session' }, 20_000);
            if (r?.cancelled) throw new Error('new_session was cancelled');
            await this.#noteSession(proc, thread.id);
            await this.#assertThinking(proc);
          } catch (err) {
            log('agents', `${this.agentId}: new chat via RPC failed (${errorText(err)}) — restarting the agent on next prompt`);
            await pool.stop(this.agentId); // the thread has no session file yet → the next spawn starts fresh
          }
        });
      }
    }
    store.patch(this.agentId, { threadId: thread.id }, true);
    this.d.accountChanged?.(this.agentId);
    if (opts.note) this.#system('info', opts.note);
    return thread;
  }

  /** Reopen an older chat: RLT shows its transcript and omp resumes its session, so the model remembers it. */
  async switchThread(threadId: string): Promise<ThreadRecord> {
    const { threads, store, pool } = this.d;
    if (threads.current(this.agentId)?.id === threadId) {
      store.setTranscript(this.agentId, store.transcript(this.agentId), true);
      return threads.current(this.agentId)!;
    }
    const { thread, items } = threads.switchTo(this.agentId, threadId);
    this.#resumeGoal = false; // the goal was the old chat's
    store.setTranscript(this.agentId, items, true);
    // That chat's last reading ("last seen") and goal (paused: omp brings a goal back paused) until omp is on it.
    store.patch(this.agentId, { context: threads.context(this.agentId), goal: threads.goal(this.agentId) }, true);
    const proc = pool.get(this.agentId);
    if (proc) {
      await this.#exclusive(async () => {
        try {
          const spec = this.d.specFor(this.agentId);
          // A session recorded in another folder would move omp there: such a chat continues with a fresh memory.
          const saved = threads.sessionPath(this.agentId, thread.id);
          const file = saved && spec && sessionCwdMatches(saved, spec.cwd) ? saved : undefined;
          if (file) {
            const { provider, id } = splitSelector(spec?.model ?? '');
            // Keep the person's current model (the chat may have been with another one).
            const cmd = provider && id ? { type: 'switch_session', sessionPath: file, provider, modelId: id } : { type: 'switch_session', sessionPath: file };
            const r = await proc.call<{ cancelled?: boolean }>(cmd, 30_000);
            if (r?.cancelled) throw new Error('switch_session was cancelled');
          } else {
            const r = await proc.call<{ cancelled?: boolean }>({ type: 'new_session' }, 20_000);
            if (r?.cancelled) throw new Error('new_session was cancelled');
          }
          await this.#noteSession(proc, thread.id);
          // omp gives the chat back the effort it was saved with, silently: the person's own effort again.
          await this.#assertThinking(proc);
          await this.#syncAccountIn(proc, false);
        } catch (err) {
          log('agents', `${this.agentId}: switching chats via RPC failed (${errorText(err)}) — restarting the agent on next prompt`);
          await pool.stop(this.agentId); // the next spawn resumes this thread's file with --resume
        }
      });
    }
    store.patch(this.agentId, { threadId: thread.id }, true);
    this.d.accountChanged?.(this.agentId);
    return thread;
  }

  /** The person's effort on the live omp again (after a chat switch: omp restores the level the chat was saved with,
   *  without an event; a model without a level drops it). */
  async #assertThinking(proc: OmpProcess): Promise<void> {
    const spec = this.d.specFor(this.agentId);
    if (!spec) return;
    await proc.call({ type: 'set_thinking_level', level: spec.thinking ?? 'high' }, 10_000).catch((err: unknown) => {
      log('agents', `${this.agentId}: couldn't set the effort on the agent: ${errorText(err)}`);
    });
  }

  /** Run RLT's own commands on the live omp one after another (see #ops). */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#ops.then(fn, fn);
    this.#ops = run.catch(() => {});
    return run;
  }

  /** The person's model or effort changed (a lead's job): switch the live omp in place (omp set_model, checked to be
   *  exactly that model, then set_thinking_level) — mid-turn too: a reply already streaming finishes on the old model,
   *  the next step uses the new one. Anything else changed as well, or omp refused: the next idle message restarts
   *  omp with it (as before). Without a live omp there is nothing to do (the next start uses the new spec). */
  async retarget(next: ProcessSpec): Promise<void> {
    if (this.#retired || !this.d.pool.get(this.agentId)) return;
    const providerChanged = await this.#exclusive(async () => {
      // The job can change again while omp switches (Sonnet, then straight back to Opus; Low, then High): the last
      // choice wins. Each round takes the spec as it is NOW (not the one this call was made with, which a switch
      // already under way may have overtaken); another round only when it changed meanwhile — a refusal isn't retried.
      let changed = false;
      let tried = '';
      for (;;) {
        const want = this.d.specFor(this.agentId) ?? (tried ? null : next);
        const key = want ? `${want.model}\n${want.thinking ?? ''}` : tried;
        if (!want || key === tried || !this.d.pool.canRetarget(this.agentId, want)) break;
        tried = key;
        if (await this.#retargetIn(want)) changed = true;
      }
      return changed;
    });
    void this.#refreshContext(); // another model: another context window
    if (providerChanged) void this.syncAccount(); // the chat's own account of the new provider
  }

  /** retarget's work, inside #exclusive. Returns whether the model's provider changed. */
  async #retargetIn(next: ProcessSpec): Promise<boolean> {
    const proc = this.d.pool.get(this.agentId);
    const cur = this.d.pool.spec(this.agentId);
    if (!proc || !cur || !this.d.pool.canRetarget(this.agentId, next)) return false;
    try {
      let providerChanged = false;
      if (cur.model !== next.model) {
        const { provider, id } = splitSelector(next.model);
        const m = await proc.call<{ provider?: string; id?: string }>({ type: 'set_model', provider, modelId: id }, 20_000);
        const got = `${m?.provider}/${m?.id}`;
        if (got !== next.model) throw new Error(`the agent switched to ${got}, not ${next.model}`);
        providerChanged = splitSelector(cur.model).provider !== provider;
      }
      await proc.call({ type: 'set_thinking_level', level: next.thinking ?? 'high' }, 10_000);
      this.d.pool.retarget(this.agentId, next);
      log('agents', `${this.agentId}: now on ${next.model} · effort ${next.thinking ?? 'high'}${this.#working ? ' (from its next step)' : ''}`);
      return providerChanged;
    } catch (err) {
      log('agents', `${this.agentId}: couldn't switch the agent to ${next.model} in place (${errorText(err)}) — restarting it with the new model before the next message`);
      return false;
    } finally {
      if (this.#working && cur.model !== next.model) this.#prevModel = cur.model;
    }
  }

  /** Bring omp's account for the current chat in line with RLT (accountPlan): fork away an explicit pin the chat no
   *  longer wants (omp has no unpin: a fork is the same chat under a new session id, its pins automatic again, so the
   *  order moves it), pin the chat's own pick (`/session pin`), and read which account omp is on. Only while omp runs
   *  and nothing is under way: otherwise it happens before the next message or when this turn ends. Never throws. */
  async syncAccount(): Promise<void> {
    if (this.#retired || !this.d.pool.get(this.agentId)) return;
    await this.#exclusive(async () => {
      const proc = this.d.pool.get(this.agentId);
      if (proc) await this.#syncAccountIn(proc, false);
    });
  }

  /** syncAccount's work, inside #exclusive. `beforePrompt`: a message of this person goes out right after (omp is idle
   *  although the runtime counts as working); only then is reading the account skipped when nothing changes. */
  async #syncAccountIn(proc: OmpProcess, beforePrompt: boolean): Promise<void> {
    if (this.#retired || this.d.pool.get(this.agentId) !== proc || this.d.pool.isStarting(this.agentId)) return;
    if (this.#compacting || this.goalActive() || this.d.subagents.activeFor(this.agentId) > 0) return;
    if (!beforePrompt && this.#working) return;
    const plan = this.d.accountPlan?.(this.agentId);
    const st = this.d.threads.accountState(this.agentId);
    if (!plan || !st) return;
    const checked = this.#accountChecked?.proc === proc && this.#accountChecked.threadId === st.threadId;
    let changed = false;
    let active: number | null | undefined;
    try {
      if (plan.drop) {
        const r = await proc.call<{ cancelled?: boolean }>({ type: 'fork' }, 30_000);
        if (r?.cancelled) throw new Error('the agent called the fork off');
        await this.#noteSession(proc, st.threadId); // another session file: RLT's pins on the old one are gone
        changed = true;
        log('agents', `${this.agentId}: the chat follows the account order again (forked its agent session)`);
      }
      const want = plan.credentialId;
      if (want !== null) {
        const pinned = changed ? undefined : st.pinned?.[plan.provider];
        // Pinned before: checked once per process and chat (omp may have let the pin go, e.g. its 30-day expiry).
        if (pinned === want && !checked) active = await this.#activeAccount(proc, plan.provider);
        if (pinned !== want || (active !== undefined && active !== want)) {
          await this.#pinAccount(proc, want);
          active = await this.#activeAccount(proc, plan.provider);
          if (active !== want) throw new Error(`the agent stayed on account #${active ?? '—'}`);
          this.d.threads.notePinned(this.agentId, st.threadId, plan.provider, want);
          changed = true;
          log('agents', `${this.agentId}: the chat uses account #${want} of ${plan.provider}`);
        }
      }
      this.#accountChecked = { proc, threadId: st.threadId };
      if (plan.read && (!beforePrompt || changed)) {
        active ??= await this.#activeAccount(proc, plan.provider);
        if (active !== null) this.d.threads.noteSeen(this.agentId, st.threadId, plan.provider, active);
      }
    } catch (err) {
      log('agents', `${this.agentId}: couldn't put the chat on its account yet (${errorText(err)}) — trying again later`);
    }
    this.d.accountChanged?.(this.agentId);
  }

  /** `/session pin OAuth credential #<id>`: omp's builtin command (no turn, no transcript entry) — pins the model's
   *  provider's account to this session explicitly. */
  async #pinAccount(proc: OmpProcess, credentialId: number): Promise<void> {
    const r = await proc.request({ type: 'prompt', message: `/session pin OAuth credential #${credentialId}`, streamingBehavior: 'followUp' }, 15_000);
    if (!r.success) throw new Error(String(r.error));
    if ((r.data as { agentInvoked?: unknown } | undefined)?.agentInvoked !== false) {
      void proc.call({ type: 'abort' }, 5000).catch(() => {});
      throw new Error('the agent handed the pin command to the model');
    }
  }

  /** The account omp is on for this session (get_logout_accounts' active OAuth row); null when none is. */
  async #activeAccount(proc: OmpProcess, provider: string): Promise<number | null> {
    const d = await proc.call<{ accounts?: { credentialId?: unknown; active?: unknown; type?: unknown }[] }>({ type: 'get_logout_accounts', providerId: provider }, 10_000);
    const row = (Array.isArray(d?.accounts) ? d.accounts : []).find((a) => a?.active === true && a.type === 'oauth');
    return typeof row?.credentialId === 'number' ? row.credentialId : null;
  }

  async #noteSession(proc: OmpProcess, threadId: string) {
    const st = await proc.call<BootState>({ type: 'get_state' }, 20_000);
    this.d.threads.noteSession(this.agentId, st.sessionFile, threadId);
    this.#setContext(st.contextUsage);
    this.#applyGoal(parseOmpGoal(st.goal?.goal), true);
    this.#markAdvisorStart();
  }

  /** Arguments of the running tool call an approval dialog is about (omp starts the call, then asks): the only
   *  running call of that tool, or the one whose command / code / path the dialog shows. */
  /** The running tool call an "Allow tool: …" dialog is about (its id and arguments), when it can be told apart. */
  #callAsked(frame: Record<string, unknown>): { id: string; args: unknown } | undefined {
    const [first = '', ...rest] = String(frame.title ?? '').split('\n');
    if (!first.startsWith('Allow tool: ')) return undefined;
    const tool = first.slice('Allow tool: '.length).trim();
    const calls = [...this.#tools.entries()].filter(([, t]) => t.tool === tool).map(([id, t]) => ({ id, args: t.args }));
    if (calls.length <= 1) return calls[0];
    const shown = rest.join('\n');
    return calls.find((t) => {
      const a = (t.args ?? {}) as Record<string, unknown>;
      const key = [a.command, a.code, a.path].find((v): v is string => typeof v === 'string');
      return key !== undefined && shown.includes(key.slice(0, 200));
    });
  }

  /** Auto mode's rules cleared this tool call: label its chat item now and on every later update of it (#61). */
  #markAuto(toolCallId: string | undefined): void {
    if (!toolCallId) return;
    this.#autoCleared.add(toolCallId);
    if (this.#autoCleared.size > 200) this.#autoCleared.delete(this.#autoCleared.values().next().value!);
    const item = this.d.store.findItem(this.agentId, toolCallId);
    if (item?.kind === 'tool' && !item.auto) this.d.store.upsertItem(this.agentId, { ...item, auto: true });
  }

  /** Talk to one of this person's helpers mid-task. */
  async steerHelper(ompSubagentId: string, message: string): Promise<boolean> {
    const proc = this.d.pool.get(this.agentId);
    if (!proc) return false;
    try {
      await proc.call({ type: 'steer_subagent', subagentId: ompSubagentId, message }, 15_000);
      return true;
    } catch {
      return false;
    }
  }

  /** omp is still starting and said so (its watchdog, every 10 s): show that it is alive, just slow. */
  startProgress(seconds: number): void {
    if (this.#retired || this.info?.status !== 'starting') return;
    this.#setBase({ activity: 'listening', detail: `Still getting ready (${seconds} s) — the computer is busy` });
  }

  /** Show this person waiting for the user (e.g. "Waiting for you: plan for “X”"), or stop showing it (null). */
  setWaiting(detail: string | null): void {
    this.#waitingFor = detail;
    this.render();
  }

  /** Re-evaluate the displayed activity (approval added/resolved elsewhere). */
  render(): void {
    const pending = this.d.approvals.pendingFor(this.agentId)[0];
    const shown: Base = pending
      ? { activity: 'waiting_approval', detail: isQuestion(pending) ? 'Has a question for you' : `Needs your OK · ${pending.tool}`, tool: pending.tool }
      : this.#waitingFor
        ? { activity: 'waiting_approval', detail: this.#waitingFor }
        : this.#base;
    const cur = this.info;
    if (!cur) return;
    const now = Date.now();
    // Let a visible station (listening, bookshelf, desk, …) register before falling back to a calmer state:
    // a read takes milliseconds, the walk to the bookshelf does not.
    const calmer = shown.activity === 'thinking' || shown.activity === 'done' || shown.activity === 'idle';
    if (!pending && !this.#waitingFor && calmer && cur.activity !== shown.activity && now < this.#holdUntil) {
      if (this.#deferTimer) clearTimeout(this.#deferTimer);
      this.#deferTimer = setTimeout(() => this.render(), this.#holdUntil - now);
      return;
    }
    if (cur.activity !== shown.activity) this.#holdUntil = now + (DWELL_MS[shown.activity] ?? 0);
    this.d.store.patch(this.agentId, { activity: shown.activity, detail: shown.detail, tool: shown.tool });
  }

  onFrame(frame: OmpFrame): void {
    if (this.#retired) return;
    if (!this.#normalizer) {
      // Tool paths inside the person's folder become relative (the viewer opens them); others stay absolute.
      const cwd = this.d.pool.spec(this.agentId)?.cwd ?? this.d.specFor(this.agentId)?.cwd;
      this.#normalizer = new FrameNormalizer(`${Date.now().toString(36)}.${++this.#gen}`, { cwd });
      this.#mismatchWarned = false;
    }
    for (const e of this.#normalizer.handle(frame)) this.#onEvent(e);
  }

  onExit(info: { code: number | null; signal: string | null; stderr: string; expected: boolean }): void {
    if (this.#retired) return;
    this.#normalizer = undefined;
    this.#proc = undefined;
    this.#prevModel = undefined;
    this.#accountChecked = undefined;
    this.d.turns?.end(this.agentId); // what the turn changed before omp went away
    this.#working = false;
    this.#turn = undefined;
    this.#tools.clear();
    this.#clearTimers();
    this.#setAvailable(false);
    // omp's queues went with it; a message still on its way to omp goes to the next one (its bubble is shown).
    this.#sent = this.#sent.filter((s) => this.#booting.has(s));
    this.#withdrawn.clear();
    this.#publishQueue();
    // Context: kept, "last seen". A goal comes back paused when omp resumes the chat (it never goes on by itself).
    const cur = this.info;
    if (info.expected && this.#acquiring && cur?.goal?.status === 'active') this.#resumeGoal = true;
    this.d.store.patch(this.agentId, {
      context: cur?.context ? { ...cur.context, live: false } : undefined,
      goal: cur?.goal?.status === 'active' ? { ...cur.goal, status: 'paused' } : cur?.goal,
    }, true);
    this.d.approvals.dismissForAgent(this.agentId);
    this.d.subagents.removeForParent(this.agentId);
    const outcome: PromptOutcome = info.expected
      ? { status: 'aborted', text: '', error: 'stopped' }
      : { status: 'error', text: '', error: `the agent exited unexpectedly (code ${info.code ?? info.signal})` };
    for (const w of this.#waiters.splice(0)) w.resolve(outcome);
    if (info.expected && this.#acquiring) return; // restarting with a new brief/model: stay "Getting ready…"
    if (info.expected) {
      this.#base = { activity: 'idle' };
      this.d.store.patch(this.agentId, { status: 'offline', activity: 'idle', detail: undefined, tool: undefined });
      return;
    }
    const msg = `The agent stopped unexpectedly (exit ${info.code ?? info.signal}).${info.stderr.trim() ? `\n${tail(info.stderr.trim(), 1500)}` : ''}`;
    this.#system('error', msg);
    this.#base = { activity: 'error', detail: 'Crashed — send a message to restart' };
    this.d.store.patch(this.agentId, { status: 'error', activity: 'error', detail: this.#base.detail, tool: undefined }, true);
    this.d.toast('error', `${this.info?.name ?? 'An agent'} stopped unexpectedly`, this.projectId, this.agentId);
  }

  dispose(): void {
    this.#clearTimers();
  }

  // ───────────────────────── internals ─────────────────────────

  #onEvent(e: AgentEvent): void {
    const { store } = this.d;
    switch (e.kind) {
      case 'item':
        store.upsertItem(this.agentId, e.item.kind === 'tool' && this.#autoCleared.has(e.item.id) ? { ...e.item, auto: true } : e.item, e.stream);
        return;
      case 'producing':
        if (this.#tools.size === 0) this.#setBase({ activity: 'thinking', detail: 'Thinking…' });
        return;
      case 'composing':
        // Long write/edit arguments stream for a while: be at the desk already, not pacing.
        if (this.#tools.size === 0 && activityForTool(e.tool) === 'writing') this.#setBase({ activity: 'writing', detail: 'Drafting changes…', tool: e.tool });
        return;
      case 'tool_start':
        this.#empty.reset(); // the model answered with something
        this.#tools.set(e.toolCallId, { tool: e.tool, args: e.args, intent: e.intent });
        this.#setBase({ activity: activityForTool(e.tool), detail: e.detail, tool: e.tool });
        return;
      case 'tool_end': {
        const started = this.#tools.get(e.toolCallId);
        this.#tools.delete(e.toolCallId);
        if (mayChangeFiles(e.tool) || e.tool === 'task') {
          this.d.git.poke(this.projectId, this.info?.jobId); // helpers (task) may have changed files too
          this.d.onFileTool?.(this.agentId, e.tool, started?.args);
        }
        if (this.#tools.size === 0 && this.#working) this.#setBase({ activity: 'thinking', detail: 'Thinking…' });
        return;
      }
      case 'usage':
        this.#usage(e);
        return;
      case 'agent_start':
        this.#clearTimers();
        this.#stopNoted = false;
        this.#setAvailable(false); // a turn (the user's message, helpers reporting back, the goal) is running
        if (!this.#working) {
          // A turn omp starts by itself (the goal, helpers reporting back): an earlier message's error is over.
          this.#working = true;
          this.#lastError = undefined;
          this.#status('busy');
          this.#setBase({ activity: 'thinking', detail: this.goalActive() ? 'Working on the goal…' : 'Back to work' });
        } else if (this.#base.activity === 'done' || this.#base.activity === 'idle') {
          // The prompt was answered but omp goes on by itself (the goal, queued messages): not "Done" yet.
          this.#setBase({ activity: 'thinking', detail: this.goalActive() ? 'Working on the goal…' : 'Back to work' });
        }
        return;
      case 'agent_end':
        // Helpers still out once the model's turn is over: free to talk until they report back.
        if (this.#working && this.d.subagents.activeFor(this.agentId) > 0) this.#delegating();
        void this.#refreshContext(); // a goal can run many turns without the session settling
        return;
      case 'prompt_result':
        this.#promptResult(e);
        return;
      case 'settled':
        this.#settled();
        return;
      case 'ui_request': {
        const proc = this.d.pool.get(this.agentId);
        const id = String(e.frame.id ?? '');
        const call = this.#callAsked(e.frame);
        const from = approvalOrigin(String(e.frame.title ?? ''), [...this.#tools.values()]);
        const offered = this.d.approvals.offer(e.frame, this.agentId, this.projectId, (payload) => proc?.respondUi(id, payload), call?.args, () => this.#markAuto(call?.id), from);
        if (!offered) this.#system('warn', `${this.info?.name ?? 'The agent'} asked for free-text input, which CAST can't show yet — skipped.`);
        return;
      }
      case 'ui_cancel':
        this.d.approvals.dismiss(e.targetId);
        return;
      case 'subagent_lifecycle': {
        const parent = this.info;
        if (parent) this.d.subagents.lifecycle(parent, e.payload);
        this.#refreshDelegating();
        return;
      }
      case 'subagent_progress': {
        const parent = this.info;
        if (parent) this.d.subagents.progress(parent, e.payload);
        this.#refreshDelegating();
        return;
      }
      case 'retry': {
        // An empty answer is counted here too (omp's retry notice says how many attempts failed): the card shows from the
        // 2nd, while omp still sends the same request again.
        const n = this.#empty.atLeast(e.message, this.#modelNow(), e.attempt);
        if (n !== null) this.#showEmpty(e.message, false);
        this.d.store.patch(this.agentId, { detail: n !== null ? `Empty answer — retrying (${e.attempt}/${e.maxAttempts})` : `Connection trouble — retrying (${e.attempt}/${e.maxAttempts})` });
        return;
      }
      case 'model_error': {
        // An empty answer isn't a line each time (omp may retry the identical request 10 times): it is counted, and
        // the card says what to do. Any other error is a line, as before.
        if (this.#empty.note(e.message, this.#modelNow()) !== null) this.#showEmpty(e.message, false);
        else store.upsertItem(this.agentId, { kind: 'system', id: e.id, level: 'error', text: e.message, ts: Date.now() });
        return;
      }
      case 'notice':
        if (!e.message) return;
        this.#lastNotice = e.message;
        this.#system(e.level, e.message);
        if (e.level === 'error') this.d.toast('error', truncate(e.message, 160), this.projectId, this.agentId);
        return;
      case 'assistant_text':
        this.#lastText = e.text;
        this.#empty.reset();
        return;
      case 'wake':
        this.#system('info', e.jobs === 1 ? 'A helper reported back.' : `${e.jobs} helpers reported back.`);
        return;
      case 'queue':
        this.#queueUpdate(e);
        return;
      case 'user_message':
        this.#delivered(e);
        return;
      case 'advisor':
        // May come after the session settled (the last review of a turn): shown all the same.
        store.upsertItem(this.agentId, { kind: 'advisor', id: e.id, notes: e.notes, ts: Date.now() });
        return;
      case 'advisor_yielded':
        this.#advisorSpend();
        return;
      case 'compaction_start':
        this.#setBase({ activity: 'thinking', detail: 'Tidying up the chat…' });
        return;
      case 'compaction_end':
        // omp usually said why in a notice already (and then tries its next method)
        if (e.error && !e.willRetry && e.error !== this.#lastNotice) this.#system('warn', `Couldn’t tidy up the chat: ${truncate(e.error, 300)}`);
        else if (!e.error && !e.aborted && !e.skipped) {
          this.#system('info', e.tokensBefore ? `Tidied up the chat to make room (≈${fmtTokens(e.tokensBefore)} tokens summarized).` : 'Tidied up the chat to make room.');
        }
        this.#setBase(this.#working ? { activity: 'thinking', detail: 'Thinking…' } : { activity: 'idle' });
        void this.#refreshContext();
        return;
      case 'goal':
        this.#applyGoal(e.goal);
        return;
    }
  }

  /** omp's queues changed: a chip moved between them (promoted to steering). */
  #queueUpdate(e: Extract<AgentEvent, { kind: 'queue' }>) {
    let changed = false;
    for (const s of this.#sent) {
      if (s.echoed) continue;
      const mode = e.steering.includes(s.text) ? 'steer' : e.followUp.includes(s.text) ? 'queue' : s.mode;
      if (mode !== s.mode) {
        s.mode = mode;
        changed = true;
      }
    }
    if (changed) this.#publishQueue();
  }

  /** omp handed a user message to the model: its chip becomes a bubble (one sent while idle already is one). */
  #delivered(e: Extract<AgentEvent, { kind: 'user_message' }>) {
    const text = e.text.trim();
    let i = this.#sent.findIndex((s) => s.text.trim() === text);
    // omp may have expanded the text (a prompt template): the oldest message sent while idle, else the oldest
    // queued one of its kind.
    if (i < 0) i = this.#sent.findIndex((s) => s.echoed);
    if (i < 0) i = this.#sent.findIndex((s) => (s.mode === 'steer') === e.steering);
    const s = i >= 0 ? this.#sent.splice(i, 1)[0] : undefined;
    // The message this turn works on now (a restart before it ends says so in the chat).
    this.#turn = s?.chat ? { text: s.text, images: s.images, ...(s.itemId ? { itemId: s.itemId } : {}) } : undefined;
    this.#journal();
    if (s?.echoed) return;
    if (s?.shown) this.#system('info', s.shown);
    else if (s) this.d.store.upsertItem(this.agentId, this.#bubble(s, e.steering));
    else if (text) this.d.store.upsertItem(this.agentId, { kind: 'user', id: `${this.agentId}:u:${uid()}`, text: e.text, ts: Date.now(), ...(e.steering ? { steered: true } : {}) });
    if (s) this.#publishQueue();
  }

  #bubble(s: Sent, steered: boolean): TranscriptItem {
    return {
      kind: 'user',
      id: `${this.agentId}:u:${uid()}`,
      text: s.text,
      ts: Date.now(),
      ...(s.images.length ? { images: s.images } : {}),
      ...(steered ? { steered: true } : {}),
    };
  }

  #unsend(s: Sent) {
    const i = this.#sent.indexOf(s);
    if (i < 0) return;
    this.#sent.splice(i, 1);
    if (!s.echoed) this.#publishQueue();
    this.#journal();
  }

  /** Keep what the person is doing for the user on disk (work-journal.ts): the chat message the turn works on, and
   *  the chat messages they haven't read yet. */
  #journal() {
    if (!this.d.journal) return;
    const waiting = this.#sent.filter((s) => s.chat).map((s) => ({ text: s.text, images: s.images, ...(s.itemId && s.echoed ? { itemId: s.itemId } : {}) }));
    const turn = this.#working ? this.#turn : undefined;
    this.d.journal(this.agentId, turn || waiting.length ? { ...(this.info?.threadId ? { threadId: this.info.threadId } : {}), at: Date.now(), ...(turn ? { turn } : {}), waiting } : null);
  }

  #publishQueue() {
    const queue: QueuedMessage[] = this.#sent
      .filter((s) => !s.echoed)
      .map((s) => ({ key: s.key, text: truncate(s.shown ?? s.text, MAX_CHIP), images: s.images.length, mode: s.mode, by: s.by }));
    this.d.store.patch(this.agentId, { queue: queue.length ? queue : undefined }, true);
    this.#journal();
  }

  /** One "Stopped." per Stop, however many of its prompts omp reports aborted. */
  #noteStopped() {
    if (this.#stopNoted) return;
    this.#stopNoted = true;
    this.#system('info', 'Stopped.');
  }

  /** A freshly started omp: take what it said at boot (context, goal) and count advisor spend from here on. */
  #booted(proc: OmpProcess) {
    this.#proc = proc;
    const boot = this.d.pool.bootState(this.agentId);
    if (boot) {
      this.#setContext(boot.contextUsage);
      this.#applyGoal(parseOmpGoal(boot.goal?.goal), true);
    }
    this.#markAdvisorStart();
  }

  /** How full the context is now (get_session_stats: small, unlike get_state). Never while compacting: omp runs
   *  commands one at a time, so the reading would only wait behind it. */
  async #refreshContext(): Promise<void> {
    const proc = this.d.pool.get(this.agentId);
    if (!proc || this.#compacting || this.#retired) return;
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return;
    }
    this.#refreshing = true;
    try {
      const r = await proc.call<{ contextUsage?: BootState['contextUsage'] }>({ type: 'get_session_stats' }, STATS_MS);
      if (this.d.pool.get(this.agentId) === proc && !this.#retired) this.#setContext(r?.contextUsage);
    } catch {
      /* a reading is optional */
    } finally {
      this.#refreshing = false;
    }
    if (this.#refreshAgain) {
      this.#refreshAgain = false;
      await this.#refreshContext();
    }
  }

  #setContext(u: BootState['contextUsage'] | undefined) {
    const tokens = count(u?.tokens);
    const window = count(u?.contextWindow);
    if (tokens === undefined || !window) return;
    const percent = count(u?.percent) ?? (tokens / window) * 100;
    const context: ContextUsage = { tokens: Math.round(tokens), window, percent: Math.round(percent * 10) / 10, live: true, at: Date.now() };
    this.d.store.patch(this.agentId, { context });
    this.d.threads.setContext(this.agentId, context); // kept with the chat: shown "last seen" while omp is down
  }

  /** omp's goal changed (goal_updated, a goal command's answer; `quiet`: read at boot or after a chat switch). */
  #applyGoal(g: OmpGoal | null, quiet = false) {
    const prev = this.info?.goal;
    const status = g?.status;
    const next: GoalInfo | undefined =
      g && (status === 'active' || status === 'paused' || status === 'budget-limited')
        ? {
            objective: g.objective,
            status,
            tokensUsed: g.tokensUsed ?? 0,
            ...(g.tokenBudget ? { tokenBudget: g.tokenBudget } : {}),
            ...(g.timeUsedSeconds !== undefined ? { timeUsedSeconds: g.timeUsedSeconds } : {}),
            updatedAt: g.updatedAt ?? Date.now(),
          }
        : undefined;
    if (!quiet) {
      const say = (text: string) => this.#system('info', text);
      if (status === 'complete') {
        if (prev) say('Goal complete');
      } else if (!next) {
        if (prev) say('Goal dropped');
      } else if (!prev || prev.objective !== next.objective) {
        if (next.status === 'active') say(`Goal set: ${truncate(next.objective, 300)}`);
      } else if (prev.status !== next.status) {
        if (next.status === 'paused') say('Goal paused');
        else if (next.status === 'budget-limited') say('Token budget reached — wrapping up');
        else if (prev.status === 'paused') say('Goal resumed');
      }
    }
    // Token counts move after every model call: coalesced; a new status goes out at once.
    this.d.store.patch(this.agentId, { goal: next }, prev?.status !== next?.status);
    this.d.threads.setGoal(this.agentId, next); // kept with the chat: shown (paused) while omp is down
  }

  /** The advisor's transcript of the current chat (omp keeps it beside the session's helper transcripts). */
  #advisorFile(): string | undefined {
    const session = this.d.threads.resumeFile(this.agentId);
    return session?.endsWith('.jsonl') ? join(session.slice(0, -'.jsonl'.length), '__advisor.jsonl') : undefined;
  }

  /** Spend already in the advisor's transcript is from before this process (or chat): not counted again. */
  #markAdvisorStart() {
    const file = this.#advisorFile();
    if (!file) return;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* no review yet */
    }
    this.#advisorRead.set(file, size);
  }

  /** An advisor review finished: add what its requests cost (new lines of __advisor.jsonl) to the lead's spend —
   *  get_session_stats leaves it out. The file is omp's: anything unexpected is skipped quietly. */
  #advisorSpend() {
    const file = this.#advisorFile();
    if (!file) return;
    let fd: number | undefined;
    try {
      const from = this.#advisorRead.get(file) ?? 0;
      const size = statSync(file).size;
      if (size <= from) return;
      fd = openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      const end = buf.subarray(0, n).lastIndexOf(10); // whole lines only: the rest is still being written
      if (end < 0) return;
      let cost = 0;
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        try {
          const e = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: { cost?: { total?: unknown } } } };
          if (e.type === 'message' && e.message?.role === 'assistant') cost += count(e.message.usage?.cost?.total) ?? 0;
        } catch {
          /* a torn or foreign line */
        }
      }
      this.#advisorRead.set(file, from + end + 1);
      if (cost > 0) this.d.store.patch(this.agentId, { costUsd: (this.info?.costUsd ?? 0) + cost });
    } catch {
      /* no transcript (yet) */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  #usage(e: Extract<AgentEvent, { kind: 'usage' }>) {
    const cur = this.info;
    if (!cur) return;
    const tokens = { input: (cur.tokens?.input ?? 0) + e.input, output: (cur.tokens?.output ?? 0) + e.output };
    this.d.store.patch(this.agentId, { tokens, costUsd: (cur.costUsd ?? 0) + e.cost });
    const spec = this.d.specFor(this.agentId);
    const got = `${e.provider}/${e.model}`;
    if (spec && e.provider && !this.#mismatchWarned && got !== spec.model && got !== this.#prevModel) {
      this.#mismatchWarned = true;
      this.d.toast('warn', `${cur.name} answered with ${got} instead of ${spec.model}`, this.projectId, this.agentId);
    }
  }

  #promptResult(e: Extract<AgentEvent, { kind: 'prompt_result' }>) {
    if (this.#withdrawn.delete(e.id)) return; // taken back out of the queue: its waiter is settled already
    const sent = this.#sent.find((s) => s.promptId === e.id);
    if (sent) this.#unsend(sent); // never handed to the model (aborted, failed, or a builtin command)
    const w = this.#waiters.find((x) => x.id === e.id);
    if (e.status === 'error') {
      const msg = e.error ?? 'The model returned an error';
      const stuck = stuckKind(msg);
      if (stuck) this.#failStuck(stuck, msg);
      else this.#fail(msg);
    } else if (e.status === 'aborted') {
      this.#noteStopped();
      this.#tools.clear();
      this.#setBase({ activity: 'idle' });
      this.d.turns?.end(this.agentId); // a stopped turn may never settle
    } else {
      this.#tools.clear();
      if (!e.sessionSettled && this.d.subagents.activeFor(this.agentId) > 0) this.#delegating();
      else this.#setBase({ activity: 'done', detail: 'Done' });
    }
    if (w) {
      w.status = e.status;
      w.error = e.error;
      w.phase = 'settle';
      // An aborted turn may never settle (queued work was withdrawn) — resolve right away.
      if (e.status === 'aborted') void this.#finishWaiter(w);
    }
    // "settled" here means the same as a session_settled frame (which may or may not follow): finish now so
    // whoever awaited this prompt sees an idle, non-busy person.
    if (e.sessionSettled) this.#settled();
  }

  #settled() {
    this.d.turns?.end(this.agentId);
    this.#working = false;
    this.#turn = undefined;
    this.#journal();
    this.#tools.clear();
    this.#setAvailable(false);
    if (this.d.pool.spec(this.agentId)?.model === this.d.specFor(this.agentId)?.model) this.#prevModel = undefined;
    void this.syncAccount(); // a pick made while it worked; and which account omp used for this turn
    for (const w of this.#waiters.filter((x) => x.phase === 'settle')) void this.#finishWaiter(w);
    this.#status(this.#lastError ? 'error' : 'idle', true);
    this.d.git.poke(this.projectId, this.info?.jobId);
    void this.#refreshContext();
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#base.activity === 'error') {
      this.#idleTimer = setTimeout(() => this.#setBase({ activity: 'idle', detail: this.#base.detail }), ERROR_TO_IDLE_MS);
      return;
    }
    // session_settled can arrive after prompt_result already finished the turn and the workflow moved on:
    // a user stop (idle) or a handoff walk must not be replaced by a late "Done".
    const a = this.#base.activity;
    if (a === 'idle' || a === 'handoff') return;
    if (a !== 'done') this.#setBase({ activity: 'done', detail: 'Done' });
    this.#idleTimer = setTimeout(() => this.#setBase({ activity: 'idle' }), DONE_TO_IDLE_MS);
  }

  async #finishWaiter(w: Waiter) {
    this.#waiters = this.#waiters.filter((x) => x !== w);
    let text = this.#lastText;
    const proc = this.d.pool.get(this.agentId);
    if (proc && w.status === 'completed') {
      try {
        const r = await proc.call<{ text?: string | null }>({ type: 'get_last_assistant_text' }, 5000);
        if (r?.text) text = r.text;
      } catch {
        /* fall back to the streamed text */
      }
    }
    w.resolve({ status: w.status, text, error: w.error });
  }

  #dropWaiter(id: string, outcome: PromptOutcome) {
    const w = this.#waiters.find((x) => x.id === id);
    if (!w) return;
    this.#waiters = this.#waiters.filter((x) => x !== w);
    w.resolve(outcome);
  }

  #refreshDelegating() {
    if (this.#base.activity !== 'delegating' || !this.info?.available) return;
    if (this.d.subagents.activeFor(this.agentId) > 0) this.#delegating();
  }

  /** The turn is over but helpers still work in the background: show them working, the person free to talk. */
  #delegating() {
    const n = this.d.subagents.activeFor(this.agentId);
    this.#setBase({ activity: 'delegating', detail: `${n} helper${n === 1 ? '' : 's'} working · free to talk` });
    this.#setAvailable(true);
  }

  #setAvailable(v: boolean) {
    if (!!this.info?.available !== v) this.d.store.patch(this.agentId, { available: v || undefined }, true);
  }

  #fail(message: string) {
    this.#lastError = message;
    this.#tools.clear();
    // An expired sign-in or a refused key isn't fixed by sending again: say where it is fixed (omp's words under Details).
    const plain = explainAuthError(message);
    this.#system('error', plain ?? message, plain ? { details: message } : {});
    const line = plain ?? message.split('\n')[0]!;
    this.#setBase({ activity: 'error', detail: truncate(line, 80) });
    this.#status('error', true);
    this.d.toast('error', `${this.info?.name ?? 'Agent'}: ${truncate(line, 140)}`, this.projectId, this.agentId);
  }

  /** The model the person is on now (an empty-answer streak is per model). */
  #modelNow(): string {
    return this.d.pool.spec(this.agentId)?.model ?? this.info?.model ?? '';
  }

  /** The empty-answer card (F5): from the 2nd identical empty answer, or at once when the turn ended on one. One card
   *  per streak, updated in place (final: the turn is over — omp stopped retrying). */
  #showEmpty(message: string, final: boolean, kind: StuckKind = 'empty') {
    const count = Math.max(this.#empty.count, retriesOf(message) + (retriesOf(message) ? 1 : 0));
    if (!final && count < 2) return;
    this.#empty.cardId ??= `${this.agentId}:stuck:${uid()}`;
    const model = this.info?.modelLabel ?? this.#modelNow();
    this.d.store.upsertItem(this.agentId, {
      kind: 'system',
      id: this.#empty.cardId,
      level: final ? 'error' : 'warn',
      text: stuckText(kind, model, message),
      ts: Date.now(),
      details: message,
      stuck: { kind, model, count: Math.max(count, 1), ...(final ? { final: true } : {}) },
    });
  }

  /** The turn ended on an empty answer, or omp gave up retrying another error: the card instead of a bare line. */
  #failStuck(kind: StuckKind, message: string) {
    this.#lastError = message;
    this.#tools.clear();
    if (kind === 'empty') this.#empty.atLeast(message, this.#modelNow(), 1);
    else this.#empty.reset();
    this.#showEmpty(message, true, kind);
    const model = this.info?.modelLabel ?? 'The model';
    this.#setBase({ activity: 'error', detail: kind === 'empty' ? 'Empty answers — switch model?' : 'Kept failing — switch model?' });
    this.#status('error', true);
    this.d.toast(
      'error',
      kind === 'empty' ? `${this.#name}: ${model} keeps sending back empty answers — switch the model or send “continue”.` : `${this.#name}: ${model} kept failing — switch the model or try again.`,
      this.projectId,
      this.agentId,
    );
    // The card stays where it is; the next failure gets a new one at the end of the chat (an empty streak keeps its count:
    // one more empty answer after "continue" shows it again at once).
    if (kind === 'failing') this.#empty.reset();
    else this.#empty.cardId = null;
  }

  /** The start was called off (the person moved out, or their omp was stopped while booting): no error to show. */
  #calledOff(): PromptOutcome {
    this.#working = false;
    if (!this.#retired) {
      this.#base = { activity: 'idle' };
      this.d.store.patch(this.agentId, { status: 'offline', activity: 'idle', detail: undefined, tool: undefined }, true);
    }
    return { status: 'aborted', text: '', error: 'stopped' };
  }

  /** omp didn't start: a plain line in the chat (omp's own output folded behind Details), the message marked
   *  "Not sent" with Retry, and one status for the person and their job: "Couldn't start". */
  #failStart(err: unknown, spec: ProcessSpec, sent?: Sent): PromptOutcome {
    const f = describeStartFailure(err, {
      name: this.#name,
      modelLabel: this.info?.modelLabel ?? spec.model,
      ompBin: this.d.ompBin ?? 'cast-agent',
      startTimeoutS: this.d.startTimeoutS ?? 45,
    });
    log('agents', `${this.agentId}: couldn't start the agent (${f.kind}): ${truncate(errorText(err), 300)}`);
    this.#working = false;
    if (sent) this.#markNotSent(sent);
    this.#lastError = f.summary;
    this.#tools.clear();
    this.#system('error', f.summary, { details: f.details });
    this.#setBase({ activity: 'error', detail: 'Couldn’t start' });
    this.#status('error', true);
    this.d.toast('error', truncate(f.summary, 200), this.projectId, this.agentId);
    this.#idleTimer = setTimeout(() => this.#setBase({ activity: 'idle', detail: 'Couldn’t start' }), ERROR_TO_IDLE_MS);
    return { status: 'error', text: '', error: f.summary };
  }

  /** The person can't start now (their model isn't connected while another one is, found once the first check
   *  ended): the message is not sent and the chat says why. */
  #failBlocked(why: string, sent: Sent) {
    this.#markNotSent(sent);
    this.#system('warn', why);
    this.#setBase({ activity: 'idle' });
    this.#status(this.d.pool.get(this.agentId) ? 'idle' : 'offline', true);
  }

  #setBase(b: Base) {
    this.#base = b;
    if (b.activity !== 'done' && b.activity !== 'idle' && b.activity !== 'error' && this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    this.render();
  }

  #status(status: AgentInfo['status'], immediate = false) {
    this.d.store.patch(this.agentId, { status }, immediate);
  }

  get #name(): string {
    return this.info?.name ?? 'They';
  }

  #system(level: 'info' | 'warn' | 'error', text: string, extra: { details?: string; resend?: { text: string; images?: ImageRef[] } } = {}): string {
    const item: TranscriptItem = { kind: 'system', id: `${this.agentId}:s:${uid()}`, level, text, ts: Date.now(), ...extra };
    this.d.store.upsertItem(this.agentId, item);
    return item.id;
  }

  #clearTimers() {
    if (this.#deferTimer) clearTimeout(this.#deferTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#deferTimer = undefined;
    this.#idleTimer = undefined;
  }
}
