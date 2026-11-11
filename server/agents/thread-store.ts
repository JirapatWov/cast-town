// ThreadBook: every person's chats ("threads"). One thread = one omp session file + RLT's own transcript of it,
// so the UI can show history after a restart and reopen an older chat (omp then resumes that session, so the
// model remembers it). Layout per person (server/data-layout.ts transcriptDirFor):
//   threads.json        { version, current, threads: [{ id, title, createdAt, updatedAt, messages, sessionFile?, context?, goal?, pending?,
//                         accounts?, pinned?, seen? }] }
//   <threadId>.json     { version, items: TranscriptItem[] }
// A person with no history has a "virtual" current thread that is written to disk with its first message.
// The first time a person is seen, omp sessions already in their session dir (written before RLT kept history)
// are imported as threads; the newest becomes the current one.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ChatThread, ContextUsage, GoalInfo, ThreadSearchHit, TranscriptItem } from '../../shared/protocol';
import type { AccountPick } from './account-order';
import { writeFileAtomic } from '../util';
import { importOmpSession } from './session-import';
import { searchItems, snippetAt } from './thread-search';
import { errorText, log, truncate } from './util';

const FILE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 600;
const LIST_DEBOUNCE_MS = 800;
const MAX_ITEMS = 600;
const THREAD_ID = /^t-[a-z0-9]{4,40}$/;

export interface ThreadRecord {
  id: string;
  title: string;
  /** Explicit title (e.g. a workflow run) — not replaced by the first user message. */
  titled?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: number;
  /** omp session file name inside the person's session dir (never a path: a copied or moved data dir must use its
   *  own sessions). Set once omp reported it; may not exist on disk until the first message. */
  sessionFile?: string;
  /** How full the model's context was when last seen (omp get_session_stats) — shown, muted, while omp is down. */
  context?: ContextUsage;
  /** The chat's goal as omp last reported it (a lead's goal mode) — shown while omp is down (paused: omp brings a
   *  goal back paused when it resumes the chat). Gone once completed or dropped. */
  goal?: GoalInfo;
  /** RLT's messages for this chat's omp session that wait until the chat is open again (a team started from it
   *  finished while the user was in another chat), oldest first. */
  pending?: PendingUpdate[];
  /** The chat's own account per OAuth provider (set_chat_account). A pick made before that provider's order was last
   *  saved no longer counts (AccountOrderBook.pickOf), nor one whose account was signed out. */
  accounts?: Record<string, AccountPick>;
  /** The explicit omp pins (`/session pin`) RLT made on this chat's session, per provider. omp keeps them with the
   *  session id until the session is forked, so they only hold while sessionFile is still `file`. */
  pinned?: { file: string; accounts: Record<string, number> };
  /** The account omp last used for this chat, per provider (its get_logout_accounts active row). */
  seen?: Record<string, number>;
}

/** What RLT knows about a chat's accounts (ThreadBook.accountState). */
export interface ThreadAccounts {
  threadId: string;
  picks?: Record<string, AccountPick>;
  /** Explicit pins on the chat's current omp session (none once it has another session file). */
  pinned?: Record<string, number>;
  seen?: Record<string, number>;
}

/** A message of RLT (a team update) waiting for its chat. */
export interface PendingUpdate {
  text: string; // what omp gets
  shown: string; // the chat's line for it
  at: number;
}

interface ThreadIndex {
  version: number;
  current: string;
  threads: ThreadRecord[];
}

interface Person {
  agentId: string;
  dir: string; // transcript dir
  sessionDir: string; // omp --session-dir (for the one-time import)
  index: ThreadIndex;
  /** Items of the current thread — the same array the AgentStore holds for this agent. */
  items: TranscriptItem[];
  /** Thread ids whose transcript/index must be written. */
  dirty: boolean;
  indexOnDisk: boolean;
  saveTimer?: ReturnType<typeof setTimeout>;
  listTimer?: ReturnType<typeof setTimeout>;
  lastListed: string; // JSON of the last broadcast list (skip no-op broadcasts)
}

export interface PersonPaths {
  agentId: string;
  transcriptDir: string;
  sessionDir: string;
}

let seq = 0;
export function newThreadId(): string {
  seq = (seq + 1) % 1_679_616;
  return `t-${Date.now().toString(36)}${seq.toString(36).padStart(4, '0')}`;
}

const NEW_CHAT = 'New chat';

function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function oneLine(text: string, max = 60): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** What a person would count as messages: what the user said and the replies with visible text
 *  (not the thinking-only steps between tool calls, nor a message that was never sent). */
export function countMessages(items: TranscriptItem[]): number {
  let n = 0;
  for (const i of items) if ((i.kind === 'user' && !i.notSent) || (i.kind === 'assistant' && i.text.trim())) n++;
  return n;
}

/** The message that names a chat: the user's first one that reached the person. */
export function firstSent(items: TranscriptItem[]): Extract<TranscriptItem, { kind: 'user' }> | undefined {
  return items.find((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user' && !i.notSent);
}

/** Items saved mid-stream (the server stopped while someone was talking) must not look live forever — nor a plan
 *  card still waiting then (its tool call is gone), nor a helper still out (its omp is gone, and so is its person). */
function settle(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((i) => {
    if (i.kind === 'assistant' && i.streaming) return { ...i, streaming: false };
    if (i.kind === 'plan' && i.plan.status === 'pending') return { ...i, plan: { ...i.plan, status: 'cancelled' as const } };
    if (i.kind === 'tool' && i.status === 'running') return { ...i, status: 'error' as const, isError: true, result: i.result || 'Interrupted (CAST restarted)' };
    if (i.kind === 'helper' && (i.status === 'running' || i.agentId)) {
      const { agentId: _gone, ...rest } = i;
      return { ...rest, status: i.status === 'running' ? ('aborted' as const) : i.status };
    }
    return i;
  });
}

const num = (v: unknown, min = 0) => typeof v === 'number' && Number.isFinite(v) && v >= min;

/** A stored context reading, or undefined when it doesn't look like one. Always "last seen" after a load. */
function storedContext(v: unknown): ContextUsage | undefined {
  const c = v as Partial<ContextUsage> | undefined;
  if (!c || !num(c.tokens) || !num(c.window, 1) || !num(c.percent) || !num(c.at)) return undefined;
  return { tokens: c.tokens!, window: c.window!, percent: c.percent!, live: false, at: c.at! };
}

/** A stored goal, or undefined when it doesn't look like one. */
function storedGoal(v: unknown): GoalInfo | undefined {
  const g = v as Partial<GoalInfo> | undefined;
  if (!g || typeof g.objective !== 'string' || !g.objective || !['active', 'paused', 'budget-limited'].includes(g.status as string)) return undefined;
  return {
    objective: g.objective,
    status: g.status!,
    tokensUsed: num(g.tokensUsed) ? g.tokensUsed! : 0,
    ...(num(g.tokenBudget, 1) ? { tokenBudget: g.tokenBudget } : {}),
    ...(num(g.timeUsedSeconds) ? { timeUsedSeconds: g.timeUsedSeconds } : {}),
    updatedAt: num(g.updatedAt) ? g.updatedAt! : Date.now(),
  };
}

const credId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Stored per-provider credential ids that look like ones. */
function storedIds(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([p, id]) => PROVIDER.test(p) && credId(id)));
  return Object.keys(out).length ? out : undefined;
}

/** Stored account picks that look like ones. */
function storedPicks(v: unknown): Record<string, AccountPick> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, AccountPick> = {};
  for (const [p, pick] of Object.entries(v)) {
    const k = pick as Partial<AccountPick> | undefined;
    if (PROVIDER.test(p) && k && credId(k.credentialId) && num(k.at)) out[p] = { credentialId: k.credentialId, at: k.at! };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Stored waiting RLT messages that look like ones. */
function storedPending(v: unknown): PendingUpdate[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((u): u is PendingUpdate => !!u && typeof u.text === 'string' && !!u.text && typeof u.shown === 'string')
    .map((u) => ({ text: u.text, shown: u.shown, at: num(u.at) ? u.at : Date.now() }));
}

export class ThreadBook {
  #people = new Map<string, Person>();

  /** `changed` fires (debounced) when a person's thread list changed — broadcast it. */
  constructor(private readonly changed: (agentId: string, threads: ChatThread[]) => void) {}

  has(agentId: string): boolean {
    return this.#people.has(agentId);
  }

  /** Register a person (idempotent) and return their current thread's id and items. */
  attach(p: PersonPaths): { threadId: string; items: TranscriptItem[] } {
    const cur = this.#people.get(p.agentId);
    if (cur) return { threadId: cur.index.current, items: cur.items };
    const person = this.#load(p);
    this.#people.set(p.agentId, person);
    return { threadId: person.index.current, items: person.items };
  }

  /** Forget a person (they moved out); pending writes are flushed first. Files stay on disk. */
  detach(agentId: string): void {
    const p = this.#people.get(agentId);
    if (!p) return;
    this.#flush(p);
    if (p.listTimer) clearTimeout(p.listTimer);
    this.#people.delete(agentId);
  }

  current(agentId: string): ThreadRecord | undefined {
    const p = this.#people.get(agentId);
    return p ? this.#cur(p) : undefined;
  }

  get(agentId: string, threadId: string): ThreadRecord | undefined {
    return this.#people.get(agentId)?.index.threads.find((t) => t.id === threadId);
  }

  /** The current thread's omp session file, if it exists on disk (spawn resumes it with --resume). */
  resumeFile(agentId: string): string | undefined {
    const t = this.current(agentId);
    return t ? this.sessionPath(agentId, t.id) : undefined;
  }

  /** Absolute path of a thread's omp session file in this person's own session dir, if it exists on disk. */
  sessionPath(agentId: string, threadId: string): string | undefined {
    const p = this.#people.get(agentId);
    const f = p?.index.threads.find((t) => t.id === threadId)?.sessionFile;
    if (!p || !f) return undefined;
    const abs = join(p.sessionDir, f);
    return existsSync(abs) ? abs : undefined;
  }

  /** Newest first; empty threads are hidden unless current. */
  list(agentId: string): ChatThread[] {
    const p = this.#people.get(agentId);
    if (!p) return [];
    return p.index.threads
      .filter((t) => t.messages > 0 || t.id === p.index.current)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({ id: t.id, agentId, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, messages: t.messages, current: t.id === p.index.current }));
  }

  /** Search this person's chats — titles and what was said (finding #44). Title matches first, then the newest. */
  search(agentId: string, query: string, limit = 30): ThreadSearchHit[] {
    const p = this.#people.get(agentId);
    const q = query.trim().toLowerCase();
    if (!p || !q) return [];
    const hits: (ThreadSearchHit & { inTitle: boolean })[] = [];
    for (const t of p.index.threads) {
      const isCur = t.id === p.index.current;
      if (!t.messages && !isCur) continue;
      const m = searchItems(isCur ? p.items : this.#readItems(p.dir, t.id), q);
      const ti = t.title.toLowerCase().indexOf(q);
      if (!m.hits && ti < 0) continue;
      const shown = m.hits ? { snippet: m.snippet, at: m.at } : snippetAt(t.title, ti, q.length);
      hits.push({ threadId: t.id, title: t.title, updatedAt: t.updatedAt, messages: t.messages, current: isCur, hits: m.hits, ...shown, ...(m.itemId ? { itemId: m.itemId } : {}), inTitle: ti >= 0 });
    }
    return hits
      .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(({ inTitle: _, ...h }) => h);
  }

  /** omp told us which session file a thread lives in (after spawn, new_session or switch_session). `threadId` is
   *  the thread the process was started or switched for (default: the current one) — a boot that finishes after the
   *  person moved to another chat must not stamp that chat. Files outside the person's session dir are ignored. */
  noteSession(agentId: string, sessionFile: string | undefined, threadId?: string): void {
    const p = this.#people.get(agentId);
    if (!p || !sessionFile) return;
    const name = this.#ownSessionName(p, sessionFile);
    if (!name) {
      log('threads', `${agentId}: ignoring session ${sessionFile} (not in ${p.sessionDir})`);
      return;
    }
    const t = threadId ? p.index.threads.find((x) => x.id === threadId) : this.#cur(p);
    if (!t || t.sessionFile === name) return;
    t.sessionFile = name;
    if (t.pinned) delete t.pinned; // another session (a fork, a fresh one): RLT's pins were on the old session id
    if (p.indexOnDisk || t.messages > 0) this.#schedule(p);
  }

  /** A chat's accounts (the current chat when `threadId` is absent); undefined when the person or chat is unknown. */
  accountState(agentId: string, threadId?: string): ThreadAccounts | undefined {
    const p = this.#people.get(agentId);
    const t = p && (threadId ? p.index.threads.find((x) => x.id === threadId) : this.#cur(p));
    if (!t) return undefined;
    const pinned = t.pinned && t.pinned.file === t.sessionFile ? t.pinned.accounts : undefined;
    return { threadId: t.id, ...(t.accounts ? { picks: { ...t.accounts } } : {}), ...(pinned ? { pinned: { ...pinned } } : {}), ...(t.seen ? { seen: { ...t.seen } } : {}) };
  }

  /** The chat's own account of a provider (null: back to the order). False when the chat is gone. */
  setPick(agentId: string, threadId: string, provider: string, pick: AccountPick | null): boolean {
    const p = this.#people.get(agentId);
    const t = p?.index.threads.find((x) => x.id === threadId);
    if (!p || !t) return false;
    const next = { ...(t.accounts ?? {}) };
    if (pick) next[provider] = { ...pick };
    else delete next[provider];
    if (Object.keys(next).length) t.accounts = next;
    else delete t.accounts;
    this.#schedule(p);
    return true;
  }

  /** RLT pinned (`credentialId`) or found unpinned (null) this provider's account on the chat's current session. */
  notePinned(agentId: string, threadId: string, provider: string, credentialId: number | null): void {
    const p = this.#people.get(agentId);
    const t = p?.index.threads.find((x) => x.id === threadId);
    if (!p || !t?.sessionFile) return;
    const accounts = t.pinned && t.pinned.file === t.sessionFile ? { ...t.pinned.accounts } : {};
    if (credentialId === null) delete accounts[provider];
    else accounts[provider] = credentialId;
    if (Object.keys(accounts).length) t.pinned = { file: t.sessionFile, accounts };
    else delete t.pinned;
    this.#schedule(p);
  }

  /** The account omp is on for this chat (its active row), per provider. */
  noteSeen(agentId: string, threadId: string, provider: string, credentialId: number): void {
    const p = this.#people.get(agentId);
    const t = p?.index.threads.find((x) => x.id === threadId);
    if (!p || !t || t.seen?.[provider] === credentialId) return;
    t.seen = { ...(t.seen ?? {}), [provider]: credentialId };
    if (p.indexOnDisk || t.messages > 0) this.#schedule(p);
  }

  /** The current thread's last context reading (live: false — it is from before), if one was kept. */
  context(agentId: string): ContextUsage | undefined {
    const c = this.current(agentId)?.context;
    return c ? { ...c, live: false } : undefined;
  }

  /** Keep a fresh context reading with the current thread (threads.json; written once the chat has a file). */
  setContext(agentId: string, context: ContextUsage): void {
    const p = this.#people.get(agentId);
    if (!p) return;
    const t = this.#cur(p);
    const next: ContextUsage = { ...context, live: false };
    if (t.context && JSON.stringify(t.context) === JSON.stringify(next)) return;
    t.context = next;
    if (p.indexOnDisk || t.messages > 0) this.#schedule(p);
  }

  /** The current thread's goal as last seen, for while omp is down: an active one shows as paused (omp brings it
   *  back paused when it resumes the chat). */
  goal(agentId: string): GoalInfo | undefined {
    const g = this.current(agentId)?.goal;
    return g ? { ...g, status: g.status === 'active' ? 'paused' : g.status } : undefined;
  }

  /** Keep the goal omp reports with the current thread (undefined: none any more). */
  setGoal(agentId: string, goal: GoalInfo | undefined): void {
    const p = this.#people.get(agentId);
    if (!p) return;
    const t = this.#cur(p);
    if (JSON.stringify(t.goal) === JSON.stringify(goal)) return;
    if (goal) t.goal = { ...goal };
    else delete t.goal;
    if (p.indexOnDisk || t.messages > 0) this.#schedule(p);
  }

  /** Keep RLT messages with a thread until it is open again (threads.json, so a restart keeps them). `front`: put
   *  back ones that couldn't be sent. False when the thread is gone. */
  addPending(agentId: string, threadId: string, updates: PendingUpdate[], front = false): boolean {
    const p = this.#people.get(agentId);
    const t = p?.index.threads.find((x) => x.id === threadId);
    if (!p || !t) return false;
    if (!updates.length) return true;
    t.pending = front ? [...updates, ...(t.pending ?? [])] : [...(t.pending ?? []), ...updates];
    this.#schedule(p);
    return true;
  }

  /** Take a thread's waiting RLT messages (they are the caller's to send now). */
  takePending(agentId: string, threadId: string): PendingUpdate[] {
    const p = this.#people.get(agentId);
    const t = p?.index.threads.find((x) => x.id === threadId);
    if (!p || !t?.pending?.length) return [];
    const out = t.pending;
    delete t.pending;
    this.#schedule(p);
    return out;
  }

  /** True when `threadId` is this person's current thread. */
  isCurrent(agentId: string, threadId: string | undefined): boolean {
    const p = this.#people.get(agentId);
    return !!p && !!threadId && p.index.current === threadId;
  }

  /** The AgentStore changed this person's transcript (same array as `items`, or a replacement). */
  observe(agentId: string, items: TranscriptItem[]): void {
    const p = this.#people.get(agentId);
    if (!p) return;
    p.items = items;
    const t = this.#cur(p);
    const messages = countMessages(items);
    const firstUser = firstSent(items);
    const title = t.titled ? t.title : firstUser ? oneLine(firstUser.text) : NEW_CHAT;
    const last = items.at(-1)?.ts ?? t.updatedAt;
    const listChanged = messages !== t.messages || title !== t.title;
    t.messages = messages;
    t.title = title;
    t.updatedAt = Math.max(t.updatedAt, last);
    // nothing worth a file yet (a message that wasn't sent is kept, though: its Retry must survive a restart)
    if (messages === 0 && !p.indexOnDisk && !items.some((i) => i.kind === 'user')) return;
    this.#schedule(p);
    if (listChanged) this.#scheduleList(p);
  }

  /** Make a fresh current thread. Reuses the current one when nothing was said in it yet (`fresh: false` —
   *  then its omp session, if any, is still empty and can be kept). */
  create(agentId: string, title?: string): { thread: ThreadRecord; fresh: boolean } {
    const p = this.#people.get(agentId);
    if (!p) throw new Error(`unknown person ${agentId}`);
    this.#flush(p);
    let t = this.#cur(p);
    const fresh = t.messages > 0 || p.items.length > 0;
    if (fresh) {
      t = { id: newThreadId(), title: NEW_CHAT, createdAt: Date.now(), updatedAt: Date.now(), messages: 0 };
      p.index.threads.push(t);
      p.index.current = t.id;
      p.items = [];
    } else {
      t.createdAt = t.updatedAt = Date.now();
    }
    if (title) {
      t.title = oneLine(title);
      t.titled = true;
    } else {
      t.title = NEW_CHAT;
      delete t.titled;
    }
    if (p.indexOnDisk) this.#schedule(p);
    this.#scheduleList(p, true);
    return { thread: t, fresh };
  }

  /** Make an existing thread current and return its items (loaded from disk). Drops the old current thread if empty. */
  switchTo(agentId: string, threadId: string): { thread: ThreadRecord; items: TranscriptItem[] } {
    const p = this.#people.get(agentId);
    if (!p) throw new Error(`unknown person ${agentId}`);
    const target = p.index.threads.find((t) => t.id === threadId);
    if (!target) throw new Error('unknown thread');
    if (target.id === p.index.current) return { thread: target, items: p.items };
    this.#flush(p);
    const old = this.#cur(p);
    if (old.messages === 0 && p.items.length === 0) p.index.threads = p.index.threads.filter((t) => t !== old);
    p.index.current = target.id;
    p.items = this.#readItems(p.dir, target.id);
    this.#schedule(p);
    this.#scheduleList(p, true);
    return { thread: target, items: p.items };
  }

  /** Delete a chat that is not the current one: its transcript, its omp session file and its helpers' sessions (the
   *  folder of the same name next to it). Returns false when there was no such thread. Callers make another thread
   *  current first (agent-runtime newThread) — the live omp must not be on the session being deleted. */
  remove(agentId: string, threadId: string): boolean {
    const p = this.#people.get(agentId);
    if (!p) throw new Error(`unknown person ${agentId}`);
    if (p.index.current === threadId) throw new Error('the current chat cannot be deleted');
    const t = p.index.threads.find((x) => x.id === threadId);
    if (!t) return false;
    this.#flush(p);
    p.index.threads = p.index.threads.filter((x) => x !== t);
    const doomed = [join(p.dir, `${t.id}.json`)];
    if (t.sessionFile) doomed.push(join(p.sessionDir, t.sessionFile), join(p.sessionDir, t.sessionFile.replace(/\.jsonl$/, '')));
    for (const f of doomed) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch (err) {
        log('threads', `could not delete ${f}: ${errorText(err)}`);
      }
    }
    this.#writeIndex(p);
    this.#scheduleList(p, true);
    return true;
  }

  flushAll(): void {
    for (const p of this.#people.values()) {
      this.#flush(p);
      if (p.listTimer) clearTimeout(p.listTimer);
    }
  }

  // ───────────────────────── internals ─────────────────────────

  /** A session file reference → its name in this person's session dir, or undefined when it belongs elsewhere.
   *  Older threads.json files stored absolute paths: those of a copied/moved data dir resolve to the file of the
   *  same name here (when there is one), never to the original location. */
  #ownSessionName(p: Person, ref: string): string | undefined {
    const name = basename(ref);
    if (!name.endsWith('.jsonl') || name.startsWith('.')) return undefined;
    if (!isAbsolute(ref)) return ref === name ? name : undefined;
    if (sameDir(dirname(ref), p.sessionDir)) return name;
    return existsSync(join(p.sessionDir, name)) ? name : undefined;
  }

  #cur(p: Person): ThreadRecord {
    let t = p.index.threads.find((x) => x.id === p.index.current);
    if (!t) {
      t = { id: newThreadId(), title: NEW_CHAT, createdAt: Date.now(), updatedAt: Date.now(), messages: 0 };
      p.index.threads.push(t);
      p.index.current = t.id;
    }
    return t;
  }

  #load(paths: PersonPaths): Person {
    const file = join(paths.transcriptDir, 'threads.json');
    const person: Person = {
      agentId: paths.agentId,
      dir: paths.transcriptDir,
      sessionDir: paths.sessionDir,
      index: { version: FILE_VERSION, current: '', threads: [] },
      items: [],
      dirty: false,
      indexOnDisk: false,
      lastListed: '',
    };
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ThreadIndex>;
        const threads = (Array.isArray(raw.threads) ? raw.threads : []).filter(
          (t): t is ThreadRecord => !!t && typeof t.id === 'string' && THREAD_ID.test(t.id) && typeof t.title === 'string',
        );
        for (const t of threads) {
          t.createdAt = typeof t.createdAt === 'number' ? t.createdAt : Date.now();
          t.updatedAt = typeof t.updatedAt === 'number' ? t.updatedAt : t.createdAt;
          t.messages = typeof t.messages === 'number' ? t.messages : 0;
          const name = typeof t.sessionFile === 'string' ? this.#ownSessionName(person, t.sessionFile) : undefined;
          if (name) t.sessionFile = name;
          else delete t.sessionFile;
          const context = storedContext(t.context);
          if (context) t.context = context;
          else delete t.context;
          const goal = storedGoal(t.goal);
          if (goal) t.goal = goal;
          else delete t.goal;
          const pending = storedPending(t.pending);
          if (pending.length) t.pending = pending;
          else delete t.pending;
          const picks = storedPicks(t.accounts);
          if (picks) t.accounts = picks;
          else delete t.accounts;
          const pins = t.pinned && typeof t.pinned.file === 'string' ? storedIds(t.pinned.accounts) : undefined;
          if (pins && t.pinned!.file === t.sessionFile) t.pinned = { file: t.pinned!.file, accounts: pins };
          else delete t.pinned;
          const seen = storedIds(t.seen);
          if (seen) t.seen = seen;
          else delete t.seen;
        }
        person.index = { version: FILE_VERSION, current: typeof raw.current === 'string' ? raw.current : '', threads };
        person.indexOnDisk = true;
      } catch (err) {
        log('threads', `could not read ${file} (${errorText(err)}); starting a fresh chat list`);
      }
    } else {
      this.#importLegacy(person);
    }
    const cur = this.#cur(person);
    person.items = this.#readItems(person.dir, cur.id);
    return person;
  }

  /** omp sessions from before RLT kept history → threads (newest current). Writes files only if there was any. */
  #importLegacy(p: Person) {
    let files: string[] = [];
    try {
      files = readdirSync(p.sessionDir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return; // never spawned
    }
    const imported: ThreadRecord[] = [];
    for (const f of files) {
      const id = newThreadId();
      const s = importOmpSession(join(p.sessionDir, f), id);
      if (!s) continue;
      const items = s.items.slice(-MAX_ITEMS);
      const firstUser = firstSent(items);
      const title = s.title ? oneLine(s.title) : firstUser ? oneLine(firstUser.text) : NEW_CHAT;
      const t: ThreadRecord = { id, title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: countMessages(items), sessionFile: f };
      if (s.title) t.titled = true;
      try {
        writeFileAtomic(join(p.dir, `${id}.json`), JSON.stringify({ version: FILE_VERSION, items }));
        imported.push(t);
      } catch (err) {
        log('threads', `could not import ${f}: ${errorText(err)}`);
      }
    }
    if (!imported.length) return;
    imported.sort((a, b) => a.updatedAt - b.updatedAt);
    p.index = { version: FILE_VERSION, current: imported.at(-1)!.id, threads: imported };
    this.#writeIndex(p);
    log('threads', `${p.agentId}: imported ${imported.length} earlier chat${imported.length === 1 ? '' : 's'} from agent sessions`);
  }

  #readItems(dir: string, threadId: string): TranscriptItem[] {
    const file = join(dir, `${threadId}.json`);
    if (!existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { items?: unknown };
      return Array.isArray(raw.items) ? settle(raw.items as TranscriptItem[]).slice(-MAX_ITEMS) : [];
    } catch (err) {
      log('threads', `could not read ${file}: ${errorText(err)}`);
      return [];
    }
  }

  #schedule(p: Person) {
    p.dirty = true;
    if (p.saveTimer) return;
    p.saveTimer = setTimeout(() => {
      p.saveTimer = undefined;
      this.#flush(p);
    }, SAVE_DEBOUNCE_MS);
  }

  #flush(p: Person) {
    if (p.saveTimer) clearTimeout(p.saveTimer);
    p.saveTimer = undefined;
    if (!p.dirty) return;
    p.dirty = false;
    const cur = this.#cur(p);
    try {
      if (p.items.length || existsSync(join(p.dir, `${cur.id}.json`))) {
        writeFileAtomic(join(p.dir, `${cur.id}.json`), JSON.stringify({ version: FILE_VERSION, items: p.items.slice(-MAX_ITEMS) }));
      }
      this.#writeIndex(p);
    } catch (err) {
      log('threads', `could not save chats of ${p.agentId}: ${errorText(err)}`);
    }
  }

  #writeIndex(p: Person) {
    // Empty threads other than the current one are not worth keeping.
    p.index.threads = p.index.threads.filter((t) => t.messages > 0 || t.id === p.index.current);
    writeFileAtomic(join(p.dir, 'threads.json'), `${JSON.stringify(p.index, null, 2)}\n`);
    p.indexOnDisk = true;
  }

  #scheduleList(p: Person, now = false) {
    const fire = () => {
      p.listTimer = undefined;
      if (!this.#people.has(p.agentId)) return;
      const list = this.list(p.agentId);
      const json = JSON.stringify(list);
      if (json === p.lastListed) return;
      p.lastListed = json;
      this.changed(p.agentId, list);
    };
    if (now) {
      if (p.listTimer) clearTimeout(p.listTimer);
      fire();
      return;
    }
    p.listTimer ??= setTimeout(fire, LIST_DEBOUNCE_MS);
  }
}
