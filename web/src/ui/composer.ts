// Chat input: Enter sends, Shift+Enter adds a line (on a touch keyboard Return adds a line and the Send button sends —
// there is no Shift+Return there; see touch.ts enterSends), Alt+M switches the permission mode, Alt+P / Alt+T open the
// model / effort chip's menu (Tab and Shift+Tab stay plain focus moves), Stop aborts while the person is busy. While
// busy, Enter queues the message for when the turn ends and Send now (Ctrl/Cmd+Enter) has it read at the next step;
// what waits shows as chips above the box (× takes one back, Send now moves it up). Images come in by the paperclip,
// paste or drop: shrunk and uploaded right away, sent with the message by id.
// Every person has their own draft (drafts.ts, kept in this city's browser storage): switching people, jobs or houses
// swaps the box's contents, so text typed for one person can never be sent to another. Send empties the box at once;
// the message goes out in the background, one at a time per person (send-queue.ts), and shows as a "Sending…" chip
// until the server has it. If it fails it goes back into that person's draft — never into whoever's box is open.
import { MAX_PROMPT_IMAGES, type ImageRef, type QueuedMessage } from '../../../shared/protocol';
import { uploadImage, uploadUrl } from '../net/uploads';
import { isImageFile, shrinkImage } from './attachments';
import { chatIcon } from './chat-icons';
import { autosize, deviceStorage, h, setChildren, storage } from './dom';
import { appendDraft, createDraftBook, isEmptyDraft, removeFromDraft } from './drafts';
import { focusOutOf } from './focus';
import { icon } from './icons';
import { createSendQueue, type Outgoing } from './send-queue';
import { ENTER_SENDS_KEY, enterSends, isTouchUI } from './touch';
import { modKey } from './widgets';

/** Who the composer talks to and what they are up to. */
export interface ComposerTarget {
  /** Who it is: after a send, focus goes back into the box while it still talks to them. */
  id?: string;
  name: string;
  /** Mid-turn: what is sent now waits (or, with canSteer, may be read at the next step), and the red Stop ends the turn. */
  busy?: boolean;
  /** Free to talk while their helpers work in the background: sending starts a turn right away, and a small
   *  "Stop helpers" cancels every helper (the same abort the big Stop sends). */
  helpers?: boolean;
  /** Helpers still out while the person is busy: the big Stop cancels them too, so it says so. */
  helpersOut?: number;
  /** Not connected to the CAST server: nothing can go (typing stays open; the box keeps what is written). */
  offline?: boolean;
  /** Can't take a message right now, though typing stays open (a Compact runs): why, in the hint line. */
  wait?: string;
  /** Typing is closed (a team member on its job's active run): why, as placeholder and hint (and a short `why` for
   *  a drop or paste on the closed box). Stop stays while busy. */
  locked?: { placeholder: string; hint: string | Node; why?: string };
  /** In the hint line instead of the usual one (e.g. a plan card above waits for Run or Cancel). */
  note?: string | Node;
  /** Busy messages can be queued or sent now (everyone but helpers, which only take a nudge at their next step). */
  canSteer?: boolean;
  /** Why this person can't take images (a text-only model, a helper); absent → they can. */
  noImages?: string;
  /** Messages waiting for the busy person, oldest first (AgentInfo.queue). */
  queue?: QueuedMessage[];
}

/** A message taken back (a queue chip's ×, or Stop): it goes into the box again. */
export interface ComposerDraft {
  text: string;
  images: ImageRef[];
}

export interface ComposerSend extends ComposerDraft {
  /** Only while busy (and canSteer): 'queue' → read when the turn ends; 'steer' → read at the next step. */
  mode?: 'queue' | 'steer';
  /** Who it is for: the target's id when Send was pressed (the box may show someone else by the time it goes). */
  to: string;
}

export interface ComposerHandlers {
  /** Resolves once the server has the message; rejects with why (the message then goes back into msg.to's draft). */
  onSend(msg: ComposerSend): Promise<void>;
  onAbort(): void;
  /** A queue chip's action. What 'remove' takes back comes in through restore() — from the chat tab, which knows
   *  whose box it belongs in by the time the answer arrives. */
  onQueueAction?(key: string, action: 'remove' | 'steer'): Promise<void>;
  onCycleMode?(): void;
  /** Alt+P (model) / Alt+T (effort) in the box: open that chip's menu (matched by key code: ⌥P types "π" on a Mac).
   *  False → no such chip here (the key types as usual). */
  onChipKey?(chip: 'model' | 'effort'): boolean;
  notify?(level: 'info' | 'warn' | 'error', text: string): void;
  /** A message on the wire that the chat shows already (its bubble or queue chip came before the server's answer —
   *  omp may still be starting): its "Sending…" chip would only repeat it. */
  shown?(msg: ComposerSend): boolean;
  /** Send pressed, the message able to go: true keeps it in the box for now (the first-chat note, first-chat.ts);
   *  `send` presses Send again for it later. */
  hold?(send: () => void): boolean;
}

export interface Composer {
  readonly el: HTMLElement;
  readonly input: HTMLTextAreaElement;
  /** Left of the hint line: the chat tab puts the chips here — permission mode, model, effort, account. */
  readonly modeSlot: HTMLElement;
  /** null: nobody to talk to. */
  setTarget(target: ComposerTarget | null): void;
  focus(): void;
  setText(text: string): void;
  /** Images picked, pasted or dropped: shrunk, uploaded and shown as thumbnails until sent. */
  addFiles(files: Iterable<File>): void;
  /** Put a taken-back message in a person's draft again (`id`, default: the box on show), under what is there. */
  restore(draft: ComposerDraft, id?: string): void;
  /** A message whose send looked failed turned out to have arrived: take it back out of that person's draft (the box
   *  when it is on show) if the draft still holds it. True when removed. */
  forget(draft: ComposerDraft, id?: string): boolean;
  /** The person left: their unsent draft (null when there was none) — it is forgotten here. */
  dropDraft(id: string): ComposerDraft | null;
  /** Draw the chips above the box again: the chat changed (a message on its way may have shown up there). */
  refreshQueue(): void;
}

interface Attachment {
  key: number;
  status: 'working' | 'ready' | 'error';
  ref?: ImageRef;
  preview: string;
  objectUrl?: string;
  error?: string;
  ctrl?: AbortController;
  /** Whose draft it belongs to (an upload may finish after the box moved on to someone else). */
  owner: string | null;
}

/** A person's draft while the box shows someone else (the attachments keep their previews and running uploads). */
interface Parked {
  text: string;
  attachments: Attachment[];
}

interface OutMsg {
  send: ComposerSend;
  held: Attachment[];
}

const QUEUE_LABEL: Record<'steer' | 'queue' | 'rlt', string> = { steer: 'Next step', queue: 'Queued', rlt: 'Team update' };

export function createComposer(handlers: ComposerHandlers): Composer {
  const input = h('textarea', { class: 'composer-input', rows: 1, 'aria-label': 'Message', placeholder: 'Message…', spellcheck: 'true' });
  /** Fit the box to its text. While it isn't laid out (the panel is closed, the chat tab hidden) it keeps its natural
   *  one-row height — measured then it would collapse to nothing, placeholder and all — and fits on focus. */
  const fit = () => {
    if (input.getClientRects().length) autosize(input, 180);
    else input.style.height = '';
  };
  input.addEventListener('focus', fit);
  const send = h('button', { type: 'button', class: 'composer-send', 'aria-label': 'Send message', disabled: true }, icon('send', 17));
  const steer = h('button', { type: 'button', class: 'composer-steer', hidden: true, disabled: true }, chatIcon('bolt', 14), h('span', null, 'Send now'));
  const stop = h('button', { type: 'button', class: 'composer-stop', hidden: true, 'aria-label': 'Stop' }, icon('stop', 14), h('span', null, 'Stop'));
  const stopHelpers = h('button', { type: 'button', class: 'composer-stop-helpers', hidden: true }, icon('stop', 11), h('span', null, 'Stop helpers'));
  const attach = h('button', { type: 'button', class: 'composer-attach', 'aria-label': 'Attach images' }, chatIcon('paperclip', 17));
  const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true, tabindex: '-1' });
  const thumbs = h('div', { class: 'composer-attachments', hidden: true });
  const queueEl = h('div', { class: 'composer-queue', hidden: true, role: 'list', 'aria-label': 'Waiting to be read' });
  const hint = h('div', { class: 'composer-hint' });
  const modeSlot = h('div', { class: 'composer-mode' });
  const el = h(
    'div',
    { class: 'composer' },
    queueEl,
    h('div', { class: 'composer-box' }, thumbs, h('div', { class: 'composer-row' }, attach, input, stop, steer, send)),
    h('div', { class: 'composer-foot' }, modeSlot, hint, stopHelpers),
    picker,
  );
  let target: ComposerTarget | null = null;
  let attachments: Attachment[] = [];
  let nextKey = 1;
  const acting = new Set<string>(); // queue chips with an action on the wire
  /** Whose draft the box holds (the target's id; '' for a target without one, null for nobody). */
  let boxKey: string | null = null;
  const parked = new Map<string, Parked>();
  const book = createDraftBook(storage);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const outbox = createSendQueue<OutMsg>(
    async (_to, m) => {
      await handlers.onSend(m.send);
      for (const a of m.held) dropAttachment(a);
    },
    {
      // It (and whatever was typed after it for that person) goes back into their draft, oldest first. The chat tab
      // already said why it failed.
      onFail: (to, failed) => {
        for (const f of failed) {
          for (const a of f.msg.held) dropAttachment(a);
          restore({ text: f.msg.send.text, images: f.msg.send.images }, to, false);
        }
      },
      onChange: () => renderQueue(),
    },
  );

  const notify = (level: 'info' | 'warn' | 'error', text: string) => handlers.notify?.(level, text);
  const uploading = () => attachments.filter((a) => a.status === 'working').length;
  const ready = () => attachments.filter((a) => a.status === 'ready' && a.ref);
  const steerable = () => !!target?.busy && !!target.canSteer && !target.locked;
  /** Why the message can't go yet ('' → it can). */
  const blocker = (): string => {
    const t = target;
    if (!t || t.locked) return 'closed';
    if (t.offline) return 'offline';
    if (t.wait) return 'wait';
    if (uploading()) return 'uploading';
    if (ready().length && t.noImages) return 'images';
    if (!input.value.trim() && !ready().length) return 'empty';
    return '';
  };

  /** Something typed or attached: while busy, Stop shrinks to its icon to leave room for the words. */
  const noteDraft = () => el.classList.toggle('has-draft', !!input.value.trim() || attachments.length > 0);

  const refresh = () => {
    const block = blocker();
    send.disabled = !!block;
    steer.disabled = !!block;
    noteDraft();
    // "Queue" in words where the button grows a caption (a busy chat on a touch screen: no tooltip says it there).
    // (No spinner here: the box empties at once and the message waits as a "Sending…" chip — the outbox.)
    setChildren(send, icon('send', 17), steerable() ? h('span', { class: 'composer-send-label' }, 'Queue') : null);
    input.readOnly = !!target?.locked;
    const t = target;
    const n = uploading();
    setChildren(hint,
      // offline first: the other hints may be out of date until the server is back
      t?.offline
        ? h('span', { class: 'composer-warn' }, 'Not connected to the CAST server — what you write stays here until it’s back.')
        : t?.locked
          ? t.locked.hint
          : t?.wait
            ? h('span', null, t.wait)
            : t?.note
              ? t.note
              : n
                ? h('span', null, `Uploading ${n === 1 ? 'the image' : `${n} images`}…`)
                : t?.noImages && ready().length
                  ? h('span', { class: 'composer-warn' }, `${t.noImages} — remove the images to send.`)
                  : t?.busy && steerable()
                    ? h('span', null, h('kbd', null, 'Enter'), ' to queue · ', h('kbd', null, modKey), h('kbd', null, 'Enter'), ' to send now')
                    : t?.busy
                      ? h('span', null, 'Working — what you send reaches it at its next step.')
                      : t?.helpers
                        ? h('span', null, `Helpers are working in the background — ask anything, ${t.name} answers right away.`)
                        : h('span', null, h('kbd', null, 'Enter'), ' to send, ', h('kbd', null, 'Shift'), h('kbd', null, 'Enter'), ' for a new line'),
    );
    // only the key tip: it gives way to the chips where the foot is narrow (chat.css)
    hint.classList.toggle('is-idle', !!t && !t.locked && !t.offline && !t.wait && !t.note && !n && !(t.noImages && ready().length) && !t.busy && !t.helpers);
    hint.classList.toggle('is-warn', !!t?.offline || (!t?.locked && !!(t?.noImages && ready().length) && !t.wait && !t.note));
  };

  // ── Drafts: one per person ──
  const refsOf = (list: Attachment[]) => list.filter((a) => a.status === 'ready' && a.ref).map((a) => a.ref!);
  const readyAttachment = (ref: ImageRef, owner: string | null): Attachment => ({ key: nextKey++, status: 'ready', ref, preview: uploadUrl(ref.id), owner });

  /** The box's draft into storage (debounced while typing; at once on a switch, a send or a page hide). */
  function saveBox() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (boxKey !== null) book.set(boxKey, { text: input.value, images: refsOf(attachments) });
  }
  function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBox, 250);
  }

  /** A person's draft while the box shows someone else. */
  function readParked(key: string): Parked {
    const p = parked.get(key);
    if (p) return p;
    const d = book.get(key);
    return { text: d?.text ?? '', attachments: (d?.images ?? []).map((ref) => readyAttachment(ref, key)) };
  }
  function writeParked(key: string, p: Parked) {
    if (!p.text.trim() && !p.attachments.length) parked.delete(key);
    else parked.set(key, p);
    book.set(key, { text: p.text, images: refsOf(p.attachments) });
  }

  /** Show `next`'s draft in the box; the one on show is put away first (with its uploads still running). */
  function swapTo(next: string | null) {
    if (next === boxKey) return;
    if (boxKey !== null) {
      saveBox();
      if (input.value.trim() || attachments.length) parked.set(boxKey, { text: input.value, attachments });
      else parked.delete(boxKey);
    } else {
      for (const a of attachments) dropAttachment(a);
    }
    boxKey = next;
    const p = next === null ? { text: '', attachments: [] } : readParked(next);
    if (next !== null) parked.delete(next);
    input.value = p.text;
    attachments = p.attachments;
    fit();
  }

  // ── Attachments ──
  function renderThumbs() {
    thumbs.hidden = !attachments.length;
    setChildren(thumbs,
      ...attachments.map((a) =>
        h(
          'div',
          { class: ['att', `is-${a.status}`, a.status === 'ready' && target?.noImages && 'is-blocked'], title: a.error ?? (a.status === 'working' ? 'Uploading…' : undefined) },
          h('img', { src: a.preview, alt: '', decoding: 'async' }),
          a.status === 'working' ? h('span', { class: 'att-over' }, h('span', { class: 'spinner spinner-sm' })) : null,
          a.status === 'error' ? h('span', { class: 'att-over is-error' }, icon('alert', 16)) : null,
          h('button', { type: 'button', class: 'att-x', 'aria-label': a.error ? `Remove image (${a.error})` : 'Remove image', onclick: () => removeAttachment(a) }, icon('x', 12)),
        ),
      ),
    );
  }

  function dropAttachment(a: Attachment) {
    a.ctrl?.abort();
    if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
  }

  function removeAttachment(a: Attachment) {
    dropAttachment(a);
    attachments = attachments.filter((x) => x !== a);
    renderThumbs();
    refresh();
    saveBox();
    input.focus({ preventScroll: true });
  }

  /** Still part of a draft (on show, or parked for its owner). */
  const alive = (a: Attachment) => attachments.includes(a) || (a.owner !== null && !!parked.get(a.owner)?.attachments.includes(a));

  async function processFile(a: Attachment, file: File) {
    try {
      const { blob, mimeType } = await shrinkImage(file);
      if (!alive(a)) return;
      a.ref = await uploadImage(blob, mimeType, a.ctrl?.signal);
      a.status = 'ready';
    } catch (err) {
      if (!alive(a) || (err as Error).name === 'AbortError') return;
      a.status = 'error';
      a.error = (err as Error).message;
      notify('error', a.error);
    }
    if (attachments.includes(a)) {
      renderThumbs();
      refresh();
      saveBox();
    } else if (a.owner !== null && parked.has(a.owner)) writeParked(a.owner, parked.get(a.owner)!); // finished for someone not on show
  }

  function addFiles(files: Iterable<File>) {
    const t = target;
    if (!t) return;
    const all = [...files];
    if (!all.length) return;
    if (t.locked) {
      // a drop or paste on a closed box: say why instead of swallowing it
      notify('info', `Can’t attach images now — ${t.locked.why ?? t.locked.placeholder.replace(/…$/, '')}.`);
      return;
    }
    if (t.noImages) {
      notify('warn', t.noImages);
      return;
    }
    let list = all.filter(isImageFile);
    if (list.length < all.length) notify('warn', 'Only PNG, JPEG, GIF and WebP images can be attached.');
    const room = MAX_PROMPT_IMAGES - attachments.length;
    if (list.length > room) {
      notify('warn', `Up to ${MAX_PROMPT_IMAGES} images per message.`);
      list = list.slice(0, Math.max(0, room));
    }
    for (const file of list) {
      const objectUrl = URL.createObjectURL(file);
      const a: Attachment = { key: nextKey++, status: 'working', preview: objectUrl, objectUrl, ctrl: new AbortController(), owner: boxKey };
      attachments.push(a);
      void processFile(a, file);
    }
    renderThumbs();
    refresh();
  }

  // ── Queue chips ──
  async function queueAction(q: QueuedMessage, action: 'remove' | 'steer') {
    if (!handlers.onQueueAction || acting.has(q.key)) return;
    acting.add(q.key);
    renderQueue();
    try {
      await handlers.onQueueAction(q.key, action);
    } catch (err) {
      notify('error', `${action === 'remove' ? 'Could not take that message back' : 'Could not send that message now'}: ${(err as Error).message}`);
    } finally {
      acting.delete(q.key);
      renderQueue();
    }
  }

  /** A message of ours still on its way (send-queue.ts): "Sending…" while on the wire, else waiting for the one before
   *  it — that one can still be taken back into the box. */
  function outgoingChip(o: Outgoing<OutMsg>): HTMLElement {
    const m = o.msg.send;
    const name = target?.name ?? 'them';
    return h(
      'div',
      { class: ['qchip', 'is-sending'], role: 'listitem' },
      h(
        'span',
        { class: 'qchip-mode', title: o.sending ? `On its way to ${name}` : `Goes to ${name} right after the message before it` },
        o.sending ? h('span', { class: 'spinner spinner-sm' }) : icon('clock', 11),
        o.sending ? 'Sending…' : 'Next',
      ),
      h('span', { class: 'qchip-text', title: m.text }, m.text || (m.images.length ? 'Images' : '…')),
      m.images.length ? h('span', { class: 'qchip-img', title: `${m.images.length} image${m.images.length === 1 ? '' : 's'}` }, chatIcon('image', 12), String(m.images.length)) : null,
      o.sending
        ? null
        : h('button', {
            type: 'button',
            class: 'qchip-x',
            'aria-label': 'Take it back into the box',
            title: 'Take it back into the box',
            onclick: () => {
              const back = outbox.cancel(o.key);
              if (!back) return;
              for (const a of back.msg.held) dropAttachment(a);
              restore({ text: back.msg.send.text, images: back.msg.send.images }, back.to);
            },
          }, icon('x', 12)),
    );
  }

  function renderQueue() {
    const list = target?.queue ?? [];
    for (const k of [...acting]) if (!list.some((q) => q.key === k)) acting.delete(k);
    const mine = boxKey === null ? [] : outbox.pending(boxKey).filter((o) => !(o.sending && handlers.shown?.(o.msg.send)));
    queueEl.hidden = !list.length && !mine.length;
    const name = target?.name ?? 'They';
    setChildren(queueEl,
      ...list.map((q) => {
        const kind = q.by === 'rlt' ? 'rlt' : q.mode;
        const busy = acting.has(q.key);
        return h(
          'div',
          { class: ['qchip', `is-${kind}`, busy && 'is-acting'], role: 'listitem' },
          h(
            'span',
            {
              class: 'qchip-mode',
              title:
                kind === 'rlt'
                  ? `CAST tells ${name} how the team is doing; it reads this when the turn ends`
                  : kind === 'steer'
                    ? `${name} reads this at the next step, without stopping`
                    : `${name} reads this when the current turn ends`,
            },
            kind === 'steer' ? chatIcon('bolt', 11) : kind === 'rlt' ? icon('users', 11) : icon('clock', 11),
            QUEUE_LABEL[kind],
          ),
          h('span', { class: 'qchip-text', title: q.text }, q.text || (q.images ? 'Images' : '…')),
          q.images ? h('span', { class: 'qchip-img', title: `${q.images} image${q.images === 1 ? '' : 's'}` }, chatIcon('image', 12), String(q.images)) : null,
          busy ? h('span', { class: 'spinner spinner-sm' }) : null,
          q.by === 'user' && q.mode === 'queue' && handlers.onQueueAction
            ? h('button', { type: 'button', class: 'qchip-btn', disabled: busy, title: `${name} reads it at the next step instead of when the turn ends`, onclick: () => void queueAction(q, 'steer') }, 'Send now')
            : null,
          q.by === 'user' && handlers.onQueueAction
            ? h('button', { type: 'button', class: 'qchip-x', disabled: busy, 'aria-label': 'Take it back into the box', title: 'Take it back into the box', onclick: () => void queueAction(q, 'remove') }, icon('x', 12))
            : null,
        );
      }),
      ...mine.map(outgoingChip),
    );
  }

  // ── Sending ──
  const submit = (now: boolean) => {
    if (blocker()) {
      if (blocker() === 'images' && target?.noImages) notify('warn', `${target.noImages} — remove the images to send.`);
      return;
    }
    if (handlers.hold?.(() => submit(now))) return;
    const t = target!;
    const to = t.id ?? '';
    const text = input.value.trim();
    const sent = ready();
    const mode = steerable() ? (now ? 'steer' : 'queue') : undefined;
    // Send / Send now pressed from the keyboard: they are disabled once the box is empty, which would drop focus to
    // the page (and the next keys to the global shortcuts: A approves, D denies…). The box takes it instead.
    if (document.activeElement === send || document.activeElement === steer) input.focus({ preventScroll: true });
    // Out of the box at once — it is on its way to `to` whoever the box shows next, and the box is free for the next
    // thought (queued behind this one while omp starts up).
    input.value = '';
    attachments = attachments.filter((a) => !sent.includes(a));
    fit();
    renderThumbs();
    saveBox();
    outbox.push(to, { send: { text, images: sent.map((a) => a.ref!), to, ...(mode ? { mode } : {}) }, held: sent });
    refresh();
  };

  function forget(draft: ComposerDraft, id?: string): boolean {
    const key = id ?? boxKey;
    if (key === null) return false;
    if (key === boxKey) {
      const left = removeFromDraft({ text: input.value, images: refsOf(attachments) }, draft);
      if (!left) return false;
      input.value = left.text;
      const gone = new Set(draft.images.map((r) => r.id));
      for (const a of attachments) if (a.ref && gone.has(a.ref.id)) dropAttachment(a);
      attachments = attachments.filter((a) => !(a.ref && gone.has(a.ref.id)));
      fit();
      renderThumbs();
      refresh();
      saveBox();
      return true;
    }
    const p = readParked(key);
    const left = removeFromDraft({ text: p.text, images: refsOf(p.attachments) }, draft);
    if (!left) return false;
    const keep = new Set(left.images.map((r) => r.id));
    writeParked(key, { text: left.text, attachments: p.attachments.filter((a) => !a.ref || keep.has(a.ref.id)) });
    return true;
  }

  /** focus: put the caret in the box afterwards (not when a failed send comes back while the user types elsewhere). */
  function restore(draft: ComposerDraft, id?: string, focus = true) {
    const key = id ?? boxKey;
    if (key === null) return;
    if (key !== boxKey) {
      const p = readParked(key);
      const { draft: next, dropped } = appendDraft({ text: p.text, images: refsOf(p.attachments) }, { text: draft.text, images: draft.images ?? [] }, MAX_PROMPT_IMAGES);
      if (dropped) notify('warn', `${dropped} image${dropped === 1 ? '' : 's'} didn’t fit — up to ${MAX_PROMPT_IMAGES} per message.`);
      const have = new Set(p.attachments.map((a) => a.ref?.id));
      writeParked(key, { text: next.text, attachments: [...p.attachments, ...next.images.filter((r) => !have.has(r.id)).map((r) => readyAttachment(r, key))] });
      return;
    }
    input.value = appendDraft({ text: input.value, images: [] }, { text: draft.text, images: [] }, MAX_PROMPT_IMAGES).draft.text;
    let dropped = 0;
    for (const ref of draft.images ?? []) {
      if (attachments.some((a) => a.ref?.id === ref.id)) continue;
      if (attachments.length >= MAX_PROMPT_IMAGES) dropped++;
      else attachments.push(readyAttachment(ref, key));
    }
    if (dropped) notify('warn', `${dropped} image${dropped === 1 ? '' : 's'} didn’t fit — up to ${MAX_PROMPT_IMAGES} per message.`);
    fit();
    renderThumbs();
    refresh();
    saveBox();
    // On a touch screen focusing pops the keyboard over half the chat: only when the user was typing here already.
    if (focus && !input.disabled && (!isTouchUI() || el.contains(document.activeElement))) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function dropDraft(id: string): ComposerDraft | null {
    if (id === boxKey) return null; // on show: it stays in the box (the chat tab moves the box to someone else first)
    const p = readParked(id);
    parked.delete(id);
    book.clear(id);
    for (const a of p.attachments) dropAttachment(a);
    const d = { text: p.text, images: refsOf(p.attachments) };
    return isEmptyDraft(d) ? null : d;
  }

  /** Return sends here (hardware keyboard), or adds a line (touch keyboard) — the user's choice in the More menu wins. */
  const returnSends = () => enterSends({ touch: isTouchUI(), pref: deviceStorage.get(ENTER_SENDS_KEY) });
  // The on-screen keyboard labels its Return key by what it does. Read on focus: the choice can change meanwhile.
  const labelReturn = () => (input.enterKeyHint = returnSends() ? 'send' : 'enter');
  labelReturn();
  input.addEventListener('focus', labelReturn);
  input.addEventListener('input', () => {
    fit();
    const block = blocker();
    send.disabled = !!block;
    steer.disabled = !!block;
    noteDraft();
    saveSoon();
  });
  // A draft typed in the last quarter second still makes it into storage when the tab goes away.
  addEventListener('pagehide', () => saveBox());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) {
      ev.preventDefault();
      submit(true);
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229 && returnSends()) {
      ev.preventDefault();
      submit(false);
    }
    // Alt+M (matched by key code: ⌥M types "µ" on a Mac). Never Shift+Tab: that is how keyboard users move back
    // out of the box, and a safety setting must not change as a side effect of moving focus.
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.code === 'KeyM' && !ev.isComposing && handlers.onCycleMode) {
      ev.preventDefault();
      handlers.onCycleMode();
    }
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && (ev.code === 'KeyP' || ev.code === 'KeyT') && !ev.isComposing) {
      if (handlers.onChipKey?.(ev.code === 'KeyP' ? 'model' : 'effort')) ev.preventDefault();
    }
    if (ev.key === 'Escape') {
      // Leave the box only — a single Esc never aborts work. Focus lands on the chat around it (not <body>), so the
      // next Esc closes the panel and Tab carries on from here.
      focusOutOf(input);
      ev.stopPropagation();
    }
  });
  // A screenshot pasted into the box rides along; the text part of a paste still lands as usual.
  input.addEventListener('paste', (ev) => {
    const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    if (!ev.clipboardData?.getData('text/plain')) ev.preventDefault();
    addFiles(files);
  });
  send.addEventListener('click', () => submit(false));
  steer.addEventListener('click', () => submit(true));
  // A mouse click on Send / Send now leaves focus where it was (the box), not on a button about to be disabled.
  for (const b of [send, steer]) b.addEventListener('mousedown', (ev) => ev.preventDefault());
  stop.addEventListener('click', () => handlers.onAbort());
  stopHelpers.addEventListener('click', () => handlers.onAbort());
  attach.addEventListener('click', () => {
    if (!target || target.locked) return;
    if (target.noImages) notify('info', target.noImages);
    else picker.click();
  });
  picker.addEventListener('change', () => {
    if (picker.files) addFiles(picker.files);
    picker.value = '';
  });
  refresh();

  return {
    el,
    input,
    modeSlot,
    setTarget(next) {
      swapTo(next ? (next.id ?? '') : null);
      target = next;
      const busy = !!next?.busy;
      const helpers = !!next?.helpers && !busy;
      const locked = !!next?.locked;
      input.placeholder = next ? (next.locked?.placeholder ?? `Message ${next.name}…`) : 'Pick someone to talk to';
      // Locked = read-only, not disabled: disabling the focused box would drop focus to the page and send the rest of
      // the sentence to the global shortcuts (A approves, D denies…). submit() refuses while locked.
      input.disabled = !next;
      if (locked) input.setAttribute('aria-disabled', 'true');
      else input.removeAttribute('aria-disabled');
      stop.hidden = !busy;
      const out = busy ? (next?.helpersOut ?? 0) : 0;
      const stopTitle = out ? `Stop — also cancels the ${out} helper${out === 1 ? '' : 's'} still working` : 'Stop';
      stop.title = out ? stopTitle : '';
      stop.setAttribute('aria-label', stopTitle);
      stopHelpers.hidden = !helpers || locked;
      if (next && helpers) {
        const title = `Stop every helper ${next.name} started — all of them are cancelled, not just one. ${next.name} keeps the chat.`;
        stopHelpers.title = title;
        stopHelpers.setAttribute('aria-label', title);
      }
      const now = steerable();
      steer.hidden = !now;
      if (next && now) {
        const title = `Send now — ${next.name} reads it at the next step, without stopping (${modKey}+Enter)`;
        steer.title = title;
        steer.setAttribute('aria-label', title);
      }
      const sendTitle = next && now ? `Queue — ${next.name} reads it when this turn ends (Enter)` : 'Send message';
      send.title = next && now ? sendTitle : '';
      send.setAttribute('aria-label', sendTitle);
      attach.hidden = !next || locked;
      attach.classList.toggle('is-off', !!next?.noImages);
      attach.setAttribute('aria-disabled', String(!!next?.noImages));
      attach.title = next?.noImages ?? 'Attach images — or paste or drop them here';
      el.classList.toggle('is-busy', busy);
      el.classList.toggle('is-helpers', helpers);
      el.classList.toggle('is-locked', locked);
      el.classList.toggle('is-offline', !!next?.offline);
      renderThumbs();
      renderQueue();
      refresh();
    },
    focus() {
      input.focus({ preventScroll: true });
    },
    setText(text) {
      if (target?.locked) return; // the suggestion would wait in a closed box
      input.value = text;
      fit();
      refresh();
      saveBox();
      input.focus();
      input.setSelectionRange(text.length, text.length);
    },
    addFiles,
    restore: (draft, id) => restore(draft, id),
    forget,
    dropDraft,
    refreshQueue: renderQueue,
  };
}
