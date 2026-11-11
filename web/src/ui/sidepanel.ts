// Right side panel (bottom sheet on narrow screens) hosting the Chat / Workflow / Changes / Inbox tabs.
import { approvalLine, isQuestion } from '../../../shared/ask';
import type { AgentInfo, ServerMsg } from '../../../shared/protocol';
import { createChangesTab, gitTarget, requestGit } from './changes-tab';
import { createChatTab } from './chat-tab';
import { deviceStorage, h, setChildren } from './dom';
import { focusRegion, markCurrentFocus, restoreFocus, type FocusMark } from './focus';
import { icon } from './icons';
import { goToRequest, shownInPanel, type PanelView } from './approvals';
import { openHouseMenu } from './house-menu';
import { createInboxTab } from './inbox-tab';
import { createJobSwitcher } from './job-switcher';
import { createPanelResizer } from './panel-resize';
import { MAIN_JOB } from './jobs';
import { waitingCount } from './plans';
import { isRunActive, runsOf } from './runs';
import type { PanelTab, Shell } from './shell';
import { createWorkflowTab } from './workflow-tab';
import { installSheetDrag, isNarrow, isPhoneBoard, isSheetLayout } from './touch';
import { rememberHouse } from './last-house';

/** Below this height (a half-open sheet, a phone held sideways, a desktop window zoomed to 200 %, the full sheet of a
 *  320 × 568 phone) the panel folds the job row, people strip and chat bar away so the conversation keeps its room; a
 *  chevron in the header shows them. */
const SHORT_PX = 520;
const TINY_PX = 300;

const TABS: { id: PanelTab; label: string; icon: string; key?: string }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat', key: '/' },
  { id: 'workflow', label: 'Workflow', icon: 'workflow', key: 'W' },
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
];

export function createSidePanel(shell: Shell) {
  const { store } = shell;
  const chat = createChatTab(shell);
  const workflow = createWorkflowTab(shell);
  const changes = createChangesTab(shell);
  const inbox = createInboxTab(shell);
  const jobs = createJobSwitcher(shell);

  let open = false;
  let tab: PanelTab = 'chat';
  let projectId: string | null = null;
  let jobKey = ''; // "<projectId>/<jobId>" the panels currently follow
  let opener: FocusMark | null = null; // where focus was when the panel opened: it goes back there on close
  const changeListeners: (() => void)[] = [];
  const changed = () => changeListeners.forEach((fn) => fn());
  const lastPerson = new Map<string, string>(); // jobKey → agent last chatted with there

  const activeJob = () => (projectId ? shell.jobs.active(projectId) : undefined);
  const keyOf = (pid: string | null, jobId: string | undefined) => `${pid ?? ''}/${jobId ?? ''}`;
  /** People of the job the panel follows (the whole house on servers without jobs). */
  function roster(): AgentInfo[] {
    if (!projectId) return [];
    const job = activeJob();
    return job ? store.agentsOfJob(projectId, job.id) : store.agentsOf(projectId);
  }

  const tabButtons = new Map<PanelTab, HTMLButtonElement>();
  const tablist = h(
    'div',
    { class: 'panel-tabs', role: 'tablist', 'aria-label': 'Panel' },
    TABS.map((t) => {
      const b = h(
        'button',
        { type: 'button', role: 'tab', id: `ptab-${t.id}`, 'aria-controls': `ppane-${t.id}`, class: 'panel-tab', onclick: () => api.show(t.id) },
        icon(t.icon, 15),
        h('span', null, t.label),
        h('span', { class: 'tab-badge' }),
      );
      tabButtons.set(t.id, b);
      return b;
    }),
  );
  tablist.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    ev.preventDefault(); // handled here: the shared option-group keys (radios.ts) leave it alone
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (ev.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    api.show(next.id);
    tabButtons.get(next.id)?.focus();
  });

  const projectLabel = h('div', { class: 'panel-project' });
  // Desktop: the panel folds up to its header + jobs card, giving the scene back the full height (remembered per
  // browser; a convenience only, so storage failures are ignored).
  const COLLAPSE_KEY = 'rlt.panel.collapsed';
  let collapsed = false;
  collapsed = deviceStorage.get(COLLAPSE_KEY) === '1';
  const collapseBtn = h('button', { type: 'button', class: 'icon-btn panel-collapse', 'aria-label': 'Fold panel', title: 'Fold panel' }, icon('chevronUp', 16));
  /** Folded now: the board's phone page has no fold (it is the whole screen; the 3D view keeps it). */
  const isFolded = () => collapsed && !isPhoneBoard(shell.focusMode);
  const applyCollapsed = () => {
    el.classList.toggle('is-collapsed', isFolded());
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    collapseBtn.setAttribute('aria-label', collapsed ? 'Unfold panel' : 'Fold panel');
    collapseBtn.title = collapsed ? 'Unfold panel' : 'Fold panel';
  };
  const setCollapsed = (on: boolean) => {
    if (on === collapsed) return;
    collapsed = on;
    deviceStorage.set(COLLAPSE_KEY, collapsed ? '1' : '0');
    applyCollapsed();
    changed(); // its cards hide or show again: the floating stack takes them over or gives them back
  };
  collapseBtn.addEventListener('click', () => setCollapsed(!collapsed));
  const handle = h('button', { type: 'button', class: 'sheet-handle', 'aria-label': 'Expand panel', 'aria-expanded': 'false' }, h('span'));
  // Phone: the floating approval cards hide while the sheet is expanded (it covers them), so a one-line bar in the
  // sheet says who waits and takes you to the card. Hidden on wide screens (CSS), where the cards float beside it.
  const asksBar = h('button', { type: 'button', class: 'panel-asks', hidden: true });
  // Short panel: the rows folded away (see SHORT_PX) come back with this.
  const chromeBtn = h(
    'button',
    { type: 'button', class: 'icon-btn panel-chrome', 'aria-expanded': 'false', 'aria-label': 'Show job, people and chats', title: 'Show job, people and chats' },
    icon('chevronDown', 17),
  );
  // Board on a phone: the chat covers the top bar and its run strip, so the job's team run gets a pill in the header
  // (mobile.css shows it there only).
  const runPill = h('button', { type: 'button', class: 'panel-run', hidden: true });
  const panes: Record<PanelTab, HTMLElement> = {
    chat: h('div', { class: 'panel-pane', role: 'tabpanel', id: 'ppane-chat', 'aria-labelledby': 'ptab-chat' }, chat.el),
    workflow: h('div', { class: 'panel-pane', role: 'tabpanel', id: 'ppane-workflow', 'aria-labelledby': 'ptab-workflow' }, workflow.el),
    changes: h('div', { class: 'panel-pane', role: 'tabpanel', id: 'ppane-changes', 'aria-labelledby': 'ptab-changes' }, changes.el),
    inbox: h('div', { class: 'panel-pane', role: 'tabpanel', id: 'ppane-inbox', 'aria-labelledby': 'ptab-inbox' }, inbox.el),
  };
  const el = h(
    'aside',
    { class: 'sidepanel glass', 'aria-label': 'Side panel', hidden: true },
    handle,
    h(
      'header',
      { class: 'panel-head' },
      projectLabel,
      runPill,
      h('div', { class: 'panel-head-actions' },
        chromeBtn,
        collapseBtn,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close panel', title: 'Close (Esc)', onclick: () => shell.closePanel() }, icon('x', 17)), // (the shell also brings back the floating approval card)
      ),
    ),
    jobs.el,
    tablist,
    asksBar,
    h('div', { class: 'panel-body' }, Object.values(panes)),
  );
  applyCollapsed();
  el.prepend(createPanelResizer(shell.root, el)); // desktop: drag its left edge (panel.css shows it on a docked panel only)

  // ── Phone sheet: half or full height (handle tap, drag, or an explicit open), see responsive.css / mobile.css ──
  const setExpanded = (on: boolean) => {
    el.classList.toggle('is-expanded', on);
    handle.setAttribute('aria-expanded', String(on));
    handle.setAttribute('aria-label', on ? 'Shrink panel' : 'Expand panel');
  };
  handle.addEventListener('click', () => {
    if (sheetDrag.consumeClick()) return; // the click that ends a drag is not a tap on the handle
    setExpanded(!el.classList.contains('is-expanded'));
  });
  // Phone: typing to someone (or finding in the chat) gets the whole sheet (the transcript would otherwise be a few
  // lines tall).
  el.addEventListener('focusin', (ev) => {
    if (isSheetLayout() && (ev.target as HTMLElement).matches?.('textarea, .find-input')) setExpanded(true);
  });
  const setChromeOpen = (on: boolean) => {
    el.classList.toggle('is-chrome-open', on);
    chromeBtn.setAttribute('aria-expanded', String(on));
    chromeBtn.setAttribute('aria-label', on ? 'Hide job, people and chats' : 'Show job, people and chats');
    chromeBtn.title = chromeBtn.getAttribute('aria-label')!;
    // Board on a phone: the header's job name is the chevron (renderChrome)
    if (isPhoneBoard(shell.focusMode)) projectLabel.querySelector('.panel-project-btn')?.setAttribute('aria-expanded', String(on));
  };
  chromeBtn.addEventListener('click', () => setChromeOpen(!el.classList.contains('is-chrome-open')));
  // A short panel (a phone held sideways, a half sheet) opens those rows to pick something: picking a person or starting
  // to type folds them away again, so the conversation gets its room back (with them open it had a few lines at most).
  // (a click on a person, not focus: Tab walks through the people strip without folding it away under the focus; on
  // the way down, before the chip's own handler redraws the strip and takes the chip out of the page)
  const foldPicked = (t: EventTarget | null, what: string) => {
    if (!el.classList.contains('is-short') || !el.classList.contains('is-chrome-open') || !(t instanceof Element)) return;
    if (t.closest(what)) setChromeOpen(false);
  };
  el.addEventListener('click', (ev) => foldPicked(ev.target, '.people .person'), true);
  el.addEventListener('focusin', (ev) => foldPicked(ev.target, '.composer-input'));
  // Short panels fold their extra rows (not the desktop fold, which is short on purpose); phone-sized and short panels
  // show the person's card as one line (is-tight); a very short one (a phone held sideways with its keyboard up) also
  // folds the chips under the chat box (is-tiny). See mobile.css.
  new ResizeObserver(() => {
    const hgt = el.clientHeight;
    if (!hgt) return;
    const short = !isFolded() && hgt < SHORT_PX;
    el.classList.toggle('is-short', short);
    el.classList.toggle('is-tight', short || isNarrow());
    el.classList.toggle('is-tiny', !isFolded() && hgt < TINY_PX);
  }).observe(el);

  // Drag the sheet by its handle or header: it follows the finger and settles on closed, half or full (touch.ts).
  const inDragZone = (t: unknown) =>
    t instanceof Element && (handle.contains(t) || (!!t.closest('.panel-head') && !t.closest('button, a, input, select, textarea')));
  const sheetDrag = installSheetDrag(el, {
    // (Board on a phone: the chat is a page, not a sheet over the board — Close or the browser's Back leave it)
    canStart: (t) => open && isSheetLayout() && !isPhoneBoard(shell.focusMode) && inDragZone(t),
    rootH: () => shell.root.clientHeight,
    // a drag closes the on-screen keyboard (it would hold the sheet up)
    onStart: () => {
      if (el.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('textarea, input')) (document.activeElement as HTMLElement).blur();
    },
    settle: (snap) => (snap === 'closed' ? api.close() : setExpanded(snap === 'full')),
  });

  /** Requests the open tab doesn't show as cards (the inbox shows its house's, a chat its person's, the Workflow tab
   *  the run's): the phone bar names the oldest. */
  function renderAsks() {
    const shows: PanelView = { ...api.view, open: true, folded: false }; // what the open tab itself lists
    const hidden = Object.values(store.state.approvals)
      .filter((a) => !shownInPanel(shows, a))
      .sort((a, b) => a.ts - b.ts);
    const first = hidden[0];
    asksBar.hidden = !first;
    if (!first) return setChildren(asksBar);
    const who = store.state.agents[first.agentId]?.name ?? 'Someone';
    const where = first.projectId !== projectId ? ` in ${store.project(first.projectId)?.name ?? 'another house'}` : '';
    setChildren(asksBar,
      icon('hand', 14),
      h('span', { class: 'panel-asks-text' }, isQuestion(first) ? `${who}${where} asks: ${approvalLine(first)}` : `${who}${where} wants to use ${first.tool}`, hidden.length > 1 ? h('span', { class: 'muted' }, ` · ${hidden.length - 1} more`) : null),
      h('span', { class: 'panel-asks-go' }, isQuestion(first) ? 'Answer' : 'Review', icon('chevronRight', 13)),
    );
    asksBar.onclick = () => (first.projectId === projectId ? api.show('inbox') : goToRequest(shell, first));
  }

  /** The job's team run, while it runs or waits for you (the same run the Workflow tab's live dot means). */
  function renderRun() {
    const jobId = activeJob()?.id ?? MAIN_JOB;
    const run = projectId ? runsOf(store.state, projectId).find((r) => isRunActive(r) && (r.jobId ?? MAIN_JOB) === jobId) : undefined;
    runPill.hidden = !run;
    if (!run) return setChildren(runPill);
    const waits = run.status === 'waiting_approval';
    const label = `Team run “${run.workflowName}” ${waits ? 'waits for you' : 'is working'} — open it`;
    runPill.classList.toggle('is-waiting', waits);
    runPill.title = label;
    runPill.setAttribute('aria-label', label);
    runPill.onclick = () => shell.openWorkflow(run.projectId, run.id);
    setChildren(runPill, waits ? icon('hand', 13) : h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), h('span', { class: 'panel-run-name' }, run.workflowName));
  }

  function renderChrome() {
    renderAsks();
    renderRun();
    const project = store.project(projectId);
    const job = activeJob();
    // Board on a phone the header names the job (the job row waits behind it) and opens the job, people and chat rows
    const phone = isPhoneBoard(shell.focusMode);
    const chromeOpen = el.classList.contains('is-chrome-open');
    setChildren(projectLabel,
      project
        ? [
            h(
              'button',
              {
                type: 'button',
                class: ['panel-project-btn', job && 'has-job'],
                title: project.path,
                'aria-expanded': phone ? String(chromeOpen) : undefined,
                'aria-label': phone ? `${job ? `${job.name} in ` : ''}${project.name} — show jobs, people and chats` : undefined,
                onclick: () => (isPhoneBoard(shell.focusMode) ? setChromeOpen(!el.classList.contains('is-chrome-open')) : shell.enterProject(project.id)),
              },
              icon('home', 15),
              h('span', { class: 'panel-project-name' }, project.name),
              job ? h('span', { class: 'panel-job-name' }, job.name) : null,
              h('span', { class: 'panel-title-chev', 'aria-hidden': 'true' }, icon('chevronDown', 14)),
            ),
            h('button', { type: 'button', class: 'icon-btn panel-house-menu', 'aria-label': `House: ${project.name} — browse files, rename, move or remove`, title: 'Browse files, rename, move or remove this house', 'aria-haspopup': 'menu', onclick: (ev: MouseEvent) => openHouseMenu(shell, ev.currentTarget as HTMLElement, project) }, icon('dots', 16)),
          ]
        : h('span', { class: 'panel-project-btn is-static' }, icon('inbox', 15), h('span', { class: 'panel-project-name' }, 'Town')),
    );
    for (const t of TABS) {
      const b = tabButtons.get(t.id)!;
      const on = t.id === tab;
      b.hidden = !project && t.id !== 'inbox'; // the town's Inbox: a house's tabs wait until a house is picked
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      panes[t.id].hidden = !on;
      const badge = b.querySelector('.tab-badge')!;
      let text = '';
      let cls = 'tab-badge';
      if (t.id === 'inbox') {
        const n = waitingCount(store.state, projectId ?? undefined); // this house's (the tab lists only those)
        if (n) (text = String(n)), (cls += ' is-amber');
      } else if (t.id === 'changes' && projectId) {
        const n = store.state.git[gitTarget(shell, projectId).key]?.files.length ?? 0; // the job's own copy when it has one
        if (n) text = String(n);
      } else if (t.id === 'workflow' && projectId && runsOf(store.state, projectId).some((r) => isRunActive(r) && (r.jobId ?? MAIN_JOB) === (activeJob()?.id ?? MAIN_JOB))) {
        cls += ' is-live';
      }
      badge.className = cls;
      badge.textContent = text;
    }
  }

  function showChatPerson() {
    const people = roster();
    if (chat.agentId && people.some((p) => p.id === chat.agentId)) return;
    const remembered = lastPerson.get(jobKey);
    const target = people.find((p) => p.id === remembered) ?? people[0];
    if (target) chat.show(target.id);
    else if (projectId) {
      const job = activeJob();
      chat.clear(job ? `Opening room ${job.name}…` : 'Nobody home yet', 'People move in as soon as the server has the room ready.');
    }
  }

  /** The active job changed (picked here, in 3D, from the palette…): chat + workflow follow it. */
  function syncJob(): boolean {
    const key = keyOf(projectId, activeJob()?.id);
    if (key === jobKey) return false;
    jobKey = key;
    jobs.show(projectId);
    // the Changes badge counts a job's own copy: fetch it the first time that job is picked (the open tab asks itself)
    if (projectId && tab !== 'changes' && !store.state.git[gitTarget(shell, projectId).key]) requestGit(shell, projectId);
    return true;
  }

  function showTab() {
    const pid = projectId;
    syncJob();
    jobs.show(pid);
    if (tab === 'chat') {
      showChatPerson();
    } else if (tab === 'workflow' && pid) workflow.show(pid, activeJob()?.id ?? MAIN_JOB);
    else if (tab === 'changes' && pid) changes.show(pid);
    else if (tab === 'inbox') inbox.show(pid);
  }

  const api = {
    el,
    chat,
    workflow,
    get isOpen() {
      return open;
    },
    get tab() {
      return tab;
    },
    get projectId() {
      return projectId;
    },
    /** What it shows of the approval requests (the floating stack leaves those out). */
    get view(): PanelView {
      return {
        open,
        folded: isFolded() && !isSheetLayout(), // a phone's sheet has no fold
        tab,
        projectId,
        chatAgentId: chat.agentId ?? null,
        workflowShows: (agentId) => workflow.showsAsksOf(agentId),
      };
    },
    open(nextTab: PanelTab, pid?: string | null) {
      if (pid) {
        projectId = pid;
        rememberHouse(pid);
      } else if (pid === null && nextTab === 'inbox') projectId = null; // the town's Inbox: every house's requests
      // a house's tab needs a house: the one in view, else the last one used (shell.contextProjectId)
      if (!projectId && !(pid === null && nextTab === 'inbox')) projectId = shell.contextProjectId();
      tab = nextTab;
      if (!open) {
        if (!el.contains(document.activeElement)) opener = markCurrentFocus();
        open = true;
        el.hidden = false;
        requestAnimationFrame(() => el.classList.add('is-open'));
        shell.root.classList.add('has-panel');
        // Board on a phone: always the whole page (no half sheet over the board's cards)
        if (isPhoneBoard(shell.focusMode)) setExpanded(true);
      }
      renderChrome();
      showTab();
      changed();
    },
    show(nextTab: PanelTab) {
      api.open(nextTab);
    },
    /** Unfold a folded panel: the user asked for something in it (a person, the workflow, the inbox…). Opening on
     *  its own (entering a house) keeps the fold. */
    reveal() {
      setCollapsed(false);
      // phone: what was asked for gets the whole sheet (drag the handle down to see the house again)
      if (isSheetLayout()) setExpanded(true);
    },
    openAgent(agentId: string) {
      const a = store.state.agents[agentId];
      if (!a) return;
      projectId = a.projectId;
      rememberHouse(a.projectId);
      tab = 'chat';
      chat.show(agentId);
      const jobId = a.jobId ?? (store.jobsOf(a.projectId).length ? MAIN_JOB : undefined);
      if (jobId && store.job(a.projectId, jobId) && shell.jobs.active(a.projectId)?.id !== jobId) shell.jobs.select(a.projectId, jobId);
      api.open('chat');
      api.reveal();
    },
    close() {
      if (!open) return;
      open = false;
      // Focus inside goes back to whatever opened the panel (or the page's main heading), not to <body>.
      const at = document.activeElement;
      const hadFocus = el.contains(at) || !at || at === document.body;
      el.classList.remove('is-open');
      setExpanded(false);
      shell.root.classList.remove('has-panel');
      setTimeout(() => {
        if (!open) el.hidden = true;
      }, 200);
      if (hadFocus) restoreFocus(opener);
      opener = null;
      changed();
    },
    /** Move focus to the panel itself (after entering a house from the board: the next step is in here). */
    focus(from?: FocusMark | null) {
      if (!open) return;
      // Esc / close comes back to `from` (what was focused when the user acted), else to what has focus now
      const mark = from && !el.contains(from.el) ? from : !el.contains(document.activeElement) ? markCurrentFocus() : null;
      if (mark) opener = mark;
      focusRegion(el);
    },
    /** Focus the open tab's pane (a shortcut opened it: W). */
    focusPane() {
      if (!open) return;
      if (!el.contains(document.activeElement)) opener = markCurrentFocus();
      focusRegion(panes[tab]);
    },
    /** Called after the panel opens, closes or changes tab. */
    onChange(fn: () => void) {
      changeListeners.push(fn);
    },
    onState(msg?: ServerMsg) {
      if (msg?.t === 'city' && projectId && !store.project(projectId)) projectId = shell.contextProjectId();
      chat.onState(msg);
      if (chat.agentId) {
        const a = store.state.agents[chat.agentId];
        if (a) lastPerson.set(keyOf(a.projectId, a.jobId), a.id);
      }
      if (!open) return;
      const jobChanged = syncJob();
      if (jobChanged) {
        renderChrome();
        showTab();
        return;
      }
      if (msg?.t !== 'transcript_upsert') jobs.render();
      renderChrome();
      // A job's people arrive after it is created: show its lead as soon as they do.
      if (tab === 'chat' && (msg?.t === 'agent' || msg?.t === 'jobs' || msg?.t === 'agent_removed' || msg?.t === 'snapshot')) showChatPerson();
      // phone: a plan card waiting in the open chat needs room to be read and answered
      const plan = msg?.t === 'plan' ? msg.plan : msg?.t === 'transcript_upsert' && msg.item.kind === 'plan' ? msg.item.plan : undefined;
      if (plan && plan.status === 'pending' && tab === 'chat' && plan.agentId === chat.agentId && isSheetLayout()) setExpanded(true);
      if (tab === 'workflow') workflow.onState(msg);
      else if (tab === 'changes') changes.onState(msg);
      else if (tab === 'inbox') inbox.onState(msg);
      if (tab === 'workflow' && (msg?.t === 'approval' || msg?.t === 'approval_resolved' || msg?.t === 'run')) renderAsks(); // the run card may show it now
    },
    refreshInbox() {
      if (open && tab === 'inbox') inbox.render();
    },
    jobs,
  };
  // Board ↔ 3D with the panel open: the header's job title and the whole-page chat follow the view (a microtask:
  // the shell's own listener, registered after this one, applies the mode)
  shell.bus.on('focusmode:change', () =>
    queueMicrotask(() => {
      applyCollapsed();
      if (!open) return;
      if (isPhoneBoard(shell.focusMode)) setExpanded(true);
      renderChrome();
      changed(); // folded or not: the floating approval cards follow
    }),
  );
  return api;
}

export type SidePanel = ReturnType<typeof createSidePanel>;
