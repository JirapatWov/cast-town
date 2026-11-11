// Workflow tab: pick a saved team, edit the people in it, give the team a task, watch the run. Goal first: the lead
// picks or builds a team for each task on its own, so editing teams here is optional. The list is this house's
// workflows (shared/house-workflows.ts): the ones saved or imported here; a new house has none. Below it, the shared
// library: a house imports a copy of one, and puts a copy of its own in it (workflow-library.ts).
import { MAX_WORKFLOW_STEPS, type AgentInfo, type RevertPlan, type ServerMsg, type Workflow, type WorkflowRun, type WorkflowStep } from '../../../shared/protocol';
import { autosize, h, memo, setChildren } from './dom';
import { describeTeam } from '../../../shared/team-text';
import { fmtClock, fmtDuration, listJoin, modelLabel, slugify, vendorColor, vendorOfModel } from './format';
import { icon } from './icons';
import { RequestError } from '../net/requests';
import { openPopover } from './popover';
import { reviewChip, roleCard, roleModelLine } from './role-card';
import { runTimeline } from './run-timeline';
import { addRunStep, editRunStep, noteRunStep } from './run-edit';
import { codeBadge } from './job-switcher';
import { MAIN_JOB, jobRoomCode, kindInfo } from './jobs';
import { fixLoopTargets, stepGroups, teamLine } from './plans';
import { continuableSteps, continuedBy, isAdhocRun, isRunActive, keptFromReverted, runTeam, runsOf } from './runs';
import type { Shell } from './shell';
import { emptyState, kbd, modKey, optionNames, uid } from './widgets';
import { teamHeading } from './team-default';
import { workStyleChip } from './work-style';
import { canPromote, importAsk, libraryRows, peopleText, promoteAsk, removeFromLibraryAsk, type LibraryAsk, type LibraryRow } from './workflow-library';
import { deleteAsk, teamOfJob, workflowUse } from './workflow-use';
import { blockOpts } from './agents-health';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function newStep(index: number, prev?: WorkflowStep): WorkflowStep {
  return {
    id: `role-${Date.now().toString(36)}${index}`,
    name: `Person ${index + 1}`,
    model: prev?.model ?? 'anthropic/claude-sonnet-5-5',
    thinking: 'medium',
    persona: '',
    instruction: index === 0 ? '{{task}}' : 'Continue from {{prevName}}:\n\n{{prev}}\n\nOriginal task: {{task}}',
    kind: 'work',
  };
}

export function createWorkflowTab(shell: Shell) {
  const { store } = shell;
  let projectId: string | null = null;
  let jobId: string = MAIN_JOB;
  let selectedId: string | null = null;
  let draft: Workflow | null = null;
  let baseline = '';
  let expanded = new Set<string>();
  const advancedOpen = new Set<string>(); // step ids whose Advanced part is open
  const parkedLoops = new Map<string, string>(); // review step id → the target it lost by joining the first group
  let seenTeam: string | null | undefined; // the job's team when the tab last looked (see sync)
  let saving = 0; // saves on the wire: their own broadcast lands before the ack, so it isn't "changed meanwhile"
  const tasks = new Map<string, string>(); // unsent task text per "<project>/<job>"
  const openOutputs = new Set<string>(); // "runId:attemptIndex" of expanded step outputs ("runId:edits": its changes list)
  let pickedRun: string | null = null; // a run opened from elsewhere ("Open run" on a plan card); else the latest
  let fadedRun: string | null = null; // the run card fades in once per run, not on every update
  const againNotes = new Map<string, string>(); // unsent "What should be different?" per "<runId>:<stepId>"
  let follow: string | null = null; // a workflow just imported: selected once the workflows broadcast brings it
  let busy = false;

  const introEl = h('p', { class: 'wf-intro' });
  const styleEl = h('div', { class: 'wf-style' }); // how the lead works in this job (plan first / just go / on request)
  const jobEl = h('div', { class: 'wf-job' });
  const listTitle = h('h3', { id: uid('wf-list') }, 'This house’s workflows');
  const listHead = h('div', { class: 'wf-section-head' }, listTitle);
  const templatesEl = h('div', { class: 'wf-templates', role: 'radiogroup', 'aria-labelledby': listTitle.id });
  const emptyEl = h('div', { class: 'wf-empty', hidden: true }); // in place of the list while the house has none
  // The shared library: workflows any house can import a copy of (none of them is this house's team until then).
  const libTitle = h('h3', { id: uid('wf-lib'), tabindex: '-1' }, 'Library');
  const libEl = h('section', { class: 'wf-lib', 'aria-labelledby': libTitle.id, hidden: true });
  const runEl = h('div', { class: 'wf-run' });
  const teamHead = h('div', { class: 'wf-section-head' });
  const staleEl = h('div', { class: 'wf-stale', role: 'status', hidden: true });
  const teamEl = h('div', { class: 'wf-team' });
  const taskInput = h('textarea', { class: 'input wf-task', rows: 2, placeholder: 'What should the team do?', 'aria-label': 'Task for the team' });
  const runBtn = h('button', { type: 'button', class: 'btn btn-primary' });
  // Save: the changes go into this workflow (own workflows only); the other button saves a copy under a new name.
  const plainSaveBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Save the changes to this workflow' }, icon('save', 14), 'Save');
  const saveBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' });
  // Delete, for the user's own workflows: here it is always on screen (the one by the Team heading is below the list).
  const deleteBtn = h('button', { type: 'button', class: 'icon-btn wf-compose-delete' }, icon('trash', 14));
  const composeHint = h('span', { class: 'wf-compose-hint' });
  const compose = h(
    'div',
    { class: 'wf-compose' },
    taskInput,
    h('div', { class: 'wf-compose-row' }, plainSaveBtn, saveBtn, deleteBtn, composeHint, runBtn),
  );
  // Outside the radiogroup: it opens the lead's chat instead of picking a template.
  const askBtn = h('button', {
    type: 'button',
    class: 'wf-add wf-ai',
    // No job/house name in it: a colon or a CI word there would confuse the scripted test model's parser.
    onclick: () => askLead('Design a team workflow and use it for this job. The team should: '),
  });
  const scroll = h('div', { class: 'wf-scroll' }, introEl, styleEl, jobEl, listHead, templatesEl, emptyEl, libEl, askBtn, runEl, teamHead, staleEl, teamEl);
  const el = h('div', { class: 'tab-workflow' }, scroll, compose);

  const dirty = () => !!draft && JSON.stringify(draft) !== baseline;
  /** The workflows this house sees: the ones saved or imported here. */
  const workflows = () => store.workflowsOf(projectId);
  const workflowById = (id: string | null | undefined) => store.workflowOf(projectId, id);
  const project = () => store.project(projectId);
  const job = () => (projectId ? store.job(projectId, jobId) : undefined);
  const taskKey = () => `${projectId}/${jobId}`;
  /** Runs of the job this tab follows (runs saved before jobs existed belong to 'main'). */
  const jobRuns = (): WorkflowRun[] => (projectId ? runsOf(store.state, projectId).filter((r) => (r.jobId ?? MAIN_JOB) === jobId) : []);
  const activeRun = (): WorkflowRun | undefined => jobRuns().find(isRunActive);
  /** The job's own team; the 'main' job falls back to the house's default workflow. */
  const teamId = (): string | null => teamOfJob(job(), project());
  /** The job's lead: the one who designs teams from chat (the workflow_* tools). */
  const lead = (): AgentInfo | undefined =>
    projectId
      ? (store.jobsOf(projectId).length ? store.agentsOfJob(projectId, jobId) : store.agentsOf(projectId)).find((a) => a.roleId === 'assistant' && a.kind !== 'subagent')
      : undefined;
  const leadName = () => lead()?.name ?? kindInfo(job()?.kind).lead;

  /** Open the lead's chat with a starter sentence for the user to finish (it never replaces what they typed there). */
  function askLead(text: string) {
    const l = lead();
    if (!l) return shell.toast('info', `The ${leadName()} hasn't moved into this room yet — try again in a moment.`);
    shell.openAgent(l.id, { focusComposer: true, draft: text });
  }

  const askChanged = memo();
  function renderAsk() {
    renderEmpty(); // it names the lead too
    const name = leadName();
    if (!askChanged(name)) return;
    introEl.textContent = `The ${name} picks or builds a team for each task. Edit teams only if you want to.`;
    askBtn.title = `Describe the team in chat — the ${name} builds the workflow and can make it this job's team`;
    setChildren(askBtn, icon('sparkle', 15), `Create with the ${name}`);
  }

  const styleChanged = memo();
  function renderStyle() {
    const j = job();
    if (!styleChanged([j?.projectId, j?.id, j?.name, j?.workStyle, leadName()])) return;
    setChildren(styleEl, j ? workStyleChip(shell, j, leadName()) : null);
  }

  const jobChanged = memo();
  function renderJob() {
    const j = job();
    const many = projectId ? store.jobsOf(projectId).length > 1 : false;
    if (!jobChanged([j?.id, j?.name, j?.kind, j?.room, many])) return;
    if (!j || !many) return setChildren(jobEl);
    setChildren(jobEl,
      codeBadge(j, 'sm'),
      h('span', { class: 'wf-job-text' }, 'Team for ', h('strong', null, j.name)),
      h('span', { class: 'muted small' }, `runs in room ${jobRoomCode(j)}`),
    );
  }

  /** Whether the job's team moved since the tab last looked (a team whose workflow isn't in the list yet counts once it arrives). */
  const teamMoved = (team = teamId()) => team !== seenTeam && (!team || !!workflowById(team));
  /** The job's new team, when it moved to a workflow other than the selected one: the one to show next. */
  const newTeam = (): string | null => {
    const team = teamId();
    return team && team !== selectedId && teamMoved(team) ? team : null;
  };
  /** The tab has now looked at the job's team: a move it saw (or the user passed over) isn't followed again. */
  function teamSeen() {
    const team = teamId();
    if (teamMoved(team)) seenTeam = team;
  }

  /** Drop the draft for what the server has now: the job's team when it moved meanwhile, else the selected workflow. */
  const reload = () => select(newTeam() ?? selectedId);

  /** Show this workflow; one the house doesn't have (none, deleted) falls back to its first, else nothing. */
  function select(id: string | null) {
    teamSeen(); // picking/reloading is looking: a later sync won't swap this choice for the job's team
    const wf = workflowById(id) ?? workflows()[0];
    selectedId = wf?.id ?? null;
    draft = wf ? clone(wf) : null;
    baseline = draft ? JSON.stringify(draft) : '';
    expanded = new Set();
    parkedLoops.clear();
    renderTemplates();
    renderTeam();
    renderCompose();
  }

  function renderTemplates() {
    const list = workflows();
    const team = teamId();
    // an older server's list is every house's
    listTitle.textContent = store.state.houseWorkflows ? 'This house’s workflows' : 'Workflows';
    renderEmpty();
    setChildren(templatesEl,
      ...list.map((w) => {
        const name = h(
          'span',
          { class: 'wf-tpl-name' },
          w.name,
          // picking a card only opens it here: this says which one the job actually uses (the job's Edit job → Team sets it)
          w.id === team ? h('span', { class: 'wf-tpl-tag wf-tpl-team', title: 'This job works with this team — change it in the job’s Edit job → Team' }, 'This job’s team') : null,
        );
        const desc = h('span', { class: 'wf-tpl-desc' }, w.description);
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(w.id === selectedId),
            class: ['wf-tpl', w.id === selectedId && 'is-on'],
            title: w.description,
            ...optionNames(name, desc),
            onclick: () => {
              if (w.id !== selectedId) select(w.id);
            },
          },
          h('span', { class: 'wf-tpl-icon', 'aria-hidden': 'true' }, w.icon || '•'),
          h('span', { class: 'wf-tpl-text' }, name, desc),
          h(
            'span',
            { class: 'wf-tpl-dots', 'aria-hidden': 'true' },
            w.steps.map((st) => h('span', { style: { background: vendorColor(vendorOfModel(st.model, store.state.models)) } })),
          ),
          w.id === selectedId && dirty() ? h('span', { class: 'wf-tpl-edited' }, 'edited') : null,
        );
      }),
    );
  }

  const emptyChanged = memo();
  /** No workflows in this house (a new house has none): a note in place of the list. */
  function renderEmpty() {
    const none = !!projectId && !workflows().length;
    const name = leadName();
    if (!emptyChanged([none, name])) return;
    templatesEl.hidden = none;
    emptyEl.hidden = !none;
    setChildren(emptyEl, none ? emptyState('users', 'No workflows in this house yet', `The ${name} builds a team for each task. To keep one, press Create with the ${name}.`) : null);
  }

  const libChanged = memo();
  /** The Library section: each workflow with Import (a copy into this house) and Remove from the library. Hidden on an
   *  older server (it has no library). A rebuild keeps the focus on the same button (or the next row, or the heading). */
  function renderLibrary() {
    const has = !!store.state.library && !!projectId;
    const rows = has ? libraryRows(store.state, projectId) : [];
    if (!libChanged([has, projectId, rows])) return;
    libEl.hidden = !has;
    if (!has) return setChildren(libEl);
    const active = document.activeElement instanceof HTMLElement && libEl.contains(document.activeElement) ? document.activeElement : null;
    const at = active ? [...libEl.querySelectorAll('[data-key]')].indexOf(active) : -1;
    setChildren(libEl,
      h('div', { class: 'wf-section-head' }, libTitle, rows.length ? h('span', { class: 'muted small' }, 'Any house can import a copy') : null),
      rows.length
        ? h('ul', { class: 'wf-lib-list', role: 'list' }, rows.map(libraryItem))
        : h('p', { class: 'wf-lib-empty' }, 'Empty. To share one of this house’s own workflows with the other houses, open it and press Put in the library (the book button by its Team heading).'),
    );
    if (!active) return;
    const keys = [...libEl.querySelectorAll<HTMLElement>('[data-key]')];
    (keys.find((b) => b.dataset.key === active.dataset.key) ?? keys[Math.min(Math.max(at, 0), keys.length - 1)] ?? libTitle).focus();
  }

  function libraryItem(row: LibraryRow): HTMLElement {
    const name = h('span', { class: 'wf-tpl-name' }, row.name,
      row.here ? h('span', { class: 'wf-tpl-tag', title: 'This house has a workflow with this id — importing replaces it (it asks first)' }, 'In this house') : null);
    const meta = h('span', { class: 'wf-tpl-desc', id: uid('wf-lib-meta') }, `${peopleText(row.people)} · ${row.from}`);
    return h(
      'li',
      { class: 'wf-lib-item' },
      h('div', { class: 'wf-lib-row', title: row.description || undefined },
        h('span', { class: 'wf-tpl-icon', 'aria-hidden': 'true' }, row.icon),
        h('span', { class: 'wf-tpl-text' }, name, meta),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-soft btn-sm wf-lib-import',
          'data-key': `import:${row.id}`,
          'aria-label': `Import “${row.name}”`,
          'aria-describedby': meta.id,
          title: row.here ? 'Replace this house’s copy with the library’s (it asks first)' : 'Copy it into this house: then it is this house’s own workflow',
          onclick: () => void importWorkflow(row),
        },
        icon('arrowDown', 13),
        'Import',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn wf-lib-remove',
          'data-key': `remove:${row.id}`,
          'aria-label': `Remove “${row.name}” from the library`,
          title: 'Remove from the library (houses keep their copies)',
          onclick: () => void removeFromLibrary(row),
        },
        icon('trash', 14),
      ),
    );
  }

  const askFirst = (ask: LibraryAsk, iconName: string) =>
    shell.confirm({ title: ask.title, body: h('div', null, ask.text.map((t) => h('p', null, t))), confirmLabel: ask.confirmLabel, tone: ask.danger ? 'danger' : 'default', icon: iconName });

  /** Copy a library workflow into this house (import_workflow), replacing the house's own with that id when the user
   *  says so; then show it. */
  async function importWorkflow(row: LibraryRow) {
    if (!projectId) return;
    const pid = projectId;
    const ask = importAsk(store.state, pid, row.id);
    if (ask && !(await askFirst(ask, 'arrowDown'))) return;
    try {
      const res = await store.request<{ workflow?: Workflow } | undefined>({ t: 'import_workflow', reqId: '', projectId: pid, workflowId: row.id, ...(ask ? { replace: true } : {}) });
      shell.toast('success', `Imported “${res?.workflow?.name ?? row.name}” — it’s this house’s own now`, { projectId: pid });
      if (projectId !== pid) return; // the tab is on another house now
      // show it — now, or when the workflows broadcast brings it
      const id = res?.workflow?.id ?? row.id;
      if (workflowById(id)) select(id);
      else follow = id;
    } catch (err) {
      shell.toast('error', `Could not import “${row.name}”: ${(err as Error).message}`);
    }
  }

  /** Take a workflow out of the library (delete_library_workflow): the houses' copies stay theirs. */
  async function removeFromLibrary(row: LibraryRow) {
    if (!(await askFirst(removeFromLibraryAsk(row.name), 'trash'))) return;
    try {
      await store.request({ t: 'delete_library_workflow', reqId: '', workflowId: row.id });
      shell.toast('info', `Took “${row.name}” out of the library`);
    } catch (err) {
      shell.toast('error', `Could not remove “${row.name}” from the library: ${(err as Error).message}`);
    }
  }

  /** Put a copy of this house's own saved workflow in the library (promote_workflow): the saved one, not unsaved edits. */
  async function promote(wf: Workflow) {
    if (!projectId) return;
    const pid = projectId;
    if (dirty() && draft?.id === wf.id) return shell.toast('info', `Save your changes first — the library gets “${wf.name}” as it is saved.`);
    const ask = promoteAsk(store.state, wf);
    if (ask && !(await askFirst(ask, 'book'))) return;
    try {
      await store.request({ t: 'promote_workflow', reqId: '', projectId: pid, workflowId: wf.id, ...(ask ? { replace: true } : {}) });
      shell.toast('success', `Put “${wf.name}” in the library — other houses can import it now`, { projectId: pid });
    } catch (err) {
      shell.toast('error', `Could not put “${wf.name}” in the library: ${(err as Error).message}`);
    }
  }

  // Live clocks: the timeline is only rebuilt on state changes, so tick the running durations in place.
  setInterval(() => {
    if (!runEl.isConnected) return;
    const now = Date.now();
    for (const span of runEl.querySelectorAll<HTMLElement>('[data-since]')) {
      // working time: minus the waits for the user (closed ones, and the one going on — the clock stops while waiting)
      const from = span.dataset.waitFrom ? Number(span.dataset.waitFrom) : null;
      const ms = (from ?? now) - Number(span.dataset.since) - Number(span.dataset.wait ?? 0);
      span.textContent = span.dataset.fmt === 'clock' ? fmtClock(ms) : fmtDuration(ms);
    }
  }, 1000);

  const runChanged = memo();
  function renderRun() {
    const latest = jobRuns()[0];
    const picked = pickedRun ? store.state.runs[pickedRun] : undefined;
    const run = picked ?? latest;
    const older = !!picked && !!latest && picked.id !== latest.id;
    const live = run?.steps.filter((st) => st.status === 'running').map((st) => store.state.agents[st.agentId]);
    const present = run?.steps.map((st) => !!store.state.agents[st.agentId]); // one-off people leave after the run
    const going = activeRun();
    // a continuation links to the run it continues, a continued run to the later one
    const links = run ? [run.continues ? store.state.runs[run.continues.runId]?.startedAt : null, continuedBy(store.state, run)[0]?.id] : null;
    // kept rows: a revert of the run they came from changes where this one can run again from
    const sources = run?.steps.map((st) => !!st.reused && keptFromReverted(st, store.state.runs));
    // requests of the run's people: their cards sit in the step that waits
    const asks = run ? Object.values(store.state.approvals).filter((a) => run.steps.some((st) => st.status === 'running' && st.agentId === a.agentId)).map((a) => a.id) : null;
    // the people's model chips: connected or not (not while the first check runs, nor on the scripted test model)
    const reach = [store.state.models.map((m) => m.available), blockOpts(store.state.hello)];
    if (!runChanged([projectId, jobId, run, older, older && isRunActive(latest!), live?.map((a) => [a?.activity, a?.detail]), present, reach, going?.id, links, sources, asks])) return;
    if (!run) return setChildren(runEl);
    const ended = !isRunActive(run);
    const card = runTimeline(shell, run, openOutputs, {
      onAbort: () => store.send({ t: 'abort_run', runId: run.id }),
      onRevert: () => void revert(run),
      onKeep: isAdhocRun(run) && ended ? (anchor) => keepTeam(run, anchor) : undefined,
      onContinue: ended ? (stepId, anchor) => continueRun(run, stepId, anchor) : undefined,
      continueBlocked: ended && going ? 'A run is going in this job' : undefined,
      onShowRun: (id) => showRunCard(id),
      // while it runs: its later steps change in place, the person working now gets a note (it keeps going)
      onEditStep: ended ? undefined : (stepId) => void editRunStep(shell, run, stepId),
      onAddStep: ended ? undefined : () => void addRunStep(shell, run),
      onNote: ended ? undefined : (stepId, name, anchor) => noteRunStep(shell, run, stepId, name, anchor),
    });
    // Rebuilt on every update of a live run: only a run that wasn't shown before fades in (else it flickers).
    if (run.id !== fadedRun) card.classList.add('is-new');
    fadedRun = run.id;
    setChildren(runEl,
      older
        ? h(
            'p',
            { class: 'wf-run-note' },
            icon('clock', 13),
            h('span', null, 'An earlier run of this job — '),
            h('button', { type: 'button', class: 'link-btn', onclick: () => pickRun(null) }, isRunActive(latest!) ? 'show the one running now' : 'show the latest'),
          )
        : null,
      card,
      // the team below is the saved workflow: what's changed there is for next time, not this run
      !ended && run.workflowId && run.workflowId === teamId()
        ? h('p', { class: 'wf-run-note wf-run-live' }, icon('pencil', 13), h('span', null, 'Changes to the team below are for next time — to change this run, use Edit on its up-next steps above.'))
        : null,
    );
  }

  /** Show this run instead of the latest (null: back to the latest). */
  function pickRun(id: string | null) {
    pickedRun = id;
    renderRun();
  }

  /** Show this run and scroll its card into view. */
  function showRunCard(id: string | null) {
    pickRun(id);
    if (id) requestAnimationFrame(() => scroll.scrollTo({ top: Math.max(0, scroll.scrollTop + runEl.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 8), behavior: 'smooth' }));
  }

  /** "Run again from here" (continue_run): the steps before `stepId`'s group keep their results, that group and
   *  everyone after it work again on the files as they are now. The server checks it all again and says why not. */
  function continueRun(run: WorkflowRun, stepId: string, anchor: HTMLElement) {
    const team = runTeam(store.state, run);
    const groups = stepGroups(team);
    const start = continuableSteps(run, team, store.state.runs).get(stepId) ?? stepId;
    const at = Math.max(0, groups.findIndex((g) => g.some((m) => m.id === start)));
    const group = groups[at] ?? [];
    const name = group.map((m) => m.name).join(' + ') || stepId;
    const kept = groups.slice(0, at).flat();
    const key = `${run.id}:${start}`;
    const note = h('textarea', {
      class: 'input again-note',
      rows: 3,
      maxlength: '8000',
      placeholder: 'e.g. Check the error handling more closely',
      'aria-describedby': 'again-pop-text',
    });
    note.value = againNotes.get(key) ?? '';
    note.addEventListener('input', () => {
      autosize(note, 180);
      if (note.value) againNotes.set(key, note.value);
      else againNotes.delete(key);
    });
    const go = async () => {
      const text = note.value.trim();
      close();
      try {
        const res = await store.request<{ runId?: string } | undefined>({ t: 'continue_run', reqId: '', runId: run.id, fromStepId: start, ...(text ? { note: text } : {}) });
        againNotes.delete(key);
        shell.toast('info', `“${run.workflowName}” runs again from ${name}`, { projectId: run.projectId });
        if (res?.runId) showRunCard(res.runId);
      } catch (err) {
        shell.toast('error', `Could not run it again: ${(err as Error).message}`);
      }
    };
    note.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
        ev.preventDefault();
        void go();
      }
    });
    const pop = h(
      'div',
      { class: 'save-pop again-pop glass-strong', role: 'dialog', 'aria-label': `Run again from ${name}` },
      h('p', { class: 'again-pop-title' }, icon('loop', 14), `Run again from ${name}`),
      h(
        'p',
        { class: 'again-pop-text', id: 'again-pop-text' },
        kept.length === 1 ? `${kept[0].name} keeps its result. ` : kept.length ? `${teamLine(kept)} stay as they are, with their results. ` : '',
        at < groups.length - 1 ? `${name} and everyone after them work again` : `${name} work${group.length === 1 ? 's' : ''} again`,
        ' on the files as they are now — nothing is reverted.',
      ),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'What should be different? (optional)'), note),
      h(
        'div',
        { class: 'save-pop-actions' },
        h('span', { class: 'again-pop-hint' }, kbd(modKey, 'Enter')),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => void go() }, icon('play', 13), 'Run'),
      ),
    );
    const close = openPopover(shell.root, shell.layers, anchor, pop, { id: 'continue-run', align: 'start' });
    requestAnimationFrame(() => note.focus());
  }

  /** "Keep this team": a one-off team the lead made becomes a saved workflow (save_run_team). */
  function keepTeam(run: WorkflowRun, anchor: HTMLElement) {
    // a name no workflow has yet (the lead's one-off team may be called like a saved one), like Save as copy
    const input = h('input', { class: 'input', value: uniqueName(run.workflowName), 'aria-label': 'Workflow name', maxlength: '60' });
    const go = async () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      close();
      try {
        const res = await store.request<{ workflow?: Workflow } | undefined>({ t: 'save_run_team', reqId: '', runId: run.id, name });
        shell.toast('success', `Kept the team as “${res?.workflow?.name ?? name}” — it’s with this house’s workflows now`);
        if (res?.workflow && run.projectId === projectId) {
          // show it — now, or when the workflows broadcast brings it (sync reloads the selected id then)
          teamSeen();
          selectedId = res.workflow.id;
          if (workflowById(selectedId)) select(selectedId);
        }
      } catch (err) {
        shell.toast('error', `Could not keep the team: ${(err as Error).message}`);
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) void go();
    });
    const pop = h(
      'div',
      { class: 'save-pop glass-strong' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Keep this team as'), input),
      h('div', { class: 'save-pop-actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: go }, 'Keep')),
    );
    const close = openPopover(shell.root, shell.layers, anchor, pop, { id: 'keep-team', placement: 'above', align: 'start' });
    requestAnimationFrame(() => input.select());
  }

  /** Delete a saved workflow. The dialog says which jobs have it as their team (they get no fixed team
   *  when the user goes ahead) and, while it runs, offers to stop the run first: it is never deleted during one. */
  async function removeWorkflow(wf: Workflow) {
    if (!projectId) return;
    const pid = projectId;
    const ask = deleteAsk(wf, workflowUse(store.state, pid, wf.id), { inLibrary: !!store.state.library?.some((e) => e.workflow.id === wf.id) });
    const ok = await shell.confirm({
      title: ask.title,
      body: h('div', null, ask.text.map((t) => h('p', null, t))),
      confirmLabel: ask.confirmLabel,
      tone: 'danger',
      icon: ask.stopRuns ? 'stop' : 'trash',
    });
    if (!ok) return;
    if (ask.stopRuns) {
      for (const { runId } of workflowUse(store.state, pid, wf.id).runs) store.send({ t: 'abort_run', runId });
      shell.toast('info', `Stopping “${wf.name}” — delete it once the run has stopped.`);
      return;
    }
    try {
      const res = await store.request<{ cleared?: string[] } | undefined>({ t: 'delete_workflow', reqId: '', projectId: pid, workflowId: wf.id, ...(ask.clearTeams ? { clearTeams: true } : {}) });
      const cleared = (res?.cleared ?? []).map((c) => `“${c}”`);
      shell.toast('info', cleared.length ? `Deleted “${wf.name}” — ${listJoin(cleared)} ${cleared.length === 1 ? 'has' : 'have'} no fixed team now` : `Deleted “${wf.name}”`);
      if (projectId === pid && selectedId === wf.id) select(teamId());
    } catch (err) {
      shell.toast('error', `Could not delete “${wf.name}”: ${(err as Error).message}`);
    }
  }

  /** A continuation: the name of the step it worked again from ('' for a plain run). */
  function continuedFrom(run: WorkflowRun): string {
    if (!run.continues) return '';
    const id = run.continues.stepId;
    return runTeam(store.state, run).find((m) => m.id === id)?.name ?? id;
  }

  async function revert(run: WorkflowRun) {
    let plan: RevertPlan;
    try {
      plan = (await store.request<{ plan: RevertPlan }>({ t: 'revert_run', reqId: '', runId: run.id, preview: true })).plan;
    } catch (err) {
      shell.toast('error', `Could not revert: ${(err as Error).message}`);
      return;
    }
    if (!plan.files.length) {
      shell.toast('info', plan.kept.length ? `Nothing to revert: every file “${run.workflowName}” changed was changed again since.` : `“${run.workflowName}” didn't change any files.`);
      return;
    }
    const list = (paths: string[]) =>
      h('ul', { class: 'revert-files' }, paths.slice(0, 10).map((f) => h('li', null, h('code', null, f))), paths.length > 10 ? h('li', { class: 'muted' }, `and ${paths.length - 10} more`) : null);
    // A run of a job with its own copy of the files worked (and is reverted) in that copy, not in the house folder:
    // only that job's own people can have worked there beside it.
    const job = store.job(run.projectId, run.jobId ?? MAIN_JOB);
    const copy = job?.worktree;
    const ok = await shell.confirm({
      title: 'Revert this run?',
      body: h(
        'div',
        null,
        h(
          'p',
          null,
          `${plan.files.length === 1 ? 'This file goes' : `These ${plan.files.length} files go`} back to how ${plan.files.length === 1 ? 'it was' : 'they were'} before “${run.workflowName}” ${continuedFrom(run) ? `continued from ${continuedFrom(run)}` : 'started'} (files the run created are removed)`,
          copy ? [' in “', job!.name, '”’s own copy of the files (branch ', h('code', null, copy.branch), '):'] : ':',
        ),
        list(plan.files),
        plan.kept.length
          ? [h('p', null, copy ? 'Kept as they are — changed again after the run, or also edited by someone else in the job:' : 'Kept as they are — changed again after the run, or also edited by another job:'), list(plan.kept)]
          : null,
        (() => {
          // othersUnknown ran commands or sent helpers: their file edits can't be told apart from the run's
          const unknown = new Set(plan.othersUnknown ?? []);
          const known = plan.others.filter((p) => !unknown.has(p));
          return [
            known.length
              ? h('p', { class: 'revert-warn' }, icon('alert', 14), ` ${known.join(', ')} also worked ${copy ? 'in that copy' : 'in this folder'} during the run. Their own files are kept; check the list above.`)
              : null,
            unknown.size
              ? h('p', { class: 'revert-warn' }, icon('alert', 14), ` ${[...unknown].join(', ')} ran commands or used helpers during the run, so some of their changes may be in the list above and would go back too. Check it first.`)
              : null,
          ];
        })(),
        h('p', { class: 'muted' }, copy
          ? 'Only that copy changes: the house’s files, other files and your commits are not touched.'
          : 'Other files, your commits, branches and staged changes are not touched.'),
      ),
      confirmLabel: plan.files.length === 1 ? 'Revert 1 file' : `Revert ${plan.files.length} files`,
      tone: 'danger',
    });
    if (!ok) return;
    try {
      // the server announces the result (with what it kept) to every open window
      await store.request<{ plan: RevertPlan }>({ t: 'revert_run', reqId: '', runId: run.id });
      // the folder the run worked in: the job's own copy (state.git "projectId:jobId") or the house
      const now = store.job(run.projectId, run.jobId ?? MAIN_JOB);
      store.send(now?.worktree ? { t: 'get_git', projectId: run.projectId, jobId: now.id } : { t: 'get_git', projectId: run.projectId });
    } catch (err) {
      shell.toast('error', `Could not revert: ${(err as Error).message}`);
    }
  }

  /** The server's copy of the selected workflow moved on under unsaved edits (the lead saved it from chat…). */
  function stale(): boolean {
    const server = workflowById(selectedId);
    return !saving && dirty() && !!server && JSON.stringify(server) !== baseline;
  }

  const headChanged = memo();
  /** "Team" heading: Discard edits while the draft differs, else an ask for the lead to change it. Plus the note when
   *  the job's team or the selected workflow moved on under unsaved edits (the job's new team wins: Discard shows it). */
  function renderTeamHead() {
    const isDirty = dirty();
    const isStale = stale();
    const moved = isDirty ? newTeam() : null;
    const movedName = moved ? workflowById(moved)?.name : undefined;
    const name = leadName();
    const saved = workflowById(selectedId);
    const jobTeam = teamId();
    // a saved workflow of this house: it can go in the library
    const promotable = !!saved && canPromote(store.state, projectId, saved.id);
    const inLibrary = promotable && !!store.state.library?.some((e) => e.workflow.id === saved!.id);
    if (!headChanged([draft?.id, draft?.name, draft?.steps.length, draft && stepGroups(draft.steps).length, isDirty, isStale, movedName, name, saved?.id, saved?.name, jobTeam, promotable, inLibrary])) return;
    const focused = document.activeElement instanceof HTMLElement && teamHead.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    const discardBtn = () => h('button', { type: 'button', class: 'link-btn', onclick: reload }, 'Discard edits');
    staleEl.hidden = !movedName && !isStale;
    setChildren(staleEl,
      movedName
        ? [icon('alert', 14), h('span', null, `This job's team is now “${movedName}” (set from chat) — `, discardBtn(), ' to see it.')]
        : isStale
          ? [icon('alert', 14), h('span', null, `Changed meanwhile (by the ${name}?) — `, discardBtn(), ' to see it, or save to keep yours.')]
          : null,
    );
    if (!draft) return setChildren(teamHead);
    const steps = draft.steps;
    const together = stepGroups(steps).length < steps.length;
    const ask = `Change the “${draft.name}” workflow: `;
    const heading = teamHeading(jobTeam, name);
    setChildren(teamHead,
      h('h3', null, heading.title),
      h('span', { class: 'muted small' }, `${steps.length} ${steps.length === 1 ? 'person' : 'people'}, in order${together ? ', some at the same time' : ''}`),
      // the link and the buttons stay together (on the next line, at the right, when they don't fit)
      h(
        'span',
        { class: 'wf-head-tail' },
        isDirty
          ? discardBtn()
          : h(
              'button',
              { type: 'button', class: 'link-btn', title: `Tell the ${name} in chat what to change`, onclick: () => askLead(ask) },
              `Ask the ${name} to change it`,
            ),
        promotable
        ? h(
            'button',
            {
              type: 'button',
              class: 'icon-btn wf-delete wf-promote',
              'data-key': 'promote',
              title: inLibrary ? `Put “${saved!.name}” in the library again (it replaces the library’s copy, after asking)` : `Put “${saved!.name}” in the library: other houses can import a copy`,
              'aria-label': `Put ${saved!.name} in the library`,
              onclick: () => void promote(saved!),
            },
            icon('book', 14),
          )
        : null,
        saved
          ? h('button', { type: 'button', class: 'icon-btn wf-delete', 'data-key': 'delete', title: `Delete “${saved.name}” from this house`, 'aria-label': `Delete workflow ${saved.name}`, onclick: () => void removeWorkflow(saved) }, icon('trash', 14))
          : null,
      ),
      heading.note ? h('p', { class: 'wf-team-note' }, heading.note) : null,
    );
    if (focused) teamHead.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
  }

  function renderTeam() {
    renderTeamHead();
    if (!draft) return setChildren(teamEl); // no workflow in this house: the note in place of the list says so
    const steps = draft.steps;
    const patch = (i: number, p: Partial<WorkflowStep>) => {
      if (!draft) return;
      draft.steps[i] = { ...draft.steps[i], ...p };
      if ('loopBackTo' in p) parkedLoops.delete(draft.steps[i].id); // the user's own choice: nothing to bring back
      if ('parallel' in p || 'kind' in p) fixLoopTargets(draft.steps, parkedLoops); // a review can't send work back into its own group
      // Name/model edits update the summary line live; everything else just marks the draft dirty.
      const structural = 'kind' in p || 'model' in p || 'parallel' in p;
      if (structural) renderTeam();
      else {
        refreshCardSummary(i);
        renderTeamHead(); // Discard edits shows up with the first change
      }
      renderTemplates();
      renderCompose();
    };
    const card = (step: WorkflowStep) => {
      const i = steps.indexOf(step);
      return roleCard(shell, {
        step,
        index: i,
        steps,
        expanded: expanded.has(step.id),
        advanced: advancedOpen.has(step.id),
        onAdvanced: (open) => (open ? advancedOpen.add(step.id) : advancedOpen.delete(step.id)),
        canRemove: steps.length > 1,
        onToggle: () => {
          if (expanded.has(step.id)) expanded.delete(step.id);
          else expanded.add(step.id);
          renderTeam();
        },
        onChange: (p) => patch(i, p),
        onRemove: () => {
          if (!draft) return;
          draft.steps.splice(i, 1);
          for (const s of draft.steps) if (s.loopBackTo === step.id) s.loopBackTo = draft.steps[0]?.id;
          if (draft.steps[0]?.parallel) delete draft.steps[0].parallel; // the first person never works beside an earlier one
          fixLoopTargets(draft.steps, parkedLoops);
          renderTeam();
          renderTemplates();
          renderCompose();
        },
      });
    };
    // People who work at the same time sit side by side; groups follow one another top to bottom.
    const cards: HTMLElement[] = [];
    stepGroups(steps).forEach((group, g) => {
      if (g > 0) cards.push(h('div', { class: 'wf-handoff', 'aria-hidden': 'true' }, h('span', null), icon('arrowDown', 12)));
      cards.push(
        group.length > 1
          ? h(
              'div',
              { class: ['wf-group', group.some((st) => expanded.has(st.id)) && 'has-open'], role: 'group', 'aria-label': `${group.map((st) => st.name).join(', ')} work at the same time` },
              h('span', { class: 'wf-group-label' }, icon('columns', 11), 'At the same time'),
              h('div', { class: 'wf-group-cards' }, group.map(card)),
            )
          : card(group[0]),
      );
    });
    const full = steps.length >= MAX_WORKFLOW_STEPS;
    cards.push(
      h(
        'button',
        {
          type: 'button',
          class: 'wf-add',
          disabled: full,
          title: full ? `A team has ${MAX_WORKFLOW_STEPS} people at most` : undefined,
          onclick: () => {
            if (!draft || draft.steps.length >= MAX_WORKFLOW_STEPS) return;
            const s = newStep(draft.steps.length, draft.steps[draft.steps.length - 1]);
            draft.steps.push(s);
            expanded.add(s.id);
            renderTeam();
            renderTemplates();
            renderCompose();
          },
        },
        icon('plus', 15),
        full ? `${MAX_WORKFLOW_STEPS} people at most` : 'Add a person',
      ),
    );
    setChildren(teamEl, ...cards);
  }

  /** Update the collapsed header of one card without re-creating inputs (keeps focus while typing). */
  function refreshCardSummary(i: number) {
    const step = draft?.steps[i];
    const card = teamEl.querySelectorAll('.role')[i]; // cards are in step order, groups included
    if (!step || !card) return;
    const name = card.querySelector('.role-name');
    if (name) name.textContent = step.name || 'Unnamed';
    const av = card.querySelector('.role-head .avatar');
    if (av) av.textContent = ([...step.name.trim()][0] ?? '?').toUpperCase();
    const chip = reviewChip(step, draft!.steps);
    const old = card.querySelector('.role-head .chip-review');
    if (old && chip) old.replaceWith(chip);
    card.querySelector('.role-head .role-model')?.replaceWith(roleModelLine(step, store.state.models)); // the effort shows there
  }

  function renderCompose() {
    compose.hidden = !draft; // nothing to give a task to
    const running = activeRun();
    const isDirty = dirty();
    setChildren(runBtn, icon('play', 14), isDirty ? 'Save & run' : 'Run');
    runBtn.disabled = busy || !draft || !!running || !projectId;
    const own = ownDraft();
    plainSaveBtn.hidden = !own;
    plainSaveBtn.disabled = busy || !draft || !isDirty;
    deleteBtn.hidden = !own;
    deleteBtn.disabled = busy;
    deleteBtn.title = own ? `Delete “${own.name}”` : '';
    deleteBtn.setAttribute('aria-label', own ? `Delete workflow ${own.name}` : 'Delete workflow');
    setChildren(saveBtn, icon(own ? 'copy' : 'save', 14), own ? 'Save as copy…' : 'Save as a workflow…');
    saveBtn.title = own ? 'Save this team as a new workflow, next to this one' : 'Save this team as a workflow of this house';
    saveBtn.disabled = busy || !draft;
    setChildren(composeHint,
      // a key tip: the whole of it goes on touch screens (not just the keys, which left "to run"), and it never wraps;
      // the keys are aria-hidden, so a screen reader gets them as text
      running ? h('span', null, 'A run is in progress') : h('span', { class: 'kbd-hint' }, kbd(modKey, 'Enter'), h('span', { class: 'sr-only' }, `${modKey}+Enter`), ' to run'),
    );
  }

  /** The saved workflow the draft edits (gone when it was deleted meanwhile): plain Save writes over it. */
  function ownDraft(): Workflow | undefined {
    return draft ? workflowById(draft.id) : undefined;
  }

  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  /** Another workflow of this house called `name` (not `exceptId`). */
  const nameTaken = (name: string, exceptId?: string) => workflows().find((w) => w.id !== exceptId && sameName(w.name, name));
  /** `name`, or "name 2", "name 3"… when it's taken. */
  function uniqueName(name: string, exceptId?: string): string {
    let out = name;
    for (let n = 2; nameTaken(out, exceptId); n++) out = `${name} ${n}`;
    return out;
  }

  const describe = (steps: WorkflowStep[]) => describeTeam(steps, (m) => modelLabel(m, store.state.models));

  /** Persist the draft as a workflow of this house. `as`: save a copy under this name (and description), or over
   *  `replaceId` — another workflow of the house the user chose to replace. */
  async function saveDraft(as?: { name: string; description?: string; replaceId?: string }): Promise<Workflow | null> {
    if (!draft || !projectId) return null;
    const pid = projectId;
    const base = workflowById(draft.id);
    const finalName = as?.name ?? (base ? draft.name : uniqueName(draft.name));
    const stepsChanged = !base || JSON.stringify(base.steps) !== JSON.stringify(draft.steps);
    const wf: Workflow = {
      ...clone(draft),
      id: as?.replaceId ?? (as ? `${slugify(finalName)}-${Date.now().toString(36).slice(-4)}` : draft.id),
      name: finalName,
      // a description made from the people themselves, so a changed team never keeps the old one
      description: as?.description?.trim() || (as || stepsChanged ? describe(draft.steps) : draft.description),
    };
    let res: { workflow?: Workflow } | undefined;
    saving++;
    try {
      res = await store.request<{ workflow?: Workflow } | undefined>({ t: 'save_workflow', reqId: '', projectId: pid, workflow: wf });
    } finally {
      saving--;
    }
    // Follow the server's normalized copy, so a later change to it (from chat) reads as one.
    const saved = res?.workflow ?? wf;
    if (projectId !== pid) return saved; // the tab shows another house now: the answer is not for what it shows
    teamSeen(); // saving kept the user's team in view: don't swap it for a job team the note already showed
    selectedId = saved.id;
    draft = clone(saved);
    baseline = JSON.stringify(draft);
    renderTemplates();
    renderTeam();
    renderCompose();
    return saved;
  }

  async function plainSave() {
    if (!ownDraft() || !dirty()) return;
    busy = true;
    renderCompose();
    try {
      const wf = await saveDraft();
      if (wf) shell.toast('success', `Saved “${wf.name}”`);
    } catch (err) {
      shell.toast('error', `Could not save: ${(err as Error).message}`);
    } finally {
      busy = false;
      renderCompose();
    }
  }

  async function run() {
    const task = taskInput.value.trim();
    if (!task) {
      taskInput.focus();
      taskInput.classList.add('is-invalid');
      setTimeout(() => taskInput.classList.remove('is-invalid'), 900);
      return;
    }
    if (!projectId || !draft) return;
    // the house and job Run was pressed in (the tab may show another one by the time a save answers)
    const pid = projectId;
    const jid = jobId;
    const key = taskKey();
    busy = true;
    renderCompose();
    try {
      const wf = dirty() ? await saveDraft() : draft;
      if (!wf) return;
      await store.request({ t: 'run_workflow', reqId: '', projectId: pid, jobId: jid, workflowId: wf.id, task });
      tasks.delete(key);
      const here = projectId === pid && jobId === jid;
      if (here) {
        taskInput.value = '';
        autosize(taskInput, 160);
      }
      const j = store.jobsOf(pid).find((x) => x.id === jid);
      const where = j && store.jobsOf(pid).length > 1 ? `“${j.name}” (${jobRoomCode(j)})` : store.project(pid)?.name ?? 'the house';
      shell.toast('info', `${wf.name} started in ${where}`, { projectId: pid });
      if (here) scroll.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      shell.toast('error', err instanceof RequestError ? err.message : `Could not start the run: ${(err as Error).message}`);
    } finally {
      busy = false;
      renderCompose();
    }
  }

  /** Save as a copy (or as a new workflow, when the one the draft edits was deleted meanwhile): a name that isn't taken
   *  — or replacing another workflow of that name, when the user says so — and a description, made from the people. */
  function promptSaveName() {
    if (!draft) return;
    const own = ownDraft();
    const input = h('input', { class: 'input', value: uniqueName(own ? `${draft.name} copy` : draft.name), 'aria-label': 'Workflow name', maxlength: '60' });
    const about = h('textarea', { class: 'input save-pop-about', rows: 3, maxlength: '400', 'aria-label': 'Description' });
    about.value = describe(draft.steps);
    const note = h('p', { class: 'save-pop-note', role: 'status', hidden: true });
    const saveGo = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Save');
    const replaceGo = h('button', { type: 'button', class: 'btn btn-soft btn-sm', hidden: true });
    const check = () => {
      const name = input.value.trim();
      const taken = name ? nameTaken(name) : undefined;
      note.hidden = !taken;
      replaceGo.hidden = !taken;
      saveGo.disabled = !name || !!taken;
      if (!taken) return taken;
      note.textContent = `This house already has a workflow called “${taken.name}”. Pick another name, or replace it (every job in this house that uses it gets this team).`;
      replaceGo.textContent = `Replace “${taken.name}”`;
      return taken;
    };
    const go = async (replace: boolean) => {
      const name = input.value.trim();
      if (!name) return input.focus();
      const taken = check();
      if (taken && !replace) return input.focus();
      close();
      try {
        const wf = await saveDraft({ name: taken ? taken.name : name, description: about.value, ...(taken ? { replaceId: taken.id } : {}) });
        if (wf) shell.toast('success', taken ? `Replaced “${wf.name}”` : `Saved workflow “${wf.name}”`);
      } catch (err) {
        shell.toast('error', `Could not save: ${(err as Error).message}`);
      }
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void go(false);
    });
    saveGo.addEventListener('click', () => void go(false));
    replaceGo.addEventListener('click', () => void go(true));
    const pop = h(
      'div',
      { class: 'save-pop glass-strong' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, own ? 'Save a copy as' : 'Save this team as'), input),
      note,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Description'), about),
      h('div', { class: 'save-pop-actions' }, replaceGo, saveGo),
    );
    const close = openPopover(shell.root, shell.layers, saveBtn, pop, { id: 'save-workflow', placement: 'above', align: 'start' });
    check();
    requestAnimationFrame(() => input.select());
  }

  taskInput.addEventListener('input', () => {
    autosize(taskInput, 160);
    if (projectId) tasks.set(taskKey(), taskInput.value);
  });
  taskInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void run();
    }
  });
  runBtn.addEventListener('click', () => void run());
  saveBtn.addEventListener('click', promptSaveName);
  plainSaveBtn.addEventListener('click', () => void plainSave());
  deleteBtn.addEventListener('click', () => {
    const own = ownDraft();
    if (own) void removeWorkflow(own);
  });

  /** Follow changes made elsewhere (the lead saving or assigning a team from chat, the job dialog, another window)
   *  without dropping unsaved edits: those keep their draft and get a note instead, and a team move stays unseen
   *  (not recorded) until Discard edits or the next clean sync shows it. */
  function sync() {
    if (follow && workflowById(follow)) {
      const id = follow;
      follow = null;
      return select(id);
    }
    if (!dirty()) {
      const server = workflowById(selectedId);
      if (newTeam() || !server || JSON.stringify(server) !== baseline) return reload();
      teamSeen(); // moved to the selected workflow, or to none: nothing to show
    }
    renderTemplates();
    renderTeamHead();
  }

  return {
    el,
    show(pid: string, jid: string = MAIN_JOB) {
      if (pid !== projectId || jid !== jobId) {
        const otherHouse = pid !== projectId;
        projectId = pid;
        jobId = jid;
        pickedRun = null;
        follow = null;
        taskInput.value = tasks.get(taskKey()) ?? '';
        autosize(taskInput, 160);
        // The job's own team first.
        seenTeam = teamId();
        // (no team of its own: the house's first workflow, not whatever another house had open). Unsaved edits
        // stay for another job of the house; another house has its own workflows, so they don't go there.
        if (!dirty() || seenTeam || otherHouse) select(seenTeam);
      } else sync(); // hidden tabs miss 'jobs'/'workflows': catch up with what the lead did from chat meanwhile
      renderAsk();
      renderStyle();
      renderJob();
      renderLibrary();
      renderRun();
      renderCompose();
    },
    focusTask() {
      taskInput.focus();
    },
    /** Show this run (a plan card's "Open run"), or the latest with null. */
    showRun(id: string | null) {
      showRunCard(id);
    },
    /** The run card on show has this person's approval cards in its waiting step (so the floating stack can skip them). */
    showsAsksOf(agentId: string): boolean {
      return !!runEl.querySelector('.tl-asks') && !!projectId && jobRuns().some((r) => isRunActive(r) && r.steps.some((st) => st.status === 'running' && st.agentId === agentId)) && runEl.isConnected;
    },
    onState(msg?: ServerMsg) {
      if (!projectId) return;
      const touchesRun =
        (msg?.t === 'agent' && runsOf(store.state, projectId).some((r) => isRunActive(r) && r.steps.some((st) => st.agentId === msg.agent.id))) ||
        (msg?.t === 'agent_removed' && runsOf(store.state, projectId).some((r) => r.steps.some((st) => st.agentId === msg.agentId)));
      if (!msg || msg.t === 'run' || touchesRun || msg.t === 'approval' || msg.t === 'approval_resolved') {
        renderRun();
        renderCompose();
      }
      if (msg?.t === 'workflows' || msg?.t === 'jobs' || msg?.t === 'snapshot') sync();
      if (msg?.t === 'workflows' || msg?.t === 'snapshot') renderRun();
      if (msg?.t === 'workflows' || msg?.t === 'snapshot' || msg?.t === 'city') renderLibrary(); // 'city': a house's name in "from …"
      if (msg?.t === 'models' && !teamEl.contains(document.activeElement)) renderTeam();
      if (!msg || msg.t === 'jobs' || msg.t === 'snapshot') renderJob();
      if (!msg || msg.t === 'jobs' || msg.t === 'agent' || msg.t === 'agent_removed' || msg.t === 'snapshot') {
        renderAsk();
        renderStyle();
      }
    },
  };
}
