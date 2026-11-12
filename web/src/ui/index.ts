// createUI(ctx): the 2D layer over the 3D town. Composes panels, wires store + bus, owns shortcuts.
import './styles.css';
import type { AppContext, Quality, UI, ViewName } from '../core/types';
import { APP_NAME } from '../../../shared/brand';
import type { ServerMsg, TeamPlan } from '../../../shared/protocol';
import { a11yPref, onA11yPref } from './a11y-prefs';
import { createAnnouncer, pageTitle, placeAnnouncement } from './announce';
import { installFocusGuard, markCurrentFocus, setFocusFallback } from './focus';
import { createMainView } from './main-view';
import { installOptionGroups } from './radios';
import { installTheme } from './theme';
import { openSettings } from './settings';
import { takeSettingsLink } from './settings-link';
import { onSingleKeysChange, singleKeysEnabled } from './shortcuts';
import { rememberBoard, threeD } from './view-mode';
import { CONNECTING, LOADING_HOUSES, whenSynced } from './town-loading';
import { createFloorSwitcher } from './floor-switcher';
import { openJobDialog, refreshJobDialog } from './job-dialog';
import { lastHouse, rememberHouse, townPanelHouse } from './last-house';
import { confirmDeleteJob, openRenamePopover } from './job-menu';
import { MAIN_JOB, createJobChoice, floorName, jobAt, projectFloors, type JobChoice } from './jobs';
import { createActionBar } from './actionbar';
import { attachCityOffline } from './cities';
import { createApprovalStack, shownInPanel } from './approvals';
import { approvalAnnouncement } from './approval-text';
import { dropDraft } from './ask-draft';
import { alertApproval, alertPlan, approvalGone, approvalsKnown, planGone, planSeen, plansKnown } from './notify';
import { waitingCount } from './plans';
import { confirmDialog } from './confirm';
import { createDiffOverlay } from './diff-overlay';
import { deviceStorage, frameScheduler, h } from './dom';
import { createFocusView } from './focus-view';
import { createHelp } from './help';
import { installKeyboard } from './keyboard';
import { createLayerStack } from './layers';
import { appNav } from './nav-history';
import { noticeInterrupted } from './agents-health';
import { createOmpWarning } from './omp-warning';
import { createOnboarding, onboardingDismissed } from './onboarding';
import { createPalette } from './palette';
import { createPlacement } from './placement';
import { createProviders } from './providers';
import type { PanelTab, Shell } from './shell';
import { createSidePanel } from './sidepanel';
import { createTerminalDock, houseTermTarget } from './terminal';
import { createToasts } from './toasts';
import { installAutoQuality } from './auto-quality';
import { createTopBar } from './topbar';
import { loadSession, watchAccess } from '../net/session';
import { installPwa } from '../pwa';
import { guardScenePinch, installViewport, isSheetLayout, isTouchUI } from './touch';

/** The self-hosted @font-face rules (web/public/fonts). index.html carries them inlined; harness pages may not. */
function ensureFonts() {
  if (document.querySelector('[data-rlt-fonts]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: '/fonts/fonts.css', 'data-rlt-fonts': '' }));
}

export function createUI(ctx: AppContext): UI {
  const { store, bus, engine } = ctx;
  installTheme(); // light / dark (#77): index.html already set it before the first paint; this follows changes
  const root = h('div', { class: 'rlt-ui' });
  // dialogs close with the browser's Back too (finding #50)
  const layers = createLayerStack({ onModal: (close) => appNav().overlay(close) });
  const announcer = createAnnouncer();
  const toasts = createToasts((text, level) => announcer.say(text, level));
  const schedule = frameScheduler();

  let view: { view: ViewName; projectId: string | null } = { view: store.state.view, projectId: store.state.currentProjectId };
  let focusMode = false;
  let quality: Quality = engine?.quality ?? 'high';
  let panelAutoOpened = false;
  /** The board opened the chat beside itself and nobody has touched it since: leaving the board closes it again, so
   *  the town a 3D start switches to (after the board stood in while it loaded) looks as it would have at once. */
  let boardOpenedPanel = false;

  // Late-bound so the shell can be handed to components before they exist.
  let panel!: ReturnType<typeof createSidePanel>;
  let diff!: ReturnType<typeof createDiffOverlay>;
  /** Ctrl+` (finding #45): the shell of the house being looked at — inside it, or its panel open in the town or on
   *  the 2D board — like the palette's "Open terminal"; nothing in view: the last one used, else the town. */
  const termHere = (): string | undefined => {
    const pid = view.view === 'house' && view.projectId ? view.projectId : panel?.isOpen && panel.projectId ? panel.projectId : null;
    return pid && store.project(pid) ? houseTermTarget(shell, pid) : undefined;
  };
  let palette!: ReturnType<typeof createPalette>;
  let placement!: ReturnType<typeof createPlacement>;
  let providers!: ReturnType<typeof createProviders>;
  let onboarding!: ReturnType<typeof createOnboarding>;
  let focusView!: ReturnType<typeof createFocusView>;
  let terminal!: ReturnType<typeof createTerminalDock>;
  let jobChoice!: JobChoice;
  let floorSwitch!: ReturnType<typeof createFloorSwitcher>;
  let help!: ReturnType<typeof createHelp>;

  /** Inside a house, acting on another house (a person, a job, a request of theirs) takes you there, so breadcrumb,
   *  panel and 3D agree on which house you are working in. */
  function followHouse(projectId: string | undefined) {
    if (projectId && view.view === 'house' && view.projectId && view.projectId !== projectId && store.project(projectId)) bus.emit('nav:enter', { projectId });
  }

  /** Resolve once the store satisfies `ok` (or after ms). */
  const until = (ok: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (ok()) return resolve(true);
      const t = setTimeout(() => {
        off();
        resolve(ok());
      }, ms);
      const off = store.subscribe(() => {
        if (!ok()) return;
        clearTimeout(t);
        off();
        resolve(true);
      });
    });

  const shell: Shell = {
    store,
    bus,
    engine,
    root,
    layers,
    get view() {
      return view;
    },
    get focusMode() {
      return focusMode;
    },
    get quality() {
      return quality;
    },
    get chatAgentId() {
      return panel?.isOpen && panel.tab === 'chat' ? (panel.chat.agentId ?? null) : null;
    },
    setFocusMode(on) {
      if (!on && threeD.state !== 'ready') {
        if (threeD.state === 'unavailable') {
          toasts.show('info', '3D isn’t available in this browser — the board has everything.');
          return;
        }
        // Not built yet (a board start, or a 3D start still building): build it, keep the board until it's ready,
        // then switch (threeD.onChange).
        threeD.want(true);
        rememberBoard(false);
        threeD.load();
        announcer.say('Loading the 3D town. The board stays until it is ready.');
        schedule('topbar', topbar.render);
        schedule('focusview', focusView.render);
        return;
      }
      if (on && focusMode && threeD.wanted) {
        // Board picked while the board stands in for a town still loading: stay here, now and next time.
        threeD.want(false);
        rememberBoard(true);
        announcer.say('Staying on the board. Switch to the 3D town in the top bar any time.');
        schedule('topbar', topbar.render);
        schedule('focusview', focusView.render);
        return;
      }
      threeD.want(false);
      if (on === focusMode) return;
      rememberBoard(on);
      applyFocusMode(on);
      bus.emit('focusmode:change', { on });
    },
    setQuality(q, opts) {
      if (q === quality) return;
      quality = q;
      bus.emit('quality:change', { quality: q });
      schedule('topbar', topbar.render);
      if (!opts?.quiet) toasts.show('info', `Graphics set to ${q[0].toUpperCase()}${q.slice(1)}`);
    },
    announce: (text, level) => announcer.say(text, level),
    toast: (level, text, opts) => toasts.show(level, text, opts),
    get notifications() {
      return toasts.history;
    },
    confirm: (opts) => confirmDialog(root, layers, opts),
    openAgent(agentId, opts) {
      followHouse(store.state.agents[agentId]?.projectId);
      panelAutoOpened = false;
      panel.openAgent(agentId);
      // Next frame: the panel is unhidden in this one, and focusing a hidden box does nothing. Not on a touch screen:
      // the keyboard would cover half the chat before anything was read (a tap on the box brings it up).
      const draft = opts?.draft;
      const focus = !!opts?.focusComposer && !isTouchUI();
      if (draft || focus)
        requestAnimationFrame(() => {
          if (draft && panel.chat.setDraft(draft)) return; // it focuses the box too
          if (focus) panel.chat.focusComposer();
        });
      schedule('approvals', approvals.render);
    },
    openPanel(tab: PanelTab, projectId) {
      panelAutoOpened = false;
      panel.open(tab, projectId);
      panel.reveal();
      schedule('approvals', approvals.render);
    },
    closePanel() {
      panel.close();
      schedule('approvals', approvals.render);
    },
    openWorkflow(projectId, runId) {
      shell.openPanel('workflow', projectId);
      panel.workflow.showRun(runId ?? null);
    },
    openDiff(projectId, file, opts) {
      diff.open(projectId, file, opts);
    },
    openPlacement(lotId) {
      placement.open(lotId);
    },
    openProviders() {
      providers.open();
    },
    openPalette() {
      palette.open();
    },
    openTerminal(target) {
      void terminal.open(target);
    },
    toggleTerminal() {
      terminal.toggle(termHere());
    },
    openOnboarding() {
      onboarding.open();
    },
    openHelp(section) {
      help.open(section);
    },
    openSettings(section) {
      openSettings(shell, section);
    },
    enterProject(projectId, opts) {
      const from = opts?.focusPanel ? markCurrentFocus() : null; // now: entering re-renders the pressed button away
      bus.emit('nav:enter', { projectId });
      if (focusMode || opts?.focusPanel) shell.openPanel('chat', projectId);
      if (opts?.focusPanel) requestAnimationFrame(() => panel.focus(from));
    },
    contextProjectId() {
      if (view.view === 'house' && view.projectId) return view.projectId;
      if (panel?.projectId && store.project(panel.projectId)) return panel.projectId;
      const ids = store.state.city.projects.map((p) => p.id);
      return lastHouse(ids) ?? ids[0] ?? null;
    },
    get jobs() {
      return jobChoice;
    },
    selectJob(projectId, jobId, opts) {
      if (!store.job(projectId, jobId)) return;
      followHouse(projectId);
      jobChoice.select(projectId, jobId, { focus: opts?.focus });
      if (opts?.openPanel || (panel.isOpen && panel.projectId !== projectId)) {
        panelAutoOpened = false;
        panel.open(panel.isOpen && panel.tab === 'workflow' ? 'workflow' : 'chat', projectId);
        if (opts?.openPanel) panel.reveal();
        schedule('approvals', approvals.render);
      }
    },
    openNewJob(projectId, room) {
      openJobDialog(shell, { mode: 'new', projectId, room });
    },
    editJob(projectId, jobId, mode, anchor) {
      const job = store.job(projectId, jobId);
      if (!job) return;
      if (mode === 'rename') openRenamePopover(shell, anchor ?? root, job);
      else openJobDialog(shell, { mode, projectId, jobId });
    },
    async deleteJob(projectId, jobId) {
      const job = store.job(projectId, jobId);
      if (!job) return;
      const wasActive = jobChoice.active(projectId)?.id === jobId;
      if (!(await confirmDeleteJob(shell, job))) return;
      await until(() => !store.job(projectId, jobId), 3000);
      const next = store.job(projectId, MAIN_JOB) ?? store.jobsOf(projectId)[0];
      if (wasActive && next) shell.selectJob(projectId, next.id, { focus: true });
    },
    async addFloor(projectId) {
      const before = projectFloors(store.project(projectId));
      try {
        await store.request({ t: 'add_floor', reqId: '', projectId });
        await until(() => projectFloors(store.project(projectId)) > before, 4000);
        const floor = projectFloors(store.project(projectId)) - 1;
        if (floor < before) return null;
        toasts.show('success', `${floorName(floor)} added — 4 free rooms`, { projectId });
        return floor;
      } catch (err) {
        toasts.show('error', `Could not add a floor: ${(err as Error).message}`);
        return null;
      }
    },
  };
  jobChoice = createJobChoice(shell);

  const topbar = createTopBar(shell);
  const actionbar = createActionBar(shell);
  panel = createSidePanel(shell);
  // phone: the panel sheet covers the town or the house, so the browser's Back closes it first (finding #50)
  let sheetBack: (() => void) | null = null;
  panel.onChange(() => {
    const sheet = panel.isOpen && isSheetLayout();
    if (sheet && !sheetBack) {
      sheetBack = appNav().overlay(() => {
        sheetBack = null;
        shell.closePanel();
      });
    } else if (!sheet && sheetBack) {
      const done = sheetBack;
      sheetBack = null;
      done();
    }
  });
  diff = createDiffOverlay(shell);
  palette = createPalette(shell);
  placement = createPlacement(shell);
  providers = createProviders(shell);
  onboarding = createOnboarding(shell);
  focusView = createFocusView(shell);
  const mainView = createMainView(shell, focusView.el);
  terminal = createTerminalDock(shell);
  floorSwitch = createFloorSwitcher(shell);
  help = createHelp(shell);
  // the inbox tab shows the cards of its own house (other houses get a jump link there, so their cards stay up here);
  // one card in one place: whenever the panel opens, closes, folds or changes tab, the stack follows
  const approvals = createApprovalStack(shell, (a) => shownInPanel(panel.view, a));
  panel.onChange(() => schedule('approvals', approvals.render));
  const offlineText = h('span', null, `Reconnecting to the ${APP_NAME} server…`);
  const offline = h('div', { class: 'offline-banner glass', role: 'status', hidden: true }, h('span', { class: 'spinner spinner-sm' }), offlineText);
  attachCityOffline(offline); // a city through a hub that stays unreachable: offer Back to Home
  const ompWarning = createOmpWarning(shell);
  toasts.onChange(() => schedule('inbox', panel.refreshInbox));
  if (engine) installAutoQuality(shell);

  function applyFocusMode(on: boolean) {
    focusMode = on;
    root.classList.toggle('is-focus', on);
    focusView.setOn(on);
    schedule('topbar', topbar.render);
    schedule('floors', floorSwitch.render);
    schedule('main', mainView.render);
    renderConnection(); // the 3D town says its houses are loading in the banner; the board in its own card
    schedule('title', renderTitle);
    onboarding.onCity(); // an open welcome says which view this is (a board start switches under it)
    announcer.say(on ? 'Board view: every house as a list.' : '3D town.');
    // a phone's sheet would cover the board it opens over
    if (on && !panel.isOpen && !isSheetLayout()) {
      // at the town level: the house last used, else the town's Inbox — not whichever house is first in the list
      const pid = view.view === 'house' && view.projectId ? view.projectId : townPanelHouse(store.state.city.projects.map((p) => p.id));
      shell.openPanel(pid ? 'chat' : 'inbox', pid);
      boardOpenedPanel = true;
    } else if (!on && boardOpenedPanel && panel.isOpen && view.view !== 'house') shell.closePanel();
    if (!on) boardOpenedPanel = false;
  }

  function setView(next: { view: ViewName; projectId: string | null }) {
    const prev = view;
    if (prev.view === next.view && prev.projectId === next.projectId) return;
    view = next;
    root.dataset.view = next.view;
    schedule('topbar', topbar.render);
    schedule('actionbar', actionbar.render);
    schedule('main', mainView.render);
    schedule('title', renderTitle);
    const project = store.project(next.projectId);
    const job = project ? store.activeJob(project.id) : undefined;
    announcer.say(placeAnnouncement(next.view, { house: project?.name, job: job && job.id !== MAIN_JOB ? job.name : null, board: focusMode }));
    if (next.view === 'house' && next.projectId) {
      rememberHouse(next.projectId);
      store.send({ t: 'get_git', projectId: next.projectId });
      jobChoice.onEnter(next.projectId);
      floorSwitch.onEnter(next.projectId);
      // Entering a house opens the chat with its assistant (on wide screens) so the next step is obvious.
      if (!panel.isOpen && !isSheetLayout()) {
        panel.open('chat', next.projectId);
        panelAutoOpened = true;
      } else if (panel.isOpen && panel.projectId !== next.projectId) panel.open(panel.tab, next.projectId);
    } else if (prev.view === 'house' && panelAutoOpened) {
      panel.close();
      panelAutoOpened = false;
    }
    schedule('approvals', approvals.render);
    schedule('floors', floorSwitch.render);
  }

  // The banner under the top bar: no connection (the first one is slow, or it was lost), or — in the 3D town, whose
  // lots would read as empty — connected and the houses still on their way (the board says that in its own card).
  type Banner = 'connect' | 'reconnect' | 'load';
  const BANNER_TEXT: Record<Banner, string> = { connect: CONNECTING, reconnect: `Reconnecting to the ${APP_NAME} server…`, load: LOADING_HOUSES };
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;
  let banner: Banner | null = null; // what it shows (null: hidden)
  let everConnected = false; // a slow first connect is not a lost connection: say nothing about it
  const bannerWanted = (): Banner | null => {
    const s = store.state;
    if (!s.connected) return everConnected ? 'reconnect' : 'connect';
    return s.synced || focusMode ? null : 'load';
  };
  const showBanner = (kind: Banner | null) => {
    banner = kind;
    offline.hidden = !kind;
    if (kind) offlineText.textContent = BANNER_TEXT[kind];
    offline.classList.toggle('is-loading', kind === 'load');
  };
  function renderConnection() {
    if (store.state.connected) {
      if (banner === 'reconnect') announcer.say(`Connected to the ${APP_NAME} server again.`);
      everConnected = true;
    }
    const want = bannerWanted();
    if (!want) {
      clearTimeout(bannerTimer ?? undefined);
      bannerTimer = null;
      showBanner(null);
    } else if (banner) {
      if (banner !== want) showBanner(want); // already up: say what it is now (connected, the houses still loading)
    } else if (!bannerTimer) {
      // Don't flash the banner for a blip (or for a quick first load).
      bannerTimer = setTimeout(() => {
        bannerTimer = null;
        const kind = bannerWanted();
        if (!kind) return;
        showBanner(kind);
        root.classList.toggle('is-offline', true);
        if (kind === 'reconnect') announcer.say(`Lost the connection to the ${APP_NAME} server. Reconnecting…`, 'assertive');
      }, 1500);
    }
    root.classList.toggle('is-offline', !offline.hidden); // the town board makes room on a phone (health.css)
  }

  const PANEL_TITLE: Record<PanelTab, string> = { chat: 'Chat', workflow: 'Workflow', changes: 'Changes', inbox: 'Inbox' };
  /** "(2) Inbox · todo-api · CAST": where you are, so tabs and history entries can be told apart. */
  function renderTitle() {
    const project = view.view === 'house' ? store.project(view.projectId) : undefined;
    const job = project ? store.activeJob(project.id) : undefined;
    document.title = pageTitle({
      waiting: waitingCount(store.state),
      tab: panel.isOpen ? PANEL_TITLE[panel.tab] : null,
      place: project?.name ?? (view.view === 'drive' ? 'Driving' : focusMode ? 'Town board' : null),
      job: job && job.id !== MAIN_JOB ? job.name : null,
      app: APP_NAME,
    });
  }

  /** A run that ended while the user may be elsewhere: one line for the screen reader (toasts cover the rest). */
  const runStatus = new Map<string, string>();
  function onRun(run: { id: string; status: string; projectId: string; workflowName?: string }) {
    const before = runStatus.get(run.id);
    runStatus.set(run.id, run.status);
    if (!before || before === run.status) return;
    const active = (st: string) => st === 'running' || st === 'waiting_approval';
    if (!active(before) || active(run.status)) return;
    const where = store.project(run.projectId)?.name ?? 'a house';
    const what = run.workflowName ? `Workflow “${run.workflowName}”` : 'A workflow';
    const how = run.status === 'done' ? 'finished' : run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'was stopped' : run.status;
    announcer.say(`${what} in ${where} ${how}.`, run.status === 'failed' ? 'assertive' : 'polite');
  }

  /** A plan card waits in a lead's chat: say so unless the user is looking at that chat right now (like approvals,
   *  the system notification only fires while CAST is in the background). */
  function onPlan(plan: TeamPlan) {
    if (plan.status !== 'pending') return planGone(plan.id);
    const looking = panel.isOpen && panel.tab === 'chat' && panel.chat.agentId === plan.agentId && !document.hidden && document.hasFocus();
    if (looking) return planSeen(plan.id);
    const who = store.state.agents[plan.agentId]?.name ?? 'The lead';
    const open = () => (store.state.agents[plan.agentId] ? shell.openAgent(plan.agentId) : undefined);
    if (alertPlan(plan, who, open)) {
      toasts.show('info', `${who} has a plan for you: “${plan.title}” — Run it, change the models, or cancel.`, {
        agentId: plan.agentId,
        projectId: plan.projectId,
        onClick: store.state.agents[plan.agentId] ? open : undefined,
      });
    }
  }

  function onStoreChange(msg?: ServerMsg) {
    if (!msg) {
      const s = store.state;
      if (s.view !== view.view || s.currentProjectId !== view.projectId) setView({ view: s.view, projectId: s.currentProjectId });
      renderConnection();
    }
    if (msg?.t === 'toast') {
      const { agentId, projectId } = msg;
      toasts.show(msg.level, msg.text, {
        agentId,
        projectId,
        onClick: agentId && store.state.agents[agentId] ? () => shell.openAgent(agentId) : undefined,
        record: !(msg.id && store.state.activity), // a house event: the server's activity log (state.activity) keeps it
      });
    }
    if (msg?.t === 'snapshot') {
      approvalsKnown(msg.approvals.map((a) => a.id));
      plansKnown((msg.plans ?? []).map((p) => p.id));
      for (const r of msg.runs ?? []) runStatus.set(r.id, r.status);
      renderConnection(); // the first one: the houses are in, no "loading" banner
    }
    if (msg?.t === 'run') onRun(msg.run);
    if (msg?.t === 'plan') onPlan(msg.plan);
    if (msg?.t === 'transcript_upsert' && msg.item.kind === 'plan') onPlan(msg.item.plan);
    if (msg?.t === 'approval') {
      const a = msg.approval;
      const who = store.state.agents[a.agentId]?.name ?? 'Someone';
      alertApproval(a, who, () => shell.openAgent(a.agentId));
      const where = store.project(a.projectId)?.name;
      announcer.say(approvalAnnouncement(a, who, where));
    }
    if (msg?.t === 'approval_resolved') {
      approvalGone(msg.id);
      dropDraft(msg.id); // an ask's picks (answered here, elsewhere, or withdrawn)
    }
    if (msg?.t === 'models' || msg?.t === 'snapshot') providers.onModels();
    if (msg?.t === 'login') providers.onLogin(msg.login);
    if (msg?.t === 'city' || msg?.t === 'snapshot') {
      onboarding.onCity();
      terminal.onCity();
      // a board start opens the panel before the town arrives (the town's Inbox): now the house last used is known
      if (boardOpenedPanel && panel.isOpen && !panel.projectId && view.view !== 'house') {
        const pid = townPanelHouse(store.state.city.projects.map((p) => p.id));
        if (pid) panel.open('chat', pid);
      }
    }
    if (msg?.t === 'models' || msg?.t === 'hello') onboarding.onCity(); // its AI-account / runs-as facts
    if (msg?.t === 'jobs') terminal.onCity(); // a deleted job's own-copy shell is gone

    schedule('topbar', topbar.render);
    schedule('approvals', approvals.render);
    schedule('title', renderTitle);
    if (!msg || msg.t === 'hello' || msg.t === 'models') schedule('ompwarning', ompWarning.render);
    if (msg?.t === 'snapshot') noticeInterrupted(shell, store.state.agents);
    if (!msg || msg.t === 'city' || msg.t === 'snapshot' || msg.t === 'jobs' || msg.t === 'agent' || msg.t === 'agent_removed') schedule('actionbar', actionbar.render);
    if (msg?.t !== 'transcript_upsert') schedule('floors', floorSwitch.render);
    if (!msg || msg.t === 'city' || msg.t === 'jobs' || msg.t === 'snapshot' || msg.t === 'models' || msg.t === 'workflows') schedule('jobdialog', refreshJobDialog);
    if (focusMode) schedule('focusview', focusView.render);
    else if (view.view === 'city') schedule('main', mainView.render);
    if (diff.isOpen && (!msg || msg.t === 'git' || msg.t === 'snapshot')) schedule('diff', () => diff.onState());
    // The side panel diffs per message type, so it is fed synchronously (streaming text stays smooth).
    panel.onState(msg);
  }

  let mounted = false;
  return {
    mount(host: HTMLElement) {
      if (mounted) return;
      mounted = true;
      ensureFonts();
      root.dataset.view = view.view;
      // The top bar comes first: screen readers and Tab meet the banner (city, house, tools) before the board. The board
      // still paints under it (css/hud.css .focus-view).
      root.append(
        topbar.el,
        mainView.el,
        floorSwitch.el,
        offline,
        ompWarning.el,
        toasts.el,
        panel.el,
        approvals.el,
        actionbar.el,
        terminal.el,
        diff.el,
        palette.el,
        onboarding.el,
        announcer.el,
      );
      host.appendChild(root);
      installViewport(root); // phones: where the on-screen keyboard is (--kb / --vvh / .is-kb)
      guardScenePinch(document.getElementById('scene'));
      // Keyboard and screen-reader plumbing for the whole UI: option groups (one Tab stop, arrow keys), focus that
      // never falls to <body> after a re-render or a close, and the single-key / solid-panel preferences.
      installOptionGroups();
      installFocusGuard(root);
      setFocusFallback(() => mainView.focusHeading());
      const syncPrefs = () => {
        root.classList.toggle('no-single-keys', !singleKeysEnabled());
        root.classList.toggle('is-solid', a11yPref('solid'));
      };
      syncPrefs();
      onSingleKeysChange(syncPrefs);
      onA11yPref(syncPrefs);
      panel.onChange(() => schedule('title', renderTitle)); // (the approval stack has its own hook, by createApprovalStack)
      const touched = () => (boardOpenedPanel = false);
      panel.el.addEventListener('pointerdown', touched, true);
      panel.el.addEventListener('focusin', touched, true);
      let was3D = threeD.state;
      threeD.onChange(() => {
        // the town's code didn't arrive: the board stays, 3D can be picked again (nothing is remembered; main.ts then
        // reloads the page, the only way a browser fetches a failed module again)
        if (was3D === 'loading' && threeD.state === 'idle' && threeD.wanted) {
          threeD.want(false);
          toasts.show('warn', 'Couldn’t load the 3D town (connection problem). The board has everything; pick 3D in the top bar to reload and try again.');
        }
        was3D = threeD.state;
        if (threeD.state === 'ready' && threeD.wanted) shell.setFocusMode(false);
        if (threeD.state === 'unavailable' && threeD.wanted) {
          threeD.want(false);
          rememberBoard(true);
          toasts.show('warn', 'The 3D town couldn’t start in this browser — staying on the board.');
        }
        schedule('topbar', topbar.render);
        schedule('focusview', focusView.render);
      });

      store.subscribe((_s, msg) => onStoreChange(msg));
      bus.on('view:changed', (p) => setView({ view: p.view, projectId: p.projectId ?? null }));
      bus.on('person:click', (p) => shell.openAgent(p.agentId));
      bus.on('tv:click', (p) => shell.openDiff(p.projectId, undefined, { house: true })); // what that TV shows
      bus.on('board:click', (p) => shell.openWorkflow(p.projectId));
      bus.on('computer:click', (p) => shell.openTerminal(houseTermTarget(shell, p.projectId)));
      bus.on('lot:click', (p) => shell.openPlacement(p.lotId));
      bus.on('room:click', (p) => {
        if (!store.project(p.projectId)) return;
        const job = jobAt(shell, p.projectId, p);
        if (job) shell.selectJob(p.projectId, job.id, { focus: true, openPanel: true });
        else shell.openNewJob(p.projectId, { floor: p.floor, slot: p.slot });
      });
      bus.on('floor:changed', (p) => floorSwitch.onFloorChanged(p.projectId, p.floor));
      bus.on('landmark:click', (p) => {
        if (p.landmarkId === 'agency') shell.openProviders();
      });
      bus.on('quality:change', (p) => {
        if (p.quality !== quality) {
          quality = p.quality;
          schedule('topbar', topbar.render);
        }
      });
      bus.on('focusmode:change', (p) => {
        if (p.on !== focusMode) applyFocusMode(p.on);
      });

      installKeyboard(shell, {
        togglePalette: () => palette.toggle(),
        openHelp: () => shell.openHelp(),
        toggleTerminal: () => terminal.toggle(termHere()),
        answerApproval: (id, kind) => approvals.answer(id, kind),
        focusPanelPane: () => panel.focusPane(),
        panelOpen: () => panel.isOpen,
        closePanel: () => shell.closePanel(),
        openJobs: () => {
          const pid = shell.contextProjectId();
          if (!pid || !store.jobsOf(pid).length) return false;
          if (!panel.isOpen || panel.projectId !== pid) shell.openPanel('chat', pid);
          requestAnimationFrame(() => panel.jobs.open());
          return true;
        },
        focusChat: () => {
          const current = panel.chat.agentId && store.state.agents[panel.chat.agentId] ? panel.chat.agentId : null;
          const pid = shell.contextProjectId();
          const job = pid ? jobChoice.active(pid) : undefined;
          const target = current ?? (pid ? (job ? store.agentsOfJob(pid, job.id) : store.agentsOf(pid))[0]?.id : undefined);
          if (target) shell.openAgent(target, { focusComposer: true });
          else palette.open();
        },
      });

      // Who this browser is (and whether the terminal is on); reload to the "signed out" page if it gets signed out.
      void loadSession();
      watchAccess(store);

      topbar.render();
      actionbar.render();
      approvals.render();
      mainView.render();
      renderTitle();
      renderConnection();
      ompWarning.render();
      // `?settings=pair` (the Mac menu bar's "Pair a phone…"): what the link asked for comes first; the welcome tour
      // waits for the next visit
      const settingsLink = takeSettingsLink();
      if (settingsLink !== null) shell.openSettings(settingsLink || undefined);
      // the welcome's next step is the first house, else placing one, and it says whether an AI account is connected:
      // it waits for the first snapshot, so it never offers "Place your first project" to a town still on its way
      else if (!onboardingDismissed()) whenSynced(store, () => !onboardingDismissed() && onboarding.open());
      // the installed app: service worker, icon badge, notifications, shortcuts (web/src/pwa)
      installPwa({ store, toast: shell.toast, openInbox: () => shell.openPanel('inbox'), openSettings: (s) => shell.openSettings(s) });
    },
    openAgent: (id) => shell.openAgent(id),
    openWorkflow: (pid) => shell.openWorkflow(pid),
    openDiff: (pid) => shell.openDiff(pid),
    openPlacement: (lotId) => shell.openPlacement(lotId),
    openProviders: () => shell.openProviders(),
    closePanels() {
      while (layers.closeTop()) {
        /* close every dialog, menu and overlay */
      }
      panel.close();
    },
  };
}

