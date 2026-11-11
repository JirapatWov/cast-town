// Change a going run from its card (edit_run, like the lead's team_edit): Edit a step that hasn't started, Add a
// person, Send a note to the person working now. The run keeps going — finished steps keep their results and nobody
// working is restarted; the server checks every change again against the run as it is then and says why not.
import type { RunEditOp, RunPlanView, WorkflowRun, WorkflowStep } from '../../../shared/protocol';
import { confirmDialog } from './confirm';
import { autosize, h, setChildren } from './dom';
import { icon } from './icons';
import { openModal } from './modal';
import { openPopover } from './popover';
import { roleCard } from './role-card';
import { addOp, addPlaces, blankStep, stepOps } from './run-plan';
import type { Shell } from './shell';
import { kbd, modKey } from './widgets';

interface EditAck {
  changes: string[];
  warnings: string[];
  delivered: { stepId: string; name: string; how: 'steered' | 'prompt' }[];
  saved?: string;
  notSaved?: string;
}

async function planOf(shell: Shell, run: WorkflowRun): Promise<RunPlanView | null> {
  try {
    return await shell.store.request<RunPlanView>({ t: 'get_run_plan', reqId: '', runId: run.id });
  } catch (err) {
    shell.toast('error', (err as Error).message, { projectId: run.projectId });
    return null;
  }
}

/** `onError`: where a refusal shows (a dialog's own error line: a toast would be hidden behind the dialog). */
async function send(shell: Shell, run: WorkflowRun, ops: RunEditOp[], o: { view?: RunPlanView; save?: boolean; onError?: (message: string) => void } = {}): Promise<EditAck | null> {
  try {
    return await shell.store.request<EditAck>({
      t: 'edit_run',
      reqId: '',
      runId: run.id,
      ops,
      ...(o.save ? { save: true } : {}),
      ...(o.view ? { seen: { rev: o.view.rev, frozen: o.view.frozen } } : {}),
    });
  } catch (err) {
    if (o.onError) o.onError((err as Error).message);
    else shell.toast('error', (err as Error).message, { projectId: run.projectId });
    return null;
  }
}

function doneToast(shell: Shell, run: WorkflowRun, what: string, r: EditAck) {
  const saved = r.saved ? ` Also saved to “${r.saved}” for next time.` : r.notSaved ? ` ${r.notSaved.replace(/^Not saved[^:]*: /, 'Not saved: ')}` : '';
  shell.toast('success', `${what} — the team keeps going.${saved}`, { projectId: run.projectId });
  for (const w of r.warnings) shell.toast('warn', w, { projectId: run.projectId });
}

/** "Also save to “X” for next time": only for a saved workflow of the run's house (projectId), not a one-off team. */
function saveBox(shell: Shell, view: RunPlanView, projectId: string): { el: HTMLElement; checked(): boolean } | null {
  const wf = shell.store.workflowOf(projectId, view.workflowId);
  if (!wf) return null;
  const box = h('input', { type: 'checkbox' });
  return { el: h('label', { class: 'run-edit-save' }, box, h('span', null, `Also save to “${wf.name}” for next time`)), checked: () => box.checked };
}

/** A dialog's error line (shown above its buttons). */
type Fail = (message: string) => void;

/** The person editor (a role card, always open) in a dialog, with Apply / Cancel. A refusal shows in the dialog. */
function stepDialog(
  shell: Shell,
  o: { id: string; title: string; subtitle: string; step: WorkflowStep; index: number; steps: (draft: WorkflowStep) => WorkflowStep[]; extra?: HTMLElement; save: ReturnType<typeof saveBox>; applyLabel: string; onRemove?: (close: () => void, fail: Fail) => void; onApply(draft: WorkflowStep, save: boolean, fail: Fail): Promise<boolean> },
): void {
  let draft: WorkflowStep = structuredClone(o.step);
  let advanced = false;
  const holder = h('div', { class: 'run-edit-card' });
  const error = h('p', { class: 'form-error run-edit-error', role: 'alert', hidden: true });
  const fail: Fail = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  const paint = () =>
    setChildren(
      holder,
      roleCard(shell, {
        step: draft,
        index: o.index,
        steps: o.steps(draft),
        expanded: true,
        advanced,
        onAdvanced: (v) => (advanced = v),
        canRemove: !!o.onRemove,
        onToggle: () => {},
        onChange: (patch) => {
          draft = { ...draft, ...patch };
          // a choice changes what the card shows (effort levels, sending back); typing doesn't (it keeps the caret)
          if (!('name' in patch || 'persona' in patch || 'instruction' in patch)) paint();
        },
        onRemove: () => {
          error.hidden = true;
          o.onRemove?.(() => modal.close(), fail);
        },
      }),
    );
  paint();
  let busy = false;
  const apply = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('check', 13), o.applyLabel);
  apply.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    error.hidden = true;
    apply.setAttribute('aria-busy', 'true');
    const ok = await o.onApply(draft, o.save?.checked() ?? false, fail);
    busy = false;
    apply.removeAttribute('aria-busy');
    if (ok) modal.close();
  });
  const modal = openModal(shell.root, shell.layers, {
    id: o.id,
    className: 'modal-run-edit',
    title: o.title,
    subtitle: o.subtitle,
    body: h('div', { class: 'run-edit-body' }, o.extra ?? null, holder),
    footer: [error, o.save?.el ?? null, h('span', { class: 'run-edit-gap' }), h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => modal.close() }, 'Cancel'), apply],
  });
}

/** Edit on an up-next step: its role card; Apply sends only what changed. */
export async function editRunStep(shell: Shell, run: WorkflowRun, stepId: string): Promise<void> {
  const view = await planOf(shell, run);
  if (!view) return;
  const i = view.steps.findIndex((s) => s.id === stepId);
  const before = view.steps[i];
  if (!before) return shell.toast('info', 'That step is no longer in this run.', { projectId: run.projectId });
  if (i < view.frozen) return shell.toast('info', `${before.name} started meanwhile — send them a note instead.`, { projectId: run.projectId });
  const save = saveBox(shell, view, run.projectId);
  stepDialog(shell, {
    id: 'run-edit-step',
    title: `Change ${before.name} for this run`,
    subtitle: "The run keeps going: finished steps keep their results, and nobody working now is restarted.",
    step: before,
    index: i,
    steps: (draft) => view.steps.map((s, k) => (k === i ? draft : s)),
    save,
    applyLabel: 'Apply to this run',
    onRemove: (close, fail) => void removeStep(shell, run, view, before, close, fail),
    async onApply(draft, saveToo, fail) {
      const op = stepOps(before, draft);
      if (!op) return true;
      if (!draft.name.trim()) {
        fail('Give them a name first.');
        return false;
      }
      const r = await send(shell, run, [op], { view, save: saveToo, onError: fail });
      if (r) doneToast(shell, run, `${draft.name} changed for this run`, r);
      return !!r;
    },
  });
}

async function removeStep(shell: Shell, run: WorkflowRun, view: RunPlanView, step: WorkflowStep, closeEditor: () => void, fail: Fail): Promise<void> {
  const yes = await confirmDialog(shell.root, shell.layers, {
    title: `Take ${step.name} out of this run?`,
    body: "They won't work in this run. Everyone else keeps going; finished steps keep their results.",
    confirmLabel: 'Take out',
    tone: 'danger',
    icon: 'trash',
  });
  if (!yes) return;
  const r = await send(shell, run, [{ op: 'remove', step: step.id }], { view, onError: fail });
  if (!r) return;
  closeEditor();
  doneToast(shell, run, `${step.name} taken out of this run`, r);
}

/** "Add a person": after the group working now or a later step; the model of the step before by default. */
export async function addRunStep(shell: Shell, run: WorkflowRun): Promise<void> {
  const view = await planOf(shell, run);
  if (!view) return;
  const places = addPlaces(view);
  if (!places.length) return shell.toast('info', 'Nobody can be added to this run any more.', { projectId: run.projectId });
  let after = places.at(-1)!.after;
  const step = blankStep(view, after);
  const where = h('select', { class: 'input input-inline', 'aria-label': 'Comes' }, places.map((p) => h('option', { value: p.after, selected: p.after === after }, p.label)));
  where.addEventListener('change', () => (after = where.value));
  stepDialog(shell, {
    id: 'run-add-step',
    title: 'Add a person to this run',
    subtitle: 'They join the steps that haven\'t started — the run keeps going.',
    step,
    index: view.steps.length,
    steps: (draft) => [...view.steps, draft],
    extra: h('label', { class: 'field run-edit-where' }, h('span', { class: 'field-label' }, 'Comes'), where),
    save: saveBox(shell, view, run.projectId),
    applyLabel: 'Add to this run',
    async onApply(draft, saveToo, fail) {
      if (!draft.name.trim()) {
        fail('Give them a name first.');
        return false;
      }
      const r = await send(shell, run, [addOp(draft, after)], { view, save: saveToo, onError: fail });
      if (r) doneToast(shell, run, `${draft.name.trim()} added to this run`, r);
      return !!r;
    },
  });
}

/** "Send a note" on the person working now: they read it at their next step (or with their prompt, when they're
 *  about to start). */
export function noteRunStep(shell: Shell, run: WorkflowRun, stepId: string, name: string, anchor: HTMLElement): void {
  const note = h('textarea', { class: 'input again-note', rows: 3, maxlength: '4000', placeholder: 'e.g. Keep the chapter under 800 words', 'aria-label': `Note for ${name}` });
  note.addEventListener('input', () => autosize(note, 180));
  const go = async () => {
    const text = note.value.trim();
    if (!text) return note.focus();
    close();
    const r = await send(shell, run, [{ op: 'note', step: stepId, text }]);
    if (!r) return;
    const how = r.delivered.find((d) => d.stepId === stepId)?.how;
    shell.toast('success', how === 'prompt' ? `Note added to ${name}'s step — they read it when they start.` : `Note sent to ${name} — they read it at their next step.`, { projectId: run.projectId });
  };
  note.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
      ev.preventDefault();
      void go();
    }
  });
  const pop = h(
    'div',
    { class: 'save-pop again-pop glass-strong', role: 'dialog', 'aria-label': `Send a note to ${name}` },
    h('p', { class: 'again-pop-title' }, icon('chat', 14), `Send a note to ${name}`),
    h('p', { class: 'again-pop-text' }, `${name} keeps working and reads it at their next step — nothing restarts.`),
    note,
    h(
      'div',
      { class: 'save-pop-actions' },
      h('span', { class: 'again-pop-hint' }, kbd(modKey, 'Enter')),
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => void go() }, icon('send', 13), 'Send'),
    ),
  );
  const close = openPopover(shell.root, shell.layers, anchor, pop, { id: 'run-note', align: 'start' });
  requestAnimationFrame(() => note.focus());
}
