// One editable workflow role ("person") card: compact summary that expands into the full editor.
import type { ModelInfo, ThinkingLevel, WorkflowStep } from '../../../shared/protocol';
import { autosize, h } from './dom';
import { modelLabel, THINKING_LABEL, thinkingChoices, vendorColor, vendorOfModel } from './format';
import { icon } from './icons';
import { createModelPicker } from './model-picker';
import { stepGroups } from './plans';
import type { Shell } from './shell';
import { avatar, groupField, modelChip, segmented } from './widgets';

const PLACEHOLDERS: { key: string; hint: string }[] = [
  { key: '{{task}}', hint: 'what you asked the team' },
  { key: '{{prev}}', hint: "previous person's result" },
  { key: '{{prevName}}', hint: 'their name' },
  { key: '{{feedback}}', hint: "reviewer's notes" },
  { key: '{{runDir}}', hint: 'shared folder for this run' },
];

export interface RoleCardOptions {
  step: WorkflowStep;
  index: number;
  steps: WorkflowStep[];
  expanded: boolean;
  /** The Advanced part (loop-back, instruction) is open. */
  advanced?: boolean;
  onAdvanced?(open: boolean): void;
  canRemove: boolean;
  onToggle(): void;
  onChange(patch: Partial<WorkflowStep>): void;
  onRemove(): void;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

function textArea(value: string, rows: number, onInput: (v: string) => void, extra: Record<string, unknown> = {}): HTMLTextAreaElement {
  const ta = h('textarea', { class: 'input', rows, ...extra }, value);
  ta.addEventListener('input', () => {
    autosize(ta, 320);
    onInput(ta.value);
  });
  requestAnimationFrame(() => autosize(ta, 320));
  return ta;
}

/** The review chip in a card's summary: who gets the work back, or just "review" when nobody does. */
export function reviewChip(step: WorkflowStep, steps: WorkflowStep[]): HTMLElement | null {
  if (step.kind !== 'review') return null;
  const target = step.loopBackTo ? steps.find((s) => s.id === step.loopBackTo) : undefined;
  const times = step.maxLoops ?? 2;
  const title = target
    ? `${step.name || 'This person'} checks the work and sends it back to ${target.name} when changes are needed (up to ${times} time${times === 1 ? '' : 's'} per run)`
    : `${step.name || 'This person'} checks the work but sends nothing back`;
  return h('span', { class: 'chip chip-review', title, 'aria-label': title }, icon('loop', 11), target ? `back to ${target.name}` : 'checks only');
}

/** The summary's second line: "Opus 5.5 · max effort", "… · effort off"; nothing extra for the default effort. */
export function roleModelLine(step: WorkflowStep, models: ModelInfo[]): HTMLElement {
  const effort = !step.thinking ? null : step.thinking === 'off' ? ' · effort off' : ` · ${THINKING_LABEL[step.thinking].toLowerCase()} effort`;
  return h('span', { class: 'role-model' }, modelLabel(step.model, models), effort ? h('span', { class: 'muted' }, effort) : null);
}

export function roleCard(shell: Shell, o: RoleCardOptions): HTMLElement {
  const { step } = o;
  const models = shell.store.state.models;
  const vendor = vendorOfModel(step.model, models);

  const summary = h(
    'button',
    { type: 'button', class: 'role-head', 'aria-expanded': String(o.expanded), onclick: o.onToggle },
    h('span', { class: 'role-num num' }, String(o.index + 1)),
    avatar(step.name || '?', vendor, 'md'),
    h(
      'span',
      { class: 'role-titles' },
      h('span', { class: 'role-name' }, step.name || 'Unnamed'),
      roleModelLine(step, models),
    ),
    h(
      'span',
      { class: 'role-chips' },
      modelChip(step.model, models),
      o.index > 0 && step.parallel ? h('span', { class: 'chip chip-par', title: `Works at the same time as ${o.steps[o.index - 1]?.name ?? 'the person before'}` }, icon('columns', 11), 'same time') : null,
      reviewChip(step, o.steps),
    ),
    icon('chevronDown', 16, 'role-chev'),
  );

  const card = h('article', { class: ['role', o.expanded && 'is-open'], style: { '--vc': vendorColor(vendor) } }, summary);
  if (!o.expanded) return card;

  const nameInput = h('input', { class: 'input', value: step.name, maxlength: '40', 'aria-label': 'Name' });
  nameInput.addEventListener('input', () => o.onChange({ name: nameInput.value }));

  // A review sends work back to someone before its own parallel group (the server refuses a target inside it).
  const group = stepGroups(o.steps).find((g) => g.includes(step)) ?? [step];
  const earlier = o.steps.slice(0, o.steps.indexOf(group[0]));
  const reviewOpts =
    step.kind === 'review' && earlier.length
      ? (() => {
          // Shows what the step really has: a review may send nothing back (the lead can make one; a review that was
          // first in its group lost its target) — never a person who isn't saved.
          const sel = h(
            'select',
            { class: 'input input-inline', 'aria-label': 'Send back to' },
            earlier.map((s) => h('option', { value: s.id, selected: s.id === step.loopBackTo }, s.name)),
            h('option', { value: '', selected: !step.loopBackTo }, 'nobody (just report)'),
          );
          const loops = h('input', { class: 'input input-inline input-num', type: 'number', min: '1', max: '5', value: String(step.maxLoops ?? 2), 'aria-label': 'Maximum rounds' });
          loops.addEventListener('change', () => o.onChange({ maxLoops: Math.max(1, Math.min(5, Number(loops.value) || 2)) }));
          const rounds = h('span', { class: 'review-loop-rounds', hidden: !step.loopBackTo }, h('span', null, 'up to'), loops, h('span', null, 'times'));
          sel.addEventListener('change', () => {
            rounds.hidden = !sel.value;
            o.onChange({ loopBackTo: sel.value || undefined });
          });
          return h('div', { class: 'review-loop' }, icon('loop', 14), h('span', null, 'If changes are needed, send back to'), sel, rounds);
        })()
      : null;

  /** Same time as the person before: they form a group that starts together; the next person gets all their results. */
  function parallelToggle(): HTMLElement {
    const box = h('input', { type: 'checkbox', checked: !!step.parallel, 'aria-describedby': `par-hint-${step.id}` });
    box.addEventListener('change', () => o.onChange({ parallel: box.checked || undefined }));
    const prev = o.steps[o.index - 1];
    return h(
      'label',
      { class: 'role-par' },
      box,
      h(
        'span',
        null,
        h('span', { class: 'role-par-label' }, 'Works at the same time as the person before'),
        h('span', { class: 'field-hint', id: `par-hint-${step.id}` }, `Starts together with ${prev?.name || 'them'} on a separate part; the next person gets both results.`),
      ),
    );
  }

  let instruction: HTMLTextAreaElement;
  const insert = (key: string) => {
    const at = instruction.selectionStart ?? instruction.value.length;
    instruction.setRangeText(key, at, instruction.selectionEnd ?? at, 'end');
    instruction.dispatchEvent(new Event('input'));
    instruction.focus();
  };
  instruction = textArea(step.instruction, 5, (v) => o.onChange({ instruction: v }), { class: 'input input-mono', 'aria-label': 'Instruction' });

  const body = h(
    'div',
    { class: 'role-body' },
    h(
      'div',
      { class: 'field-row' },
      field('Name', nameInput),
      field(
        'Model',
        createModelPicker(shell, step.model, (id) => o.onChange({ model: id })),
      ),
    ),
    // Effort: Default (High) or a level the model offers — like the lead's in the job dialog.
    groupField(
      'Effort',
      segmented<ThinkingLevel | 'default'>(
        [{ value: 'default', label: 'Default' }, ...thinkingChoices(step.model, models, step.thinking).map((v) => ({ value: v, label: THINKING_LABEL[v] }))],
        step.thinking ?? 'default',
        (v) => o.onChange({ thinking: v === 'default' ? undefined : v }),
        'Effort',
      ),
      'Default (High). More effort is slower and costs more.',
    ),
    groupField(
      'Does',
      segmented(
        [
          { value: 'work', label: 'Works' },
          { value: 'review', label: 'Checks (review)' },
        ],
        step.kind,
        (v) => o.onChange(v === 'review' ? { kind: v, loopBackTo: step.loopBackTo ?? earlier[earlier.length - 1]?.id, maxLoops: step.maxLoops ?? 2 } : { kind: v, loopBackTo: undefined }),
        'Does',
      ),
    ),
    o.index > 0 ? parallelToggle() : null,
    field('Who they are', textArea(step.persona, 2, (v) => o.onChange({ persona: v }), { 'aria-label': 'Persona', placeholder: 'A careful senior engineer who…' }), 'Added to their system prompt.'),
    h(
      'details',
      { class: 'role-advanced', open: !!o.advanced, ontoggle: (ev: Event) => o.onAdvanced?.((ev.currentTarget as HTMLDetailsElement).open) },
      h('summary', null, h('span', null, 'Advanced'), h('span', { class: 'muted small' }, step.kind === 'review' ? 'sending back, instruction' : 'instruction'), icon('chevronDown', 13, 'role-advanced-chev')),
      h(
        'div',
        { class: 'role-advanced-body' },
        reviewOpts,
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label' }, 'What to do'),
          instruction,
          h(
            'div',
            { class: 'placeholders' },
            PLACEHOLDERS.map((p) => h('button', { type: 'button', class: 'ph', title: `Insert ${p.hint}`, onclick: () => insert(p.key) }, p.key)),
          ),
          step.kind === 'review' ? h('span', { class: 'field-hint' }, 'Reviewers end their reply with a verdict: approve or revise.') : null,
        ),
      ),
    ),
    o.canRemove
      ? h('div', { class: 'role-foot' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-deny', onclick: o.onRemove }, icon('trash', 14), `Remove ${step.name || 'person'}`))
      : null,
  );
  card.appendChild(body);
  return card;
}
