// omp RPC frames → semantic agent events + transcript items.
//
// FrameNormalizer is per agent process and stateful only for message assembly (delta mode):
// assistant blocks open empty on *_start, grow with *_delta and are replaced by message_end (the research
// "clone race" rule: never trust message_start/_start snapshots). Lifecycle policy (timers, activity
// dwell, status) lives in agent-runtime.ts; this module only says *what happened*.
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { ImageRef, TranscriptItem } from '../../shared/protocol';
import type { OmpFrame } from './omp-process';
import { changedPaths, toolDetail, toolTitle } from './tool-display';
import { truncate } from './util';

export type AgentEvent =
  | { kind: 'item'; item: TranscriptItem; stream: boolean }
  | { kind: 'producing' } // first thinking/text/toolcall delta of a model response
  | { kind: 'composing'; tool: string } // the model started writing a tool call's arguments (e.g. a long `write`)
  | { kind: 'tool_start'; tool: string; toolCallId: string; args: unknown; detail: string; intent?: string }
  | { kind: 'tool_end'; tool: string; toolCallId: string; isError: boolean }
  | { kind: 'usage'; input: number; output: number; cost: number; provider: string; model: string }
  | { kind: 'agent_start' }
  | { kind: 'agent_end' } // a model turn ended (more may follow: queued messages, helpers reporting back)
  | { kind: 'prompt_result'; id: string; status: 'completed' | 'aborted' | 'error'; error?: string; sessionSettled: boolean }
  | { kind: 'settled' }
  | { kind: 'ui_request'; frame: OmpFrame }
  | { kind: 'ui_cancel'; targetId: string }
  | { kind: 'subagent_lifecycle'; payload: SubagentLifecyclePayload }
  | { kind: 'subagent_progress'; payload: SubagentProgressPayload }
  | { kind: 'retry'; attempt: number; maxAttempts: number; message: string }
  /** An assistant message that ended in an error (each failed attempt of omp's retries, and the last one); `id` is the
   *  transcript item the runtime shows it as (AgentRuntime decides how: a line, or the empty-answer card). */
  | { kind: 'model_error'; id: string; message: string }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'assistant_text'; text: string } // a finished assistant message with visible text
  | { kind: 'wake'; jobs: number } // background jobs (helpers) reported back and woke the agent
  /** omp's queues of messages sent while the agent works (chip texts, oldest first); `live` = leading steering
   *  entries already sent into a live stream, which can't be removed any more. */
  | { kind: 'queue'; steering: string[]; followUp: string[]; live: number }
  /** omp delivered a user message to the model (steering: read at a step boundary while it worked). */
  | { kind: 'user_message'; text: string; steering: boolean; images: number }
  | { kind: 'advisor'; id: string; notes: AdvisorNote[] } // a card of the advisor's notes
  | { kind: 'advisor_yielded' } // an advisor review finished (its spend is in the session's __advisor.jsonl)
  | { kind: 'compaction_start'; reason: string; action: string } // omp tidies up the context on its own
  | { kind: 'compaction_end'; tokensBefore?: number; aborted: boolean; skipped: boolean; willRetry: boolean; error?: string }
  | { kind: 'goal'; goal: OmpGoal | null }; // goal_updated: the goal as omp has it now (null: gone)

export interface AdvisorNote {
  note: string;
  severity?: 'nit' | 'concern' | 'blocker';
}

/** omp's Goal (goal_updated, the goal command's answers, get_state.goal.goal). */
export interface OmpGoal {
  id?: string;
  objective: string;
  status: string; // 'active' | 'paused' | 'budget-limited' | 'complete' | 'dropped'
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  updatedAt?: number;
}

export interface SubagentLifecyclePayload {
  id: string;
  agent?: string;
  status: 'started' | 'completed' | 'failed' | 'aborted';
  parentToolCallId?: string; // the lead's task tool call
  description?: string;
  index?: number;
  sessionFile?: string; // the helper's own omp session (absolute; "<lead session without .jsonl>/<id>.jsonl")
}

export interface SubagentProgress {
  id: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  currentTool?: string;
  currentToolArgs?: string;
  currentToolArgsKey?: string;
  currentToolIntent?: string;
  recentTools?: unknown[];
  recentOutput?: string[];
  toolCount?: number;
  requests?: number;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  modelOverride?: string[] | string;
  resolvedModel?: string;
  resolvedModelIdentity?: string;
  assignment?: string;
  contextTokens?: number;
  contextWindow?: number;
}

export interface SubagentProgressPayload {
  agent?: string;
  assignment?: string;
  parentToolCallId?: string;
  sessionFile?: string;
  progress: SubagentProgress;
}

const MAX_RESULT = 4096;
const MAX_ARG_STRING = 2048;
const MAX_NOTE = 2000;
const MAX_TOOL_PATHS = 20;
const MAX_TOOL_IMAGES = 8;
const MAX_TOOL_IMAGE_BYTES = 25 * 1024 * 1024; // decoded

/** Keeps a tool result's image bytes like an upload and returns its ref (null: not a PNG/JPEG/GIF/WebP). */
export type ToolImageStore = (bytes: Uint8Array) => ImageRef | null;

let defaultImageStore: ToolImageStore | null = null;

/** Where every normalizer keeps tool-result images unless it was given its own (index.ts sets this at startup to the
 *  uploads store). Unset → images are dropped: the item keeps only the result's '[image]' text. */
export function setToolImageStore(store: ToolImageStore | null): void {
  defaultImageStore = store;
}

export interface NormalizerOptions {
  /** The person's folder (omp's cwd): tool paths inside it become relative, others absolute. Absent → as omp got them. */
  cwd?: string;
  /** Overrides setToolImageStore's store (tests). */
  storeImage?: ToolImageStore;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Only the fields RLT uses, type-checked (a helper's session file must be a string to be resolved later). */
function subagentPayload<T extends { parentToolCallId?: string; sessionFile?: string }>(p: T): T {
  const out = { ...p };
  if (!str(out.sessionFile)) delete out.sessionFile;
  if (!str(out.parentToolCallId)) delete out.parentToolCallId;
  return out;
}

/** The text of a message's content (a string, or text blocks). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[]).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
}

function advisorNotes(details: unknown): AdvisorNote[] {
  const raw = (details as { notes?: unknown } | undefined)?.notes;
  if (!Array.isArray(raw)) return [];
  const notes: AdvisorNote[] = [];
  for (const n of raw as { note?: unknown; severity?: unknown }[]) {
    const note = str(n?.note)?.trim();
    if (!note) continue;
    const severity = n.severity === 'nit' || n.severity === 'concern' || n.severity === 'blocker' ? n.severity : undefined;
    notes.push(severity ? { note: truncate(note, MAX_NOTE), severity } : { note: truncate(note, MAX_NOTE) });
  }
  return notes;
}

export function parseOmpGoal(v: unknown): OmpGoal | null {
  const g = v as Partial<OmpGoal> | null | undefined;
  if (!g || typeof g !== 'object' || typeof g.objective !== 'string' || typeof g.status !== 'string') return null;
  return {
    id: str(g.id),
    objective: g.objective,
    status: g.status,
    tokenBudget: count(g.tokenBudget),
    tokensUsed: count(g.tokensUsed),
    timeUsedSeconds: count(g.timeUsedSeconds),
    updatedAt: count(g.updatedAt),
  };
}

type Block = { type?: string; text?: string; thinking?: string; narration?: boolean };

/** Tool results are `{content:[{type:'text',text}], details}`; flatten to text. */
export function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const r = result as { content?: unknown } | undefined;
  if (r && Array.isArray(r.content)) {
    return (r.content as { type?: string; text?: string }[])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : c.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  return '';
}

/** `src/app.ts:10-20` → `src/app.ts` (as tool-display's cleanPath). */
const cleanPath = (p: string) => p.replace(/:(raw|conflicts|img|-?\d[\d,+\-:]*)(:raw)?$/i, '') || p;
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The files a tool call reads or writes, from its arguments (write/edit/patch targets, a read's path). */
export function toolArgPaths(tool: string, rawArgs: unknown): string[] {
  const out = [...(changedPaths(tool, rawArgs) ?? [])];
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  if (tool === 'read' && typeof args.path === 'string') out.push(cleanPath(args.path.trim()));
  return out;
}

/** Paths as the transcript keeps them: relative to `cwd` when inside it (and cwd is known), else absolute; no URLs,
 *  no '.', no duplicates. */
export function tidyPaths(paths: string[], cwd?: string): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let p = raw.trim().replace(/\/+$/, '');
    if (!p || URLISH.test(p) || p.length > 1024 || p.includes('\0')) continue;
    if (cwd) {
      const abs = resolve(cwd, p);
      const rel = relative(cwd, abs);
      if (!rel) continue; // the folder itself
      p = rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : abs;
    } else if (!isAbsolute(p)) {
      p = posix.normalize(p).replace(/^\.\//, '');
    }
    if (!p || p === '.' || out.includes(p)) continue;
    out.push(p);
    if (out.length >= MAX_TOOL_PATHS) break;
  }
  return out;
}

/** The images of a tool result (content image blocks; generate_image's details.images), kept by `store`. */
export function toolResultImages(result: unknown, store: ToolImageStore | null): ImageRef[] {
  if (!store) return [];
  const r = (result && typeof result === 'object' ? result : {}) as { content?: unknown; details?: { images?: unknown } };
  const raw: unknown[] = [
    ...(Array.isArray(r.content) ? (r.content as { type?: string }[]).filter((b) => b?.type === 'image') : []),
    ...(Array.isArray(r.details?.images) ? r.details.images : []),
  ];
  const refs: ImageRef[] = [];
  for (const img of raw) {
    if (refs.length >= MAX_TOOL_IMAGES) break;
    const given = (img as { data?: unknown } | null)?.data;
    if (typeof given !== 'string' || !given) continue;
    const data = given.replace(/^data:[^,]*;base64,/, '');
    if (data.length > Math.ceil((MAX_TOOL_IMAGE_BYTES * 4) / 3) + 4) continue;
    try {
      const ref = store(Buffer.from(data, 'base64'));
      if (ref && !refs.some((x) => x.id === ref.id)) refs.push(ref);
    } catch {
      /* the store logs; the result's text still says '[image]' */
    }
  }
  return refs;
}

/** Cap long string fields (write content, edit patches) so transcript items stay small. */
export function capArgs(args: unknown): unknown {
  if (typeof args === 'string') return truncate(args, MAX_ARG_STRING);
  if (Array.isArray(args)) return args.map(capArgs);
  if (args && typeof args === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) out[k] = capArgs(v);
    return out;
  }
  return args;
}

export class FrameNormalizer {
  #msgKey: string | null = null;
  #text = '';
  #thinking = '';
  #producing = false;
  #msgTs = Date.now();
  #tools = new Map<string, TranscriptItem & { kind: 'tool' }>();

  /** `gen` disambiguates omp's per-process message ids (msg-1, msg-2…) across respawns and server restarts
   *  (transcripts are persisted per thread, so ids must never repeat). */
  constructor(
    private readonly gen: string,
    private readonly opts: NormalizerOptions = {},
  ) {}

  handle(f: OmpFrame): AgentEvent[] {
    switch (f.type) {
      case 'agent_start': {
        // A reply cut off without a message_end (a compaction interrupted the turn) must not stream forever.
        const out: AgentEvent[] = [];
        if (this.#msgKey && (this.#text.trim() || this.#thinking.trim())) out.push({ kind: 'item', item: this.#assistantItem(false), stream: false });
        this.#msgKey = null;
        this.#producing = false;
        out.push({ kind: 'agent_start' });
        return out;
      }
      case 'agent_end':
        return [{ kind: 'agent_end' }];
      case 'message_start':
        return this.#messageStart(f);
      case 'message_update':
        return this.#messageUpdate(f);
      case 'message_end':
        return this.#messageEnd(f);
      case 'tool_execution_start':
        return this.#toolStart(f);
      case 'tool_execution_update':
        return this.#toolUpdate(f);
      case 'tool_execution_end':
        return this.#toolEnd(f);
      case 'prompt_result': {
        const err = f.error as { message?: string } | undefined;
        const status = (['completed', 'aborted', 'error'].includes(String(f.status)) ? f.status : 'error') as 'completed' | 'aborted' | 'error';
        return [{ kind: 'prompt_result', id: String(f.id ?? ''), status, error: err?.message, sessionSettled: f.sessionSettled !== false }];
      }
      case 'session_settled':
        return [{ kind: 'settled' }];
      case 'extension_ui_request': {
        const method = String(f.method ?? '');
        if (method === 'cancel') return [{ kind: 'ui_cancel', targetId: String(f.targetId ?? '') }];
        if (['select', 'confirm', 'input', 'editor', 'ask'].includes(method)) return [{ kind: 'ui_request', frame: f }];
        return []; // setWidget / setStatus / notify noise
      }
      case 'subagent_lifecycle':
        return f.payload ? [{ kind: 'subagent_lifecycle', payload: subagentPayload(f.payload as SubagentLifecyclePayload) }] : [];
      case 'subagent_progress': {
        const p = f.payload as SubagentProgressPayload | undefined;
        return p?.progress?.id ? [{ kind: 'subagent_progress', payload: subagentPayload(p) }] : [];
      }
      case 'queue_update': {
        const texts = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []);
        return [{ kind: 'queue', steering: texts(f.steering), followUp: texts(f.followUp), live: count(f.liveSteered) ?? 0 }];
      }
      case 'auto_compaction_start':
        return [{ kind: 'compaction_start', reason: String(f.reason ?? ''), action: String(f.action ?? '') }];
      case 'auto_compaction_end': {
        const result = f.result as { tokensBefore?: unknown } | undefined;
        return [{
          kind: 'compaction_end',
          tokensBefore: count(result?.tokensBefore),
          aborted: f.aborted === true,
          skipped: f.skipped === true,
          willRetry: f.willRetry === true,
          error: str(f.errorMessage),
        }];
      }
      case 'goal_updated':
        return [{ kind: 'goal', goal: parseOmpGoal(f.goal) }];
      case 'advisor_yielded':
        return [{ kind: 'advisor_yielded' }];
      case 'auto_retry_start':
        return [{ kind: 'retry', attempt: Number(f.attempt ?? 0), maxAttempts: Number(f.maxAttempts ?? 0), message: String(f.errorMessage ?? '') }];
      case 'notice': {
        const level = f.level === 'error' ? 'error' : f.level === 'warning' || f.level === 'warn' ? 'warn' : 'info';
        return [{ kind: 'notice', level, message: String(f.message ?? '') }];
      }
      case 'extension_error':
        return [{ kind: 'notice', level: 'warn', message: `Extension error: ${String(f.error ?? '')}` }];
      default:
        return [];
    }
  }

  #messageStart(f: OmpFrame): AgentEvent[] {
    const msg = f.message as
      | { role?: string; customType?: string; details?: { jobs?: unknown[] }; content?: unknown; steering?: boolean; synthetic?: boolean }
      | undefined;
    if (msg?.role === 'user' && !msg.synthetic) {
      const images = Array.isArray(msg.content) ? (msg.content as Block[]).filter((b) => b?.type === 'image').length : 0;
      return [{ kind: 'user_message', text: contentText(msg.content), steering: msg.steering === true, images }];
    }
    if (msg?.role === 'assistant') {
      this.#msgKey = `${this.gen}:${String(f.messageId ?? Date.now())}`;
      this.#text = '';
      this.#thinking = '';
      this.#producing = false;
      this.#msgTs = Date.now();
      return [];
    }
    if (msg?.role === 'custom' && msg.customType === 'async-result') {
      return [{ kind: 'wake', jobs: Array.isArray(msg.details?.jobs) ? msg.details!.jobs!.length : 1 }];
    }
    return [];
  }

  #assistantItem(streaming: boolean): TranscriptItem {
    return {
      kind: 'assistant',
      id: this.#msgKey ?? `${this.gen}:msg`,
      text: this.#text,
      thinking: this.#thinking || undefined,
      streaming,
      ts: this.#msgTs,
    };
  }

  #messageUpdate(f: OmpFrame): AgentEvent[] {
    const e = f.assistantMessageEvent as { type?: string; delta?: string; block?: { name?: string } } | undefined;
    if (!e || !this.#msgKey) return [];
    const out: AgentEvent[] = [];
    const first = () => {
      if (!this.#producing) {
        this.#producing = true;
        out.push({ kind: 'producing' });
      }
    };
    switch (e.type) {
      case 'thinking_delta':
        first();
        this.#thinking += e.delta ?? '';
        out.push({ kind: 'item', item: this.#assistantItem(true), stream: true });
        break;
      case 'text_delta':
        first();
        this.#text += e.delta ?? '';
        out.push({ kind: 'item', item: this.#assistantItem(true), stream: true });
        break;
      case 'thinking_start':
      case 'text_start':
        first();
        break;
      case 'toolcall_start':
        first();
        if (e.block?.name) out.push({ kind: 'composing', tool: e.block.name });
        break;
    }
    return out;
  }

  #messageEnd(f: OmpFrame): AgentEvent[] {
    const msg = f.message as
      | { role?: string; customType?: string; details?: unknown; content?: Block[]; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } }; stopReason?: string; errorMessage?: string; provider?: string; model?: string }
      | undefined;
    if (msg?.role === 'custom' && msg.customType === 'advisor') {
      // Show omp's structured notes; never parse the card's text (it is written for the model).
      const notes = advisorNotes(msg.details);
      return notes.length ? [{ kind: 'advisor', id: `${this.gen}:adv:${String(f.messageId ?? Date.now())}`, notes }] : [];
    }
    if (msg?.role !== 'assistant') return [];
    if (!this.#msgKey) this.#msgKey = `${this.gen}:${String(f.messageId ?? Date.now())}`;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks.filter((b) => b.type === 'text' || (b.type === 'thinking' && b.narration)).map((b) => b.text ?? b.thinking ?? '').join('');
    const thinking = blocks.filter((b) => b.type === 'thinking' && !b.narration).map((b) => b.thinking ?? '').join('\n\n');
    // message_end is authoritative; keep streamed text only if the final message has none (aborted mid-stream).
    if (text || msg.stopReason !== 'aborted') this.#text = text;
    if (thinking || msg.stopReason !== 'aborted') this.#thinking = thinking;
    const out: AgentEvent[] = [];
    if (this.#text.trim() || this.#thinking.trim()) {
      out.push({ kind: 'item', item: this.#assistantItem(false), stream: false });
    }
    if (this.#text.trim()) out.push({ kind: 'assistant_text', text: this.#text });
    const u = msg.usage;
    if (u) {
      out.push({
        kind: 'usage',
        input: (u.input ?? 0) + (u.cacheRead ?? 0),
        output: u.output ?? 0,
        cost: u.cost?.total ?? 0,
        provider: msg.provider ?? '',
        model: msg.model ?? '',
      });
    }
    if (msg.stopReason === 'error' && msg.errorMessage) out.push({ kind: 'model_error', id: `${this.#msgKey}:error`, message: truncate(msg.errorMessage, 1200) });
    this.#msgKey = null;
    this.#producing = false;
    return out;
  }

  #toolStart(f: OmpFrame): AgentEvent[] {
    const id = String(f.toolCallId ?? '');
    const tool = String(f.toolName ?? 'tool');
    const item: TranscriptItem & { kind: 'tool' } = {
      kind: 'tool',
      id,
      tool,
      title: toolTitle(tool, f.args),
      args: capArgs(f.args),
      status: 'running',
      ts: Date.now(),
    };
    const paths = tidyPaths(toolArgPaths(tool, f.args), this.opts.cwd);
    if (paths.length) item.paths = paths;
    this.#tools.set(id, item);
    return [
      { kind: 'item', item, stream: false },
      { kind: 'tool_start', tool, toolCallId: id, args: f.args, detail: toolDetail(tool, f.args), intent: typeof f.intent === 'string' ? f.intent : undefined },
    ];
  }

  #toolUpdate(f: OmpFrame): AgentEvent[] {
    const id = String(f.toolCallId ?? '');
    const cur = this.#tools.get(id);
    if (!cur || cur.tool === 'task') return []; // task partials are progress noise; subagent frames cover it
    const partial = resultText(f.partialResult);
    if (!partial) return [];
    const item = { ...cur, result: truncate(partial, MAX_RESULT) };
    this.#tools.set(id, item);
    return [{ kind: 'item', item, stream: true }];
  }

  #toolEnd(f: OmpFrame): AgentEvent[] {
    const id = String(f.toolCallId ?? '');
    const tool = String(f.toolName ?? this.#tools.get(id)?.tool ?? 'tool');
    const isError = f.isError === true;
    const base = this.#tools.get(id) ?? { kind: 'tool' as const, id, tool, title: toolTitle(tool, undefined), status: 'running' as const, ts: Date.now() };
    const item: TranscriptItem & { kind: 'tool' } = { ...base, result: truncate(resultText(f.result), MAX_RESULT), isError, status: isError ? 'error' : 'done' };
    // generate_image saves its pictures outside the house (os.tmpdir()); the bytes ride along in details.images.
    const made = (f.result as { details?: { imagePaths?: unknown } } | undefined)?.details?.imagePaths;
    if (Array.isArray(made)) {
      const paths = tidyPaths([...(base.paths ?? []), ...made.filter((p): p is string => typeof p === 'string')], this.opts.cwd);
      if (paths.length) item.paths = paths;
    }
    const images = toolResultImages(f.result, this.opts.storeImage ?? defaultImageStore);
    if (images.length) item.images = images;
    this.#tools.delete(id);
    return [
      { kind: 'item', item, stream: false },
      { kind: 'tool_end', tool, toolCallId: id, isError },
    ];
  }
}
