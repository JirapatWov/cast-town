// Place-project dialog: pick an existing folder (or create a new one), choose a building style and a lot.
import { clipName, MAX_PROJECT_NAME } from '../../../shared/limits';
import type { BuildingStyle, Lot, Project } from '../../../shared/protocol';
import { needsAccount } from './agents-health';
import { h, setChildren } from './dom';
import { basename, lotLabel, SET_UP_GIT_TEXT, slugify } from './format';
import { createFolderBrowser, startFolder, type FolderChoice } from './folder-browser';
import { shortPath } from './display-path';
import { pathLine } from './path-line';
import { icon } from './icons';
import { buildingIllustration } from './illustrations';
import { openModal, type ModalHandle } from './modal';
import type { Shell } from './shell';
import { optionNames, segmented } from './widgets';

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

function freeLots(lots: Lot[], projects: Project[]): Lot[] {
  const taken = new Set(projects.map((p) => p.lotId));
  return lots.filter((l) => !taken.has(l.id));
}

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
    const lots = () => freeLots(store.state.city.lots, store.state.city.projects);
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
      const free = lots();
      if (lot && !free.some((l) => l.id === lot)) lot = free[0]?.id ?? '';
      setChildren(lotSelect, ...free.map((l) => h('option', { value: l.id, selected: l.id === lot }, lotLabel(l))));
      lotSelect.disabled = !free.length;
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
      try {
        const data =
          mode === 'pick'
            ? await store.request<unknown>({ t: 'place_project', reqId: '', path: picked!.path, name, lotId: lot, style, ...(setUp ? { initGit: true } : {}) })
            : await store.request<unknown>({ t: 'create_project', reqId: '', name, lotId: lot, style, template });
        // the ack carries { project, gitError? } (older servers: the project itself)
        const reply = (data && typeof data === 'object' ? data : {}) as { project?: Project; gitError?: string; id?: string };
        const placed = reply.project ?? (reply.id ? (data as Project) : undefined) ?? store.state.city.projects.find((p) => p.lotId === lot);
        const where = store.state.city.lots.find((l) => l.id === lot)?.district ?? 'its lot';
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
    renderFoot();
    renderPicked();
    updateCreateHint();

    const body = h(
      'div',
      { class: 'place' },
      // the lead's model is set when the house is placed: with no account yet that is the default, which may not be
      // the one connected later
      needsAccount(store.state) ? h('p', { class: 'picked-note is-warn' }, icon('key', 14), 'No AI account yet — connect one first so the lead uses it.') : null,
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
