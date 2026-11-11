// Subagent people: omp task-tool workers become temporary helpers who walk into the house, do chores
// (or a mapped station when a tool is active) and leave ~6 s after finishing. Each helper also leaves a durable
// 'helper' card in the parent's chat (id "helper:<omp id>", saved with that chat): its whole chat is read later from
// the helper's omp session file — <parent session file without .jsonl>/<omp id>.jsonl, stored with the card — even
// after it left, the parent's omp stopped, RLT restarted or that chat moved to another session (helperSessionFile).
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Activity, AgentInfo, TranscriptItem } from '../../shared/protocol';
import type { AgentStore } from './agent-store';
import type { ModelRegistry } from './models';
import { splitSelector, vendorOf } from './models';
import type { SubagentLifecyclePayload, SubagentProgressPayload } from './normalize';
import { residentAppearance } from './residents';
import { activityForTool, toolDetail } from './tool-display';
import { humanize, truncate } from './util';

const REMOVE_AFTER_MS = 6000;
const MAX_TASK = 2048;
/** Helper session files remembered (parent + omp id → file relative to the parent's session dir), oldest dropped. */
const MAX_FILES = 2000;

type HelperItem = Extract<TranscriptItem, { kind: 'helper' }>;

/** The parent chat's card for a helper. */
export const helperItemId = (ompId: string) => `helper:${ompId}`;

/** `file` relative to `dir` when it is a .jsonl that really lies inside it, else undefined. Decided on real paths (a
 *  symlinked data dir is fine; a symlinked folder or file inside the dir that points elsewhere is not). */
export function insideSessionDir(dir: string, file: string): string | undefined {
  const rel = (base: string, f: string) => {
    const r = relative(base, f);
    return r && !r.startsWith('..') && !isAbsolute(r) && r.endsWith('.jsonl') ? r : undefined;
  };
  const abs = resolve(dir, file);
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return rel(resolve(dir), abs); // no session dir yet: nothing in it can be read either
  }
  try {
    // The deepest existing folder on the way, resolved through any links, plus the parts that don't exist yet.
    let head = dirname(abs);
    const tail = [basename(abs)];
    while (!lstatSync(head, { throwIfNoEntry: false })) {
      if (dirname(head) === head) return undefined;
      tail.unshift(basename(head));
      head = dirname(head);
    }
    const real = join(realpathSync(head), ...tail);
    if (lstatSync(real, { throwIfNoEntry: false })?.isSymbolicLink()) return undefined;
    return rel(realDir, real);
  } catch {
    return undefined;
  }
}

/** Where a helper's omp session lives: the file omp reported (when it lies in the parent's session dir), else the
 *  file omp would have written — next to the parent's own session file, in a folder named after it. */
export function helperSessionFile(sessionDir: string, parentSession: string | undefined, ompId: string, reported?: string): string | undefined {
  if (reported) {
    const rel = insideSessionDir(sessionDir, reported);
    if (rel) return join(resolve(sessionDir), rel);
  }
  if (!parentSession || !parentSession.endsWith('.jsonl')) return undefined;
  const derived = join(resolve(sessionDir, parentSession.slice(0, -'.jsonl'.length)), `${ompId}.jsonl`);
  const rel = insideSessionDir(sessionDir, derived);
  return rel ? join(resolve(sessionDir), rel) : undefined;
}

interface Helper {
  agentId: string;
  parentId: string;
  ompId: string;
  finished: boolean;
  /** omp's status once finished ('completed' | 'failed' | 'aborted'). */
  status?: string;
  model?: string;
  task: string;
  lastTool?: string;
  toolSeq: number;
  costUsd: number;
  fallbackWarned: boolean;
  removeTimer?: ReturnType<typeof setTimeout>;
  /** Keep a tool's station on screen at least this long (helpers' reads take milliseconds). */
  holdUntil: number;
  holdTimer?: ReturnType<typeof setTimeout>;
}

const TOOL_DWELL_MS = 1500;

export interface SubagentDeps {
  store: AgentStore;
  models: ModelRegistry;
  toast(level: 'info' | 'warn' | 'error', text: string, projectId?: string, agentId?: string): void;
  /** The parent's omp session dir and its current session file (a name inside it), if known. */
  sessionOf?(parentId: string): { dir: string; file?: string } | undefined;
}

const stripThinking = (s: string) => s.replace(/:(off|minimal|low|medium|high|xhigh|max|auto)$/, '');

export class SubagentTracker {
  #helpers = new Map<string, Helper>(); // `${parentId}|${ompId}` → helper
  #counters = new Map<string, number>(); // projectId → last helper number
  #costByParent = new Map<string, number>(); // cumulative helper spend per parent (survives removal)
  /** `${parentId}|${ompId}` → { the parent's session file then, the helper's file relative to the session dir }. */
  #files = new Map<string, { parent?: string; rel: string }>();

  constructor(private readonly d: SubagentDeps) {}

  /** Number of helpers of this parent that have not finished yet. */
  activeFor(parentId: string): number {
    let n = 0;
    for (const h of this.#helpers.values()) if (h.parentId === parentId && !h.finished) n++;
    return n;
  }

  /** omp's id for a helper person (what steer_subagent / cancel_subagent expect). */
  ompIdOf(agentId: string): string | undefined {
    for (const h of this.#helpers.values()) if (h.agentId === agentId) return h.ompId;
    return undefined;
  }

  /** Cumulative USD spent by all helpers this parent ever spawned. */
  costFor(parentId: string): number {
    return this.#costByParent.get(parentId) ?? 0;
  }

  /** The helper of this parent (omp id) is still working. */
  running(parentId: string, ompId: string): boolean {
    const h = this.#helpers.get(`${parentId}|${ompId}`);
    return !!h && !h.finished;
  }

  /** The helper's omp session file (absolute, inside the parent's session dir): the one its card stored (`stored`,
   *  relative to that dir), else — cards from before they stored it — worked out for the parent's current chat. */
  sessionFile(parentId: string, ompId: string, stored?: string): string | undefined {
    const s = this.d.sessionOf?.(parentId);
    if (!s) return undefined;
    if (stored) {
      const rel = insideSessionDir(s.dir, stored);
      return rel ? join(resolve(s.dir), rel) : undefined;
    }
    return this.#currentFile(s, parentId, ompId);
  }

  /** The helper's file for the parent's session now: what omp reported, while the parent is still on that session
   *  (an older chat may have had a helper of that name), else derived from the parent's session file. */
  #currentFile(s: { dir: string; file?: string }, parentId: string, ompId: string): string | undefined {
    const known = this.#files.get(`${parentId}|${ompId}`);
    const reported = known && (!s.file || !known.parent || known.parent === s.file) ? join(s.dir, known.rel) : undefined;
    return helperSessionFile(s.dir, s.file, ompId, reported);
  }

  lifecycle(parent: AgentInfo, p: SubagentLifecyclePayload): void {
    this.#noteFile(parent.id, p.id, p.sessionFile);
    if (p.status === 'started') {
      this.#ensure(parent, p.id, p.agent);
      return;
    }
    const h = this.#helpers.get(`${parent.id}|${p.id}`);
    if (h) this.#finish(h, p.status);
  }

  progress(parent: AgentInfo, p: SubagentProgressPayload): void {
    const pr = p.progress;
    this.#noteFile(parent.id, pr.id, p.sessionFile);
    const h = this.#ensure(parent, pr.id, p.agent, p.assignment ?? pr.assignment);
    if (h.finished) return;
    const task = p.assignment ?? pr.assignment;
    if (task && !h.task) {
      h.task = truncate(task, MAX_TASK);
      this.#card(h);
    }
    const { store } = this.d;
    const patch: Partial<AgentInfo> = {};

    if (pr.resolvedModel) {
      const sel = this.d.models.undemo(stripThinking(pr.resolvedModel));
      patch.model = sel;
      patch.modelLabel = this.d.models.label(sel);
      patch.vendor = vendorOf(sel);
      this.#checkFallback(parent, h, pr.modelOverride, pr.resolvedModelIdentity ?? pr.resolvedModel);
      if (h.model !== sel) {
        h.model = sel;
        this.#card(h);
      }
    }
    if (typeof pr.tokens === 'number') patch.tokens = { input: pr.tokens, output: 0 };
    if (typeof pr.cost === 'number') {
      const delta = Math.max(0, pr.cost - h.costUsd);
      h.costUsd = pr.cost;
      patch.costUsd = pr.cost;
      this.#costByParent.set(h.parentId, this.costFor(h.parentId) + delta);
      if (delta > 0) this.#card(h, true);
    }

    const tool = pr.currentTool;
    if (tool) {
      const mapped = activityForTool(tool);
      patch.activity = mapped === 'thinking' ? 'chore' : mapped;
      patch.tool = tool;
      patch.detail = toolDetail(tool, pr.currentToolArgsKey ? { [pr.currentToolArgsKey]: pr.currentToolArgs } : { path: pr.currentToolArgs });
      if (h.lastTool !== `${tool}:${pr.currentToolArgs ?? ''}`) {
        this.#closeToolItem(h);
        h.lastTool = `${tool}:${pr.currentToolArgs ?? ''}`;
        h.toolSeq++;
        store.upsertItem(h.agentId, {
          kind: 'tool',
          id: `${h.agentId}:tool:${h.toolSeq}`,
          tool,
          title: `${tool} ${pr.currentToolArgs ?? ''}`.trim(),
          status: 'running',
          ts: Date.now(),
        });
      }
      h.holdUntil = Date.now() + TOOL_DWELL_MS;
      if (h.holdTimer) clearTimeout(h.holdTimer);
      h.holdTimer = undefined;
    } else {
      this.#closeToolItem(h);
      h.lastTool = undefined;
      const wait = h.holdUntil - Date.now();
      if (wait > 0) {
        // Let the bookshelf/desk visit register, then go back to chores (unless something else happened).
        h.holdTimer ??= setTimeout(() => {
          h.holdTimer = undefined;
          if (!h.finished && !h.lastTool) this.d.store.patch(h.agentId, { activity: 'chore', tool: undefined, detail: 'Helping out' });
        }, wait);
      } else {
        patch.activity = 'chore';
        patch.tool = undefined;
        patch.detail = 'Helping out';
      }
    }
    const out = (pr.recentOutput ?? []).filter(Boolean);
    if (out.length) {
      store.upsertItem(h.agentId, { kind: 'assistant', id: `${h.agentId}:out`, text: out.join('\n'), streaming: true, ts: Date.now() }, true);
    }
    store.patch(h.agentId, patch);
    if (pr.status === 'completed' || pr.status === 'failed' || pr.status === 'aborted') this.#finish(h, pr.status);
  }

  /** The parent's process went away: everyone it spawned leaves too. */
  removeForParent(parentId: string): void {
    for (const h of [...this.#helpers.values()]) {
      if (h.parentId !== parentId) continue;
      if (!h.finished) this.#finish(h, 'aborted');
    }
  }

  dispose(): void {
    for (const h of this.#helpers.values()) {
      if (h.removeTimer) clearTimeout(h.removeTimer);
      if (h.holdTimer) clearTimeout(h.holdTimer);
    }
    this.#helpers.clear();
  }

  #ensure(parent: AgentInfo, ompId: string, agentName?: string, assignment?: string): Helper {
    const key = `${parent.id}|${ompId}`;
    const existing = this.#helpers.get(key);
    if (existing) return existing;
    const n = (this.#counters.get(parent.projectId) ?? 0) + 1;
    this.#counters.set(parent.projectId, n);
    const agentId = `${parent.projectId}:sub:${n}`;
    const task = assignment ? truncate(assignment, MAX_TASK) : '';
    const h: Helper = { agentId, parentId: parent.id, ompId, finished: false, task, toolSeq: 0, costUsd: 0, fallbackWarned: false, holdUntil: 0 };
    this.#helpers.set(key, h);
    const info: AgentInfo = {
      id: agentId,
      projectId: parent.projectId,
      jobId: parent.jobId, // helpers work in their parent's room
      kind: 'subagent',
      name: humanize(ompId),
      roleId: agentName ?? 'task',
      model: parent.model,
      modelLabel: parent.modelLabel,
      vendor: parent.vendor,
      demo: parent.demo,
      notConnected: false, // omp runs a helper on a connected model (else on its parent's): never locked
      parentId: parent.id,
      modelBy: 'helper', // its lead picks the model per task
      status: 'busy',
      activity: 'chore',
      detail: `Sent by ${parent.name}`,
      tokens: { input: 0, output: 0 },
      costUsd: 0,
      appearance: residentAppearance(agentId),
    };
    this.d.store.upsert(info);
    if (assignment) {
      this.d.store.upsertItem(agentId, { kind: 'user', id: `${agentId}:task`, text: truncate(assignment, 4000), ts: Date.now() });
    }
    this.#card(h, false, true);
    return h;
  }

  /** Upsert the helper's card in the parent's chat — created when the helper starts, updated only while that chat
   *  still holds it (the parent may be in another chat by the time the helper leaves). */
  #card(h: Helper, stream = false, create = false) {
    const id = helperItemId(h.ompId);
    const prev = this.d.store.findItem(h.parentId, id);
    if (!create && prev?.kind !== 'helper') return;
    const status: HelperItem['status'] = !h.finished ? 'running' : h.status === 'completed' ? 'done' : h.status === 'failed' ? 'failed' : 'aborted';
    const item: HelperItem = {
      kind: 'helper',
      id,
      name: humanize(h.ompId),
      task: h.task,
      status,
      ts: prev?.ts ?? Date.now(),
    };
    if (h.model) item.model = h.model;
    if (h.costUsd > 0) item.costUsd = h.costUsd;
    if (this.#helpers.has(`${h.parentId}|${h.ompId}`) && this.d.store.has(h.agentId)) item.agentId = h.agentId;
    const file = this.#cardFile(h, prev?.kind === 'helper' ? prev : undefined);
    if (file) item.sessionFile = file;
    if (prev && JSON.stringify(prev) === JSON.stringify(item)) return;
    this.d.store.upsertItem(h.parentId, item, stream);
  }

  /** The card keeps the helper's session file (relative to the parent's session dir), so its chat opens from an
   *  older chat too, whatever that chat's own session file is by then: what omp reported for the parent's session
   *  now, else what the card already holds, else derived from that session. */
  #cardFile(h: Helper, prev: HelperItem | undefined): string | undefined {
    const s = this.d.sessionOf?.(h.parentId);
    if (!s) return prev?.sessionFile;
    const known = this.#files.get(`${h.parentId}|${h.ompId}`);
    if (known && (!s.file || !known.parent || known.parent === s.file)) return known.rel;
    if (prev?.sessionFile) return prev.sessionFile;
    const abs = helperSessionFile(s.dir, s.file, h.ompId);
    return abs ? insideSessionDir(s.dir, abs) : undefined;
  }

  /** Remember where omp writes this helper's session (relative to the parent's session dir; nothing outside it). */
  #noteFile(parentId: string, ompId: string, file: string | undefined) {
    if (!file) return;
    const key = `${parentId}|${ompId}`;
    const s = this.d.sessionOf?.(parentId);
    const rel = s ? insideSessionDir(s.dir, file) : undefined;
    if (!s || !rel || this.#files.get(key)?.rel === rel) return;
    this.#files.delete(key);
    this.#files.set(key, { parent: s.file, rel });
    if (this.#files.size > MAX_FILES) this.#files.delete(this.#files.keys().next().value!);
  }

  #closeToolItem(h: Helper) {
    if (!h.lastTool) return;
    const id = `${h.agentId}:tool:${h.toolSeq}`;
    const item = this.d.store.findItem(h.agentId, id);
    if (item && item.kind === 'tool' && item.status === 'running') this.d.store.upsertItem(h.agentId, { ...item, status: 'done' });
  }

  #finish(h: Helper, status: string) {
    if (h.finished) return;
    h.finished = true;
    h.status = status;
    this.#card(h);
    if (h.holdTimer) clearTimeout(h.holdTimer);
    this.#closeToolItem(h);
    const ok = status === 'completed';
    const out = this.d.store.findItem(h.agentId, `${h.agentId}:out`);
    if (out && out.kind === 'assistant') this.d.store.upsertItem(h.agentId, { ...out, streaming: false } as TranscriptItem);
    const activity: Activity = ok ? 'done' : 'error';
    this.d.store.patch(h.agentId, { status: ok ? 'idle' : 'error', activity, tool: undefined, detail: ok ? 'Finished — heading out' : status === 'aborted' ? 'Stopped' : 'Failed' }, true);
    h.removeTimer = setTimeout(() => {
      for (const [k, v] of this.#helpers) if (v === h) this.#helpers.delete(k);
      this.d.store.remove(h.agentId);
      this.#card(h); // the person left: the card no longer points at them
    }, REMOVE_AFTER_MS);
  }

  /** Real runs only (not the scripted test model): omp silently runs a helper on the parent's model when the helper's
   *  model has no credentials. */
  #checkFallback(parent: AgentInfo, h: Helper, override: string[] | string | undefined, resolved: string) {
    if (parent.demo || h.fallbackWarned || !override) return;
    const wanted = stripThinking(Array.isArray(override) ? (override[0] ?? '') : override);
    if (!wanted || wanted.startsWith('@')) return;
    const a = splitSelector(wanted);
    const b = splitSelector(stripThinking(resolved));
    if (a.provider === b.provider && a.id === b.id) return;
    h.fallbackWarned = true;
    this.d.toast('warn', `Helper ${humanize(h.ompId)} is running on ${b.provider}/${b.id} instead of ${wanted} (no credentials for it)`, parent.projectId, h.agentId);
  }
}
