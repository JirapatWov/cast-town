// Renders one TranscriptItem and updates it in place as streaming upserts arrive. With ctx.files (the person's
// folder), paths in replies and tool cards open in the built-in viewer, and pictures show as thumbnails.
import './css/viewer.css';
import './css/health.css';
import type { ImageRef, TranscriptItem } from '../../../shared/protocol';
import { folderId } from '../net/files';
import { uploadUrl } from '../net/uploads';
import { chatIcon } from './chat-icons';
import { h, setChildren } from './dom';
import { baseName, fileKind, isImageKind, isVisualKind } from './file-kinds';
import type { FileLinks } from './file-links';
import type { FileRef } from './file-paths';
import { timeOfDay } from './format';
import { icon } from './icons';
import { toolArgsText } from './tool-args';
import { closeOpenMarkdown, fileRefOf, renderMarkdown } from './markdown';
import { vIcon } from './viewer-icons';

export interface ItemView {
  readonly el: HTMLElement;
  update(item: TranscriptItem): void;
  /** Re-read what the item shows from elsewhere (a plan card: the models, its run). */
  refresh?(): void;
}

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;
type AssistantItem = Extract<TranscriptItem, { kind: 'assistant' }>;
export type PlanItem = Extract<TranscriptItem, { kind: 'plan' }>;
export type HelperItem = Extract<TranscriptItem, { kind: 'helper' }>;
type UserItem = Extract<TranscriptItem, { kind: 'user' }>;
type AdvisorItem = Extract<TranscriptItem, { kind: 'advisor' }>;

/** Views that need the app (a plan card answers the server, a helper card opens its chat): the chat passes them in. */
export interface ItemViewContext {
  plan?(item: PlanItem): ItemView;
  helper?(item: HelperItem): ItemView;
  /** The card under a turn that changed files ("Undo this turn's changes", turn-changes.ts). */
  changes?(item: Extract<TranscriptItem, { kind: 'changes' }>): ItemView;
  /** A thumbnail in a user bubble was clicked: show it full size. */
  openImage?(ref: ImageRef): void;
  /** A system line's link: open that other chat of the same person (resolves once it is open, or it failed). */
  openThread?(threadId: string): Promise<void> | void;
  /** The person's folder (file-links.ts): paths in replies and tool cards open in the built-in viewer. */
  files?: FileLinks;
  /** "Retry" on a message that wasn't sent, "Run again" on work a restart interrupted: send it to the person again
   *  (resolves once the server has it, or it failed — the chat says why then). */
  resend?(msg: { text: string; images?: ImageRef[] }): Promise<void>;
  /** The empty-answer card's buttons (F5): open the person's model menu at the button; send "continue" (stopping the
   *  retries first while they still run). */
  stuck?: { switchModel(anchor: HTMLElement): void; nudge(): Promise<void> };
}

type SystemItem = Extract<TranscriptItem, { kind: 'system' }>;

/** A model that keeps answering with nothing (or omp gave up retrying): what happened, and the two ways out. */
function stuckCard(el: HTMLElement, item: SystemItem & { stuck: NonNullable<SystemItem['stuck']> }, ctx: ItemViewContext) {
  el.className = `msg-system msg-stuck level-${item.level}`;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', item.stuck.kind === 'empty' ? 'Empty answers' : 'Repeated failures');
  const switchBtn = h('button', { type: 'button', class: 'btn btn-soft btn-sm', 'aria-haspopup': 'menu', onclick: () => ctx.stuck?.switchModel(switchBtn) }, 'Switch model…');
  const nudgeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Stops the retries if they still run, then sends “continue”' }, 'Send “continue”');
  nudgeBtn.addEventListener('click', async () => {
    if (nudgeBtn.disabled || !ctx.stuck) return;
    nudgeBtn.disabled = true;
    nudgeBtn.textContent = 'Sending…';
    try {
      await ctx.stuck.nudge();
    } finally {
      nudgeBtn.disabled = false;
      nudgeBtn.textContent = 'Send “continue”';
    }
  });
  setChildren(el,
    h('div', { class: 'msg-stuck-head' }, icon(item.level === 'error' ? 'xCircle' : 'alert', 14), h('span', null, item.text)),
    item.stuck.final ? null : h('p', { class: 'msg-stuck-note' }, 'The agent is still trying the same request.'),
    ctx.stuck ? h('div', { class: 'msg-stuck-actions' }, switchBtn, nudgeBtn) : null,
    item.details ? h('details', { class: 'msg-details' }, h('summary', null, 'Details'), h('pre', null, item.details)) : null,
  );
}

/** A button that sends a message again: one click is enough until the answer is back. */
function resendButton(label: string, title: string, cls: string, msg: { text: string; images?: ImageRef[] }, resend: NonNullable<ItemViewContext['resend']>): HTMLElement {
  const btn = h('button', { type: 'button', class: ['link-btn', cls], title }, label);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await resend(msg);
    } finally {
      btn.disabled = false; // the server replaces this item when it went; still here → it can be tried again
      btn.textContent = label;
    }
  });
  return btn;
}

const MAX_THUMBS = 6;
const refKey = (r: FileRef) => `${folderId(r.folder)}|${r.path}`;

/** A small picture button: a file of the folder (src filled once its key is known) or an upload. */
function thumbButton(label: string, onclick: () => void, src: string | null, fill?: () => Promise<string>): HTMLElement {
  const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', ...(src ? { src } : {}) });
  const btn = h('button', { type: 'button', class: 'md-thumbs-item', title: `${label} — open in the viewer`, 'aria-label': `Open ${label}`, onclick }, img);
  img.addEventListener('error', () => btn.remove()); // not there (yet): no broken picture
  if (!src && fill) fill().then((url) => (img.src = url), () => btn.remove());
  return btn;
}

/** Wire file links of rendered Markdown in el: clicks open the viewer, pending images get their src, broken ones
 *  fall back to their label. Call once per element. */
function wireFileLinks(el: HTMLElement, files: FileLinks) {
  el.addEventListener('click', (ev) => {
    const a = (ev.target as Element).closest('a.md-file');
    if (!a || !el.contains(a)) return;
    ev.preventDefault();
    const ref = fileRefOf(a);
    if (ref) files.open(ref);
  });
  el.addEventListener(
    'error',
    (ev) => {
      const img = ev.target;
      if (img instanceof HTMLImageElement && img.closest('.md-thumb')) img.closest('.md-thumb')!.classList.add('is-broken');
    },
    true,
  );
}

function fillPending(el: HTMLElement, files: FileLinks) {
  el.querySelectorAll<HTMLImageElement>('.md-thumb img[data-pending]').forEach((img) => {
    const ref = fileRefOf(img.closest('.md-thumb')!);
    img.removeAttribute('data-pending');
    if (ref)
      files.src(ref).then(
        (url) => (img.src = url),
        () => img.closest('.md-thumb')?.classList.add('is-broken'),
      );
  });
}

const TOOL_ICON: [RegExp, string][] = [
  [/^(read|grep|find|ls|glob|lsp|ast)/, 'eye'],
  [/^(edit|write|apply_patch|notebook|ast_edit)/, 'pencil'],
  [/^(bash|exec|eval|python|shell)/, 'terminal'],
  [/^(web|fetch|browser)/, 'globe'],
  [/^task/, 'users'],
  [/^todo/, 'workflow'],
  [/^(team_|workflow_)/, 'workflow'],
];

function toolIcon(tool: string): string {
  return TOOL_ICON.find(([re]) => re.test(tool))?.[1] ?? 'wand';
}

/** A tool's files: those inside the person's folder (viewable) and the others with why not. */
function toolFiles(item: ToolItem, files: FileLinks | undefined) {
  const inside: FileRef[] = [];
  const outside: { path: string; why: string }[] = [];
  for (const p of item.paths ?? []) {
    const r = files?.resolve(p);
    if (r?.ok) {
      if (!inside.some((x) => refKey(x) === refKey(r))) inside.push(r);
    } else outside.push({ path: p, why: r && !r.ok ? r.why : 'Can’t be opened from here.' });
  }
  return { inside, outside };
}

function toolView(initial: ToolItem, ctx: ItemViewContext): ItemView {
  const statusEl = h('span', { class: 'tool-status' });
  const titleEl = h('span', { class: 'tool-title' });
  const nameEl = h('span', { class: 'tool-name' });
  // Auto mode ran this step without asking you: say so, so what Auto cleared can be looked over (#61).
  const autoEl = h('span', { class: 'tool-auto', hidden: true, title: 'Auto mode ran this without asking: its rules saw nothing risky. A best-effort check, not a sandbox.' }, icon('wand', 12), 'Auto-approved');
  const head = h(
    'button',
    { type: 'button', class: 'tool-head', 'aria-expanded': 'false' },
    statusEl,
    h('span', { class: 'tool-kind' }, icon(toolIcon(initial.tool), 14)),
    titleEl,
    autoEl,
    nameEl,
    icon('chevronDown', 14, 'tool-chev'),
  );
  const openBtn = h('button', { type: 'button', class: 'tool-open', hidden: true }, vIcon('view', 14), h('span', null, 'View'));
  const shots = h('div', { class: 'tool-shots', hidden: true });
  const body = h('div', { class: 'tool-body', hidden: true });
  const el = h('div', { class: 'tool' }, h('div', { class: 'tool-top' }, head, openBtn), shots, body);
  let item = initial;
  let filesKey = '';
  let firstFile: FileRef | null = null;

  const fileSec = () => {
    const { inside, outside } = toolFiles(item, ctx.files);
    if (!inside.length && !outside.length) return null;
    return h(
      'div',
      { class: 'tool-sec' },
      h('div', { class: 'tool-sec-label' }, inside.length + outside.length === 1 ? 'File' : 'Files'),
      h(
        'ul',
        { class: 'tool-files' },
        ...inside.map((r) =>
          h('li', null, h('button', { type: 'button', class: 'tool-file', title: `Open ${r.path} in the viewer`, onclick: () => ctx.files?.open(r) }, vIcon('view', 13), h('span', null, r.path || '.'))),
        ),
        ...outside.map((o) => h('li', null, h('span', { class: 'tool-file is-outside', title: o.why }, vIcon('alert', 13), h('span', null, o.path), h('span', { class: 'tool-file-why' }, 'outside the house')))),
      ),
    );
  };

  const fillBody = () => {
    const args = toolArgsText(item.args);
    setChildren(body,
      item.status === 'done' ? fileSec() : null,
      args ? h('div', { class: 'tool-sec' }, h('div', { class: 'tool-sec-label' }, 'Details'), h('pre', null, args)) : null,
      item.result
        ? h('div', { class: 'tool-sec' }, h('div', { class: 'tool-sec-label' }, item.isError ? 'Error' : 'Result'), h('pre', { class: item.isError ? 'is-error' : '' }, item.result))
        : item.status === 'running'
          ? h('div', { class: 'tool-sec muted small' }, 'Working…')
          : null,
    );
  };

  /** The View button (first file inside the folder, once the tool finished) and the picture strip. */
  const renderFiles = () => {
    const images = item.images ?? [];
    const done = item.status === 'done' && !item.isError;
    const { inside } = done ? toolFiles(item, ctx.files) : { inside: [] as FileRef[] };
    const sig = JSON.stringify([done, images.map((i) => i.id), inside.map(refKey)]);
    if (sig === filesKey) return;
    filesKey = sig;
    firstFile = inside.find((r) => !r.dir) ?? inside[0] ?? null;
    openBtn.hidden = !firstFile || !ctx.files;
    if (firstFile) {
      const kind = firstFile.dir ? 'unknown' : fileKind(firstFile.path);
      openBtn.title = `Open ${firstFile.path || 'the folder'} in the viewer`;
      openBtn.classList.toggle('is-quiet', !isVisualKind(kind));
    }
    const pics: HTMLElement[] = images.slice(0, MAX_THUMBS).map((ref, i) =>
      thumbButton(images.length > 1 ? `Image ${i + 1}` : 'Image', () => (ctx.files ? ctx.files.openUpload(ref, item.title || 'Image') : ctx.openImage?.(ref)), uploadUrl(ref.id)),
    );
    if (!images.length && ctx.files) {
      const files = ctx.files;
      for (const r of inside.filter((x) => !x.dir && isImageKind(fileKind(x.path))).slice(0, MAX_THUMBS))
        pics.push(thumbButton(baseName(r.path), () => files.open(r), files.srcNow(r), () => files.src(r)));
    }
    shots.hidden = !pics.length;
    setChildren(shots, ...pics);
  };
  openBtn.addEventListener('click', () => {
    if (firstFile) ctx.files?.open(firstFile);
  });

  head.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
    el.classList.toggle('is-open', open);
    if (open) fillBody();
  });

  const update = (next: TranscriptItem) => {
    if (next.kind !== 'tool') return;
    item = next;
    const status = item.isError ? 'error' : item.status;
    el.className = ['tool', `is-${status}`, el.classList.contains('is-open') && 'is-open'].filter(Boolean).join(' ');
    setChildren(statusEl, status === 'running' ? h('span', { class: 'spinner', 'aria-label': 'Running' }) : icon(status === 'error' ? 'xCircle' : 'checkCircle', 15));
    titleEl.textContent = item.title || item.tool;
    autoEl.hidden = !item.auto;
    nameEl.textContent = item.tool;
    renderFiles();
    if (!body.hidden) fillBody();
  };
  update(initial);
  return { el, update };
}

const contPending = new WeakSet<Element>();

/** Marks the assistant blocks that continue an answer (no user message since the previous one) with `is-cont`, so the
 *  phone's Board CSS can drop their repeated author/time line. Views are built detached and appended in order, so the
 *  pass runs once the caller has attached them (a microtask), once per list however many views were just added. */
function markContinuations(el: HTMLElement) {
  queueMicrotask(() => {
    const list = el.parentElement;
    if (!list || contPending.has(list)) return;
    contPending.add(list);
    queueMicrotask(() => {
      contPending.delete(list);
      let run = false;
      for (const child of list.children) {
        if (child.classList.contains('msg-user')) run = false;
        else if (child.classList.contains('msg-assistant')) {
          child.classList.toggle('is-cont', run);
          run = true;
        }
      }
    });
  });
}

function assistantView(initial: AssistantItem, authorName: string, files?: FileLinks): ItemView {
  const md = h('div', { class: 'md' });
  const thinkBody = h('div', { class: 'thinking-body' });
  const thinkLabel = h('span', null);
  const thinking = h('details', { class: 'thinking' }, h('summary', null, icon('brain', 14), thinkLabel, icon('chevronDown', 13, 'thinking-chev')), thinkBody);
  const meta = h('div', { class: 'msg-meta' }, h('span', { class: 'msg-author' }, authorName), h('span', { class: 'msg-time' }, timeOfDay(initial.ts)));
  const thumbs = h('div', { class: 'md-thumbs', hidden: true });
  const el = h('div', { class: 'msg msg-assistant' }, meta, thinking, md, thumbs);
  let lastText: string | null = null;
  let lastThinking: string | null = null;
  let thumbsKey = '';
  if (files) wireFileLinks(md, files);

  /** Pictures the reply links to (a path in a link or code span), shown under it; inline images show in place. */
  const renderThumbs = () => {
    if (!files) return;
    const inline = new Set([...md.querySelectorAll('a.md-thumb')].map((a) => fileRefOf(a)).filter((r): r is FileRef => !!r).map(refKey));
    const seen = new Set<string>();
    const refs: FileRef[] = [];
    for (const a of md.querySelectorAll('a.md-file:not(.md-thumb)')) {
      const r = fileRefOf(a);
      if (!r || r.dir || !isImageKind(fileKind(r.path))) continue;
      const k = refKey(r);
      if (inline.has(k) || seen.has(k)) continue;
      seen.add(k);
      refs.push(r);
    }
    const sig = refs.slice(0, MAX_THUMBS).map(refKey).join('\n');
    if (sig === thumbsKey) return;
    thumbsKey = sig;
    thumbs.hidden = !refs.length;
    setChildren(thumbs, ...refs.slice(0, MAX_THUMBS).map((r) => thumbButton(baseName(r.path), () => files.open(r), files.srcNow(r), () => files.src(r))));
  };

  const update = (next: TranscriptItem) => {
    if (next.kind !== 'assistant') return;
    el.classList.toggle('is-streaming', !!next.streaming);
    const th = next.thinking ?? '';
    thinking.hidden = !th;
    if (th !== lastThinking) {
      thinkBody.textContent = th;
      lastThinking = th;
    }
    thinkLabel.textContent = next.streaming && !next.text ? 'Thinking…' : 'Thought process';
    if (next.text !== lastText) {
      md.innerHTML = renderMarkdown(next.streaming ? closeOpenMarkdown(next.text) : next.text, files);
      lastText = next.text;
      if (files) {
        fillPending(md, files);
        renderThumbs();
      }
    }
    md.hidden = !next.text;
  };
  update(initial);
  markContinuations(el);
  return { el, update };
}

function userView(initial: UserItem, ctx: ItemViewContext): ItemView {
  const text = h('div', { class: 'bubble' });
  const pics = h('div', { class: 'bubble-images' });
  const tag = h('div', { class: 'msg-tag', title: 'Sent while they were working — read at their next step' }, chatIcon('bolt', 11), 'Read mid-task');
  // never reached the person (their omp didn't start, CAST restarted first): the chat above or below says why
  const notSent = h('div', { class: 'msg-notsent', hidden: true });
  const el = h('div', { class: 'msg msg-user' }, pics, text, tag, notSent);
  let shown = '';
  let notSentKey = '';
  const update = (next: TranscriptItem) => {
    if (next.kind !== 'user') return;
    text.textContent = next.text;
    text.hidden = !next.text && !!next.images?.length;
    tag.hidden = !next.steered || !!next.notSent;
    el.classList.toggle('is-notsent', !!next.notSent);
    notSent.hidden = !next.notSent;
    const nsKey = next.notSent ? `${next.text}|${(next.images ?? []).map((r) => r.id).join(',')}` : '';
    if (nsKey !== notSentKey) {
      notSentKey = nsKey;
      setChildren(notSent,
        ...(next.notSent
          ? [
              icon('alert', 12),
              h('span', null, 'Not sent'),
              ctx.resend ? h('span', { 'aria-hidden': 'true' }, '·') : null,
              ctx.resend ? resendButton('Retry', 'Send this message again', 'msg-retry', { text: next.text, images: next.images }, ctx.resend) : null,
            ]
          : []),
      );
    }
    const images = next.images ?? [];
    const key = images.map((r) => r.id).join(',');
    if (key === shown) return;
    shown = key;
    pics.hidden = !images.length;
    setChildren(pics,
      ...images.map((ref, i) =>
        h(
          'button',
          { type: 'button', class: 'bubble-img', 'aria-label': `Image ${i + 1} of ${images.length} — show full size`, onclick: () => ctx.openImage?.(ref) },
          h('img', { src: uploadUrl(ref.id), alt: '', loading: 'lazy', decoding: 'async' }),
        ),
      ),
    );
  };
  update(initial);
  return { el, update };
}

const SEVERITY_LABEL = { nit: 'Nit', concern: 'Concern', blocker: 'Blocker' } as const;

/** Notes from the job's advisor (a second model reading the lead's turns): its own small card, never a chat bubble. */
function advisorView(initial: AdvisorItem): ItemView {
  const list = h('ul', { class: 'advisor-notes' });
  const time = h('span', { class: 'msg-time' });
  const el = h('div', { class: 'advisor', role: 'note' }, h('div', { class: 'advisor-head' }, chatIcon('bulb', 13), h('span', { class: 'advisor-title' }, 'Advisor'), time), list);
  const update = (next: TranscriptItem) => {
    if (next.kind !== 'advisor') return;
    time.textContent = timeOfDay(next.ts);
    const worst = next.notes.some((n) => n.severity === 'blocker') ? 'blocker' : next.notes.some((n) => n.severity === 'concern') ? 'concern' : 'nit';
    el.className = `advisor is-${worst}`;
    setChildren(list,
      ...next.notes.map((n) => {
        const sev = n.severity ?? 'nit';
        return h('li', { class: 'advisor-note' }, h('span', { class: ['chip', 'advisor-sev', `is-${sev}`] }, SEVERITY_LABEL[sev] ?? sev), h('span', { class: 'advisor-text' }, n.note));
      }),
    );
  };
  update(initial);
  return { el, update };
}

/** "Open that chat" on a system line (e.g. where a team's update went): switches the person to that chat. */
function threadLink(link: { threadId: string; label: string }, open: NonNullable<ItemViewContext['openThread']>): HTMLElement {
  const btn = h('button', { type: 'button', class: 'link-btn msg-system-link', title: 'Switch to that chat' }, link.label);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true; // the chat is replaced once it opens; until then one click is enough
    try {
      await open(link.threadId);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

export function createItemView(item: TranscriptItem, authorName: string, ctx: ItemViewContext = {}): ItemView {
  switch (item.kind) {
    case 'plan': {
      if (ctx.plan) return ctx.plan(item);
      // no app to answer with: a plain line
      const el = h('div', { class: 'msg-system level-info' });
      const update = (next: TranscriptItem) => {
        if (next.kind === 'plan') setChildren(el, icon('users', 13), h('span', null, `Team plan “${next.plan.title}” — ${next.plan.status}`));
      };
      update(item);
      return { el, update };
    }
    case 'tool':
      return toolView(item, ctx);
    case 'assistant':
      return assistantView(item, authorName, ctx.files);
    case 'user':
      return userView(item, ctx);
    case 'advisor':
      return advisorView(item);
    case 'helper': {
      if (ctx.helper) return ctx.helper(item);
      const el = h('div', { class: 'msg-system level-info' });
      const update = (next: TranscriptItem) => {
        if (next.kind === 'helper') setChildren(el, icon('users', 13), h('span', null, `${next.name} — ${next.status === 'running' ? 'working' : next.status}`));
      };
      update(item);
      return { el, update };
    }
    case 'changes': {
      if (ctx.changes) return ctx.changes(item);
      const el = h('div', { class: 'msg-system level-info' });
      const update = (next: TranscriptItem) => {
        if (next.kind === 'changes') setChildren(el, icon('diff', 13), h('span', null, `Changed ${next.count} file${next.count === 1 ? '' : 's'}`));
      };
      update(item);
      return { el, update };
    }
    case 'system': {
      const el = h('div', { class: `msg-system level-${item.level}` });
      const update = (next: TranscriptItem) => {
        if (next.kind !== 'system') return;
        if (next.stuck) return stuckCard(el, { ...next, stuck: next.stuck }, ctx);
        el.className = `msg-system level-${next.level}`;
        setChildren(el,
          icon(next.level === 'error' ? 'xCircle' : next.level === 'warn' ? 'alert' : 'sparkle', 13),
          h('span', null, next.text),
          next.link && ctx.openThread ? threadLink(next.link, ctx.openThread) : null,
          next.resend && ctx.resend ? resendButton('Run again', 'Send that message to them again', 'msg-system-act', next.resend, ctx.resend) : null,
          // omp's own words stay folded: the line above is what a person needs
          next.details ? h('details', { class: 'msg-details' }, h('summary', null, 'Details'), h('pre', null, next.details)) : null,
        );
      };
      update(item);
      return { el, update };
    }
  }
}
