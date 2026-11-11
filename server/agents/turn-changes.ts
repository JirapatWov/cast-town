// Per-turn undo for chat turns. Before a person reads the user's chat message (in a git house folder; a job's own copy
// has Bring into house instead) the folder is snapshotted into refs/rlt/turns/<id>-from; when the turn settles, again
// into <id>-to, and if files differ a 'changes' item goes into the chat under the turn: "Undo this turn's changes"
// (undo_turn) puts exactly those files back, but only when none changed again since. Someone else working in the same
// folder during the turn (another chat, a team) makes the turn "shared": its changes can't be told apart, so the card
// points to the Changes tab instead. A turn that ran no tool that can change files leaves no card and no refs.
import type { Project, TranscriptItem, UndoneChanges } from '../../shared/protocol';
import type { GitService } from '../contracts';
import { UserError } from '../util';
import { errorText, log } from './util';

/** How long a message waits for the "before" snapshot; slower (a huge repo, a long git job holding the lock): the turn
 *  goes untracked rather than holding the user's message up. */
const BEGIN_WAIT_MS = 4000;
const MAX_FILES_SHOWN = 200;

type ChangesItem = Extract<TranscriptItem, { kind: 'changes' }>;

export interface TurnFolder {
  /** The house (its folder is the person's folder: jobs without their own copy). */
  project: Project;
  name: string; // the person's name, for log lines
}

export interface TurnChangesDeps {
  git: Pick<GitService, 'snapshotFolder' | 'changedBetween' | 'dropTurns' | 'undoTurn'>;
  /** The folder a person works in when it is a house folder; null: a job's own copy, gone, or not tracked. */
  folderOf(agentId: string): TurnFolder | null;
  /** Who else works in that house folder right now (another person busy, a team running), or null. */
  othersWorking(agentId: string, projectId: string): string | null;
  /** Anyone (this person too) working there right now: undo waits. */
  anyoneWorking(projectId: string): string | null;
  transcript(agentId: string): TranscriptItem[];
  upsertItem(agentId: string, item: TranscriptItem): void;
  /** The folder's files changed (the TV and the Changes tab refresh). */
  changed(projectId: string): void;
}

interface OpenTurn {
  id: string;
  folder: TurnFolder;
  from: string;
  ready: Promise<boolean>; // the "before" snapshot was taken
  late: boolean; // …but after the message went: the turn isn't tracked
  touched: boolean; // a tool that may change files ran
  shared: boolean;
}

let seq = 0;

export class TurnChanges {
  #open = new Map<string, OpenTurn>();

  constructor(private readonly d: TurnChangesDeps) {}

  /** A chat turn is about to start: snapshot the folder first. Resolves when it is taken (or BEGIN_WAIT_MS passed). */
  async begin(agentId: string): Promise<void> {
    const prev = this.#open.get(agentId);
    if (prev) this.#finish(agentId, prev); // a turn that never settled ends here
    const { snapshotFolder, changedBetween, undoTurn } = this.d.git;
    const folder = snapshotFolder && changedBetween && undoTurn ? this.d.folderOf(agentId) : null;
    if (!folder) return;
    const id = `${Date.now()}-${(++seq).toString(36)}`;
    const t: OpenTurn = { id, folder, from: `refs/rlt/turns/${id}-from`, ready: Promise.resolve(false), late: false, touched: false, shared: !!this.d.othersWorking(agentId, folder.project.id) };
    for (const [other, o] of this.#open) {
      if (other !== agentId && o.folder.project.id === folder.project.id) o.shared = t.shared = true;
    }
    this.#open.set(agentId, t);
    t.ready = snapshotFolder!(folder.project.path, t.from, `rlt: ${folder.project.name} before a turn of ${folder.name}`).then(
      (c) => !!c,
      (err) => (log('agents', `${agentId}: no snapshot before the turn: ${errorText(err)}`), false),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([t.ready.then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), BEGIN_WAIT_MS)))]);
    clearTimeout(timer);
    if (!waited) {
      t.late = true;
      log('agents', `${agentId}: the snapshot before the turn took over ${BEGIN_WAIT_MS / 1000} s — this turn can't be undone on its own`);
    }
  }

  /** The message never reached the person: forget the turn. */
  cancel(agentId: string): void {
    const t = this.#open.get(agentId);
    if (!t) return;
    this.#open.delete(agentId);
    void t.ready.then(() => this.d.git.dropTurns?.(t.folder.project.path, [t.from])).catch(() => {});
  }

  /** The turn settled (or stopped, or omp exited). */
  end(agentId: string): void {
    const t = this.#open.get(agentId);
    if (t) this.#finish(agentId, t);
  }

  /** A tool that may change files ran (any person): this person's turn is worth a look; someone else's in the same
   *  folder makes the turns open there shared. */
  noteFileTool(agentId: string, projectId: string): void {
    for (const [who, t] of this.#open) {
      if (t.folder.project.id !== projectId) continue;
      if (who === agentId) t.touched = true;
      else t.shared = true;
    }
  }

  #finish(agentId: string, t: OpenTurn): void {
    if (this.#open.get(agentId) === t) this.#open.delete(agentId);
    if (!t.shared && this.d.othersWorking(agentId, t.folder.project.id)) t.shared = true;
    void this.#record(agentId, t).catch((err) => log('agents', `${agentId}: couldn't record the turn's changes: ${errorText(err)}`));
  }

  async #record(agentId: string, t: OpenTurn): Promise<void> {
    const { git } = this.d;
    const path = t.folder.project.path;
    const took = await t.ready;
    if (!took) return;
    if (t.late || !t.touched) return void (await git.dropTurns?.(path, [t.from]));
    const to = `refs/rlt/turns/${t.id}-to`;
    const done = await git.snapshotFolder!(path, to, `rlt: ${t.folder.project.name} after a turn of ${t.folder.name}`);
    const files = done ? await git.changedBetween!(path, t.from, to) : [];
    if (!files.length) return void (await git.dropTurns?.(path, [t.from, to]));
    const item: ChangesItem = { kind: 'changes', id: `changes:${t.id}`, files: files.slice(0, MAX_FILES_SHOWN), count: files.length, from: t.from, to, ts: Date.now(), ...(t.shared ? { shared: true } : {}) };
    this.d.upsertItem(agentId, item);
    await git.dropTurns?.(path); // keep the newest turns only
  }

  /** undo_turn: a 'changes' item of the person's current chat. */
  async undo(agentId: string, itemId: string, preview: boolean): Promise<{ files: string[]; kept: string[]; saved?: UndoneChanges }> {
    const item = this.d.transcript(agentId).find((i): i is ChangesItem => i.kind === 'changes' && i.id === itemId);
    if (!item) throw new UserError('That turn isn’t in this chat any more.');
    if (item.undoneAt) throw new UserError('That turn’s changes are undone already.');
    if (item.shared) throw new UserError('Someone else worked in this folder during that turn, so CAST can’t tell whose changes are whose — undo files in the Changes tab instead.');
    const folder = this.d.folderOf(agentId);
    if (!folder || !this.d.git.undoTurn) throw new UserError('This turn’s folder can’t be undone from here — use the Changes tab.');
    if (!preview) {
      const busy = this.d.anyoneWorking(folder.project.id);
      if (busy) throw new UserError(`${busy} — wait until that’s done, or stop it first.`);
    }
    const r = await this.d.git.undoTurn(folder.project, item.from, item.to, preview);
    if (!preview && r.saved) {
      this.d.upsertItem(agentId, { ...item, undoneAt: Date.now() });
      this.d.changed(folder.project.id);
    }
    return r;
  }
}
