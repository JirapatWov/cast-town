// Helpers in a lead's chat: a card for each helper the lead sent (name, model, task, status, cost, Open chat) and a
// read-only viewer of the helper's whole chat. The server reads it from the helper's omp session file, so it opens
// after the helper left the house too; while the helper still works it refreshes every 2 s.
import type { TranscriptItem } from '../../../shared/protocol';
import { openImage } from './attachments';
import { copyText, h, setChildren } from './dom';
import { fmtUsd, modelLabel, vendorOfModel } from './format';
import { icon } from './icons';
import { wireCodeCopy } from './markdown';
import { openModal } from './modal';
import type { Shell } from './shell';
import { fileLinks } from './file-links';
import { createItemView, type HelperItem, type ItemView } from './transcript';
import { avatar, emptyState, vendorDot } from './widgets';

const REFRESH_MS = 2000;
const STICKY_PX = 48;

const STATUS_TEXT: Record<HelperItem['status'], string> = { running: 'Working…', done: 'Done', failed: 'Failed', aborted: 'Stopped' };

function statusBit(status: HelperItem['status']): Node {
  return status === 'running' ? h('span', { class: 'spinner spinner-sm' }) : icon(status === 'done' ? 'checkCircle' : status === 'failed' ? 'xCircle' : 'stop', 13);
}

function helperOf(shell: Shell, leadId: string, itemId: string): HelperItem | undefined {
  const it = shell.store.state.transcripts[leadId]?.find((x) => x.id === itemId);
  return it?.kind === 'helper' ? it : undefined;
}

/** The card in the lead's chat. */
export function helperCard(shell: Shell, leadId: string, initial: HelperItem): ItemView {
  let item = initial;
  let open = false;
  const el = h('article', { class: 'helper-card', 'aria-label': `Helper: ${initial.name}` });

  const render = () => {
    const { models } = shell.store.state;
    const vendor = item.model ? vendorOfModel(item.model, models) : undefined;
    const person = item.agentId ? shell.store.state.agents[item.agentId] : undefined;
    el.className = ['helper-card', `is-${item.status}`, open && 'is-open'].filter(Boolean).join(' ');
    // A button, so the keyboard opens the clamped task too.
    const task = h(
      'button',
      { type: 'button', class: 'helper-task', 'aria-expanded': String(open), title: open ? 'Show less' : 'Show the whole task' },
      h('span', { class: 'helper-task-text' }, item.task),
    );
    task.addEventListener('click', () => {
      open = !open;
      render();
    });
    // Rebuilt on every change: the keyboard focus stays on the same button.
    const focusAt = [...el.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement);
    setChildren(el,
      h(
        'div',
        { class: 'helper-top' },
        avatar(item.name, vendor, 'sm', item.status === 'running' ? 'work' : item.status === 'failed' ? 'error' : 'idle'),
        h(
          'div',
          { class: 'helper-titles' },
          h(
            'p',
            { class: 'helper-name-row' },
            person
              ? h('button', { type: 'button', class: 'helper-name link-btn', title: `Watch ${item.name} work`, onclick: () => shell.openAgent(person.id) }, item.name)
              : h('span', { class: 'helper-name' }, item.name),
            item.model ? h('span', { class: 'helper-model' }, vendorDot(vendor), modelLabel(item.model, models)) : null,
          ),
          h(
            'p',
            { class: 'helper-status' },
            statusBit(item.status),
            h('span', null, STATUS_TEXT[item.status] ?? item.status),
            item.costUsd ? h('span', { class: 'num', title: `Spent: ${fmtUsd(item.costUsd)}` }, `· ${fmtUsd(item.costUsd)}`) : null,
          ),
        ),
        h('button', { type: 'button', class: 'btn btn-soft btn-sm helper-open', onclick: () => openHelperViewer(shell, leadId, item.id) }, icon('chat', 14), 'Open chat'),
      ),
      item.task ? task : null,
    );
    if (focusAt >= 0) el.querySelectorAll('button')[focusAt]?.focus({ preventScroll: true });
  };
  render();
  return {
    el,
    update(next: TranscriptItem) {
      if (next.kind !== 'helper') return;
      item = next;
      render();
    },
    refresh: render,
  };
}

/** The helper's whole chat in a dialog (read-only). */
export function openHelperViewer(shell: Shell, leadId: string, itemId: string): void {
  const { store } = shell;
  const first = helperOf(shell, leadId, itemId);
  const name = first?.name ?? 'Helper';
  const sub = h('span', { class: 'helper-view-sub' });
  const list = h('div', { class: 'transcript-list' });
  const note = h('div', { class: 'helper-view-note' });
  const body = h('div', { class: 'helper-view' }, list, note);
  wireCodeCopy(list, copyText);
  let views = new Map<string, ItemView>();
  let order: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let loaded = false;

  const modal = openModal(shell.root, shell.layers, {
    id: 'helper-chat',
    className: 'modal-helper',
    title: `${name}’s chat`,
    subtitle: sub,
    body,
    onClose: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });
  const scroller = modal.dialog.querySelector<HTMLElement>('.modal-body')!;

  const renderSub = (running: boolean) => {
    const it = helperOf(shell, leadId, itemId) ?? first;
    const status = running ? 'running' : it?.status && it.status !== 'running' ? it.status : 'done';
    setChildren(sub,
      it?.model ? h('span', { class: 'helper-model' }, vendorDot(vendorOfModel(it.model, store.state.models)), modelLabel(it.model, store.state.models)) : null,
      h('span', { class: ['helper-status', `is-${status}`] }, statusBit(status), STATUS_TEXT[status]),
      it?.costUsd ? h('span', { class: 'num', title: `Spent: ${fmtUsd(it.costUsd)}` }, fmtUsd(it.costUsd)) : null,
      h('span', { class: 'muted' }, 'read-only'),
    );
  };

  const renderItems = (items: TranscriptItem[]) => {
    const stick = !loaded || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICKY_PX;
    const ids = items.map((x) => x.id);
    // The window of the last items moved (or something vanished): start over; else update in place and append.
    const continues = order.every((id, i) => ids[i] === id);
    if (!continues) {
      views = new Map();
      setChildren(list);
    }
    if (!items.length) setChildren(list, emptyState('chat', 'Nothing here yet', 'The helper’s chat shows up as it works.'));
    else if (!views.size) setChildren(list);
    for (const it of items) {
      const v = views.get(it.id);
      if (v) v.update(it);
      else {
        const nv = createItemView(it, name, { openImage: (ref) => openImage(shell, ref), files: fileLinks(shell, leadId) });
        views.set(it.id, nv);
        list.appendChild(nv.el);
      }
    }
    order = ids;
    loaded = true;
    if (stick) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  };

  const load = async () => {
    timer = null;
    try {
      const data = await store.request<{ items: TranscriptItem[]; running: boolean }>({ t: 'get_helper_transcript', reqId: '', agentId: leadId, itemId });
      if (closed) return;
      setChildren(note);
      renderItems(data?.items ?? []);
      renderSub(!!data?.running);
      if (data?.running) timer = setTimeout(load, REFRESH_MS);
    } catch (err) {
      if (closed) return;
      if (!loaded) setChildren(list);
      setChildren(note,
        h('span', { class: 'form-error' }, `Couldn’t read the chat: ${(err as Error).message}`),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => void load() }, icon('refresh', 14), 'Try again'),
      );
    }
  };

  setChildren(list, h('div', { class: 'loading-row' }, h('span', { class: 'spinner' }), 'Loading the chat…'));
  renderSub(first?.status === 'running');
  void load();
}
