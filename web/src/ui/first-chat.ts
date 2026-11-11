// Before the first message from this device: a short note over the message box, not a modal. People spend the
// user's AI provider money (a team multiplies it), and in a git house they edit files without asking (Accept edits is
// the default there) — said once, before the first run, not discovered after. "Ask me first" switches the house to
// that mode and sends; "Keep <mode>" sends as it is. Once per device (deviceStorage); someone who already sent a
// message here has met CAST before and never sees it.
import type { Project } from '../../../shared/protocol';
import { deviceStorage, h, setChildren } from './dom';
import { uid } from './widgets';
import { createConsentGate, type ConsentSession } from './first-chat-gate';
import { icon } from './icons';
import { modeInfo, permissionChip, setPermissionMode } from './permissions';
import type { Shell } from './shell';
import { COST_LINE } from './welcome-copy';

const SEEN_KEY = 'rlt.first-chat.v1';

export interface FirstChatNote {
  readonly el: HTMLElement;
  /** The composer's hold: true while the note waits for an answer (the message stays in the box). */
  hold(send: () => void): boolean;
  /** The house or its mode may have changed: say what is true now. */
  refresh(): void;
  /** Someone else's chat is on show: the note goes, the message stays in the box. */
  hide(): void;
}

/** `project`: the house of the person the chat shows. */
export function createFirstChatNote(shell: Shell, project: () => Project | undefined): FirstChatNote {
  const ids = uid('first-chat');
  const el = h('section', { class: 'first-chat', role: 'group', hidden: true, 'aria-labelledby': `${ids}-title`, 'aria-describedby': `${ids}-cost ${ids}-mode` });
  const gate = createConsentGate();
  let busy = false; // "Ask me first" waits for the server

  const sentBefore = () => Object.values(shell.store.state.transcripts).some((items) => items?.some((it) => it.kind === 'user'));

  /** The user answered for `session`: send its message, if it is still the one waiting. */
  function done(session: ConsentSession | null) {
    const go = session && gate.settle(session);
    if (!go) return;
    deviceStorage.set(SEEN_KEY, '1');
    api.hide();
    go();
  }

  async function askFirst(p: Project) {
    const session = gate.current;
    if (!session) return;
    busy = true;
    render();
    const ok = await setPermissionMode(shell, p, 'always-ask');
    // the note went, or another house's message waits now: this answer sends nothing (hide / hold reset busy)
    if (gate.current !== session) return;
    busy = false;
    if (ok) done(session);
    else render(); // the toast said why; the note stays with its choices
  }

  function render() {
    const p = project();
    if (!p) return api.hide();
    const m = modeInfo(p.approvalMode);
    const asks = p.approvalMode === 'always-ask';
    setChildren(el,
      h('h3', { id: `${ids}-title`, class: 'first-chat-title' }, icon('coins', 15), 'Before your first message'),
      h('p', { id: `${ids}-cost` }, COST_LINE),
      h('p', { id: `${ids}-mode`, class: 'first-chat-mode' }, permissionChip(shell, p), h('span', null, `in ${p.name}: ${m.hint}`)),
      h(
        'div',
        { class: 'first-chat-actions' },
        asks
          ? h('button', { type: 'button', class: 'btn btn-primary', disabled: busy, onclick: () => done(gate.current) }, icon('send', 15), 'Send')
          : [
              h('button', { type: 'button', class: 'btn btn-primary', disabled: busy, onclick: () => void askFirst(p) }, icon('hand', 15), 'Ask me first'),
              h('button', { type: 'button', class: 'btn btn-soft', disabled: busy, onclick: () => done(gate.current) }, `Keep ${m.label}`),
            ],
      ),
    );
  }

  const api: FirstChatNote = {
    el,
    hold(next) {
      const p = project();
      if (deviceStorage.get(SEEN_KEY) === '1' || !p) return false;
      if (sentBefore()) {
        deviceStorage.set(SEEN_KEY, '1');
        return false;
      }
      const before = gate.current;
      if (gate.hold(p.id, next) !== before) busy = false;
      const opening = el.hidden;
      el.hidden = false;
      render();
      if (opening) el.querySelector<HTMLButtonElement>('.first-chat-actions .btn')?.focus({ preventScroll: true });
      return true;
    },
    refresh() {
      if (!el.hidden && !busy) render();
    },
    hide() {
      gate.clear();
      busy = false;
      el.hidden = true;
      setChildren(el);
    },
  };
  return api;
}
