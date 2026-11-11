// WorkJournal: what each person was doing for the user, kept on disk so a restart (an update, a reboot, a crash)
// never drops work silently. <dataDir>/in-flight.json holds, per person, the chat message they were working on and
// the messages they hadn't read yet (omp's queues die with omp). On the next start the agent system marks them in the
// chat — "Interrupted … Run again", "Not sent · Retry" — instead of them vanishing (finding #22).
//
// Writes are coalesced (a busy chat changes state many times a second) and atomic. freeze() at shutdown writes the
// state as it is and ignores what stopping the processes reports afterwards (that is the restart, not the user).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ImageRef } from '../../shared/protocol';
import { errorText, log } from './util';

export interface JournalMessage {
  text: string;
  images: ImageRef[];
  /** Its bubble in the chat, when it has one (a message queued while the person worked has only a chip). */
  itemId?: string;
}

export interface JournalEntry {
  threadId?: string;
  at: number;
  /** The chat message the person was working on (handed to the model; the turn wasn't over). */
  turn?: JournalMessage;
  /** Chat messages sent but not read yet, oldest first. */
  waiting: JournalMessage[];
}

const WRITE_MS = 150;

export class WorkJournal {
  #entries: Record<string, JournalEntry> = {};
  #timer?: ReturnType<typeof setTimeout>;
  #frozen = false;

  constructor(private readonly file: string) {}

  /** What was in flight when CAST stopped last time; the file is cleared (each restart reports it once). */
  take(): Record<string, JournalEntry> {
    if (!existsSync(this.file)) return {};
    let out: Record<string, JournalEntry> = {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number; people?: Record<string, JournalEntry> };
      if (raw?.version === 1 && raw.people && typeof raw.people === 'object') out = clean(raw.people);
    } catch (err) {
      log('agents', `in-flight.json unreadable (${errorText(err)}) — nothing to restore`);
    }
    try {
      rmSync(this.file, { force: true });
    } catch {
      /* written over on the next change */
    }
    return out;
  }

  /** The person's state now (null: nothing in flight). */
  set(agentId: string, entry: JournalEntry | null): void {
    if (this.#frozen) return;
    const had = agentId in this.#entries;
    if (entry) this.#entries[agentId] = entry;
    else if (had) delete this.#entries[agentId];
    else return;
    this.#timer ??= setTimeout(() => this.#write(), WRITE_MS);
  }

  /** Shutdown: write now, and keep it — what the stopping processes report from here on is the restart's doing. */
  freeze(): void {
    if (this.#frozen) return;
    this.#write();
    this.#frozen = true;
  }

  #write() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#frozen) return;
    try {
      if (!Object.keys(this.#entries).length) {
        rmSync(this.file, { force: true });
        return;
      }
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ version: 1, people: this.#entries }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log('agents', `could not save in-flight.json: ${errorText(err)}`);
    }
  }
}

function message(m: unknown): JournalMessage | null {
  const r = m as Partial<JournalMessage> | null;
  if (!r || typeof r.text !== 'string') return null;
  const images = Array.isArray(r.images) ? r.images.filter((i): i is ImageRef => !!i && typeof i.id === 'string' && typeof i.mimeType === 'string') : [];
  if (!r.text.trim() && !images.length) return null;
  return { text: r.text, images, ...(typeof r.itemId === 'string' ? { itemId: r.itemId } : {}) };
}

/** Tolerate a hand-edited or older file: drop what doesn't look right. */
function clean(people: Record<string, unknown>): Record<string, JournalEntry> {
  const out: Record<string, JournalEntry> = {};
  for (const [id, v] of Object.entries(people)) {
    const e = v as Partial<JournalEntry> | null;
    if (!e || typeof e !== 'object') continue;
    const turn = e.turn ? message(e.turn) : null;
    const waiting = Array.isArray(e.waiting) ? e.waiting.map(message).filter((m): m is JournalMessage => !!m) : [];
    if (!turn && !waiting.length) continue;
    out[id] = { ...(typeof e.threadId === 'string' ? { threadId: e.threadId } : {}), at: typeof e.at === 'number' ? e.at : 0, ...(turn ? { turn } : {}), waiting };
  }
  return out;
}
