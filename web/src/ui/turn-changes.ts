// The card under a chat turn that changed files ('changes' transcript item, server: agents/turn-changes.ts): which files,
// each opening its change on the TV, and "Undo this turn's changes" — only while none of them changed again since (else
// it says so and points to the Changes tab). Undoing keeps a copy (toast: "Undone N files · Bring back").
import type { TranscriptItem, UndoneChanges } from '../../../shared/protocol';
import { h, setChildren } from './dom';
import { splitPath } from './format';
import { icon } from './icons';
import type { Shell } from './shell';
import type { ItemView } from './transcript';
import { files, undoBlocked, undoneToast } from './undo-changes';

type ChangesItem = Extract<TranscriptItem, { kind: 'changes' }>;

const SHOWN = 4;

function fileList(paths: string[]): HTMLElement {
  return h('ul', { class: 'revert-files' }, paths.slice(0, 10).map((f) => h('li', null, h('code', null, f))), paths.length > 10 ? h('li', { class: 'muted' }, `and ${paths.length - 10} more`) : null);
}

/** The card's state line: what happens if you press Undo, or why you can't. Pure, for tests. */
export function turnChangesNote(item: Pick<ChangesItem, 'shared' | 'undoneAt' | 'count'>): string | null {
  if (item.undoneAt) return 'Undone. Changes → Undone recently can bring it back.';
  if (item.shared) return 'Someone else worked in this folder during this turn, so CAST can’t tell whose changes are whose. Undo files in the Changes tab.';
  return null;
}

export function turnChangesCard(shell: Shell, agentId: string, initial: ChangesItem): ItemView {
  const { store } = shell;
  const el = h('div', { class: 'turn-changes', role: 'group', 'aria-label': 'Files this turn changed' });
  let item = initial;
  let working = false;
  const projectId = () => store.state.agents[agentId]?.projectId ?? store.state.currentProjectId ?? '';

  async function undo(btn: HTMLButtonElement) {
    const pid = projectId();
    if (working || !pid) return;
    const blocked = undoBlocked(shell, pid);
    if (blocked) {
      shell.toast('warn', `Undo waits until ${blocked} is done — files can’t change while someone works in the house.`, { projectId: pid });
      return;
    }
    working = true;
    btn.disabled = true;
    try {
      let plan: { files: string[]; kept: string[] };
      try {
        plan = await store.request<{ files: string[]; kept: string[] }>({ t: 'undo_turn', reqId: '', agentId, itemId: item.id, preview: true });
      } catch (err) {
        shell.toast('error', `Could not undo this turn: ${(err as Error).message}`, { agentId });
        return;
      }
      if (plan.kept.length) {
        const open = await shell.confirm({
          title: 'This turn can’t be undone on its own',
          body: h(
            'div',
            null,
            h('p', null, `${plan.kept.length === 1 ? 'This file was' : `These ${plan.kept.length} files were`} changed again after this turn, so undoing the turn could lose that newer work:`),
            fileList(plan.kept),
            h('p', { class: 'muted' }, 'In the Changes tab you can undo files one by one, back to the last commit.'),
          ),
          confirmLabel: 'Open Changes',
          cancelLabel: 'Close',
          icon: 'diff',
        });
        if (open) shell.openPanel('changes', pid);
        return;
      }
      if (!plan.files.length) {
        shell.toast('info', 'Nothing to undo — the files are as they were before this turn.', { agentId });
        return;
      }
      const ok = await shell.confirm({
        title: 'Undo this turn’s changes?',
        body: h(
          'div',
          null,
          h('p', null, `${plan.files.length === 1 ? 'This file goes' : `These ${plan.files.length} files go`} back to how ${plan.files.length === 1 ? 'it was' : 'they were'} before this turn (a file the turn made is deleted):`),
          fileList(plan.files),
          h('p', { class: 'muted' }, 'CAST keeps a copy first, so Bring back can put it all back. The chat stays as it is.'),
        ),
        confirmLabel: plan.files.length === 1 ? 'Undo 1 file' : `Undo ${plan.files.length} files`,
        tone: 'danger',
      });
      if (!ok) return;
      try {
        const r = await store.request<{ files: string[]; kept: string[]; saved?: UndoneChanges }>({ t: 'undo_turn', reqId: '', agentId, itemId: item.id });
        if (r.saved && r.files.length) undoneToast(shell, pid, r.saved, r.files.length);
        else if (r.kept.length) shell.toast('warn', `Nothing undone: ${r.kept[0]} changed again just now.`, { agentId });
      } catch (err) {
        shell.toast('error', `Could not undo this turn: ${(err as Error).message}`, { agentId });
      }
    } finally {
      working = false;
      btn.disabled = false;
    }
  }

  function render() {
    const names = item.files.slice(0, SHOWN);
    const more = item.count - names.length;
    const note = turnChangesNote(item);
    const pid = projectId();
    const undoBtn = h('button', { type: 'button', class: 'btn btn-soft btn-sm turn-undo' }, icon('revert', 14), 'Undo this turn’s changes') as HTMLButtonElement;
    undoBtn.addEventListener('click', () => void undo(undoBtn));
    el.classList.toggle('is-undone', !!item.undoneAt);
    setChildren(el,
      h(
        'div',
        { class: 'turn-changes-head' },
        icon('diff', 13),
        h('span', { class: 'turn-changes-title' }, `Changed ${files(item.count)}`),
        h(
          'span',
          { class: 'turn-changes-files' },
          names.map((f) => h('button', { type: 'button', class: 'turn-file', title: `${f} — see the change on TV`, onclick: () => pid && shell.openDiff(pid, f, { house: true }) }, splitPath(f).file)),
          more > 0 ? h('span', { class: 'muted' }, `+${more} more`) : null,
        ),
      ),
      note
        ? h('p', { class: 'turn-changes-note' }, note, item.shared && !item.undoneAt ? h('button', { type: 'button', class: 'link-btn', onclick: () => pid && shell.openPanel('changes', pid) }, ' Open Changes') : null)
        : h('div', { class: 'turn-changes-actions' }, undoBtn),
    );
  }

  render();
  return {
    el,
    update(next: TranscriptItem) {
      if (next.kind !== 'changes') return;
      item = next;
      render();
    },
  };
}
