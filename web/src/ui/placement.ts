// Place-project dialog: pick an existing folder (or create a new one), choose a building style and a lot. A full town
// (every lot has a house) says so at the top, with the two ways to make room: remove a house, or add a city.
import { clipName, MAX_PROJECT_NAME } from '../../../shared/limits';
import type { BuildingStyle, Project } from '../../../shared/protocol';
import { needsAccount } from './agents-health';
import { h, setChildren } from './dom';
import { basename, lotLabel, SET_UP_GIT_TEXT, slugify } from './format';
import { openAddCity } from './cities';
import { removeHouse } from './house-menu';
import { createFolderBrowser, startFolder, type FolderChoice } from './folder-browser';
import { shortPath } from './display-path';
import { pathLine } from './path-line';
import { icon } from './icons';
import { buildingIllustration } from './illustrations';
import { openModal, type ModalHandle } from './modal';
import type { Shell } from './shell';
import { optionNames, segmented } from './widgets';
import { freeLots, LOADING_HOUSES, townFull, townFullLabel, townFullText } from './town-loading';

type Mode = 'pick' | 'create';
type Template = 'empty' | 'node-api' | 'novel';

export const STYLES: { id: BuildingStyle; name: string; blurb: string }[] = [
  // every style starts with one storey and grows one per floor of jobs, so no blurb promises a height
  { id: 'house', name: 'House', blurb: 'Pitched roof and a garden' },
  { id: 'office', name: 'Office', blurb: 'Glass and steel, grows a storey per floor' },
  { id: 'cottage', name: 'Cottage', blurb: 'Cosy, good for writing' },
  { id: 'studio', name: 'Studio', blurb: 'Loft with tall windows' },
];

const TEMPLATES: { id: Template; name: string; blurb: string; icon: string }[] = [
  { id: 'empty', name: 'Empty folder', blurb: 'Start from scratch', icon: 'folder' },
  { id: 'node-api', name: 'Bun API (TypeScript)', blurb: 'Tiny HTTP server with tests, runs on Bun', icon: 'terminal' },
  { id: 'novel', name: 'Novel', blurb: 'Outline, characters, chapters', icon: 'book' },
];

export function createPlacement(shell: Shell) {
  const { store, bus } = shell;
  let modal: ModalHandle | null = null;
  let setLot: ((lotId: string) => void) | null = null;

  function open(lotId?: string) {
    if (modal) {
      if (lotId) setLot?.(lotId);
      return;
    }
    let mode: Mode = 'pick';
    let style: BuildingStyle = 'house';
    let template: Template = 'node-api';
    let picked: FolderChoice | null = null;
    let initGit = true; // a folder without git: set it up first (recommended), so changes can be seen and undone
    let nameTouched = false;
    let submitting = false;
    const lots = () => freeLots(store.state) ?? [];
    let lot = lotId ?? lots()[0]?.id ?? '';

    // An empty box that reads like a filled one ("my-project" in grey) left people puzzled by a disabled button: say what to do.
    const namePlaceholder = () => (mode === 'pick' && !picked ? 'Choose a folder first' : 'Type a name');
    // a picked folder's name can be any length; an input's maxlength doesn't stop a value set from code
    const folderName = (path: string) => clipName(basename(path), MAX_PROJECT_NAME);
    const nameInput = h('input', { class: 'input', placeholder: 'Choose a folder first', maxlength: String(MAX_PROJECT_NAME), 'aria-label': 'Name on the sign' });
    nameInput.addEventListener('input', () => {
      nameTouched = true;
      renderFoot();
    });

    const pickedEl = h('div', { class: 'picked', 'aria-live': 'polite' });
    const browser = createFolderBrowser(
      shell,
      (choice) => {
        picked = choice;
        if (!nameTouched && mode === 'pick') nameInput.value = choice ? folderName(choice.path) : '';
        nameInput.placeholder = namePlaceholder();
        renderPicked();
        renderFoot();
      },
      // the same as picking the tab (rebuilt by the click, so found again to take the focus the link had)
      () => {
        const tab = () => modeToggle.querySelector<HTMLButtonElement>('[data-focus-key="seg:create"]');
        tab()?.click();
        tab()?.focus();
      },
    );

    /** The chosen folder, and — prominently, not in small grey — what CAST can and can't do there. */
    function renderPicked() {
      if (!picked) {
        setChildren(pickedEl, h('span', { class: 'picked-none' }, icon('folder', 15), 'No folder chosen yet — open one in the list above.'));
        return;
      }
      const home = store.state.hello?.home;
      const path = h('div', { class: 'picked-row' },
        icon(picked.isGit ? 'branch' : 'folder', 15),
        pathLine('span', 'picked-path', picked.path, home, 56),
        picked.isGit ? h('span', { class: 'git-badge' }, 'git') : null,
      );
      const notes: HTMLElement[] = [];
      if (picked.house) {
        notes.push(h('p', { class: 'picked-note is-err' }, icon('home', 14), `This folder already is the house “${picked.house.name}”. Choose another folder.`));
      }
      if (picked.isRoot) {
        notes.push(h('p', { class: 'picked-note is-warn' }, icon('alert', 14), 'This is a whole browse root. Its people could read and change everything inside it — usually you want one project folder instead.'));
      } else if (picked.gitRepos >= 2) {
        notes.push(h('p', { class: 'picked-note is-warn' }, icon('alert', 14), `This folder holds ${picked.gitRepos} git projects. Placing it makes them one house — you may want one of them instead.`));
      }
      if (!picked.isGit && !picked.house) {
        const box = h('input', { type: 'checkbox', checked: initGit, 'aria-describedby': 'place-git-hint' });
        box.addEventListener('change', () => {
          initGit = box.checked;
          renderPicked();
        });
        notes.push(
          h(
            'div',
            { class: 'picked-git' },
            h('p', { class: 'picked-note is-warn' }, icon('alert', 14), h('span', null, h('strong', null, 'Not a git repository. '), 'Without git, CAST can’t show what agents change here, and nothing they do can be undone.')),
            h(
              'label',
              { class: 'jd-copy place-git' },
              box,
              h(
                'span',
                { class: 'jd-copy-text' },
                h('span', { class: 'jd-copy-label' }, 'Set up git here (recommended)'),
                h(
                  'span',
                  { class: 'field-hint', id: 'place-git-hint' },
                  initGit
                    ? `${SET_UP_GIT_TEXT} Every edit then shows on the TV and can be undone.`
                    : 'People in this house will ask before every edit (Ask first). You can set up git later in the Changes tab.',
                ),
              ),
            ),
          ),
        );
      }
      setChildren(pickedEl, path, notes);
    }

    const tplEl = h('div', { class: 'tpl-grid', role: 'radiogroup', 'aria-label': 'Template' });
    function renderTemplates() {
      setChildren(tplEl,
        ...TEMPLATES.map((t) => {
          const name = h('span', { class: 'tpl-name' }, t.name);
          const blurb = h('span', { class: 'tpl-blurb' }, t.blurb);
          return h(
            'button',
            { type: 'button', role: 'radio', 'aria-checked': String(t.id === template), class: ['tpl', t.id === template && 'is-on'], ...optionNames(name, blurb), onclick: () => { template = t.id; renderTemplates(); } },
            icon(t.icon, 18),
            name,
            blurb,
          );
        }),
      );
    }
    const createHint = h('p', { class: 'field-hint' });
    const updateCreateHint = () => {
      const root = shortPath(store.state.hello?.workspaceRoot ?? 'your workspace folder', store.state.hello?.home, 60);
      const name = nameInput.value.trim();
      createHint.textContent = name
        ? `Creates ${root}/${slugify(name)} with git, so every change can be seen and undone.`
        : `Type a name below — CAST makes a new folder with that name in ${root}, with git.`;
    };
    nameInput.addEventListener('input', updateCreateHint);

    const pickPane = h('div', { class: 'place-pane' }, browser.el, pickedEl);
    const createPane = h('div', { class: 'place-pane', hidden: true }, h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Start from'), tplEl), createHint);

    const styleEl = h('div', { class: 'style-grid', role: 'radiogroup', 'aria-label': 'Building style' });
    function renderStyles() {
      setChildren(styleEl,
        ...STYLES.map((st) => {
          const name = h('span', { class: 'style-name' }, st.name);
          const blurb = h('span', { class: 'style-blurb' }, st.blurb);
          return h(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(st.id === style),
              class: ['style-card', st.id === style && 'is-on'],
              ...optionNames(name, blurb),
              onclick: () => {
                style = st.id;
                renderStyles();
              },
            },
            h('span', { class: 'style-art', html: buildingIllustration(st.id) }),
            name,
            blurb,
            st.id === style ? h('span', { class: 'style-check' }, icon('check', 12)) : null,
          );
        }),
      );
    }

    const lotSelect = h('select', { class: 'input', 'aria-label': 'Lot' });
    function renderLots() {
      const free = freeLots(store.state);
      if (!free) {
        // the town is still on its way (before the first snapshot): its lots come with it — filled in then
        setChildren(lotSelect, h('option', { value: '' }, LOADING_HOUSES));
        lotSelect.disabled = true;
        return;
      }
      if (!free.some((l) => l.id === lot)) lot = free[0]?.id ?? '';
      const full = townFull(store.state);
      if (full) setChildren(lotSelect, h('option', { value: '' }, townFullLabel(full)));
      else setChildren(lotSelect, ...free.map((l) => h('option', { value: l.id, selected: l.id === lot }, lotLabel(l))));
      lotSelect.disabled = !free.length;
    }

    // Every lot taken: say so before anything else, with the ways out right here (not a greyed list and a button
    // that never wakes up). Removing a house frees its lot, and the dialog carries on with it.
    const fullNote = h('div', { class: 'place-full', id: 'place-full', role: 'status', hidden: true });
    let fullShown = '';
    function renderFull() {
      const full = townFull(store.state);
      const houses = full ? store.state.city.projects : [];
      const key = JSON.stringify(houses.map((p) => [p.id, p.name]));
      fullNote.hidden = !full;
      if (!full || key === fullShown) return;
      fullShown = key;
      const pick = h('select', { class: 'input', 'aria-label': 'House to remove' }, ...houses.map((p) => h('option', { value: p.id }, p.name)));
      setChildren(fullNote,
        h('p', { class: 'place-full-title' }, icon('alert', 15), h('strong', null, townFullText(full))),
        h('p', { class: 'place-full-hint' }, 'To place this project, remove a house from the town (its folder and files stay), or add another machine running CAST as a city.'),
        h(
          'div',
          { class: 'place-full-actions' },
          pick,
          h('button', { type: 'button', class: 'btn btn-soft', onclick: () => void removeHouse(shell, pick.value) }, icon('trash', 15), 'Remove from town…'),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => openAddCity(shell) }, icon('plus', 15), 'Add a city…'),
        ),
      );
    }
    lotSelect.addEventListener('change', () => {
      lot = lotSelect.value;
      bus.emit('placement:start', { lotId: lot });
    });
    setLot = (id) => {
      lot = id;
      renderLots();
    };

    const submit = h('button', { type: 'button', class: 'btn btn-primary' });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    function renderFoot() {
      setChildren(submit, icon(mode === 'pick' ? 'pin' : 'folderPlus', 15), mode === 'pick' ? 'Place project' : 'Create & place');
      const ready = !!lot && !!nameInput.value.trim() && (mode === 'create' || (!!picked && !picked.house));
      submit.disabled = !ready || submitting;
      // the reason a full town's button stays off, for the tooltip and a screen reader
      const full = townFull(store.state);
      submit.title = full ? townFullText(full) : '';
      if (full) submit.setAttribute('aria-describedby', fullNote.id);
      else submit.removeAttribute('aria-describedby');
    }

    const modeToggle = segmented<Mode>(
      [
        { value: 'pick', label: 'Pick a folder', icon: 'folder' },
        { value: 'create', label: 'Create new', icon: 'folderPlus' },
      ],
      mode,
      (v) => {
        mode = v;
        pickPane.hidden = v !== 'pick';
        createPane.hidden = v !== 'create';
        if (v === 'create' && !nameTouched) nameInput.value = '';
        if (v === 'pick' && !nameTouched) nameInput.value = picked ? folderName(picked.path) : '';
        nameInput.placeholder = namePlaceholder();
        updateCreateHint();
        renderFoot();
      },
      'Source',
    );

    async function doSubmit() {
      if (submit.disabled) return;
      submitting = true;
      error.hidden = true;
      renderFoot();
      const name = nameInput.value.trim();
      const setUp = mode === 'pick' && !!picked && !picked.isGit && initGit;
      // the lot asked for: the city update that arrives with the ack moves `lot` on (to the next free one, or none)
      const lotId = lot;
      try {
        const data =
          mode === 'pick'
            ? await store.request<unknown>({ t: 'place_project', reqId: '', path: picked!.path, name, lotId, style, ...(setUp ? { initGit: true } : {}) })
            : await store.request<unknown>({ t: 'create_project', reqId: '', name, lotId, style, template });
        // the ack carries { project, gitError? } (older servers: the project itself)
        const reply = (data && typeof data === 'object' ? data : {}) as { project?: Project; gitError?: string; id?: string };
        const placed = reply.project ?? (reply.id ? (data as Project) : undefined) ?? store.state.city.projects.find((p) => p.lotId === lotId);
        const where = store.state.city.lots.find((l) => l.id === lotId)?.district ?? 'its lot';
        if (reply.gitError) shell.toast('warn', `${name} moved in on ${where}, but git couldn’t be set up (${reply.gitError}). People there ask before every edit; try again from the Changes tab.`, { projectId: placed?.id });
        else if (placed && !placed.isGit) shell.toast('info', `${name} moved in on ${where}. It has no git, so people there ask before every edit — set up git in the Changes tab to change that.`, { projectId: placed.id });
        else shell.toast('success', `${name} moved in on ${where}`, { projectId: placed?.id });
        modal?.close();
        // straight into the new house (its lead is moving in), so the next step is right there
        if (placed) shell.enterProject(placed.id);
      } catch (err) {
        error.textContent = (err as Error).message;
        error.hidden = false;
      } finally {
        submitting = false;
        renderFoot();
      }
    }
    submit.addEventListener('click', () => void doSubmit());
    nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void doSubmit();
    });

    renderTemplates();
    renderStyles();
    renderLots();
    renderFull();
    renderFoot();
    renderPicked();
    updateCreateHint();

    // the lead's model is set when the house is placed: with no account yet that is the default, which may not be
    // the one connected later (said once the accounts are known: before the first snapshot nothing is)
    const accountNote = h('p', { class: 'picked-note is-warn', hidden: true }, icon('key', 14), 'No AI account yet — connect one first so the lead uses it.');
    const renderAccount = () => (accountNote.hidden = !(store.state.synced && needsAccount(store.state)));
    renderAccount();
    // the town's lots and the accounts can change while this is open (the first snapshot, a house placed elsewhere)
    const offStore = store.subscribe((_s, msg) => {
      if (msg?.t !== 'snapshot' && msg?.t !== 'city' && msg?.t !== 'models') return;
      renderLots();
      renderFull();
      renderFoot();
      renderAccount();
    });

    const body = h(
      'div',
      { class: 'place' },
      fullNote,
      accountNote,
      modeToggle,
      pickPane,
      createPane,
      h(
        'div',
        { class: 'field-row' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name on the sign'), nameInput),
        h('label', { class: 'field' }, h('span', { class: 'field-label', title: 'An empty plot in the town where the house will stand' }, 'Where in town'), lotSelect),
      ),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Building'), styleEl),
      error,
    );

    modal = openModal(shell.root, shell.layers, {
      id: 'placement',
      className: 'modal-place',
      title: 'Place a project',
      subtitle: 'Any folder on this machine can become a house. Nothing runs until you give someone a task.',
      body,
      footer: [h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal?.close() }, 'Cancel'), submit],
      onClose: () => {
        offStore();
        modal = null;
        setLot = null;
        bus.emit('placement:end', {});
      },
    });
    bus.emit('placement:start', { lotId: lot || undefined });
    // '~' = the server's first browse root (CAST_FS_ROOTS), so the picker opens somewhere real on every machine.
    // Nothing is chosen on open: the user picks the folder (start: next to the last one chosen).
    const start = startFolder('~');
    void browser.load(start).then((ok) => {
      if (!ok && start !== '~') void browser.load('~');
    });
  }

  return {
    open,
    get isOpen() {
      return !!modal;
    },
  };
}
