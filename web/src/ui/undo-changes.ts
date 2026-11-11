// Changes → Undo changes (one file) and Undo all (the house folder's uncommitted changes), each with a confirm that names
// the files, then a toast "Undone N files · Bring back"; "Undone recently" lists what CAST kept so it can still be
// brought back after the toast is gone. Server: discard_changes / list_undone / bring_back_undone (git.ts keeps what an
// undo removes under refs/rlt/discarded/<ms>, the last 20). A job's own copy has Bring into house / Undo last bring.
import type { BringPlan, DiscardResult, GitFileChange, UndoneChanges } from '../../../shared/protocol';
import { h, setChildren } from './dom';
import { splitPath, timeAgo } from './format';
import { icon } from './icons';
import { houseBusy } from './leftovers';
import type { Shell } from './shell';

export const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

function fileList(paths: string[]): HTMLElement {
  return h('ul', { class: 'revert-files' }, paths.slice(0, 10).map((f) => h('li', null, h('code', null, f))), paths.length > 10 ? h('li', { class: 'muted' }, `and ${paths.length - 10} more`) : null);
}

/** New files (Undo deletes them) apart from the rest (Undo puts them back as the last commit has them). Pure. */
export function splitUndo(list: Pick<GitFileChange, 'path' | 'status'>[]): { back: string[]; deleted: string[] } {
  const isNew = (s: string) => s.trim() === '??' || s.trim() === 'A';
  return {
    back: list.filter((f) => !isNew(f.status)).map((f) => f.path),
    deleted: list.filter((f) => isNew(f.status)).map((f) => f.path),
  };
}

/** The confirm's title: names the one file, else counts them. Pure. */
export function undoTitle(paths: string[]): string {
  return paths.length === 1 ? `Undo changes to ${splitPath(paths[0]!).file}?` : `Undo changes to ${files(paths.length)}?`;
}

/** The line under an Undone recently entry: which files, and when. Pure. */
export function undoneMeta(u: Pick<UndoneChanges, 'files' | 'at'>, now = Date.now()): string {
  const names = u.files.slice(0, 2).map((f) => splitPath(f).file).join(', ');
  const more = u.files.length > 2 ? ` and ${u.files.length - 2} more` : '';
  return `${names}${more} · ${timeAgo(u.at, now)}`;
}

/** Can the server put files back right now? null, or who it waits for (it refuses while anyone works there). */
export function undoBlocked(shell: Shell, projectId: string): string | null {
  return houseBusy(shell, projectId);
}

/** Bring back what an Undo changes (or a turn's undo) kept: straight away when every file comes back cleanly, else a
 *  confirm says what happens to the files changed again since. Toasts say how it went. */
export async function bringBackUndone(shell: Shell, pid: string, id: string): Promise<void> {
  const { store } = shell;
  let plan: BringPlan;
  try {
    plan = (await store.request<{ plan: BringPlan }>({ t: 'bring_back_undone', reqId: '', projectId: pid, id, preview: true })).plan;
  } catch (err) {
    shell.toast('error', `Could not bring the files back: ${(err as Error).message}`, { projectId: pid });
    return;
  }
  const n = plan.files.length + plan.conflicts.length;
  if (!n) {
    shell.toast('info', plan.skipped.length ? `Nothing can be brought back: ${plan.skipped.join(', ')} changed again since.` : 'Nothing to bring back — the files are like that already.', { projectId: pid });
    return;
  }
  if (plan.conflicts.length || plan.skipped.length) {
    const ok = await shell.confirm({
      title: 'Bring the files back?',
      body: h(
        'div',
        null,
        plan.files.length ? [h('p', null, `${plan.files.length === 1 ? 'This file comes' : `These ${plan.files.length} files come`} back:`), fileList(plan.files)] : null,
        plan.conflicts.length
          ? [h('p', { class: 'revert-warn' }, icon('alert', 14), ` Changed again since — ${plan.conflicts.length === 1 ? 'it gets' : 'they get'} <<<<<<< now / >>>>>>> brought back markers to sort out by hand:`), fileList(plan.conflicts)]
          : null,
        plan.skipped.length ? [h('p', null, `Left as ${plan.skipped.length === 1 ? 'it is' : 'they are'} now — changed again, and can’t be merged:`), fileList(plan.skipped)] : null,
      ),
      confirmLabel: n === 1 ? 'Bring 1 file back' : `Bring ${n} files back`,
      icon: 'revert',
    });
    if (!ok) return;
  }
  try {
    const done = (await store.request<{ plan: BringPlan }>({ t: 'bring_back_undone', reqId: '', projectId: pid, id })).plan;
    const brought = done.files.length + done.conflicts.length;
    if (done.conflicts.length) shell.toast('warn', `Brought back ${files(brought)} — ${done.conflicts.length} with conflict markers to sort out.`, { projectId: pid });
    else shell.toast('success', `Brought back ${files(brought)}.`, { projectId: pid });
  } catch (err) {
    shell.toast('error', `Could not bring the files back: ${(err as Error).message}`, { projectId: pid });
  }
}

/** The toast after an undo: "Undone N files" with Bring back. */
export function undoneToast(shell: Shell, pid: string, saved: UndoneChanges, n: number, bringBack: () => void = () => void bringBackUndone(shell, pid, saved.id)): void {
  shell.toast('success', `Undone ${files(n)}`, { projectId: pid, action: { label: 'Bring back', run: bringBack } });
}

export interface UndoChanges {
  /** The "Undone recently" section (hidden when there is nothing to bring back). */
  readonly el: HTMLElement;
  show(projectId: string): void;
  refresh(reload: boolean): void;
  /** Confirm, then put these files of the house folder back (Changes → Undo changes / Undo all). */
  undo(projectId: string, list: GitFileChange[]): Promise<void>;
  /** Bring back what an undo kept (the toast's button, Undone recently). */
  bringBack(projectId: string, id: string): Promise<void>;
  /** An undo or bring back is on its way. */
  readonly busy: boolean;
}

export function createUndoChanges(shell: Shell, opts: { changed(): void }): UndoChanges {
  const { store } = shell;
  const el = h('section', { class: 'leftovers undone', hidden: true, 'aria-label': 'Undone recently' });
  let projectId: string | null = null;
  let list: UndoneChanges[] = [];
  let loadedAt = 0;
  let seq = 0;
  let working: string | null = null; // 'undo' or the id being brought back

  async function load() {
    const pid = projectId;
    if (!pid) return;
    const mine = ++seq;
    loadedAt = Date.now();
    try {
      const data = await store.request<{ undone?: UndoneChanges[] } | undefined>({ t: 'list_undone', reqId: '', projectId: pid });
      if (mine !== seq || pid !== projectId) return;
      list = data?.undone ?? [];
    } catch {
      if (mine !== seq) return;
      list = []; // an older server, or not a git house
    }
    render();
  }

  function waits(pid: string): boolean {
    const blocked = undoBlocked(shell, pid);
    if (blocked) shell.toast('warn', `Undo waits until ${blocked} is done — files can’t change while someone works in the house.`, { projectId: pid });
    return !!blocked;
  }

  async function undo(pid: string, picked: GitFileChange[]) {
    if (working || !picked.length || waits(pid)) return;
    const { back, deleted } = splitUndo(picked);
    const one = picked.length === 1;
    const ok = await shell.confirm({
      title: undoTitle(picked.map((f) => f.path)),
      body: h(
        'div',
        null,
        back.length
          ? [h('p', null, one ? 'It goes back to how the last commit has it:' : `${back.length === 1 ? 'This file goes' : `These ${back.length} files go`} back to how the last commit has them:`), fileList(back)]
          : null,
        deleted.length ? [h('p', null, deleted.length === 1 ? 'This new file is deleted:' : `These ${deleted.length} new files are deleted:`), fileList(deleted)] : null,
        h('p', { class: 'muted' }, 'CAST keeps a copy first, so Bring back can put it all back. Your commits and branches are not touched.'),
      ),
      confirmLabel: one ? 'Undo changes' : `Undo ${files(picked.length)}`,
      tone: 'danger',
    });
    if (!ok) return;
    working = 'undo';
    render();
    try {
      const r = await store.request<DiscardResult>({ t: 'discard_changes', reqId: '', projectId: pid, paths: picked.map((f) => f.path) });
      const saved = r.saved;
      if (r.files.length && saved) undoneToast(shell, pid, saved, r.files.length, () => void bringBack(pid, saved.id));
      if (r.skipped.length) {
        const first = r.skipped[0]!;
        shell.toast('warn', `${r.files.length ? 'Left alone' : 'Nothing undone'}: ${first.path} ${first.why}${r.skipped.length > 1 ? ` (and ${r.skipped.length - 1} more)` : ''}.`, { projectId: pid });
      }
    } catch (err) {
      shell.toast('error', `Could not undo the changes: ${(err as Error).message}`, { projectId: pid });
    } finally {
      working = null;
      opts.changed();
      void load();
    }
  }

  async function bringBack(pid: string, id: string) {
    if (working || waits(pid)) return;
    working = id;
    render();
    try {
      await bringBackUndone(shell, pid, id);
    } finally {
      working = null;
      opts.changed();
      void load();
    }
  }

  function render() {
    const pid = projectId;
    if (!pid || !list.length) {
      el.hidden = true;
      setChildren(el);
      return;
    }
    el.hidden = false;
    const shown = list.slice(0, 5);
    setChildren(el,
      h(
        'h3',
        { class: 'leftovers-title' },
        'Undone recently',
        h('span', { class: 'leftovers-info', tabindex: '0', title: 'What Undo changes took away. CAST keeps the last 20, so you can bring them back.' }, icon('help', 13)),
      ),
      h(
        'ul',
        { class: 'leftover-list' },
        shown.map((u) =>
          h(
            'li',
            { class: 'leftover' },
            h('span', { class: 'leftover-icon', 'aria-hidden': 'true' }, icon('history', 15)),
            h('div', { class: 'leftover-main' }, h('span', { class: 'leftover-name', title: u.files.join('\n') }, `Undone ${files(u.files.length)}`), h('span', { class: 'leftover-meta' }, undoneMeta(u))),
            h(
              'div',
              { class: 'leftover-actions' },
              h(
                'button',
                { type: 'button', class: 'btn btn-soft btn-sm', disabled: !!working, 'aria-label': `Bring back ${files(u.files.length)} undone ${timeAgo(u.at)}`, onclick: () => void bringBack(pid, u.id) },
                working === u.id ? h('span', { class: 'spinner spinner-sm' }) : icon('revert', 14),
                'Bring back',
              ),
            ),
          ),
        ),
      ),
      list.length > shown.length ? h('p', { class: 'changes-note' }, `and ${list.length - shown.length} older`) : null,
    );
  }

  return {
    el,
    get busy() {
      return working !== null;
    },
    show(pid: string) {
      const changed = pid !== projectId;
      projectId = pid;
      if (changed) list = [];
      if (changed || Date.now() - loadedAt > 4000) void load();
      else render();
    },
    refresh(reload: boolean) {
      if (reload) void load();
      else render();
    },
    undo,
    bringBack,
  };
}
