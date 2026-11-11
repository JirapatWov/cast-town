// Chat tab: people strip, agent header (cost, how full the context is), the lead's goal bar, live transcript and
// composer for one person. Images dropped anywhere on the tab go into the composer.
import type { AgentInfo, ImageRef, ServerMsg, TranscriptItem, WorkflowRun } from '../../../shared/protocol';
import { RequestError } from '../net/requests';
import { approvalCard } from './approvals';
import { openImage } from './attachments';
import { agentsState, blockOpts } from './agents-health';
import { chatIcon } from './chat-icons';
import { createComposer, type ComposerDraft, type ComposerSend } from './composer';
import { copyText, h, memo, setChildren } from './dom';
import { accountChip, accountChipKey, watchAccountChips } from './account-chip';
import { effortChip, openEffortMenu } from './effort-chip';
import { OFF_DUTY_HINT, agentBlocked, agentStatusText, agentTone, anyConnected, fmtTokens, fmtUsd, isAgentBusy, timeAgo } from './format';
import { chatSuggestions, workKindOf } from './suggestions';
import { createGoalBar } from './goal-bar';
import { helperCard, openHelperViewer } from './helper-viewer';
import { icon } from './icons';
import { wireCodeCopy } from './markdown';
import { MAIN_JOB, jobRoomCode } from './jobs';
import { chipOwner, openModelMenu, personModelChip } from './model-chip';
import { cyclePermissionMode, permissionChip } from './permissions';
import { createFirstChatNote } from './first-chat';
import { planView } from './plan-card';
import { pendingPlans } from './plans';
import type { Shell } from './shell';
import { createChatFind } from './chat-find';
import { createThreadBar } from './thread-bar';
import { lockingRun } from './runs';
import { rosterOf } from './roster';
import { fileLinks } from './file-links';
import { createItemView, type HelperItem, type ItemView } from './transcript';
import { turnChangesCard } from './turn-changes';
import { isPhoneBoard, pointWord } from './touch';
import { agentAvatar, agentModelChip, emptyState, statusDot } from './widgets';

const STICKY_PX = 48;
/** How long a message whose send looked failed is looked for in the chat (see Unsure). */
const UNSURE_MS = 120_000;

/** A message that went out but whose answer never came (the connection dropped, or no answer in time): the
 *  server may have it anyway. The box keeps it until its bubble or chip shows up (then it leaves the box) or the
 *  chat, reloaded after the connection came back, shows it never arrived. */
interface Unsure {
  agentId: string;
  text: string;
  images: ImageRef[];
  items: Set<string>; // the person's user bubbles when it was sent
  chips: Set<string>; // and their queue chips
  until: number;
}

/** The server trims and may cut a long text ("…"); a chip shows at most 300 characters. */
function sameText(shown: string, sent: string): boolean {
  const a = shown.trim();
  return a === sent || (a.endsWith('…') && sent.startsWith(a.slice(0, -1)));
}

/** A send a Stop called off before it went (not an error: nothing to say, the box keeps the words). */
const CALLED_OFF = new Error('called off');

export function createChatTab(shell: Shell) {
  const { store } = shell;
  let agentId: string | null = null;
  let views = new Map<string, ItemView>();
  const peopleChanged = memo();
  const headChanged = memo();
  const composerChanged = memo();
  const inlineChanged = memo();

  const people = h('div', { class: 'people', role: 'tablist', 'aria-label': 'People in this job' });
  const head = h('div', { class: 'agent-head' });
  const threads = createThreadBar(shell, { onCompacting: () => renderComposer(), onFind: (q) => find.open(q) });
  const list = h('div', { class: 'transcript-list' });
  const inline = h('div', { class: 'chat-inline-approvals' });
  const scroller = h('div', { class: 'transcript', tabindex: '0', 'aria-label': 'Conversation', 'aria-live': 'polite' }, list, inline);
  const jump = h('button', { type: 'button', class: 'jump-latest', hidden: true, onclick: () => scrollToEnd(true) }, icon('arrowDown', 14), 'Latest');
  const find = createChatFind({ shell, scroller, list, items: () => (agentId ? (store.state.transcripts[agentId] ?? []) : []), view: (id) => views.get(id) });
  const firstChat = createFirstChatNote(shell, () => store.project(agent()?.projectId));
  const composer = createComposer({
    async onSend(msg) {
      // Always the person the box showed when Send was pressed — the chat may show someone else by now (the message
      // waited for the one before it, or the user moved on while it went).
      const id = msg.to;
      if (!id) throw new Error('Nobody to send to');
      if (id === agentId) scrollToEnd(true);
      const u: Unsure = {
        agentId: id,
        text: msg.text,
        images: msg.images,
        items: new Set((store.state.transcripts[id] ?? []).filter((it) => it.kind === 'user').map((it) => it.id)),
        chips: new Set((store.state.agents[id]?.queue ?? []).map((q) => q.key)),
        until: 0,
      };
      onWire.set(msg, u);
      try {
        const data = await store.request<{ calledOff?: boolean } | undefined>({
          t: 'prompt',
          reqId: '',
          agentId: id,
          text: msg.text,
          ...(msg.images.length ? { images: msg.images.map((r) => r.id) } : {}),
          ...(msg.mode ? { mode: msg.mode } : {}),
        });
        // Stop came while their omp was starting: it never went, so the box keeps it (Stop's own answer brings the
        // same words back, and the box doesn't take them twice)
        if (data?.calledOff) throw CALLED_OFF;
      } catch (err) {
        // Called off by Stop: the composer keeps the words (Stop's own answer brings the same ones; never twice).
        if (err === CALLED_OFF) throw err;
        // The composer puts the message back into this person's draft (their box, wherever the chat is now).
        const name = whoOf(id);
        const where = id === agentId ? 'It’s back in the box.' : `It’s back in ${name}’s chat box.`;
        const open = id === agentId || !store.state.agents[id] ? undefined : () => shell.openAgent(id);
        if (err instanceof RequestError && err.unsure) {
          if (arrived(u)) return; // its bubble or chip is there already: sent
          unsure = { ...u, until: Date.now() + UNSURE_MS };
          shell.toast(
            'warn',
            store.state.connected
              ? `No answer about your message to ${name} — it may have reached them. ${where} Check the chat before sending it again.`
              : `Lost the connection while sending to ${name} — it may have reached them. ${where} CAST takes it out again if it shows up in the chat.`,
            { agentId: id, onClick: open },
          );
          throw err;
        }
        // their omp couldn't start: the chat shows the message "Not sent" with Retry and says why (the server
        // toasts it too) — no second copy in the box, no second toast
        if (markedNotSent(id, msg.text, u.items)) return;
        shell.toast('error', `Couldn’t send that to ${name}: ${(err as Error).message} ${where}`, { agentId: id, onClick: open });
        throw err;
      } finally {
        onWire.delete(msg);
      }
    },
    onAbort() {
      const id = agentId;
      if (!id) return;
      // The messages it hadn't read yet come back into the box (Stop throws them out of omp's queue).
      store
        .request<{ restored?: Partial<ComposerDraft>[] } | undefined>({ t: 'abort', reqId: '', agentId: id })
        .then((data) => giveBack(id, data?.restored ?? []))
        .catch((err: Error) => shell.toast('error', `Could not stop: ${err.message}`, { agentId: id }));
    },
    async onQueueAction(key, action) {
      const id = agentId;
      if (!id) return;
      const data = await store.request<Partial<ComposerDraft> | undefined>({ t: 'queue_action', reqId: '', agentId: id, key, action });
      if (action === 'remove' && data) giveBack(id, [data]);
    },
    onCycleMode() {
      const project = agentId ? store.project(store.state.agents[agentId]?.projectId) : undefined;
      if (project) cyclePermissionMode(shell, project);
    },
    onChipKey(which) {
      const a = agent();
      const anchor = composer.modeSlot.querySelector<HTMLElement>(`[data-chip="${which}"]`);
      if (!a || !anchor) return false; // no chip for this person (a helper)
      (which === 'model' ? openModelMenu : openEffortMenu)(shell, a, anchor, () => composer.focus());
      // Opened from the box, so closing it (Esc too) goes back to the box, not the chip: the next letters typed would
      // otherwise reach the global shortcuts (A approves, D denies…).
      const id = `chip-${which}`;
      const back = () => {
        if (shell.layers.has(id)) return void requestAnimationFrame(back);
        const at = document.activeElement;
        if (!at || at === document.body || at === anchor) composer.focus();
      };
      requestAnimationFrame(back);
      return true;
    },
    notify: (level, text) => shell.toast(level, text, agentId ? { agentId } : undefined),
    hold: (send) => firstChat.hold(send),
    // Board on a phone: a bubble and a "Sending…" chip with the same words read as two messages
    shown: (msg) => {
      const u = onWire.get(msg);
      return !!u && isPhoneBoard(shell.focusMode) && arrived(u);
    },
  });
  let unsure: Unsure | null = null;
  /** Messages on the wire (sent, the server's answer not back yet), with what the chat held when each went. */
  const onWire = new Map<ComposerSend, Unsure>();
  /** A person's name as the user knows them: every job's lead is "Assistant", so the job is added when it matters. */
  function whoOf(id: string): string {
    const a = store.state.agents[id];
    if (!a) return 'them';
    const job = a.jobId ? store.job(a.projectId, a.jobId) : undefined;
    const other = a.projectId !== agent()?.projectId;
    const project = other ? store.project(a.projectId)?.name : undefined;
    const label = job && store.jobsOf(a.projectId).length > 1 ? `${a.name} (${job.name})` : a.name;
    return project ? `${label} in ${project}` : label;
  }
  /** Its bubble or chip showed up since it was sent (the server shows it as soon as it has it). */
  function arrived(u: Unsure): boolean {
    const imgs = u.images.map((r) => r.id).join();
    const bubble = (store.state.transcripts[u.agentId] ?? []).some(
      (it) => it.kind === 'user' && !u.items.has(it.id) && sameText(it.text, u.text) && (it.images ?? []).map((r) => r.id).join() === imgs,
    );
    return bubble || (store.state.agents[u.agentId]?.queue ?? []).some((q) => q.by === 'user' && !u.chips.has(q.key) && q.images === u.images.length && sameText(q.text, u.text));
  }
  // Watched whichever tab shows: the answer comes with the reconnect.
  store.subscribe((_s, msg) => {
    const u = unsure;
    if (!u || !msg) return;
    if (Date.now() > u.until) {
      unsure = null;
      return;
    }
    const about =
      msg.t === 'transcript_upsert' || msg.t === 'transcript_reset' ? msg.agentId === u.agentId : msg.t === 'agent' ? msg.agent.id === u.agentId : msg.t === 'snapshot';
    if (!about) return;
    const name = store.state.agents[u.agentId]?.name ?? 'them';
    if (arrived(u)) {
      unsure = null;
      const out = composer.forget({ text: u.text, images: u.images }, u.agentId);
      shell.toast('info', out ? `Your message did reach ${name} — it’s out of the box again.` : `Your message did reach ${name}.`, { agentId: u.agentId });
    } else if (msg.t === 'transcript_reset' && store.state.connected) {
      // their chat as the server has it now (reloaded once the connection came back): it never got there
      unsure = null;
      shell.toast('info', `Your message didn’t reach ${name} — it’s in their chat box. Send it again when you’re ready.`, { agentId: u.agentId });
    }
  });
  // A message on the wire whose bubble or chip just showed up: its "Sending…" chip goes (composer `shown`).
  store.subscribe((_s, msg) => {
    if (!onWire.size || !msg) return;
    if (msg.t === 'transcript_upsert' || msg.t === 'transcript_reset' || msg.t === 'agent' || msg.t === 'snapshot') composer.refreshQueue();
  });

  // Messages taken back (Stop, a queue chip's ×) belong in the draft of the person they were sent to. The answer may
  // come after the chat moved on to someone else: then they go into that person's draft (the box when they're back).
  function giveBack(id: string, raw: Partial<ComposerDraft>[]) {
    const drafts = raw.map((d) => ({ text: d.text ?? '', images: d.images ?? [] })).filter((d) => d.text.trim() || d.images.length);
    if (!drafts.length) return;
    if (id === agentId) {
      for (const d of drafts) composer.restore(d);
      return;
    }
    if (!store.state.agents[id]) return lostDrafts(drafts);
    for (const d of drafts) composer.restore(d, id);
    const what = drafts.length === 1 ? 'Your unsent message' : `Your ${drafts.length} unsent messages`;
    shell.toast('info', `${what} to ${whoOf(id)} ${drafts.length === 1 ? 'is' : 'are'} back in their chat box.`, { agentId: id, onClick: () => shell.openAgent(id) });
  }
  /** Nobody to give them back to (the person left): the toast keeps the words (and the inbox's history). */
  function lostDrafts(drafts: ComposerDraft[]) {
    const what = drafts.length === 1 ? 'Your unsent message' : `Your ${drafts.length} unsent messages`;
    const text = drafts.map((d) => d.text.trim()).filter(Boolean).join(' / ');
    shell.toast('warn', `${what} couldn’t go back into the chat box — that person has left${text ? `: “${text.length > 200 ? `${text.slice(0, 200)}…` : text}”` : '.'}`);
  }

  const modeChanged = memo();
  const goalBar = createGoalBar(shell);
  const dropNote = h('div', { class: 'chat-drop', 'aria-hidden': 'true' });
  const el = h('div', { class: 'tab-chat' }, people, head, threads.el, find.el, goalBar.el, h('div', { class: 'transcript-wrap' }, scroller, jump), firstChat.el, composer.el, dropNote);
  wireCodeCopy(list, copyText);
  // Ctrl/⌘+F in the chat finds in the chat (the browser's find can't open folded tool cards, and phones have none)
  el.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.code === 'KeyF' && agentId) {
      ev.preventDefault();
      find.open();
    }
  });

  // Images dropped anywhere on the chat go into the composer.
  let dragDepth = 0;
  const hasFiles = (ev: DragEvent) => !!ev.dataTransfer?.types.includes('Files');
  const endDrag = () => {
    dragDepth = 0;
    el.classList.remove('is-drop');
  };
  el.addEventListener('dragenter', (ev) => {
    if (!hasFiles(ev) || !agentId) return;
    ev.preventDefault();
    if (dragDepth++ === 0) {
      const a = agent();
      const why = a ? (closedWhy(a) ?? imagesBlocked(a)) : undefined;
      setChildren(dropNote, why ? icon('alert', 20) : chatIcon('image', 20), h('span', null, why ?? 'Drop images to attach them'));
      el.classList.toggle('is-blocked', !!why);
      el.classList.add('is-drop');
    }
  });
  el.addEventListener('dragover', (ev) => {
    if (!hasFiles(ev) || !agentId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', (ev) => {
    if (!hasFiles(ev)) return;
    if (--dragDepth <= 0) endDrag();
  });
  el.addEventListener('drop', (ev) => {
    if (!hasFiles(ev) || !agentId) return;
    ev.preventDefault();
    endDrag();
    if (ev.dataTransfer?.files.length) composer.addFiles(ev.dataTransfer.files);
  });

  // Whether the chat follows its end. Measured while it shows; another tab (or a closed panel) hides it, where nothing
  // can be measured or scrolled: then items that arrive keep the last answer, and the scroll waits until it shows.
  let follow = true;
  let owed = false;
  const nearBottom = () => (scroller.clientHeight ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICKY_PX : follow);
  function scrollToEnd(smooth = false) {
    follow = true;
    jump.hidden = true;
    owed = !scroller.clientHeight;
    if (!owed) scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
  // Only moving up (the user) stops following: a scroll event comes a frame late, and one from our own scrollToEnd can
  // land after the chat was squeezed (goal bar, queue chips) — it would read as "scrolled up".
  let lastTop = 0;
  scroller.addEventListener('scroll', () => {
    if (!scroller.clientHeight) return;
    const up = scroller.scrollTop < lastTop - 1;
    lastTop = scroller.scrollTop;
    follow = up ? nearBottom() : follow || nearBottom();
    if (follow) jump.hidden = true;
  });
  // Shown again: catch up with what arrived meanwhile (the "Latest" button already shows when the user had scrolled up).
  // Also when the composer grows (thumbnails, queue chips) and squeezes the chat: a chat that followed its end keeps
  // following, else the next item would see it "scrolled up" and stop.
  new ResizeObserver(() => {
    if ((owed || follow) && scroller.clientHeight) scrollToEnd();
  }).observe(scroller);
  // A bubble image that loads late grows the chat after it scrolled (load doesn't bubble: capture it).
  list.addEventListener('load', () => {
    if (follow && scroller.clientHeight) scrollToEnd();
  }, true);

  function agent(): AgentInfo | undefined {
    return agentId ? store.state.agents[agentId] : undefined;
  }

  /** Helpers this person started that are still at it (a lead stays free to talk meanwhile). */
  function helpersWorking(a: AgentInfo): number {
    return Object.values(store.state.agents).filter((x) => x.kind === 'subagent' && x.parentId === a.id && isAgentBusy(x) && x.activity !== 'done').length;
  }

  /** The active run this person is on: they work for the run, so chatting waits until it ends. */
  function teamRunOf(a: AgentInfo): WorkflowRun | undefined {
    return lockingRun(a, Object.values(store.state.runs));
  }

  function leadOf(a: AgentInfo): AgentInfo | undefined {
    const job = a.jobId ?? MAIN_JOB;
    return Object.values(store.state.agents).find((x) => x.roleId === 'assistant' && x.kind !== 'subagent' && x.projectId === a.projectId && (x.jobId ?? MAIN_JOB) === job);
  }

  /** The person's model isn't connected, so the server won't start them (format.ts agentBlocked). */
  function blockedNow(a: AgentInfo): boolean {
    return agentBlocked(a, store.state.models, blockOpts(store.state.hello));
  }

  /** Why the box is closed to this person (undefined → open): on an active run's team, or on a model that isn't
   *  connected — the same tests as renderComposer's lock. */
  function closedWhy(a: AgentInfo): string | undefined {
    const run = teamRunOf(a);
    if (run) return `${a.name} is on the team’s “${run.workflowName}” run — chat after it finishes`;
    if (blockedNow(a)) {
      const st = agentsState(store.state.hello).kind;
      if (st === 'check-failed') return 'CAST couldn’t check your AI accounts';
      return anyConnected(store.state.models) ? `${a.modelLabel} isn’t connected` : 'No AI account is connected';
    }
    return undefined;
  }

  /** Why this person can't take images (undefined → they can): helpers take text only; else their model decides. */
  function imagesBlocked(a: AgentInfo): string | undefined {
    if (a.kind === 'subagent') return 'Helpers take text only';
    return store.state.models.find((m) => m.id === a.model)?.images ? undefined : `${a.modelLabel} can’t see images`;
  }

  /** A helper person's card in its lead's chat (the "Whole chat" button opens it). */
  const askedLead = new Set<string>();
  function helperItemOf(a: AgentInfo): HelperItem | undefined {
    if (a.kind !== 'subagent' || !a.parentId) return undefined;
    const found = store.state.transcripts[a.parentId]?.find((it): it is HelperItem => it.kind === 'helper' && it.agentId === a.id);
    // The lead's chat may not be loaded here (or only its newest items): fetch it once.
    if (!found && !askedLead.has(a.id) && store.state.agents[a.parentId]) {
      askedLead.add(a.id);
      store.send({ t: 'get_transcript', agentId: a.parentId });
    }
    return found;
  }

  /** "Context 34%" with a thin bar: amber from 70 %, red from 90 %; muted with "last seen" when it's not live. */
  function contextMeter(a: AgentInfo): HTMLElement | null {
    const c = a.context;
    if (!c || !c.window) return null;
    const pct = Math.max(0, Math.min(100, c.percent));
    const label = pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
    const title =
      `How full ${a.name}’s working memory for this chat is: ${fmtTokens(c.tokens)} of ${fmtTokens(c.window)} tokens (a token is about ¾ of a word)` +
      (c.live ? '' : ` — last seen ${timeAgo(c.at)}, before ${a.name} went off duty`) +
      '. It is tidied up by itself when it gets near full; Compact (above the chat) does it now.';
    return h(
      'div',
      { class: ['ctx-meter', pct >= 90 ? 'is-full' : pct >= 70 && 'is-high', !c.live && 'is-stale'], title, role: 'img', 'aria-label': `Context ${label} full${c.live ? '' : ' (last seen)'}` },
      h('span', { class: 'ctx-label num' }, c.live ? `Context ${label}` : `Context ~${label} · last seen`),
      h('span', { class: 'ctx-bar' }, h('span', { style: { width: `${pct}%` } })),
    );
  }

  /** The roster is the job of whoever we're talking to (each job is its own room of people). */
  function roster(a: AgentInfo | undefined): AgentInfo[] {
    const projectId = a?.projectId ?? shell.contextProjectId();
    if (!projectId) return [];
    const jobId = a?.jobId ?? shell.jobs.active(projectId)?.id;
    return jobId && store.jobsOf(projectId).length ? store.agentsOfJob(projectId, jobId) : store.agentsOf(projectId);
  }

  function renderPeople() {
    const a = agent();
    const all = rosterOf(roster(a), Object.values(store.state.runs));
    if (!peopleChanged([agentId, all.map(({ agent: p, label }) => [p.id, label, agentTone(p), p.modelLabel])])) return;
    setChildren(people,
      ...all.map(({ agent: p, label, run }) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(p.id === agentId),
            class: ['person', p.id === agentId && 'is-on', p.kind === 'subagent' && 'is-helper', run && 'is-run'],
            title: `${label} · ${p.modelLabel}${run ? ` · here for the “${run.workflowName}” run, leaves when it ends` : ''}`,
            onclick: () => shell.openAgent(p.id),
          },
          agentAvatar(p, 'sm'),
          h('span', { class: 'person-name' }, label),
        ),
      ),
    );
    people.hidden = all.length < 2;
  }

  function renderHead() {
    const a = agent();
    renderMode();
    renderComposer();
    const helpers = a?.available ? helpersWorking(a) : 0;
    const helperItem = a ? helperItemOf(a) : undefined;
    const blocked = a ? blockedNow(a) : false;
    if (!headChanged([a, helpers, store.state.connected, blocked, anyConnected(store.state.models), helperItem?.id])) return;
    if (!a) {
      setChildren(head);
      return;
    }
    const tokens = a.tokens ? a.tokens.input + a.tokens.output : 0;
    const tone = agentTone(a);
    setChildren(head,
      agentAvatar(a, 'lg'),
      h(
        'div',
        { class: 'agent-id' },
        h(
          'div',
          { class: 'agent-name-row' },
          h('h3', { class: 'agent-name' }, a.name),
          a.kind === 'subagent' ? h('span', { class: 'chip' }, 'helper') : null,
          helperItem && a.parentId
            ? h(
                'button',
                { type: 'button', class: 'agent-whole', title: `${a.name}’s whole chat so far (what you see here is a live summary)`, onclick: () => openHelperViewer(shell, a.parentId!, helperItem.id) },
                icon('chat', 12),
                'Whole chat',
              )
            : null,
        ),
        h('div', { class: 'agent-model' }, h('span', null, a.modelLabel), agentModelChip(a, store.state.models, blockOpts(store.state.hello))),
        h('div', { class: ['agent-status', `tone-${tone}`], title: a.status === 'offline' ? OFF_DUTY_HINT : undefined }, tone === 'work' ? h('span', { class: 'spinner spinner-sm' }) : statusDot(tone), h('span', null, agentStatusText(a, helpers))),
      ),
      h(
        'div',
        { class: 'agent-cost' },
        h('span', { class: 'num', title: `Spent: ${fmtUsd(a.costUsd)}` }, fmtUsd(a.costUsd)),
        h(
          'span',
          { class: 'muted small num', title: 'Tokens: how much text the model has read and written for this person (a token is about ¾ of a word). Providers bill by them.' },
          tokens ? `${fmtTokens(tokens)} tokens` : 'no tokens yet',
        ),
        contextMeter(a),
      ),
    );
  }

  /** Busy with a turn → Stop; busy only with background helpers → free to talk; on an active run's team → closed;
   *  on a model that isn't connected → closed, with where to fix it: connect a first AI account (none is), wait for a
   *  check that works (it failed), or sign in to this model's provider / pick another (another account is). */
  function renderComposer() {
    const a = agent();
    const run = a ? teamRunOf(a) : undefined;
    const lead = a && (run || a.kind === 'role') ? leadOf(a) : undefined;
    const out = a ? helpersWorking(a) : 0;
    const blocked = a ? blockedNow(a) : false;
    const plan = a ? pendingPlans(store.state).find((p) => p.agentId === a.id) : undefined;
    const noImages = a ? imagesBlocked(a) : undefined;
    const compacting = threads.isCompacting(a);
    const connected = store.state.connected;
    const health = agentsState(store.state.hello).kind;
    const ompMissing = health === 'omp-missing';
    const checkFailed = health === 'check-failed';
    const none = !anyConnected(store.state.models);
    if (!composerChanged([a?.id, a?.name, a?.status, a?.available, a?.modelLabel, out, connected, run?.id, run?.workflowName, lead?.id, lead?.name, blocked, none, checkFailed, plan?.id, noImages, a?.queue, compacting, ompMissing])) return;
    if (!a) {
      composer.setTarget(null);
      return;
    }
    const helpers = !compacting && a.status === 'busy' && !!a.available; // same test as agentStatusText's "Free to talk"
    const onRun = run ? `${a.name} is on the team's “${run.workflowName}” run — chat after it finishes.` : '';
    const link = (label: string, title: string, onclick: () => void) => h('button', { type: 'button', class: 'link-btn', title, onclick }, label);
    composer.setTarget({
      id: a.id,
      name: a.name,
      // A Compact takes no message and no Stop (omp works on it alone): the box waits, no queue, no Send now.
      busy: !compacting && isAgentBusy(a) && (!helpers || !!run), // on a run the box is locked: keep the big Stop, not "Stop helpers"
      wait: compacting ? `${a.name} is compacting the chat — you can send again in a moment.` : undefined,
      helpers,
      helpersOut: out,
      offline: !store.state.connected,
      canSteer: a.kind !== 'subagent', // helpers only take a nudge (steer_subagent): no queue to manage
      noImages,
      queue: a.queue,
      // the lead's turn waits for the card; a new message answers it instead (the server cancels the plan)
      note: plan ? h('span', null, 'Run or cancel the plan above — or write what you want instead.') : undefined,
      // offline first: what the client knows about models and omp may be out of date (the composer says it's offline)
      locked: !connected
        ? undefined
        : ompMissing
          ? {
              placeholder: 'The agent isn’t built…',
              why: 'the agent isn’t built',
              hint: h('span', null, 'Nobody can work until the agent (cast-agent) is built — ', link('how to build it', 'Open Models & providers', () => shell.openProviders()), '.'),
            }
          : run
        ? {
            placeholder: `${a.name} is on the team run…`, // the hint below says the rest
            why: closedWhy(a),
            hint: h(
              'span',
              null,
              `${onRun} Ask `,
              lead ? link(`the ${lead.name}`, `Chat with ${lead.name}`, () => shell.openAgent(lead.id)) : 'the lead',
              ' how the team is doing.',
            ),
          }
        : blocked && checkFailed
          ? {
              placeholder: 'Waiting for a check of your AI accounts…',
              why: closedWhy(a),
              hint: h('span', null, 'Nobody can work until a check works — CAST tries again by itself, or press Refresh in ', link('Models & providers', 'Open Models & providers', () => shell.openProviders()), '.'),
            }
        : blocked && none
          ? {
              placeholder: 'Connect an AI account to start…',
              why: closedWhy(a),
              hint: h('span', null, 'Nobody can work until CAST has an AI account — connect one in ', link('Models & providers', 'Open Models & providers', () => shell.openProviders()), '.'),
            }
        : blocked
          ? {
              placeholder: `${a.modelLabel} isn’t connected…`,
              why: closedWhy(a),
              hint: h(
                'span',
                null,
                `${a.name} uses ${a.modelLabel}, which isn’t connected — sign in under `,
                link('Models & providers', 'Open Models & providers', () => shell.openProviders()),
                ...(a.kind === 'resident' || a.roleId === 'assistant'
                  ? [', or pick another model in the job menu → ', link('Edit job…', 'Change the lead’s model', () => a.jobId && shell.editJob(a.projectId, a.jobId, 'edit')), '.']
                  : a.kind === 'role'
                    ? [
                        ', or change the team in the ',
                        link('Workflow tab', 'Open the Workflow tab', () => shell.openWorkflow(a.projectId)),
                        ' or ask ',
                        lead ? link(`the ${lead.name}`, `Chat with ${lead.name}`, () => shell.openAgent(lead.id)) : 'the lead',
                        '.',
                      ]
                    : ['.']),
              ),
            }
          : undefined,
    });
  }

  /** The chips under the box: the permission mode follows the person's house (its changes arrive as `city`); model and
   *  effort follow the person, their job (lead) or workflow step (team member); the account follows their chat. */
  function renderMode() {
    const a = agent();
    const project = a ? store.project(a.projectId) : undefined;
    const owner = a ? chipOwner(shell, a) : null;
    const s = store.state;
    const key = [
      project?.id, project?.approvalMode, project?.name,
      a && [a.id, a.name, a.model, a.modelLabel, a.thinking, a.modelBy, a.projectId],
      owner?.by === 'job' ? [owner.job.id, owner.job.name, owner.job.leadModel, owner.job.leadThinking] : owner ? [owner.workflow?.name, owner.step?.thinking] : null,
      owner ? [s.models, blockOpts(s.hello)] : null,
      accountChipKey(shell, a),
    ];
    if (!modeChanged(key)) return;
    setChildren(composer.modeSlot,
      project ? permissionChip(shell, project) : null,
      a ? personModelChip(shell, a) : null,
      a ? effortChip(shell, a) : null,
      a ? accountChip(shell, a) : null,
    );
  }
  watchAccountChips(shell, () => renderMode());

  function renderInlineApprovals() {
    const all = Object.values(store.state.approvals).sort((a, b) => a.ts - b.ts);
    const mine = all.filter((x) => x.agentId === agentId);
    if (!inlineChanged([agentId, mine.map((x) => x.id)])) return;
    setChildren(inline, ...mine.map((x) => approvalCard(shell, x, { showProject: false })));
  }

  /** Whether the empty chat shown now was drawn for a locked person (an 'agent' update that changes it redraws it). */
  let emptyBlocked: boolean | null = null;

  function renderEmpty(a: AgentInfo) {
    const job = a.jobId ? store.job(a.projectId, a.jobId) : undefined;
    // locked because the model isn't connected: the way to connect one instead of things to say that can't be sent
    const blocked = blockedNow(a) && !teamRunOf(a);
    emptyBlocked = blocked;
    const tips = blocked ? [] : chatSuggestions(a, workKindOf({ jobKind: job?.kind }));
    const st = agentsState(store.state.hello).kind;
    // nothing connected after a check that worked: connect one; omp missing or a failed check: Models & providers says why
    const none = st === 'ok' && !anyConnected(store.state.models);
    const connect = blocked
      ? h('div', { class: 'suggestions' }, h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => shell.openProviders() }, icon('key', 14), none ? 'Connect an AI account' : 'Models & providers'))
      : null;
    const where = job && store.jobsOf(a.projectId).length > 1 ? `“${job.name}” (room ${jobRoomCode(job)})` : store.project(a.projectId)?.name ?? 'this project';
    const until =
      st === 'omp-missing' ? 'the agent is built' : st === 'check-failed' ? 'a check of your AI accounts works' : none ? 'an AI account is connected' : `${a.modelLabel} is connected — or pick another model`;
    const lead = a.kind === 'resident' || a.roleId === 'assistant' || a.kind === 'subagent';
    setChildren(list,
      emptyState(
        'chat',
        `Say hi to ${a.name}`,
        blocked
          ? lead
            ? `They work on ${where} once ${until}.`
            : `${a.name} gets tasks from the team run, and you can talk to them too, once ${until}.`
          : lead
            ? shell.focusMode
              ? `They work on ${where}. Ask a question or give them a task — they answer right here.`
              : `They work on ${where}. Ask a question or give them a task — you will see them walk to a station and get to work.`
            : `${a.name} usually gets tasks from the team run, but you can talk to them directly too.`,
        connect ??
          (tips.length
            ? h('div', { class: 'suggestions' }, tips.map((t) => h('button', { type: 'button', class: 'suggestion', onclick: () => composer.setText(t) }, t)))
            : null),
      ),
    );
  }

  /** Redraw the empty chat (its room name, its suggestions or the way to connect an account); a chat with items or
   *  still loading is left alone. */
  function refreshEmpty() {
    const a = agent();
    if (a && store.state.transcripts[a.id] && !store.state.transcripts[a.id]!.length) renderEmpty(a);
  }

  function rebuildTranscript() {
    const a = agent();
    views = new Map();
    if (!a) {
      setChildren(list, emptyState('users', 'Nobody selected', `${pointWord()} a person in the house, or pick one above.`));
      return;
    }
    const items = store.state.transcripts[a.id];
    if (!items) {
      setChildren(list, h('div', { class: 'loading-row' }, h('span', { class: 'spinner' }), 'Loading conversation…'));
      return;
    }
    if (!items.length) {
      renderEmpty(a);
      return;
    }
    setChildren(list);
    for (const item of items) appendItem(item, a.name);
    requestAnimationFrame(() => scrollToEnd());
    find.refresh();
  }

  /** The server kept the message in the chat as "Not sent" (a new user item with this text). */
  function markedNotSent(id: string, text: string, before: Set<string>): boolean {
    return (store.state.transcripts[id] ?? []).some((it) => it.kind === 'user' && it.notSent && !before.has(it.id) && it.text === text.trim());
  }

  /** Retry / Run again: the same message once more. A failure the server explains in the chat isn't toasted again. */
  async function resend(id: string, m: { text: string; images?: ImageRef[] }): Promise<void> {
    try {
      await store.request({ t: 'prompt', reqId: '', agentId: id, text: m.text, ...(m.images?.length ? { images: m.images.map((r) => r.id) } : {}) });
    } catch (err) {
      const message = (err as Error).message;
      const last = (store.state.transcripts[id] ?? []).at(-1);
      if (last?.kind === 'system' && last.text === message) return; // the chat says why (and the server toasted it)
      if (!store.state.connected) shell.toast('warn', 'Not connected to the CAST server — try again once it’s back.', { agentId: id });
      else shell.toast('error', `Couldn’t send it: ${message}`, { agentId: id });
    }
  }

  /** The empty-answer card's "Send “continue”": while omp still retries the same request, Stop first (the messages it
   *  hadn't read come back into the box, like Stop), then the nudge. */
  async function nudge(id: string): Promise<void> {
    const a = store.state.agents[id];
    if (a && isAgentBusy(a)) {
      try {
        const data = await store.request<{ restored?: Partial<ComposerDraft>[] } | undefined>({ t: 'abort', reqId: '', agentId: id });
        giveBack(id, data?.restored ?? []);
      } catch (err) {
        shell.toast('error', `Could not stop: ${(err as Error).message}`, { agentId: id });
        return;
      }
    }
    await resend(id, { text: 'continue' });
  }

  function appendItem(item: TranscriptItem, author: string) {
    const leadId = agentId!;
    const v = createItemView(item, author, {
      plan: (it) => planView(shell, it),
      helper: (it) => helperCard(shell, leadId, it),
      changes: (it) => turnChangesCard(shell, leadId, it),
      openImage: (ref) => openImage(shell, ref),
      files: fileLinks(shell, leadId),
      resend: (m) => resend(leadId, m),
      stuck: {
        switchModel: (anchor) => {
          const a = store.state.agents[leadId];
          if (a && chipOwner(shell, a)) openModelMenu(shell, a, anchor);
          else shell.toast('info', `${a?.name ?? 'This person'}’s model is set elsewhere — change it in the Workflow tab.`, { agentId: leadId });
        },
        nudge: () => nudge(leadId),
      },
      // the server swaps the transcript (transcript_reset) and the person's threadId; the thread bar follows
      openThread: (threadId) =>
        store
          .request({ t: 'switch_thread', reqId: '', agentId: leadId, threadId })
          .then(() => store.send({ t: 'list_threads', agentId: leadId }))
          .catch((err: Error) => shell.toast('error', `Could not open that chat: ${err.message}`, { agentId: leadId })),
    });
    views.set(item.id, v);
    list.appendChild(v.el);
  }

  function refreshPlans() {
    for (const v of views.values()) v.refresh?.();
  }

  function upsert(item: TranscriptItem) {
    const a = agent();
    if (!a) return;
    const stick = nearBottom();
    const existing = views.get(item.id);
    if (existing) existing.update(item);
    else {
      if (views.size === 0) setChildren(list); // drop the empty state
      appendItem(item, a.name);
    }
    if (stick) scrollToEnd();
    else jump.hidden = false;
    find.refresh();
  }

  return {
    el,
    get agentId() {
      return agentId;
    },
    show(id: string) {
      const changed = id !== agentId;
      agentId = id;
      if (!store.state.transcripts[id]) store.send({ t: 'get_transcript', agentId: id });
      threads.show(id);
      goalBar.show(id);
      if (changed) {
        firstChat.hide();
        renderPeople();
        renderHead();
        rebuildTranscript();
        renderInlineApprovals();
      }
    },
    /** Nobody to talk to yet (a job whose people haven't moved in). */
    clear(title: string, body: string) {
      agentId = null;
      views = new Map();
      peopleChanged(null);
      headChanged(null);
      composerChanged(null);
      setChildren(people);
      people.hidden = true;
      setChildren(head);
      threads.el.hidden = true;
      find.close();
      goalBar.show(null);
      setChildren(inline);
      firstChat.hide();
      setChildren(list, h('div', { class: 'loading-row is-tall' }, h('span', { class: 'spinner' }), h('span', null, h('strong', null, title), h('br'), h('span', { class: 'muted small' }, body))));
      composer.setTarget(null);
      modeChanged([null]);
      setChildren(composer.modeSlot);
    },
    focusComposer() {
      composer.focus();
    },
    /** Fill the box with a starter sentence — only when it is empty: never replaces what the user typed. True when filled. */
    setDraft(text: string): boolean {
      if (composer.input.value.trim() || composer.input.disabled || composer.input.readOnly) return false;
      composer.setText(text);
      return true;
    },
    /** Called for every store notification while the Chat tab is visible. */
    onState(msg?: ServerMsg) {
      threads.onState(msg);
      if (!msg) {
        renderHead();
        goalBar.render();
        renderInlineApprovals(); // the job in view decides which card A / D answer
        return;
      }
      switch (msg.t) {
        case 'transcript_upsert':
          if (msg.agentId === agentId) {
            upsert(msg.item);
            if (msg.item.kind === 'plan') renderComposer();
          } else if (msg.item.kind === 'helper' && msg.agentId === agent()?.parentId) renderHead(); // "Whole chat" on a helper
          break;
        case 'transcript_reset':
          if (msg.agentId === agentId) rebuildTranscript();
          else if (msg.agentId === agent()?.parentId) renderHead();
          break;
        case 'agent':
          // a helper starting or finishing changes the lead's "N helpers working"
          if (msg.agent.id === agentId || (agentId && msg.agent.parentId === agentId)) renderHead();
          if (msg.agent.id === agentId) goalBar.render();
          // the server says the person can work now (or can't any more): the empty chat follows the lock
          if (msg.agent.id === agentId && emptyBlocked !== null && emptyBlocked !== (blockedNow(msg.agent) && !teamRunOf(msg.agent))) refreshEmpty();
          if (msg.agent.projectId === agent()?.projectId) renderPeople();
          break;
        case 'jobs': {
          renderPeople();
          renderMode(); // a lead's model and effort live on its job
          // the empty chat names the job's room, which may just have moved
          const a = agent();
          if (a && msg.projectId === a.projectId) refreshEmpty();
          break;
        }
        case 'agent_removed': {
          const lost = composer.dropDraft(msg.agentId);
          if (lost) lostDrafts([lost]);
          if (msg.agentId === agentId) rebuildTranscript();
          renderHead(); // also when it was one of their helpers (memo skips the rest)
          renderPeople();
          break;
        }
        case 'run':
          // a team member's chat closes while their run works and opens again when it ends
          if (msg.run.projectId === agent()?.projectId) {
            renderComposer();
            refreshPlans(); // "Running" → "Completed" on an answered plan card
          }
          break;
        case 'plan': {
          // the server also upserts the card into the transcript; this keeps it right if that arrives later
          const v = views.get(msg.plan.id);
          if (v && msg.plan.agentId === agentId) v.update({ kind: 'plan', id: msg.plan.id, plan: msg.plan, ts: msg.plan.ts });
          renderComposer();
          break;
        }
        case 'models':
          renderHead(); // the composer's image button follows the person's model
          refreshPlans();
          refreshEmpty(); // an empty chat offers to connect an account while the model isn't connected
          break;
        case 'city':
          renderMode();
          firstChat.refresh(); // the house's permission mode, said in the note
          break;
        case 'workflows': // a team member's model and effort live on its workflow step
          renderMode();
          break;
        case 'approval':
        case 'approval_resolved': {
          // measured before the card goes in: after, the chat it grew is no longer "at its end" and stopped following
          const stick = nearBottom();
          renderInlineApprovals();
          if (stick) scrollToEnd();
          else if (msg.t === 'approval' && msg.approval.agentId === agentId) jump.hidden = false;
          break;
        }
        case 'snapshot':
          askedLead.clear();
          renderPeople();
          renderHead();
          goalBar.render();
          rebuildTranscript();
          renderInlineApprovals();
          break;
      }
    },
  };
}
