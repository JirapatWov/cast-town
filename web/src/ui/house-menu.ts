// House actions: the "⋯" menu (side panel header, Town board card, Ctrl+K), quick rename, lot & building, another
// folder, the house's team-run limit, and Remove from town. Wired to set_project / move_project / remove_project. CAST
// never deletes the folder or its files: every dialog says so, because "remove" next to a project folder reads like
// "delete my code".
import { MAX_RUNS_PER_ASK, RUNS_PER_ASK_CEILING, runsPerAsk, type AgentInfo, type BuildingStyle, type ClientMsg, type Project } from '../../../shared/protocol';
import { h, setChildren } from './dom';
import { viewerFolder } from './changes-tab';
import { openFolder } from './file-viewer';
import { createFolderBrowser } from './folder-browser';
import { basename, listJoin, lotLabel } from './format';
import { icon } from './icons';
import { deleteHistoryOption } from './house-history';
import { buildingIllustration } from './illustrations';
import { openMenu } from './menu';
import { openModal, type ModalHandle } from './modal';
import { STYLES } from './placement';
import { openPopover } from './popover';
import { isRunActive, runsOf } from './runs';
import type { Shell } from './shell';
import { houseWorkflowsLine } from './workflow-library';

/** An extra choice on the Remove dialog (e.g. "Also delete its chat history"): it renders a control into the dialog
 *  and adds the fields it stands for to the remove_project message. Other modules push into this list. */
export interface RemoveHouseOption {
  render(project: Project): HTMLElement;
  fields(): Record<string, unknown>;
}
export const removeHouseOptions: RemoveHouseOption[] = [];
removeHouseOptions.push(deleteHistoryOption); // "Also delete its chats and history" (server: remove_project.deleteHistory)

/** Who is working in the house right now (people busy or starting, plus active runs): what a remove or a folder change
 *  would interrupt. */
export function houseActivity(shell: Shell, projectId: string): { people: AgentInfo[]; runs: string[] } {
  const people = shell.store.agentsOf(projectId).filter((a) => a.status === 'busy' || a.status === 'starting');
  const runs = runsOf(shell.store.state, projectId).filter(isRunActive).map((r) => r.workflowName);
  return { people, runs };
}

/** "Assistant and Reviewer are working" / "the “Fix bug” run is going" — '' when the house is quiet. */
function activityText(shell: Shell, projectId: string): string {
  const { people, runs } = houseActivity(shell, projectId);
  const parts: string[] = [];
  if (people.length) parts.push(`${listJoin(people.map((p) => p.name))} ${people.length === 1 ? 'is' : 'are'} working`);
  if (runs.length) parts.push(`${runs.length === 1 ? 'the team run' : 'the team runs'} ${listJoin(runs.map((r) => `“${r}”`))} ${runs.length === 1 ? 'is' : 'are'} going`);
  return parts.join(', and ');
}

export function openHouseMenu(shell: Shell, anchor: HTMLElement, project: Project) {
  const inside = shell.view.view === 'house' && shell.view.projectId === project.id;
  openMenu(
    shell.root,
    shell.layers,
    anchor,
    [
      {
        title: project.name,
        items: [
          ...(inside ? [] : [{ label: 'Go inside', icon: 'door', onSelect: () => shell.enterProject(project.id) }]),
          // a phone has no jobs bar (it waits behind the panel's chevron): New job lives here too
          { label: 'New job…', icon: 'plus', hint: 'its own room and people', onSelect: () => shell.openNewJob(project.id) },
          { label: 'Browse files', icon: 'file', hint: 'see what is in its folder', onSelect: () => openFolder(shell, viewerFolder(shell, project.id)) },
          { label: 'Rename…', icon: 'pencil', onSelect: () => renameHouse(shell, anchor, project.id) },
          { label: 'Lot & building…', icon: 'building', hint: 'move it, change its look', onSelect: () => openHouseDialog(shell, project.id) },
          { label: 'Use another folder…', icon: 'folder', hint: 'moved or renamed it?', onSelect: () => changeHouseFolder(shell, project.id) },
          { label: 'Team runs per message…', icon: 'workflow', hint: runsHint(project), onSelect: () => editRunsPerAsk(shell, anchor, project.id) },
        ],
      },
      { items: [{ label: 'Remove from town…', icon: 'trash', hint: 'files stay', onSelect: () => void removeHouse(shell, project.id) }] },
    ],
    { id: 'house-menu', align: 'end', minWidth: 250, className: 'house-menu', focusFirst: true },
  );
}

/** The house actions for the Ctrl+K palette (the palette adds group, icon and boost). */
export function houseCommands(shell: Shell, project: Project, anchor: () => HTMLElement): { id: string; title: string; subtitle: string; keywords: string; icon: string; run(): void }[] {
  return [
    { id: 'h:rename', title: 'Rename house…', subtitle: project.name, keywords: 'house project name sign title', icon: 'pencil', run: () => renameHouse(shell, anchor(), project.id) },
    { id: 'h:lot', title: 'Move house to another lot…', subtitle: `${project.name} · lot & building`, keywords: 'house project move lot building style look office cottage studio', icon: 'building', run: () => openHouseDialog(shell, project.id) },
    { id: 'h:folder', title: 'Use another folder for this house…', subtitle: project.path, keywords: 'house project folder path moved renamed relocate wrong', icon: 'folder', run: () => changeHouseFolder(shell, project.id) },
    { id: 'h:runs', title: 'Team runs per message…', subtitle: `${project.name} · ${runsHint(project)}`, keywords: 'house project team runs limit loop guard max per message workflow', icon: 'workflow', run: () => editRunsPerAsk(shell, anchor(), project.id) },
    { id: 'h:remove', title: 'Remove house from town…', subtitle: `${project.name} — the folder and its files stay`, keywords: 'house project delete remove close forget', icon: 'trash', run: () => void removeHouse(shell, project.id) },
  ];
}

async function setProject(shell: Shell, projectId: string, patch: Extract<ClientMsg, { t: 'set_project' }>['patch']): Promise<void> {
  await shell.store.request({ t: 'set_project', reqId: '', projectId, patch });
}

export function renameHouse(shell: Shell, anchor: HTMLElement, projectId: string) {
  const project = shell.store.project(projectId);
  if (!project) return;
  const input = h('input', { class: 'input', value: project.name, maxlength: '80', 'aria-label': 'House name', autocomplete: 'off', spellcheck: 'false' });
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Rename');
  const go = async () => {
    const name = input.value.trim();
    if (!name) {
      input.classList.add('is-invalid');
      setTimeout(() => input.classList.remove('is-invalid'), 900);
      return input.focus();
    }
    if (name === project.name) return close();
    save.disabled = true;
    try {
      await setProject(shell, projectId, { name });
      close();
      shell.toast('success', `Renamed to “${name}”. The folder keeps its name (${basename(project.path)}).`, { projectId });
    } catch (err) {
      save.disabled = false;
      shell.toast('error', `Could not rename: ${(err as Error).message}`);
    }
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      void go();
    }
  });
  save.addEventListener('click', () => void go());
  const pop = h(
    'div',
    { class: 'save-pop rename-pop glass-strong', role: 'dialog', 'aria-label': 'Rename house' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name on the sign'), input),
    h('p', { class: 'field-hint' }, 'Only the name in CAST changes — the folder on disk keeps its name.'),
    h('div', { class: 'save-pop-actions' }, save),
  );
  const target = anchor.isConnected ? anchor : (shell.root.querySelector<HTMLElement>('.panel-project') ?? shell.root);
  const close = openPopover(shell.root, shell.layers, target, pop, { id: 'rename-house', align: 'end' });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

/** "8" for a house with its own limit, "5 (default)" for one that follows the default. */
function runsHint(project: Project): string {
  return project.maxRunsPerAsk === undefined ? `${MAX_RUNS_PER_ASK} (default)` : String(project.maxRunsPerAsk);
}

/** How many teams a lead may start on its own for one message of the user in this house (the loop guard); the default
 *  until the user picks a number, and back to it with "Use default". */
export function editRunsPerAsk(shell: Shell, anchor: HTMLElement, projectId: string) {
  const project = shell.store.project(projectId);
  if (!project) return;
  const input = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: '1', max: String(RUNS_PER_ASK_CEILING), step: '1', value: String(runsPerAsk(project)), 'aria-label': 'Team runs per message', autocomplete: 'off' });
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Save');
  const reset = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', hidden: project.maxRunsPerAsk === undefined }, `Use default (${MAX_RUNS_PER_ASK})`);
  /** null: the default again (a number equal to it counts as the default too). */
  const apply = async (runs: number | null) => {
    save.disabled = reset.disabled = true;
    try {
      await setProject(shell, projectId, { maxRunsPerAsk: runs === MAX_RUNS_PER_ASK ? null : runs });
      close();
      const n = runs ?? MAX_RUNS_PER_ASK;
      shell.toast('success', `${project.name}: up to ${n} team run${n === 1 ? '' : 's'} per message${runs === null || runs === MAX_RUNS_PER_ASK ? ' (the default)' : ''}. Leads go by it from your next message.`, { projectId });
    } catch (err) {
      save.disabled = reset.disabled = false;
      shell.toast('error', `Could not change it: ${(err as Error).message}`);
    }
  };
  const go = () => {
    const runs = Number(input.value);
    if (!Number.isInteger(runs) || runs < 1 || runs > RUNS_PER_ASK_CEILING) {
      input.classList.add('is-invalid');
      setTimeout(() => input.classList.remove('is-invalid'), 900);
      return input.focus();
    }
    if (runs === runsPerAsk(project)) return close();
    void apply(runs);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      go();
    }
  });
  save.addEventListener('click', go);
  reset.addEventListener('click', () => void apply(null));
  const pop = h(
    'div',
    { class: 'save-pop runs-pop glass-strong', role: 'dialog', 'aria-label': `Team runs per message in ${project.name}` },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Team runs per message'), input),
    h('p', { class: 'field-hint' }, `How many teams a lead in ${project.name} may start on its own for one of your messages, 1–${RUNS_PER_ASK_CEILING} — a guard against endless loops, not a cost limit. Every new message starts the count over. Default: ${MAX_RUNS_PER_ASK}.`),
    h('div', { class: 'save-pop-actions' }, reset, save),
  );
  const target = anchor.isConnected ? anchor : (shell.root.querySelector<HTMLElement>('.panel-project') ?? shell.root);
  const close = openPopover(shell.root, shell.layers, target, pop, { id: 'runs-per-ask', align: 'end' });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

let houseDialog: ModalHandle | null = null;

/** Lot & building: move the house to a free lot and/or give it another building style. People, chats and files stay. */
export function openHouseDialog(shell: Shell, projectId: string) {
  const { store } = shell;
  const project = store.project(projectId);
  if (!project) return;
  houseDialog?.close();
  let lot = project.lotId;
  let style: BuildingStyle = project.style;
  let busy = false;

  const lotSelect = h('select', { class: 'input', 'aria-label': 'Lot' });
  const taken = new Set(store.state.city.projects.filter((p) => p.id !== projectId).map((p) => p.lotId));
  const lots = store.state.city.lots.filter((l) => !taken.has(l.id));
  setChildren(lotSelect, ...lots.map((l) => h('option', { value: l.id, selected: l.id === lot }, `${lotLabel(l)}${l.id === project.lotId ? ' (here now)' : ''}`)));
  lotSelect.addEventListener('change', () => {
    lot = lotSelect.value;
    renderFoot();
  });

  const styleEl = h('div', { class: 'style-grid', role: 'radiogroup', 'aria-label': 'Building style' });
  function renderStyles() {
    setChildren(styleEl,
      ...STYLES.map((st) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(st.id === style),
            class: ['style-card', st.id === style && 'is-on'],
            onclick: () => {
              style = st.id;
              renderStyles();
              renderFoot();
            },
          },
          h('span', { class: 'style-art', html: buildingIllustration(st.id) }),
          h('span', { class: 'style-name' }, st.name),
          h('span', { class: 'style-blurb' }, st.blurb),
          st.id === style ? h('span', { class: 'style-check' }, icon('check', 12)) : null,
        ),
      ),
    );
  }

  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'button', class: 'btn btn-primary' });
  function renderFoot() {
    const changed = lot !== project!.lotId || style !== project!.style;
    setChildren(submit, busy ? h('span', { class: 'spinner spinner-sm' }) : icon('check', 15), 'Save');
    submit.disabled = busy || !changed;
    submit.title = changed ? '' : 'Pick another lot or building first';
  }
  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    busy = true;
    error.hidden = true;
    renderFoot();
    try {
      const moved = lot !== project.lotId;
      if (moved) await store.request({ t: 'move_project', reqId: '', projectId, lotId: lot });
      if (style !== project.style) await setProject(shell, projectId, { style });
      modal.close();
      const where = store.state.city.lots.find((l) => l.id === lot);
      shell.toast('success', moved ? `${project.name} moved to ${where ? lotLabel(where) : lot}. People, chats and files are as they were.` : `${project.name} got a new look.`, { projectId });
    } catch (err) {
      error.textContent = (err as Error).message;
      error.hidden = false;
    } finally {
      busy = false;
      renderFoot();
    }
  });

  renderStyles();
  renderFoot();
  const modal = openModal(shell.root, shell.layers, {
    id: 'house-dialog',
    className: 'modal-place modal-house',
    title: `Lot & building of ${project.name}`,
    subtitle: 'Moving changes only where the house stands in the town — its folder, people and chats stay the same.',
    body: h(
      'div',
      { class: 'place' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Lot'), lotSelect),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Building'), styleEl),
      error,
    ),
    footer: [h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel'), submit],
    onClose: () => {
      if (houseDialog === modal) houseDialog = null;
    },
  });
  houseDialog = modal;
}

/** Point the house at another folder: for a project the user moved or renamed on disk, or a wrong pick. */
export function changeHouseFolder(shell: Shell, projectId: string) {
  const { store } = shell;
  const project = store.project(projectId);
  if (!project) return;
  let picked: string | null = null;
  let pickedGit = false;
  let otherHouse: Project | undefined; // the folder already is another house
  let busy = false;

  const pickedEl = h('div', { class: 'picked', 'aria-live': 'polite' });
  const browser = createFolderBrowser(shell, (choice) => {
    picked = choice?.path ?? null;
    pickedGit = !!choice?.isGit;
    otherHouse = choice?.house && choice.house.id !== projectId ? choice.house : undefined;
    renderPicked();
    renderFoot();
  });
  function renderPicked() {
    setChildren(pickedEl,
      h('div', { class: 'picked-row' },
        icon(pickedGit ? 'branch' : 'folder', 15),
        h('span', { class: 'picked-path', title: picked ?? undefined }, picked ?? '—'),
        picked === project!.path ? h('span', { class: 'muted small' }, 'its folder now') : pickedGit ? h('span', { class: 'git-badge' }, 'git') : picked ? h('span', { class: 'muted small' }, 'not a git repo — changes won’t be tracked') : null,
      ),
      otherHouse ? h('p', { class: 'picked-note is-err' }, icon('home', 14), `This folder already is the house “${otherHouse.name}”. Choose another folder.`) : null,
    );
  }

  // What stops it, said before the user picks (the server checks again and has the last word).
  const copies = store.jobsOf(projectId).filter((j) => j.worktree);
  const blocker = copies.length
    ? `${listJoin(copies.map((j) => `“${j.name}”`))} ${copies.length === 1 ? 'works in its own copy' : 'work in their own copies'} of the current folder. Delete ${copies.length === 1 ? 'that job' : 'those jobs'} first — their work stays on their branches.`
    : activityText(shell, projectId)
      ? `${activityText(shell, projectId)} in ${project.name}. Wait until they’re done, or stop them first.`
      : '';

  const error = h('p', { class: 'form-error', role: 'alert', hidden: !blocker }, blocker);
  const submit = h('button', { type: 'button', class: 'btn btn-primary' });
  function renderFoot() {
    setChildren(submit, busy ? h('span', { class: 'spinner spinner-sm' }) : icon('folder', 15), 'Use this folder');
    submit.disabled = busy || !picked || picked === project!.path || !!otherHouse || !!blocker;
  }
  submit.addEventListener('click', async () => {
    if (submit.disabled || !picked) return;
    busy = true;
    error.hidden = true;
    renderFoot();
    try {
      await setProject(shell, projectId, { path: picked });
      modal.close();
      shell.toast('success', `${project.name} now uses ${picked}. ${project.path} was not touched.`, { projectId });
      store.send({ t: 'get_git', projectId });
    } catch (err) {
      error.textContent = (err as Error).message;
      error.hidden = false;
    } finally {
      busy = false;
      renderFoot();
    }
  });

  renderPicked();
  renderFoot();
  const modal = openModal(shell.root, shell.layers, {
    id: 'house-folder',
    className: 'modal-place modal-house',
    title: `Another folder for ${project.name}`,
    subtitle: h('span', null, 'Now: ', h('code', null, project.path)),
    body: h(
      'div',
      { class: 'place' },
      h('div', { class: 'place-pane' }, browser.el, pickedEl),
      h(
        'ul',
        { class: 'house-facts' },
        h('li', null, 'People, jobs, chats and past runs stay with the house; everyone starts again in the new folder with their next message.'),
        h('li', null, 'Nothing is copied or moved on disk, and the current folder is not touched.'),
      ),
      error,
    ),
    footer: [h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel'), submit],
  });
  void browser.load(project.path).then((ok) => {
    if (!ok) void browser.load('~');
  });
}

/** Remove the house from the town after a confirm that says what happens (and what doesn't: the folder stays). */
export async function removeHouse(shell: Shell, projectId: string): Promise<boolean> {
  const { store } = shell;
  const project = store.project(projectId);
  if (!project) return false;
  const working = activityText(shell, projectId);
  const copies = store.jobsOf(projectId).filter((j) => j.worktree);
  const workflowsGo = houseWorkflowsLine(store.state, projectId); // its own workflows go with it (the library's stay)
  const extras = removeHouseOptions.map((o) => ({ o, el: o.render(project) }));
  const ok = await shell.confirm({
    title: `Remove ${project.name} from the town?`,
    body: h(
      'div',
      { class: 'house-remove' },
      h('p', null, 'The building goes, and its people leave. ', h('strong', null, 'The folder and its files stay on disk'), ' — CAST never deletes them:'),
      h('p', null, h('code', { class: 'house-remove-path' }, project.path)),
      working ? h('p', { class: 'revert-warn' }, icon('alert', 14), ` Right now ${working}. Removing stops them — their unfinished work stays in the folder as it is.`) : null,
      copies.length
        ? h('p', null, `Jobs with their own copy (${listJoin(copies.map((j) => `“${j.name}”`))}) leave it on disk too, beside CAST’s data.`)
        : null,
      workflowsGo ? h('p', null, workflowsGo) : null,
      h('p', { class: 'muted' }, `Chats with its people stay in CAST’s data folder${extras.length ? ' unless you choose otherwise below' : ''}. You can place the same folder again any time; it starts as a new house.`),
      extras.length ? h('div', { class: 'house-remove-options' }, extras.map((x) => x.el)) : null,
    ),
    confirmLabel: 'Remove from town',
    tone: 'danger',
    icon: 'trash',
  });
  if (!ok) return false;
  try {
    const fields = Object.assign({}, ...extras.map((x) => x.o.fields())) as Record<string, unknown>;
    await store.request({ ...fields, t: 'remove_project', reqId: '', projectId } as Extract<ClientMsg, { t: 'remove_project' }>);
    shell.toast('info', `Removed ${project.name} from the town. Its folder ${project.path} is untouched.`);
    return true;
  } catch (err) {
    shell.toast('error', `Could not remove ${project.name}: ${(err as Error).message}`);
    return false;
  }
}
