// House activity log: the latest things that happened (a run finished, someone couldn't start, a job was made…),
// kept on the server so the Inbox's "Recent" is the same on every device and survives a reload or a restart.
// Every toast the server broadcasts is an activity entry: recordToasts() wraps the hub, gives each broadcast toast
// an id and a time, and keeps it. Answers to one browser's own request (conn.send) are not house activity.
// Stored in <dataDir>/activity.json ({ version, entries }, newest first), written a moment after a change.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityEntry, ServerMsg } from '../shared/protocol';
import type { Hub } from './contracts';
import { log, writeFileAtomic } from './util';

/** Entries kept (newest first) and sent with the snapshot. */
export const ACTIVITY_MAX = 150;
const SAVE_DEBOUNCE_MS = 1500;
const LEVELS = new Set(['info', 'success', 'warn', 'error']);

let seq = 0;
function newId(now: number): string {
  seq = (seq + 1) % 1_679_616;
  return `a-${now.toString(36)}${seq.toString(36).padStart(4, '0')}`;
}

function clean(v: unknown): ActivityEntry | null {
  const e = v as Partial<ActivityEntry> | null;
  if (!e || typeof e.id !== 'string' || typeof e.text !== 'string' || typeof e.ts !== 'number' || !LEVELS.has(e.level as string)) return null;
  return {
    id: e.id,
    ts: e.ts,
    level: e.level as ActivityEntry['level'],
    text: e.text.slice(0, 2000),
    ...(typeof e.projectId === 'string' ? { projectId: e.projectId } : {}),
    ...(typeof e.agentId === 'string' ? { agentId: e.agentId } : {}),
  };
}

export class ActivityLog {
  #entries: ActivityEntry[] = [];
  #timer?: ReturnType<typeof setTimeout>;
  readonly #file: string | null;

  /** dataDir null: keep it in memory only (tests, the dev stub). */
  constructor(dataDir: string | null, private readonly now: () => number = Date.now) {
    this.#file = dataDir ? join(dataDir, 'activity.json') : null;
    if (this.#file && existsSync(this.#file)) {
      try {
        const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as { entries?: unknown };
        if (Array.isArray(raw.entries)) this.#entries = raw.entries.map(clean).filter((e): e is ActivityEntry => !!e).slice(0, ACTIVITY_MAX);
      } catch (err) {
        log('activity', `could not read ${this.#file}: ${(err as Error).message} — starting a new log`);
      }
    }
  }

  /** Newest first. */
  list(): ActivityEntry[] {
    return [...this.#entries];
  }

  add(e: Omit<ActivityEntry, 'id' | 'ts'>): ActivityEntry {
    const now = this.now();
    const entry: ActivityEntry = { id: newId(now), ts: now, level: e.level, text: e.text.slice(0, 2000) };
    if (e.projectId) entry.projectId = e.projectId;
    if (e.agentId) entry.agentId = e.agentId;
    this.#entries.unshift(entry);
    if (this.#entries.length > ACTIVITY_MAX) this.#entries.length = ACTIVITY_MAX;
    this.#schedule();
    return entry;
  }

  /** A house left the town: its lines go (their buttons would lead nowhere). */
  forgetProject(projectId: string): void {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.projectId !== projectId);
    if (this.#entries.length !== before) this.#schedule();
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#file) return;
    try {
      writeFileAtomic(this.#file, JSON.stringify({ version: 1, entries: this.#entries }), 0o600);
    } catch (err) {
      log('activity', `could not save the activity log: ${(err as Error).message}`);
    }
  }

  #schedule() {
    if (!this.#file || this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }
}

/** Every toast broadcast through `hub` becomes an activity entry: the toast goes out with the entry's id and time
 *  (clients keep it in "Recent" by that id). Returns the same hub object, now recording. */
export function recordToasts<H extends Hub>(hub: H, activity: ActivityLog): H {
  const broadcast = hub.broadcast.bind(hub);
  hub.broadcast = (msg: ServerMsg) => {
    if (msg.t === 'toast' && !msg.id) {
      const e = activity.add({ level: msg.level, text: msg.text, projectId: msg.projectId, agentId: msg.agentId });
      return broadcast({ ...msg, id: e.id, ts: e.ts });
    }
    return broadcast(msg);
  };
  return hub;
}
