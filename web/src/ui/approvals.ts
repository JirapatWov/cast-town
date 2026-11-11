// Approval cards: the floating stack (bottom-right), plus the same card reused inline in Chat/Inbox.
import { askQuestionsOf, isQuestion } from '../../../shared/ask';
import type { ApprovalChange, ApprovalRequest, AskQuestion, Job } from '../../../shared/protocol';
import { originLabel } from './approval-text';
import { askState, draftFor, dropDraft, isPicked, ownWords, pick, setOwnWords, toggleOwnWords, type AskDraft } from './ask-draft';
import { h, memo, setChildren } from './dom';
import { liveAgo } from './live-time';
import { icon } from './icons';
import { codeBadge } from './job-switcher';
import { floorName } from './jobs';
import { askToNotify, canAskToNotify } from './notify';
import { syncGroup } from './radios';
import type { PanelTab, Shell } from './shell';
import { avatar, kbd, optionNames } from './widgets';
import { inboxScope } from './last-house';

type OptionKind = 'approve' | 'session' | 'deny' | 'other';

function optionKind(opt: string): OptionKind {
  if (/deny|reject|block|no\b/i.test(opt)) return 'deny';
  if (/session|always|remember/i.test(opt)) return 'session';
  if (/approve|allow|yes|ok/i.test(opt)) return 'approve';
  return 'other';
}

/** The options A / D answer with. None on an ask: it is answered with its own form (every question, then Send). */
export function approveOption(a: ApprovalRequest): string | undefined {
  return a.tool === 'ask' ? undefined : a.options.find((o) => optionKind(o) === 'approve');
}
export function denyOption(a: ApprovalRequest): string | undefined {
  return a.tool === 'ask' ? undefined : a.options.find((o) => optionKind(o) === 'deny');
}

/** Go where a request comes from: into its house (when looking at another one), its job, and the asker's chat. */
export function goToRequest(shell: Shell, a: Pick<ApprovalRequest, 'projectId' | 'agentId'>) {
  if (shell.view.view === 'house' && shell.view.projectId !== a.projectId) shell.enterProject(a.projectId);
  if (shell.store.state.agents[a.agentId]) shell.openAgent(a.agentId);
  else shell.openPanel('chat', a.projectId);
}

/** Pending answers, so a card dims immediately instead of waiting for approval_resolved. */
const answering = new Set<string>();

export function answerApproval(shell: Shell, a: ApprovalRequest, value: string) {
  if (answering.has(a.id)) return;
  answering.add(a.id);
  shell.store.send({ t: 'approve', approvalId: a.id, value });
  setTimeout(() => answering.delete(a.id), 15_000);
}

function splitDetail(detail: string | undefined): { label: string; body: string } | null {
  if (!detail) return null;
  const m = /^(Command|Path|File|URL):\s*([\s\S]*)$/i.exec(detail.trim());
  return m ? { label: m[1], body: m[2] } : { label: 'Details', body: detail };
}

/** Diff lines shown on the card before "Show all". */
const PREVIEW_LINES = 12;

/** The card's own lines of a unified diff: file names, @@ markers and the changed/context lines (no git headers). */
export function diffPreviewLines(diff: string): { kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx'; text: string }[] {
  const out: { kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx'; text: string }[] = [];
  const files = diff.split('\n').filter((l) => l.startsWith('diff --git ')).length;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      if (files > 1) out.push({ kind: 'file', text: l.replace(/^diff --git a\/(.*) b\/(.*)$/, (_m, a: string, b: string) => (a === b ? a : `${a} → ${b}`)) });
    } else if (/^(new|deleted) file mode |^rename (from|to) |^(---|\+\+\+) |^index /.test(l)) continue;
    else if (l.startsWith('@@')) out.push({ kind: 'hunk', text: l.replace(/^(@@[^@]*@@).*$/, '$1') });
    else if (l.startsWith('+')) out.push({ kind: 'add', text: l });
    else if (l.startsWith('-')) out.push({ kind: 'del', text: l });
    else out.push({ kind: 'ctx', text: l });
  }
  return out;
}

/** What an edit / write would change (finding #12): +N −M, the first lines of the diff, Show all, and the full diff
 *  on the TV overlay. */
function changeBlock(shell: Shell, a: ApprovalRequest, change: ApprovalChange, who: string): HTMLElement {
  const lines = diffPreviewLines(change.diff);
  const first = change.files[0] ?? '';
  const name = first.split('/').pop() || first;
  let open = false;
  const pre = h('pre', { class: 'approval-diff', tabindex: '0', 'aria-label': `Changes to ${change.files.join(', ')}` });
  const paint = () =>
    setChildren(pre, ...(open ? lines : lines.slice(0, PREVIEW_LINES)).map((l) => h('span', { class: `dl dl-${l.kind}` }, l.text || ' ')));
  paint();
  const more = lines.length > PREVIEW_LINES;
  const toggle = more
    ? h('button', {
        type: 'button',
        class: 'link-btn approval-diff-more',
        'aria-expanded': 'false',
        onclick: (ev: MouseEvent) => {
          open = !open;
          paint();
          const b = ev.currentTarget as HTMLElement;
          b.setAttribute('aria-expanded', String(open));
          b.textContent = open ? 'Show less' : `Show all ${lines.length} lines`;
          pre.classList.toggle('is-open', open);
        },
      }, `Show all ${lines.length} lines`)
    : null;
  const note = change.approx
    ? 'CAST worked this out from the request: the lines are what it writes, their place in the file may differ.'
    : change.truncated
      ? 'Very large change — only the first part is shown.'
      : undefined;
  const nothing = !change.added && !change.removed;
  return h(
    'div',
    { class: 'approval-change' },
    h(
      'div',
      { class: 'approval-change-head' },
      icon('file', 13),
      h('span', { class: 'approval-change-file', title: change.files.join('\n') }, name, change.files.length > 1 ? h('span', { class: 'muted' }, ` + ${change.files.length - 1} more`) : null),
      h('span', { class: 'num approval-change-num', 'aria-label': `${change.added} lines added, ${change.removed} removed` }, h('span', { class: 'add' }, `+${change.added}`), ' ', h('span', { class: 'del' }, `−${change.removed}`)),
      lines.length
        ? h('button', {
            type: 'button',
            class: 'icon-btn approval-change-open',
            title: 'Open the full diff',
            'aria-label': 'Open the full diff',
            onclick: () => shell.openDiff(a.projectId, undefined, { patch: { title: `${who} wants to change ${change.files.length > 1 ? `${change.files.length} files` : name}`, diff: change.diff, note } }),
          }, icon('tv', 14))
        : null,
    ),
    nothing ? h('p', { class: 'approval-change-note' }, 'No change to the text.') : pre,
    toggle,
    note ? h('p', { class: 'approval-change-note' }, note) : null,
  );
}

/** A command as one box per word, the spaces between them kept as text: lines break between words only, never after
 *  the hyphen of a flag ("tail -" / "n 15"). A word longer than the line still breaks inside (mobile.css). Copying
 *  the text gives the command unchanged. Very long bodies (a whole file) stay one text node. */
function wordBoxes(body: string): (string | HTMLElement)[] | string {
  if (body.length > 4000) return body;
  return body
    .split(/(\s+)/)
    .filter((part) => part !== '')
    .map((part) => (/^\s/.test(part) ? part : h('span', { class: 'cmd-word' }, part)));
}

/** The job (room) whose person asks — every job has people with the same role names, so cards must say which. */
export function approvalJob(shell: Shell, a: ApprovalRequest): Job | undefined {
  const agent = shell.store.state.agents[a.agentId];
  return agent ? shell.store.job(a.projectId, agent.jobId) : undefined;
}

/** The job the user is looking at: the current house's active job (null outside a house). */
function contextJob(shell: Shell): Job | undefined {
  const s = shell.store.state;
  if (s.view !== 'house' || !s.currentProjectId) return undefined;
  return shell.store.activeJob(s.currentProjectId);
}

/** What the side panel shows right now, as far as approval cards go. */
export interface PanelView {
  open: boolean;
  /** Desktop: folded to its header (tabs and cards hidden). */
  folded: boolean;
  tab: PanelTab;
  projectId: string | null;
  /** The person whose chat the Chat tab shows. */
  chatAgentId: string | null;
  /** The Workflow tab shows this person's requests (their step of the running team run). */
  workflowShows(agentId: string): boolean;
}

/** The open panel shows this request as a card — the inbox its house's (every house's outside one), a chat its
 *  person's, the Workflow tab its run's — so the floating stack leaves it out: one card in one place at a time. */
export function shownInPanel(p: PanelView, a: Pick<ApprovalRequest, 'projectId' | 'agentId'>): boolean {
  if (!p.open || p.folded) return false;
  if (p.tab === 'inbox') return !p.projectId || p.projectId === a.projectId;
  if (p.tab === 'chat') return !!p.chatAgentId && p.chatAgentId === a.agentId;
  if (p.tab === 'workflow') return p.workflowShows(a.agentId);
  return false;
}

/** True for the requests of the job being looked at (outside a house: every request) — the stack shows those first. */
function inContext(shell: Shell, a: ApprovalRequest): boolean {
  const ctx = contextJob(shell);
  if (!ctx) return true;
  return a.projectId === ctx.projectId && approvalJob(shell, a)?.id === ctx.id;
}

let askSeq = 0;

/** An agent's `ask`, in full: per question its header chip, the whole question, every option with its description
 *  (the recommended one marked), and "Something else" for the user's own words; then one Send for all of them.
 *  Nothing is picked for the user. Picks are kept per request (ask-draft.ts) and painted in place, so focus stays. */
function askForm(shell: Shell, a: ApprovalRequest, card: () => HTMLElement): HTMLElement {
  const qs = askQuestionsOf(a);
  const draft = draftFor(a.id);
  const seq = ++askSeq;
  const paints: (() => void)[] = [];
  const hint = h('span', { class: 'ask-hint', 'aria-live': 'polite' });
  const send = h('button', { type: 'button', class: 'btn btn-sm btn-amber ask-send', onclick: () => void submit() }, qs.length > 1 ? 'Send answers' : 'Send answer');

  const paint = () => {
    for (const p of paints) p();
    const state = askState(qs, draft);
    send.disabled = answering.has(a.id) || !state.ok;
    hint.textContent = state.ok ? '' : state.problem;
  };

  async function submit() {
    const state = askState(qs, draft);
    if (!state.ok || answering.has(a.id)) return;
    answering.add(a.id);
    const el = card();
    el.classList.add('is-answering');
    const controls = [...el.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea')];
    for (const c of controls) c.disabled = true;
    const first = state.answers[0];
    try {
      // value: what a server from before whole questions takes (the first question's label or words)
      await shell.store.request({ t: 'approve', reqId: '', approvalId: a.id, value: (first?.selectedOptions[0] ?? first?.customInput ?? '').slice(0, 500), ...(a.questions ? { answers: state.answers } : {}) });
      dropDraft(a.id);
      setTimeout(() => answering.delete(a.id), 15_000);
    } catch (err) {
      answering.delete(a.id);
      el.classList.remove('is-answering');
      for (const c of controls) c.disabled = false;
      paint();
      shell.toast('error', (err as Error).message || 'Couldn’t send the answer.');
    }
  }

  const questions = qs.map((q, i) => questionBlock(q, i, qs.length, draft, `ask-${seq}-${i}`, `${a.id}:${i}`, paints, paint, submit));
  paint();
  return h(
    'div',
    { class: 'approval-ask' },
    ...questions,
    h('div', { class: 'approval-actions ask-actions' }, send, hint),
    // a phone's floating card over the half-open sheet shows the questions only: the answers wait in the chat
    h('button', { type: 'button', class: 'btn btn-sm btn-amber ask-open', onclick: () => goToRequest(shell, a) }, 'Answer', icon('chevronRight', 13)),
  );
}

/** One question of an ask. `key` names its controls for the focus guard (focus.ts): an Inbox redrawn while the user
 *  types puts focus back in the same field (the words are in the draft). */
function questionBlock(q: AskQuestion, i: number, of: number, draft: AskDraft, id: string, key: string, paints: (() => void)[], paint: () => void, submit: () => Promise<void>): HTMLElement {
  const role = q.multi ? 'checkbox' : 'radio';
  const textId = `${id}-q`;
  const options = q.options.map((o, k) => {
    const name = h('span', { class: 'ask-opt-label' }, o.label, k === q.recommended ? h('span', { class: 'ask-rec' }, 'Recommended') : null);
    const desc = o.description ? h('span', { class: 'ask-opt-desc' }, o.description) : null;
    const btn = h(
      'button',
      { type: 'button', role, class: 'ask-opt', 'data-focus-key': `ask:${key}:${k}`, ...optionNames(name, desc), onclick: () => (pick(draft, q, o.label), paint()) },
      h('span', { class: `ask-mark ask-mark-${role}`, 'aria-hidden': 'true' }),
      h('span', { class: 'ask-opt-text' }, name, desc),
    );
    paints.push(() => {
      const on = isPicked(draft, q, o.label);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', String(on));
    });
    return btn;
  });
  // the user's own words: omp always takes free text besides the options
  const ownName = h('span', { class: 'ask-opt-label' }, 'Something else');
  const ownDesc = h('span', { class: 'ask-opt-desc' }, q.multi ? 'Add your own answer' : 'Type your own answer');
  const own = h('button', { type: 'button', role, class: 'ask-opt ask-opt-own', 'data-focus-key': `ask:${key}:own`, ...optionNames(ownName, ownDesc), onclick: (ev: MouseEvent) => {
    toggleOwnWords(draft, q);
    paint();
    // a tap goes on to the field; arrows through the options (radios.ts clicks them) and Space stay on the option
    if (ownWords(draft, q).on && ev.detail > 0) field.focus();
  } },
  h('span', { class: `ask-mark ask-mark-${role}`, 'aria-hidden': 'true' }),
  h('span', { class: 'ask-opt-text' }, ownName, ownDesc));
  const field = h('textarea', {
    class: 'input ask-own',
    'data-focus-key': `ask:${key}:words`,
    rows: 2,
    placeholder: 'Your answer',
    'aria-label': `Your own answer to: ${q.question}`,
    oninput: (ev: Event) => {
      setOwnWords(draft, q, (ev.target as HTMLTextAreaElement).value);
      paint();
    },
    // focus given back after a redraw lands after the words, not before them (a click still places the caret)
    onfocus: (ev: FocusEvent) => {
      const t = ev.target as HTMLTextAreaElement;
      t.setSelectionRange(t.value.length, t.value.length);
    },
    onkeydown: (ev: KeyboardEvent) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        void submit();
      }
    },
  }) as HTMLTextAreaElement;
  field.value = ownWords(draft, q).text;
  const group = h('div', { class: 'ask-opts', role: q.multi ? 'group' : 'radiogroup', 'aria-labelledby': textId }, ...options, own);
  paints.push(() => {
    const on = ownWords(draft, q).on;
    own.classList.toggle('is-on', on);
    own.setAttribute('aria-checked', String(on));
    field.hidden = !on;
    if (!q.multi) syncGroup(group);
  });
  const chips = [q.header ? h('span', { class: 'ask-chip' }, q.header) : null, of > 1 ? h('span', { class: 'ask-count' }, `${i + 1} of ${of}`) : null, q.multi ? h('span', { class: 'ask-count' }, 'Pick any') : null].filter(Boolean);
  return h(
    'section',
    { class: 'ask-q', 'aria-labelledby': textId },
    chips.length ? h('div', { class: 'ask-chips' }, ...chips) : null,
    h('p', { class: 'ask-text', id: textId }, q.question),
    group,
    field,
  );
}

/** A card: who asks, what for, and the answers. A / D answer it while focus is inside it (keyboard.ts) — never from
 *  elsewhere, so a stray letter can't approve a command; the key hints show only then. */
export function approvalCard(shell: Shell, a: ApprovalRequest, opts: { showProject?: boolean } = {}): HTMLElement {
  const agent = shell.store.state.agents[a.agentId];
  const project = shell.store.project(a.projectId);
  const who = agent?.name ?? 'Someone';
  // with the change shown, the file / content rows of omp's prompt only repeat it
  const detail = a.change && /^(Path|File)$/i.test(splitDetail(a.detail)?.label ?? '') ? null : splitDetail(a.detail);
  const job = approvalJob(shell, a);
  const several = !!job && shell.store.jobsOf(a.projectId).length > 1;
  const ctx = contextJob(shell);
  const elsewhere = !!job && !!ctx && (ctx.projectId !== a.projectId || ctx.room.floor !== job.room.floor);
  const pending = answering.has(a.id);
  // an agent's question (ask, an extension's choice or confirm) shows what it asks, in full
  const question = isQuestion(a);
  const ask = a.tool === 'ask';
  const answer = (opt: string) => {
    answerApproval(shell, a, opt);
    card.classList.add('is-answering');
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  };

  const optionButton = (opt: string) => {
    const kind = optionKind(opt);
    const hintKey = kind === 'approve' ? 'A' : kind === 'deny' ? 'D' : null;
    const label = kind === 'session' ? 'Allow for this session' : opt;
    return h(
      'button',
      {
        type: 'button',
        class: ['btn', 'btn-sm', kind === 'approve' ? 'btn-amber' : kind === 'deny' ? 'btn-ghost btn-deny' : 'btn-soft'],
        title: opt,
        disabled: pending,
        onclick: () => answer(opt),
      },
      label,
      hintKey ? h('span', { class: 'approval-key' }, kbd(hintKey)) : null,
    );
  };
  // a choice whose options are described: one row per option (label and description), a tap answers
  const notes = a.tool === 'choice' ? a.optionNotes : undefined;
  const describedRow = (opt: string, i: number) => {
    const name = h('span', { class: 'ask-opt-label' }, opt);
    const desc = notes?.[i] ? h('span', { class: 'ask-opt-desc' }, notes[i]) : null;
    return h('button', { type: 'button', class: 'ask-opt', disabled: pending, ...optionNames(name, desc), onclick: () => answer(opt) }, h('span', { class: 'ask-opt-text' }, name, desc));
  };
  const buttons = notes?.some(Boolean) ? [h('div', { class: 'ask-opts ask-picks' }, a.options.map(describedRow))] : a.options.map(optionButton);

  const body: (HTMLElement | null)[] = ask
    ? [askForm(shell, a, () => card)]
    : question
      ? [
          h('p', { class: 'ask-text approval-question' }, a.title),
          a.detail ? h('p', { class: 'approval-question-more' }, a.detail) : null,
          h('div', { class: 'approval-actions' }, buttons),
        ]
      : [
          detail ? h('div', { class: 'approval-detail' }, h('span', { class: 'approval-detail-label' }, detail.label), h('pre', null, wordBoxes(detail.body))) : null,
          // omp says nothing but the tool's name (eval's own tools, e.g. browser): the step whose code calls it
          !detail && a.from
            ? h('div', { class: 'approval-detail' }, h('span', { class: 'approval-detail-label' }, originLabel(a.from)), h('pre', null, a.from.code))
            : null,
          !detail && !a.from && !a.change ? h('p', { class: 'approval-none' }, 'No details came with this request.') : null,
          a.change ? changeBlock(shell, a, a.change, who) : null,
          h('div', { class: 'approval-actions' }, buttons),
        ];

  const card: HTMLElement = h(
    'article',
    { class: ['approval', pending && 'is-answering', a.change && 'has-change', question && 'is-question'], 'aria-label': question ? `${who} asks you` : `${who} needs your approval`, 'data-approval-id': a.id },
    h(
      'header',
      { class: 'approval-head' },
      h('span', { class: 'approval-hand' }, icon('hand', 15)),
      h(
        'div',
        { class: 'approval-titles' },
        h(
          'p',
          { class: 'approval-title' },
          several && job ? codeBadge(job, 'sm') : null,
          h('button', { type: 'button', class: 'link-btn', onclick: () => goToRequest(shell, a) }, who),
          ...(question ? [' asks'] : [` wants to use `, h('code', null, a.tool)]),
        ),
        h(
          'p',
          { class: 'approval-meta' },
          agent ? avatar(agent.name, agent.vendor, 'xs') : null,
          several && job
            ? h('button', { type: 'button', class: 'link-btn approval-job', title: `Show ${job.name}`, onclick: () => {
                if (shell.view.view === 'house' && shell.view.projectId !== a.projectId) shell.enterProject(a.projectId);
                shell.selectJob(a.projectId, job.id, { focus: true, openPanel: true });
              } }, job.name)
            : null,
          several && job && elsewhere && ctx?.projectId === a.projectId ? h('span', { class: 'approval-floor' }, floorName(job.room.floor)) : null,
          // inside that project's house its name says nothing new (and crowds out the room); elsewhere it takes you
          // there — house, job and chat — so breadcrumb, panel and 3D agree on whose request this is
          opts.showProject !== false && project && ctx?.projectId !== a.projectId
            ? h('button', { type: 'button', class: 'link-btn approval-project', title: `Go to ${project.name}${job ? ` · ${job.name}` : ''}`, onclick: () => goToRequest(shell, a) }, project.name)
            : null,
          liveAgo(a.ts),
        ),
      ),
    ),
    a.autoReason ? h('p', { class: 'approval-auto' }, icon('wand', 13), h('span', null, `Auto mode left this to you: ${a.autoReason}.`)) : null,
    ...body,
    canAskToNotify()
      ? h(
          'button',
          {
            type: 'button',
            class: 'link-btn approval-notify',
            onclick: async (ev: MouseEvent) => {
              const btn = ev.currentTarget as HTMLElement;
              const ok = await askToNotify();
              btn.remove();
              shell.toast(ok ? 'success' : 'info', ok ? 'You’ll get a notification when someone needs you while CAST is in the background.' : 'Notifications stay off — the bell and the tab title still show who is waiting.');
            },
          },
          icon('bell', 13),
          'Notify me when someone needs me',
        )
      : null,
  );
  // a card taller than its scroll box keeps its head, then the change's file row, stuck at the top (mobile.css,
  // hud.css): the row sits right under the head, so it needs the head's height (the title can wrap)
  if (a.change && typeof ResizeObserver === 'function') {
    const head = card.querySelector<HTMLElement>('.approval-head')!;
    new ResizeObserver(() => card.style.setProperty('--apv-head', `${head.offsetHeight}px`)).observe(head);
  }
  return card;
}

export function createApprovalStack(shell: Shell, isShownElsewhere: (a: ApprovalRequest) => boolean) {
  // Not a live region: re-rendering would read the whole card again; new requests are announced once (announce.ts).
  const el = h('section', { class: 'approval-stack', 'aria-label': 'Waiting for your approval' });
  let top: ApprovalRequest | undefined;
  const changed = memo();

  // The job being looked at comes first, then the oldest.
  const ordered = () =>
    Object.values(shell.store.state.approvals)
      .filter((a) => !answering.has(a.id))
      .map((a) => ({ a, mine: inContext(shell, a) }))
      .sort((x, y) => Number(y.mine) - Number(x.mine) || x.a.ts - y.a.ts)
      .map((x) => x.a);

  function render() {
    const all = ordered();
    const shown = all.filter((a) => !isShownElsewhere(a));
    top = shown[0];
    const ctx = contextJob(shell);
    if (!changed([shown.map((a) => a.id), all.length, ctx?.projectId, ctx?.id, shown.map((a) => approvalJob(shell, a)?.name)])) return;
    if (!top) {
      setChildren(el);
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const rest = shown.length - 1;
    setChildren(el,
      rest > 0 ? h('div', { class: 'approval-peek', 'aria-hidden': 'true' }) : null,
      h('div', { class: 'approval-front glass-strong' }, approvalCard(shell, top)),
      rest > 0
        ? h('button', { type: 'button', class: 'approval-more', onclick: () => shell.openPanel('inbox', inboxScope(shell.view)) }, `${rest} more waiting`, icon('chevronRight', 13))
        : null,
    );
  }

  return {
    el,
    render,
    /** Keyboard: A / D on a focused card (any card: the stack's, the chat's, the inbox's). Returns true when handled. */
    answer(approvalId: string, kind: 'approve' | 'deny'): boolean {
      const target = shell.store.state.approvals[approvalId];
      if (!target || answering.has(target.id)) return false;
      const value = kind === 'approve' ? approveOption(target) : denyOption(target);
      if (!value) return false;
      answerApproval(shell, target, value);
      render();
      return true;
    },
    get visible() {
      return !el.hidden;
    },
  };
}
