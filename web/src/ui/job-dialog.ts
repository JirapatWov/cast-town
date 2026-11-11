// "+ New job" / "Edit job" / "Move job" dialog: name, illustrated kind cards, lead model, team, advisor, own copy of the
// files (new jobs in git houses; read-only afterwards), brief, room picker.
import { DEFAULT_WORK_STYLE, type Job, type JobKind, type JobPatch, type RoomRef, type ThinkingLevel, type Workflow, type WorkStyle } from '../../../shared/protocol';
import { roomCode, sameRoom } from '../../../shared/house-plan';
import { autosize, h, setChildren } from './dom';
import { anyConnected, modelAvailable, modelGroupTitle, modelGroups, modelLabel, modelNames, THINKING_LABEL, thinkingChoices, vendorColor, vendorOfModel } from './format';
import { icon } from './icons';
import { kindIllustration } from './illustrations';
import { KINDS, WORK_STYLES, floorName, jobRoomCode, kindInfo, projectFloors } from './jobs';
import { openMenu, type MenuSection } from './menu';
import { openModal, type ModalHandle } from './modal';
import { createModelPicker } from './model-picker';
import { defaultRoom, createRoomPicker, type RoomPicker } from './room-picker';
import type { Shell } from './shell';
import { kbd, modelChip, modKey, optionNames, segmented } from './widgets';
import { teamOfJob } from './workflow-use';

export type JobDialogMode = 'new' | 'edit' | 'move';

export interface JobDialogOptions {
  mode: JobDialogMode;
  projectId: string;
  jobId?: string;
  room?: RoomRef;
}

let current: { modal: ModalHandle; mode: JobDialogMode; projectId: string; jobId?: string; setRoom(r: RoomRef): void; refresh(): void } | null = null;

/** Re-render the open dialog's live parts (rooms taken, floors) after a store change. */
export function refreshJobDialog() {
  current?.refresh();
}

function teamLabel(wf: Workflow | undefined, lead: string): string {
  return wf ? wf.name : `The ${lead} picks (no fixed team)`;
}

export function openJobDialog(shell: Shell, opts: JobDialogOptions) {
  const { store } = shell;
  if (current) {
    if (current.mode === opts.mode && current.projectId === opts.projectId && current.jobId === opts.jobId) {
      if (opts.room) current.setRoom(opts.room);
      return;
    }
    current.modal.close();
  }
  const project = store.project(opts.projectId);
  if (!project) return;
  const existing: Job | undefined = opts.jobId ? store.job(opts.projectId, opts.jobId) : undefined;
  if (opts.mode !== 'new' && !existing) return;

  const isNew = opts.mode === 'new';
  const showDetails = opts.mode !== 'move';
  const showRooms = opts.mode !== 'edit';
  // When something is connected only connected models can be used: the kind's usual lead, else a connected one.
  const PREFERRED = ['anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol', 'google/gemini-4-argon', 'deepseek/deepseek-v4-pro', 'anthropic/claude-sonnet-5-5'];
  const defaultModel = (k: JobKind) => {
    const want = kindInfo(k).model;
    const models = store.state.models;
    if (anyConnected(models) && !modelAvailable(want, models)) return PREFERRED.find((id) => modelAvailable(id, models)) ?? models.find((m) => m.available)?.id ?? want;
    return models.length === 0 || models.some((m) => m.id === want) ? want : models[0].id;
  };

  // A new job in a writing house (its Main job writes) starts as a writing job.
  const writingHouse = store.jobsOf(opts.projectId).some((j) => j.id === 'main' && j.kind === 'write');
  let kind: JobKind = existing?.kind ?? (writingHouse ? 'write' : 'general');
  let model = existing?.leadModel ?? defaultModel(kind);
  let leadThinking: ThinkingLevel | undefined = existing?.leadThinking; // undefined: omp's own default
  let modelTouched = !isNew;
  // the team the job works with: a Main job without one of its own has its house's (the Workflow tab shows it so), and
  // "no fixed team" must then read as a change, or the house keeps that team
  const startTeam = existing ? teamOfJob(existing, project) : null;
  let workflowId: string | null = startTeam;
  let workStyle: WorkStyle = existing?.workStyle ?? DEFAULT_WORK_STYLE;
  let advisorModel: string | undefined = existing?.advisorModel; // undefined: no advisor
  let worktree = false; // new jobs only: its own copy of the files
  let submitting = false;
  let slow = false; // making the copy takes a while (a big repo): the footer says it is still going
  const leadName = () => kindInfo(kind).lead;
  const startRoom: RoomRef | null = existing
    ? { ...existing.room }
    : opts.room ?? defaultRoom(projectFloors(project), store.jobsOf(opts.projectId));

  // ── fields ──
  const nameInput = h('input', { class: 'input jd-name', maxlength: '60', placeholder: kindInfo(kind).placeholder, 'aria-label': 'Job name', value: existing?.name ?? '', autocomplete: 'off', spellcheck: 'false' });
  const briefInput = h('textarea', {
    class: 'input jd-brief',
    rows: 3,
    maxlength: '2000',
    placeholder: 'Goal, scope or style for everyone in this job — e.g. “Only edit files in reader-web/”.',
    'aria-label': 'Brief',
  });
  briefInput.value = existing?.brief ?? '';

  const kindsEl = h('div', { class: 'jd-kinds', role: 'radiogroup', 'aria-label': 'Kind of work' });
  const kindBtns = new Map<JobKind, HTMLElement>();
  /** Cards are built once and updated in place: rebuilding them would drop the focus of the clicked card to <body>
   *  (and with it the dialog's Ctrl+Enter). */
  function renderKinds() {
    if (!kindBtns.size) {
      for (const k of KINDS) {
        const name = h('span', { class: 'jd-kind-name' }, k.name);
        const blurb = h('span', { class: 'jd-kind-blurb' }, k.blurb);
        kindBtns.set(k.id, h(
          'button',
          { type: 'button', role: 'radio', class: 'jd-kind', style: { '--kc': k.accent }, ...optionNames(name, blurb), onclick: () => setKind(k.id) },
          h('span', { class: 'jd-kind-art', html: kindIllustration(k.id) }),
          h('span', { class: 'jd-kind-text' }, name, blurb),
        ));
      }
      setChildren(kindsEl, ...kindBtns.values());
    }
    for (const [id, btn] of kindBtns) {
      const on = id === kind;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
      const check = btn.querySelector('.jd-kind-check');
      if (on && !check) btn.append(h('span', { class: 'jd-kind-check' }, icon('check', 11)));
      else if (!on && check) check.remove();
    }
  }
  kindsEl.addEventListener('keydown', (ev) => {
    const dir = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    ev.preventDefault();
    const i = KINDS.findIndex((k) => k.id === kind);
    setKind(KINDS[(i + dir + KINDS.length) % KINDS.length].id);
    kindsEl.querySelector<HTMLElement>('.jd-kind.is-on')?.focus();
  });

  const modelSlot = h('div', { class: 'jd-model' });
  function renderModel() {
    setChildren(modelSlot,
      createModelPicker(shell, model, (id) => {
        model = id;
        modelTouched = true;
        renderThinking();
        renderFoot();
      }),
    );
    renderThinking();
  }

  // Effort: Default (High) or a level the lead's model offers.
  const thinkingSlot = h('div', { class: 'jd-thinking' });
  function renderThinking() {
    const choices: (ThinkingLevel | 'default')[] = ['default', ...thinkingChoices(model, store.state.models, leadThinking)];
    setChildren(thinkingSlot,
      segmented(
        choices.map((v) => ({ value: v, label: v === 'default' ? 'Default' : THINKING_LABEL[v] })),
        leadThinking ?? 'default',
        (v) => {
          leadThinking = v === 'default' ? undefined : v;
          renderFoot();
        },
        'Lead’s effort',
      ),
    );
  }

  // Advisor: Off or a signed-in model that reads each of the lead's turns (omp's advisor). Only a connected model can.
  const advisorBtn = h('button', { type: 'button', class: 'model-btn jd-advisor', 'aria-haspopup': 'menu', 'aria-describedby': 'jd-advisor-why' });
  // Why it is off, in words under it (a tooltip alone isn't seen on touch, nor before hovering a disabled button).
  const advisorWhy = h('p', { id: 'jd-advisor-why', class: 'field-hint jd-advisor-why', hidden: true });
  function renderAdvisor() {
    const s = store.state;
    const live = anyConnected(s.models);
    const label = advisorModel ? modelLabel(advisorModel, s.models) : 'Off';
    setChildren(advisorBtn,
      advisorModel
        ? h('span', { class: 'vendor-dot', style: { background: vendorColor(vendorOfModel(advisorModel, s.models)) } })
        : h('span', { class: 'jd-team-icon', 'aria-hidden': 'true' }, icon('eye', 14)),
      h('span', { class: 'model-btn-label' }, label),
      advisorModel ? modelChip(advisorModel, s.models) : null,
      icon('chevronDown', 14, 'model-btn-chev'),
    );
    advisorBtn.disabled = !live && !advisorModel;
    advisorBtn.title = live ? '' : 'Nothing is signed in yet: an advisor needs a connected model.';
    advisorWhy.hidden = live;
    if (!live)
      setChildren(advisorWhy,
        icon('alert', 13),
        ' Needs a connected AI account. ',
        h('button', { type: 'button', class: 'link-btn', onclick: () => shell.openProviders() }, 'Connect an AI account…'),
      );
    advisorBtn.setAttribute('aria-label', `Advisor: ${label}`);
  }
  advisorBtn.addEventListener('click', () => {
    const s = store.state;
    const connected = s.models.filter((m) => m.available);
    const names = modelNames(s.models);
    const sections: MenuSection[] = [
      { items: [{ label: 'Off', icon: 'x', hint: 'no second model', checked: !advisorModel, onSelect: () => setAdvisor(undefined) }] },
      ...modelGroups(connected).map((g) => ({
        title: modelGroupTitle(g),
        items: g.models.map((m) => ({ label: names.get(m.id) ?? m.label, swatch: vendorColor(m.vendor), checked: m.id === advisorModel, onSelect: () => setAdvisor(m.id) })),
      })),
    ];
    openMenu(shell.root, shell.layers, advisorBtn, sections, {
      id: 'advisor-menu',
      minWidth: 280,
      className: 'model-menu',
      footer: h('span', null, connected.length ? 'Only signed-in models can advise. A cheaper, quick model is often enough.' : 'Nothing is signed in yet: an advisor needs a connected model.'),
    });
  });
  function setAdvisor(id: string | undefined) {
    advisorModel = id;
    renderAdvisor();
    renderFoot();
  }

  // Own copy of the files (a git worktree): chosen once, when the job is created; read-only afterwards.
  const copyField = (() => {
    if (isNew) {
      const git = project.isGit;
      const box = h('input', { type: 'checkbox', disabled: !git, 'aria-describedby': 'jd-copy-hint' });
      box.addEventListener('change', () => {
        worktree = box.checked;
        renderFoot();
      });
      return h(
        'label',
        { class: ['jd-copy', !git && 'is-off'] },
        box,
        h(
          'span',
          { class: 'jd-copy-text' },
          h('span', { class: 'jd-copy-label' }, 'Work in its own copy of the files'),
          h(
            'span',
            { class: 'field-hint', id: 'jd-copy-hint' },
            git
              ? 'Its people work in a separate git worktree on a branch of its own, starting from the house’s files as they are now. Other jobs don’t see its edits until you bring them in from the Changes tab. Ignored files such as node_modules or .env aren’t copied. Can’t be changed later.'
              : `Only for houses in a git repository — ${project.name} isn’t one.`,
          ),
        ),
      );
    }
    const copy = existing?.worktree;
    if (!copy) return h('p', { class: 'jd-copy-shared' }, 'The house folder, shared with the other jobs. A job’s own copy can only be chosen when the job is created.');
    return h(
      'div',
      { class: 'jd-copy is-readonly' },
      icon('copy', 15),
      h(
        'span',
        { class: 'jd-copy-text' },
        h('span', { class: 'jd-copy-label' }, 'Its own copy of the files ', h('code', { class: 'jd-copy-branch', title: copy.path }, copy.branch)),
        h('span', { class: 'field-hint' }, 'Chosen when the job was created. Bring its changes into the house from the Changes tab.'),
      ),
    );
  })();

  const teamBtn = h('button', { type: 'button', class: 'model-btn jd-team', 'aria-haspopup': 'menu' });
  function renderTeam() {
    const wf = store.workflowOf(opts.projectId, workflowId);
    setChildren(teamBtn,
      h('span', { class: 'jd-team-icon', 'aria-hidden': 'true' }, wf ? wf.icon || '•' : icon('sparkle', 14)),
      h('span', { class: 'model-btn-label' }, teamLabel(wf, leadName())),
      wf ? h('span', { class: 'jd-team-dots', 'aria-hidden': 'true' }, wf.steps.map((st) => h('span', { style: { background: vendorColor(vendorOfModel(st.model, store.state.models)) } }))) : null,
      icon('chevronDown', 14, 'model-btn-chev'),
    );
    teamBtn.setAttribute('aria-label', `Team: ${teamLabel(wf, leadName())}`);
  }

  // How the lead goes about an ask: radio rows with a one-line hint each (built once, updated in place).
  const styleEl = h('div', { class: 'jd-styles', role: 'radiogroup', 'aria-labelledby': 'jd-style-label' });
  const styleLabel = h('span', { class: 'field-label', id: 'jd-style-label' });
  const styleBtns = new Map<WorkStyle, HTMLElement>();
  function renderStyles() {
    styleLabel.textContent = `How the ${leadName()} works`;
    if (!styleBtns.size) {
      for (const st of WORK_STYLES) {
        const name = h('span', { class: 'jd-style-name' }, st.label);
        const hint = h('span', { class: 'jd-style-hint' });
        styleBtns.set(st.id, h(
          'button',
          { type: 'button', role: 'radio', class: 'jd-style', ...optionNames(name, hint), onclick: () => setStyle(st.id) },
          h('span', { class: 'jd-style-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'jd-style-text' }, name, hint),
        ));
      }
      setChildren(styleEl, ...styleBtns.values());
    }
    for (const [id, btn] of styleBtns) {
      const on = id === workStyle;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
      btn.querySelector('.jd-style-hint')!.textContent = WORK_STYLES.find((x) => x.id === id)!.hint(leadName());
    }
  }
  styleEl.addEventListener('keydown', (ev) => {
    const dir = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    ev.preventDefault();
    const i = WORK_STYLES.findIndex((x) => x.id === workStyle);
    setStyle(WORK_STYLES[(i + dir + WORK_STYLES.length) % WORK_STYLES.length].id);
    styleEl.querySelector<HTMLElement>('.jd-style.is-on')?.focus();
  });
  function setStyle(st: WorkStyle) {
    if (st === workStyle) return;
    workStyle = st;
    renderStyles();
    renderFoot();
  }
  teamBtn.addEventListener('click', () => {
    // A new house has no workflows: the lead builds a team per task until the user or the lead saves one.
    const wfs = store.workflowsOf(opts.projectId);
    const sections: MenuSection[] = [
      { items: [{ label: `The ${leadName()} picks (no fixed team)`, icon: 'sparkle', hint: 'per task', checked: workflowId === null, onSelect: () => setTeam(null) }] },
    ];
    if (wfs.length)
      sections.push({
        title: 'Or a fixed team (each step is a person in the room)',
        items: wfs.map((w) => ({
          label: `${w.icon ? `${w.icon}  ` : ''}${w.name}`,
          hint: `${w.steps.length} people`,
          checked: w.id === workflowId,
          onSelect: () => setTeam(w.id),
        })),
      });
    openMenu(shell.root, shell.layers, teamBtn, sections, {
      id: 'team-menu',
      minWidth: 300,
      footer: wfs.length ? undefined : h('span', null, `This house has no workflows yet. To keep a team, ask the ${leadName()} to save one, or use the Workflow tab.`),
    });
  });

  function setKind(k: JobKind) {
    if (k === kind) return;
    kind = k;
    nameInput.placeholder = kindInfo(k).placeholder;
    if (!modelTouched) {
      model = defaultModel(k);
      renderModel();
    }
    renderKinds();
    renderTeam();
    renderStyles();
    renderFoot();
  }
  function setTeam(id: string | null) {
    workflowId = id;
    renderTeam();
    renderFoot();
  }

  // ── rooms ──
  let picker: RoomPicker | null = null;
  const roomHint = h('p', { class: 'field-hint jd-room-hint' });
  function renderRoomHint() {
    const r = picker?.value;
    if (!r) {
      roomHint.textContent = 'Every room on every floor is taken. Delete or move a job to make room.';
      return;
    }
    const fresh = !!picker?.onNewFloor;
    const where = `${roomCode(r.floor, r.slot)} on ${r.floor === 0 ? 'the ground floor' : floorName(r.floor)}${fresh ? ', a new floor' : ''}`;
    if (fresh) {
      roomHint.textContent = opts.mode === 'move'
        ? `Moves to ${where} — it is built when you move it. People, chats and files stay the same.`
        : `This job gets room ${where} — it is built when you create the job.`;
      return;
    }
    if (opts.mode === 'move' && existing && sameRoom(r, existing.room)) {
      roomHint.textContent = `“${existing.name}” is in ${where} now. Pick a free room to move it there — people, chats and files stay the same.`;
      return;
    }
    roomHint.textContent = opts.mode === 'move' ? `Moves to ${where}. People, chats and files stay the same.` : `This job gets room ${where}.`;
  }
  if (showRooms) {
    picker = createRoomPicker(shell, {
      projectId: opts.projectId,
      value: startRoom,
      movingJobId: opts.mode === 'move' ? existing?.id : undefined,
      previewName: () => (opts.mode === 'move' ? existing?.name ?? '' : nameInput.value),
      buildVerb: opts.mode === 'move' ? 'move it' : 'create the job',
      onChange: () => {
        renderRoomHint();
        renderFoot();
      },
    });
  }

  // ── footer ──
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'button', class: 'btn btn-primary' });
  const footHint = h('span', { class: 'jd-foot-hint' }, kbd(modKey, 'Enter'));

  function patch(): JobPatch {
    if (!existing) return {};
    const p: JobPatch = {};
    if (showDetails) {
      const name = nameInput.value.trim();
      if (name && name !== existing.name) p.name = name;
      if (kind !== existing.kind) p.kind = kind;
      if (model !== existing.leadModel) p.leadModel = model;
      if (leadThinking !== existing.leadThinking) p.leadThinking = leadThinking ?? null;
      if (advisorModel !== existing.advisorModel) p.advisorModel = advisorModel ?? null;
      if (workflowId !== startTeam) p.workflowId = workflowId;
      if (workStyle !== (existing.workStyle ?? DEFAULT_WORK_STYLE)) p.workStyle = workStyle;
      if (briefInput.value.trim() !== existing.brief.trim()) p.brief = briefInput.value.trim();
    }
    const r = picker?.value;
    if (showRooms && r && (r.floor !== existing.room.floor || r.slot !== existing.room.slot)) p.room = { ...r };
    return p;
  }

  function renderFoot() {
    const label = isNew ? (submitting && worktree ? (slow ? 'Still copying…' : 'Copying the files…') : 'Create job') : opts.mode === 'move' ? 'Move here' : 'Save changes';
    setChildren(submit, submitting ? h('span', { class: 'spinner spinner-sm' }) : icon(isNew ? 'plus' : opts.mode === 'move' ? 'layers' : 'check', 15), label);
    // Why the button can't be used yet, said next to it (a disabled button explains nothing on its own, and on a phone
    // the room picker that would say it is far below).
    let why = '';
    if (showRooms && !picker?.value) why = isNew ? 'Every room is taken — delete or move a job first' : 'Pick a free room';
    else if (opts.mode === 'move' && existing && picker?.value && sameRoom(picker.value, existing.room)) why = 'Pick another room to move to';
    else if (opts.mode === 'edit' && Object.keys(patch()).length === 0) why = 'Nothing changed yet';
    const ready = !why; // an empty name on create isn't a reason: the click shakes and focuses the field instead
    setChildren(footHint,
      submitting && slow
        ? h('span', { role: 'status' }, 'Big projects take a minute or two — it’s still going.')
        : why && !submitting
          ? h('span', { class: 'jd-why', role: 'status' }, icon('alert', 13), why)
          : kbd(modKey, 'Enter'),
    );
    submit.disabled = !ready || submitting;
    submit.title = why;
  }

  async function doSubmit() {
    if (submitting || submit.disabled) return;
    const name = nameInput.value.trim();
    if (showDetails && !name) {
      nameInput.focus();
      nameInput.classList.add('is-invalid');
      setTimeout(() => nameInput.classList.remove('is-invalid'), 900);
      return;
    }
    submitting = true;
    error.hidden = true;
    renderFoot();
    try {
      if (isNew) {
        const room = picker!.value!;
        const newFloor = picker!.onNewFloor; // the server builds it with the job
        const data = await store.request<{ job?: Job } | undefined>({
          t: 'create_job',
          reqId: '',
          projectId: opts.projectId,
          name,
          kind,
          room,
          // With no account connected the shown model is only a stand-in: leave the choice to the server, which follows the account once there is one
          ...(modelTouched || anyConnected(store.state.models) ? { leadModel: model } : {}),
          ...(leadThinking ? { leadThinking } : {}),
          workflowId,
          brief: briefInput.value.trim(),
          workStyle,
          ...(advisorModel ? { advisorModel } : {}),
          ...(worktree ? { worktree: true } : {}),
        }, {
          onSlow: () => {
            slow = true;
            renderFoot();
          },
        });
        const job = data?.job ?? store.jobsOf(opts.projectId).find((j) => j.room.floor === room.floor && j.room.slot === room.slot);
        modal.close();
        const copy = job?.worktree ? ` with its own copy of the files (branch ${job.worktree.branch})` : '';
        const built = newFloor ? ` on the new ${floorName(room.floor)}` : '';
        shell.toast('success', `“${name}” moved into room ${roomCode(room.floor, room.slot)}${built}${copy}`, { projectId: opts.projectId });
        if (job) shell.selectJob(opts.projectId, job.id, { focus: true, openPanel: true });
      } else {
        const p = patch();
        await store.request({ t: 'update_job', reqId: '', projectId: opts.projectId, jobId: existing!.id, patch: p });
        modal.close();
        if (p.room) {
          shell.toast('success', `“${p.name ?? existing!.name}” moved to room ${roomCode(p.room.floor, p.room.slot)}`, { projectId: opts.projectId });
          shell.selectJob(opts.projectId, existing!.id, { focus: true });
        } else shell.toast('success', `Saved “${p.name ?? existing!.name}”`, { projectId: opts.projectId });
      }
    } catch (err) {
      error.textContent = (err as Error).message;
      error.hidden = false;
    } finally {
      submitting = false;
      slow = false;
      renderFoot();
    }
  }

  nameInput.addEventListener('input', () => {
    picker?.refreshPreview();
    renderFoot();
  });
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      void doSubmit();
    }
  });
  briefInput.addEventListener('input', () => {
    autosize(briefInput, 180);
    renderFoot();
  });
  submit.addEventListener('click', () => void doSubmit());

  // ── layout ──
  const details = showDetails
    ? h(
        'div',
        { class: 'jd-details' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameInput),
        h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'jd-kind-label' }, 'Kind of work'), kindsEl),
        h(
          'div',
          { class: 'field-row' },
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Lead'), modelSlot, h('p', { class: 'field-hint' }, 'The person you talk to in this room.')),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Team'), teamBtn, h('p', { class: 'field-hint' }, 'Optional: the same people for every task.')),
        ),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label' }, 'Effort'),
          thinkingSlot,
          h('p', { class: 'field-hint' }, 'How hard the lead thinks. Default (High); more effort is slower and costs more. Only the levels this model has are shown.'),
        ),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label' }, 'Advisor ', h('span', { class: 'field-optional' }, 'optional')),
          advisorBtn,
          advisorWhy,
          h('p', { class: 'field-hint' }, 'A second model reads each of the lead’s turns and adds a note when it sees a problem. It costs extra.'),
        ),
        h('div', { class: 'field' }, styleLabel, styleEl),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Files'), copyField),
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label' }, 'Brief ', h('span', { class: 'field-optional' }, 'optional')),
          briefInput,
        ),
      )
    : null;
  const rooms = picker
    ? h(
        'div',
        { class: 'jd-rooms' },
        h('div', { class: 'jd-rooms-head' }, h('span', { class: 'field-label' }, opts.mode === 'move' ? 'Pick the new room' : 'Room'), roomHint),
        h('div', { class: 'jd-rooms-scroll' }, picker.el),
      )
    : null;

  renderKinds();
  renderModel();
  renderTeam();
  renderAdvisor();
  renderStyles();
  renderRoomHint();
  renderFoot();

  const title = isNew ? 'New job' : opts.mode === 'move' ? `Move “${existing!.name}”` : `Edit “${existing!.name}”`;
  const subtitle = isNew
    ? `A separate line of work in ${project.name}, with its own room, people and chat history.`
    : opts.mode === 'move'
      ? `Now in room ${jobRoomCode(existing!)}. Pick a free room on any floor.`
      : `Room ${jobRoomCode(existing!)} in ${project.name}.`;

  const modal = openModal(shell.root, shell.layers, {
    id: 'job-dialog',
    className: ['modal-job', `is-${opts.mode}`].join(' '),
    title,
    subtitle,
    body: h('div', { class: ['jd', showDetails && showRooms && 'jd-split'] }, details, rooms, error),
    footer: [footHint, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel'), submit],
    onClose: () => {
      document.removeEventListener('keydown', onSubmitKey);
      if (current?.modal === modal) current = null;
    },
  });
  // Ctrl+Enter submits from anywhere while this dialog is the top layer (focus may sit on <body> after a click on a
  // non-focusable part of the dialog).
  const onSubmitKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey) || ev.defaultPrevented) return;
    if (!modal.dialog.isConnected || shell.layers.top()?.id !== 'job-dialog') return;
    ev.preventDefault();
    void doSubmit();
  };
  document.addEventListener('keydown', onSubmitKey);
  requestAnimationFrame(() => {
    autosize(briefInput, 180);
    if (opts.mode === 'move') modal.dialog.querySelector<HTMLElement>('.rp-room.is-on, button.rp-room[tabindex="0"]')?.focus({ preventScroll: true });
    else nameInput.focus({ preventScroll: true });
    revealRoom();
  });

  /** Bring the chosen room into view. Outside move mode only the rooms column scrolls: scrollIntoView would also
   *  scroll the single-column phone dialog away from the name field. */
  function revealRoom() {
    const room = modal.dialog.querySelector<HTMLElement>('.rp-room.is-on');
    if (!room) return;
    if (opts.mode === 'move') return room.scrollIntoView({ block: 'nearest' });
    const box = modal.dialog.querySelector<HTMLElement>('.jd-rooms-scroll');
    if (!box || box.scrollHeight <= box.clientHeight + 1) return;
    const b = box.getBoundingClientRect();
    const r = room.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop += r.top - b.top - 8;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
  }

  current = {
    modal,
    mode: opts.mode,
    projectId: opts.projectId,
    jobId: opts.jobId,
    setRoom(r) {
      picker?.set(r);
      renderRoomHint();
      renderFoot();
    },
    refresh() {
      if (!store.project(opts.projectId) || (existing && !store.job(opts.projectId, existing.id))) {
        modal.close();
        return;
      }
      if (picker) {
        const sel = picker.value;
        const floors = projectFloors(store.project(opts.projectId));
        const taken = sel && store.jobsOf(opts.projectId).some((j) => j.id !== existing?.id && j.room.floor === sel.floor && j.room.slot === sel.slot);
        // a room on the next floor (not built yet) is fine; anything above it, or a room someone took, is not
        if (taken || (sel && sel.floor > floors)) picker.set(defaultRoom(floors, store.jobsOf(opts.projectId)));
        const focused = picker.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.room : undefined;
        picker.render();
        if (focused) picker.el.querySelector<HTMLElement>(`[data-room="${focused}"]`)?.focus({ preventScroll: true });
      }
      if (isNew && !modelTouched) {
        const next = defaultModel(kind); // an account may have connected since the dialog opened
        if (next !== model) {
          model = next;
          renderModel();
        }
      }
      renderAdvisor(); // a sign-in may have changed which models can advise
      renderRoomHint();
      renderFoot();
    },
  };
}
